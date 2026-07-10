import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { invokeEngine } from '../skills/leg/scripts/adapters.mjs'

const tempRoot = () => mkdtemp(path.join(os.tmpdir(), 'salvo-adapter-'))

const makeExecutable = async (file, source) => {
  await writeFile(file, `#!/usr/bin/env node\n${source}`, 'utf8')
  await chmod(file, 0o755)
}

const expected = {
  status: 'candidate',
  summary: 'fake candidate',
  changed_files: ['x.txt'],
  checks_run: [],
  needs_user: [],
}

test('codex adapter uses structured output, captures thread id, and passes model only when named', async () => {
  const root = await tempRoot()
  const bin = path.join(root, 'fake-codex')
  const argsLog = path.join(root, 'args.json')
  const stdinLog = path.join(root, 'stdin.txt')
  await makeExecutable(bin, `
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
writeFileSync(process.env.FAKE_ARGS_LOG, JSON.stringify(args))
writeFileSync(process.env.FAKE_STDIN_LOG, readFileSync(0, 'utf8'))
const out = args[args.indexOf('-o') + 1]
writeFileSync(out, JSON.stringify(${JSON.stringify(expected)}))
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread' }) + '\\n')
`)
  const old = { ...process.env }
  process.env.SALVO_CODEX_BIN = bin
  process.env.FAKE_ARGS_LOG = argsLog
  process.env.FAKE_STDIN_LOG = stdinLog
  try {
    const result = await invokeEngine({
      engine: 'codex', root, prompt: 'do the task', sessionId: null, model: 'gpt-test',
      runDir: root, label: 'codex-test',
    })
    assert.deepEqual(result.candidate, expected)
    assert.equal(result.session_id, 'codex-thread')
    const args = JSON.parse(await readFile(argsLog, 'utf8'))
    assert.deepEqual(args.slice(0, 7), [
      '--ask-for-approval', 'never', '--sandbox', 'workspace-write', '-C', root, 'exec',
    ])
    assert.ok(args.includes('--skip-git-repo-check'))
    assert.deepEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), ['-c', 'model_reasoning_effort="high"'])
    assert.ok(args.includes('--output-schema'))
    assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'gpt-test'])
    assert.equal(await readFile(stdinLog, 'utf8'), 'do the task')
  } finally {
    process.env = old
  }
})

test('claude adapter normalizes structured_output and captures session id', async () => {
  const root = await tempRoot()
  const bin = path.join(root, 'fake-claude')
  const argsLog = path.join(root, 'args.json')
  await makeExecutable(bin, `
import { readFileSync, writeFileSync } from 'node:fs'
writeFileSync(process.env.FAKE_ARGS_LOG, JSON.stringify(process.argv.slice(2)))
readFileSync(0, 'utf8')
process.stdout.write(JSON.stringify({ session_id: 'claude-session', structured_output: ${JSON.stringify(expected)} }))
`)
  const old = { ...process.env }
  process.env.SALVO_CLAUDE_BIN = bin
  process.env.FAKE_ARGS_LOG = argsLog
  try {
    const result = await invokeEngine({
      engine: 'claude', root, prompt: 'do the task', sessionId: null, model: null,
      runDir: root, label: 'claude-test',
    })
    assert.deepEqual(result.candidate, expected)
    assert.equal(result.session_id, 'claude-session')
    const args = JSON.parse(await readFile(argsLog, 'utf8'))
    assert.ok(args.includes('--json-schema'))
    assert.ok(args.includes('acceptEdits'))
    assert.ok(args.includes('Read,Write,Edit,Bash,Glob,Grep'))
    assert.equal(args.includes('--model'), false)
  } finally {
    process.env = old
  }
})

test('provider failure is fail-closed instead of becoming a candidate', async () => {
  const root = await tempRoot()
  const bin = path.join(root, 'fake-fail')
  await makeExecutable(bin, `process.stderr.write('boom'); process.exit(7)\n`)
  const old = process.env.SALVO_CODEX_BIN
  process.env.SALVO_CODEX_BIN = bin
  try {
    await assert.rejects(() => invokeEngine({
      engine: 'codex', root, prompt: 'x', sessionId: null, model: null,
      runDir: root, label: 'fail-test',
    }), /exit 7/)
  } finally {
    if (old === undefined) delete process.env.SALVO_CODEX_BIN
    else process.env.SALVO_CODEX_BIN = old
  }
})

test('a headless engine that ignores SIGTERM is hard-stopped at the turn timeout', async () => {
  const root = await tempRoot()
  const bin = path.join(root, 'fake-hang')
  await makeExecutable(bin, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\n`)
  const old = process.env.SALVO_CODEX_BIN
  process.env.SALVO_CODEX_BIN = bin
  const started = Date.now()
  try {
    await assert.rejects(() => invokeEngine({
      engine: 'codex', root, prompt: 'x', sessionId: null, model: null,
      runDir: root, label: 'timeout-test', timeoutMs: 100,
    }), /turn timeout/)
    assert.ok(Date.now() - started < 5000)
  } finally {
    if (old === undefined) delete process.env.SALVO_CODEX_BIN
    else process.env.SALVO_CODEX_BIN = old
  }
})
