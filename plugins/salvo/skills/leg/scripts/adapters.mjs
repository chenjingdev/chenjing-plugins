import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SUBMISSION_SCHEMA = path.resolve(HERE, '../references/submission.schema.json')
const MAX_ENGINE_LOG_BYTES = 32 * 1024 * 1024

const stripFence = value => value.trim()
  .replace(/^```(?:json)?\s*/i, '')
  .replace(/\s*```$/, '')

const parseMaybeJson = value => {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(stripFence(value))
  } catch {
    return null
  }
}

export const validateCandidate = candidate => {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('engine did not return a structured candidate object')
  }
  if (!['candidate', 'blocked'].includes(candidate.status)) {
    throw new Error(`invalid candidate status: ${candidate.status}`)
  }
  if (typeof candidate.summary !== 'string' || candidate.summary.trim() === '') {
    throw new Error('candidate.summary must be a non-empty string')
  }
  for (const field of ['changed_files', 'checks_run', 'needs_user']) {
    if (!Array.isArray(candidate[field]) || candidate[field].some(item => typeof item !== 'string')) {
      throw new Error(`candidate.${field} must be a string array`)
    }
  }
  return candidate
}

const terminateTree = (child, signal) => {
  if (!child.pid) return
  if (process.platform === 'win32') {
    if (signal === 'SIGKILL') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.unref()
    } else child.kill()
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

const runProcess = ({ command, args, cwd, input, onStdoutLine, timeoutMs }) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd,
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let pending = ''
  let timedOut = false
  let outputOverflow = false
  let settled = false
  let hardTimer = null
  const timer = timeoutMs ? setTimeout(() => {
    timedOut = true
    terminateTree(child, 'SIGTERM')
    hardTimer = setTimeout(() => terminateTree(child, 'SIGKILL'), 2000)
    hardTimer.unref()
  }, timeoutMs) : null
  timer?.unref()
  child.on('error', error => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    if (hardTimer) clearTimeout(hardTimer)
    reject(error)
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const markOverflow = () => {
    if (outputOverflow) return
    outputOverflow = true
    terminateTree(child, 'SIGTERM')
    hardTimer = setTimeout(() => terminateTree(child, 'SIGKILL'), 2000)
    hardTimer.unref()
  }
  const retain = chunk => {
    const remaining = Math.max(0, MAX_ENGINE_LOG_BYTES - stdout.length - stderr.length)
    if (chunk.length > remaining) markOverflow()
    return chunk.slice(0, remaining)
  }
  child.stdout.on('data', chunk => {
    const kept = retain(chunk)
    stdout += kept
    if (onStdoutLine) {
      pending += kept
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const line of lines) if (line.trim()) onStdoutLine(line)
    }
  })
  child.stderr.on('data', chunk => {
    stderr += retain(chunk)
  })
  child.on('close', (code, signal) => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    if (hardTimer) clearTimeout(hardTimer)
    if (pending.trim() && onStdoutLine) onStdoutLine(pending)
    resolve({ code, signal, stdout, stderr, timed_out: timedOut, output_overflow: outputOverflow })
  })
  child.stdin.end(input)
})

const writeRawLogs = async (runDir, label, result) => {
  const evidence = path.join(runDir, 'evidence')
  await mkdir(evidence, { recursive: true })
  const stdoutPath = path.join(evidence, `${label}.engine.stdout.log`)
  const stderrPath = path.join(evidence, `${label}.engine.stderr.log`)
  await writeFile(stdoutPath, result.stdout, 'utf8')
  await writeFile(stderrPath, result.stderr, 'utf8')
  return { stdout_path: stdoutPath, stderr_path: stderrPath }
}

const invokeCodex = async ({ root, prompt, sessionId, model, runDir, label, onSessionId, timeoutMs }) => {
  const bin = process.env.SALVO_CODEX_BIN || 'codex'
  await mkdir(path.join(runDir, 'evidence'), { recursive: true })
  const outputPath = path.join(runDir, 'evidence', `${label}.candidate.json`)
  const common = ['--ask-for-approval', 'never', '--sandbox', 'workspace-write', '-C', root]
  // --ask-for-approval is a top-level Codex option, so it must precede `exec`.
  // exec mode cannot pause for an approval prompt; failures are returned to the worker instead.
  const args = sessionId
    ? [...common, 'exec', 'resume', sessionId, '-c', 'model_reasoning_effort="high"',
        '--json', '--skip-git-repo-check',
        '--output-schema', SUBMISSION_SCHEMA, '-o', outputPath]
    : [...common, 'exec', '-c', 'model_reasoning_effort="high"', '--json', '--skip-git-repo-check',
        '--output-schema', SUBMISSION_SCHEMA, '-o', outputPath]
  if (model) args.push('--model', model)
  args.push('-')
  let capturedSession = sessionId ?? null
  const result = await runProcess({
    command: bin,
    args,
    cwd: root,
    input: prompt,
    timeoutMs,
    onStdoutLine: line => {
      const event = parseMaybeJson(line)
      if (event?.type === 'thread.started' && event.thread_id) {
        capturedSession = event.thread_id
        onSessionId?.(capturedSession)
      }
    },
  })
  const logs = await writeRawLogs(runDir, label, result)
  if (result.code !== 0 || result.timed_out || result.output_overflow) {
    const diagnostic = result.stderr.trim()
      ? `stderr: ${result.stderr.slice(-4000)}`
      : `stdout: ${result.stdout.slice(-4000)}`
    const suffix = result.timed_out ? ' (turn timeout)' : result.output_overflow ? ' (engine log limit)' : ''
    throw new Error(`codex exec failed${suffix} (exit ${result.code ?? 'none'}, signal ${result.signal ?? 'none'}); ${diagnostic}`)
  }
  if (!existsSync(outputPath)) throw new Error('codex exec returned without an output-last-message file')
  const candidate = parseMaybeJson(await readFile(outputPath, 'utf8'))
  return { candidate: validateCandidate(candidate), session_id: capturedSession, logs }
}

const invokeClaude = async ({ root, prompt, sessionId, model, runDir, label, onSessionId, timeoutMs }) => {
  const bin = process.env.SALVO_CLAUDE_BIN || 'claude'
  const schema = await readFile(SUBMISSION_SCHEMA, 'utf8')
  const args = [
    '-p', '--output-format', 'json', '--json-schema', schema,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Write,Edit,Bash,Glob,Grep',
  ]
  if (sessionId) args.push('--resume', sessionId)
  if (model) args.push('--model', model)
  const result = await runProcess({ command: bin, args, cwd: root, input: prompt, timeoutMs })
  const logs = await writeRawLogs(runDir, label, result)
  if (result.code !== 0 || result.timed_out || result.output_overflow) {
    const diagnostic = result.stderr.trim()
      ? `stderr: ${result.stderr.slice(-4000)}`
      : `stdout: ${result.stdout.slice(-4000)}`
    const suffix = result.timed_out ? ' (turn timeout)' : result.output_overflow ? ' (engine log limit)' : ''
    throw new Error(`claude -p failed${suffix} (exit ${result.code ?? 'none'}, signal ${result.signal ?? 'none'}); ${diagnostic}`)
  }
  const envelope = parseMaybeJson(result.stdout)
  if (!envelope) throw new Error(`claude -p returned non-JSON output: ${result.stdout.slice(-2000)}`)
  const capturedSession = envelope.session_id ?? sessionId ?? null
  if (capturedSession) onSessionId?.(capturedSession)
  const candidate = parseMaybeJson(envelope.structured_output) ||
    parseMaybeJson(envelope.result) ||
    (envelope.status ? envelope : null)
  return { candidate: validateCandidate(candidate), session_id: capturedSession, logs }
}

export const invokeEngine = async options => {
  if (options.engine === 'codex') return invokeCodex(options)
  if (options.engine === 'claude') return invokeClaude(options)
  throw new Error(`unknown engine: ${options.engine}`)
}
