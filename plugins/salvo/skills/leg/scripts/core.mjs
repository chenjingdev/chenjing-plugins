import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import {
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  lstat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const PLAN_VERSION = 1
export const STATE_VERSION = 1

const MAX_LOG_BYTES = 8 * 1024 * 1024
const FORBIDDEN_GLOB = /[*?[\]{}]/

export const sha256 = value => createHash('sha256').update(value).digest('hex')

export const defaultStateRoot = () => process.env.SALVO_STATE_DIR ||
  (process.env.PLUGIN_DATA && path.join(process.env.PLUGIN_DATA, 'legs')) ||
  path.join(os.homedir(), '.local', 'state', 'salvo', 'legs')

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

const assertString = (value, label) => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
}

export const resolveWithin = (root, candidate, label = 'path') => {
  assertString(candidate, label)
  if (FORBIDDEN_GLOB.test(candidate)) throw new Error(`${label} must be an exact path, not a glob: ${candidate}`)
  const resolved = path.resolve(root, candidate)
  const relative = path.relative(root, resolved)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the project root: ${candidate}`)
  }
  return resolved
}

const isInside = (root, target) => {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

const physicalAnchor = async target => {
  let current = target
  while (true) {
    try {
      return await realpath(current)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

const assertPhysicalWithin = async (root, target, label) => {
  const [rootReal, targetAnchor] = await Promise.all([realpath(root), physicalAnchor(target)])
  if (!isInside(rootReal, targetAnchor)) throw new Error(`${label} resolves outside the project root`)
}

const normalizeCheck = (check, label) => {
  if (!isObject(check)) throw new Error(`${label} must be an object`)
  assertString(check.name, `${label}.name`)
  if (!Array.isArray(check.argv) || check.argv.length === 0 || check.argv.some(x => typeof x !== 'string' || x === '')) {
    throw new Error(`${label}.argv must be a non-empty string array`)
  }
  const timeout = check.timeout_ms ?? 120000
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 3600000) {
    throw new Error(`${label}.timeout_ms must be an integer from 100 to 3600000`)
  }
  if (check.cwd !== undefined) assertString(check.cwd, `${label}.cwd`)
  let programIndex = 0
  let program = path.basename(check.argv[programIndex]).toLowerCase().replace(/\.exe$/, '')
  if (program === 'env') {
    programIndex++
    while (programIndex < check.argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(check.argv[programIndex])) programIndex++
    program = path.basename(check.argv[programIndex] ?? '').toLowerCase().replace(/\.exe$/, '')
  }
  if (program === 'busybox') {
    programIndex++
    program = path.basename(check.argv[programIndex] ?? '').toLowerCase().replace(/\.exe$/, '')
  }
  const programArgs = check.argv.slice(programIndex + 1).map(arg => arg.toLowerCase())
  const usesCommandString = programArgs.some(arg =>
    arg === '/c' || arg === '-command' || arg === '-commandwithargs' || /^-[a-z]*c[a-z]*$/.test(arg))
  if (['sh', 'bash', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh'].includes(program) && usesCommandString) {
    throw new Error(`${label}.argv must not invoke a shell command string; use an executable plus literal argv`)
  }
  return {
    name: check.name.trim(),
    argv: [...check.argv],
    cwd: check.cwd ?? '.',
    timeout_ms: timeout,
  }
}

const normalizeTask = (task, index) => {
  const label = `tasks[${index}]`
  if (!isObject(task)) throw new Error(`${label} must be an object`)
  if (!Number.isInteger(task.id) || task.id < 1) throw new Error(`${label}.id must be a positive integer`)
  assertString(task.title, `${label}.title`)
  assertString(task.instructions, `${label}.instructions`)
  if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) {
    throw new Error(`${label}.acceptance must contain at least one criterion`)
  }
  task.acceptance.forEach((item, i) => assertString(item, `${label}.acceptance[${i}]`))
  if (!Array.isArray(task.artifacts) || task.artifacts.length === 0) {
    throw new Error(`${label}.artifacts must contain at least one exact path`)
  }
  task.artifacts.forEach((item, i) => assertString(item, `${label}.artifacts[${i}]`))
  if (!Array.isArray(task.verify) || task.verify.length === 0) {
    throw new Error(`${label}.verify must contain at least one external verifier`)
  }
  const maxAttempts = task.max_attempts ?? 3
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error(`${label}.max_attempts must be an integer from 1 to 10`)
  }
  if (task.require_change !== undefined && typeof task.require_change !== 'boolean') {
    throw new Error(`${label}.require_change must be boolean`)
  }
  return {
    id: task.id,
    title: task.title.trim(),
    instructions: task.instructions.trim(),
    acceptance: task.acceptance.map(x => x.trim()),
    artifacts: [...new Set(task.artifacts)],
    verify: task.verify.map((check, i) => normalizeCheck(check, `${label}.verify[${i}]`)),
    require_change: task.require_change ?? true,
    max_attempts: maxAttempts,
  }
}

export const validatePlan = (plan, { planPath = path.resolve('plan.json'), from, to } = {}) => {
  if (!isObject(plan)) throw new Error('plan must be an object')
  if (plan.version !== PLAN_VERSION) throw new Error(`plan.version must be ${PLAN_VERSION}`)
  assertString(plan.objective, 'plan.objective')
  if (plan.root !== undefined) assertString(plan.root, 'plan.root')
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) throw new Error('plan.tasks must not be empty')
  const tasks = plan.tasks.map(normalizeTask).sort((a, b) => a.id - b.id)
  const ids = tasks.map(task => task.id)
  if (new Set(ids).size !== ids.length) throw new Error('task ids must be unique')
  if (!Array.isArray(plan.final_verify) || plan.final_verify.length === 0) {
    throw new Error('plan.final_verify must contain at least one range-level regression check')
  }
  const finalVerify = plan.final_verify.map((check, i) => normalizeCheck(check, `final_verify[${i}]`))
  const protectedPaths = plan.protected ?? []
  if (!Array.isArray(protectedPaths) || protectedPaths.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error('plan.protected must be an array of exact paths')
  }
  const first = from ?? ids[0]
  const last = to ?? ids.at(-1)
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || first > last) {
    throw new Error('range must be positive integers with from <= to')
  }
  for (let id = first; id <= last; id++) {
    if (!ids.includes(id)) throw new Error(`selected range is missing task ${id}`)
  }
  const selected = tasks.filter(task => task.id >= first && task.id <= last)
  const root = path.resolve(path.dirname(planPath), plan.root ?? '.')
  if (!existsSync(root)) throw new Error(`project root does not exist: ${root}`)
  if (!statSync(root).isDirectory()) throw new Error(`project root is not a directory: ${root}`)
  for (const task of selected) {
    for (const artifact of task.artifacts) resolveWithin(root, artifact, `task ${task.id} artifact`)
    for (const check of task.verify) resolveWithin(root, check.cwd, `task ${task.id} verifier cwd`)
  }
  for (const check of finalVerify) resolveWithin(root, check.cwd, 'final verifier cwd')
  for (const protectedPath of protectedPaths) resolveWithin(root, protectedPath, 'protected path')
  return {
    version: PLAN_VERSION,
    objective: plan.objective.trim(),
    root,
    range: { from: first, to: last },
    tasks: selected,
    final_verify: finalVerify,
    protected: [...new Set(protectedPaths)],
  }
}

export const loadPlan = async (planPath, range = {}) => {
  const absolute = path.resolve(planPath)
  const raw = await readFile(absolute, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`cannot parse plan JSON: ${error.message}`)
  }
  return { plan: validatePlan(parsed, { planPath: absolute, ...range }), raw, planPath: absolute }
}

const timestampId = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

export const createRun = async ({
  plan,
  rawPlan,
  planPath,
  engine,
  model = null,
  turnTimeoutMs = 1800000,
  stateRoot = defaultStateRoot(),
}) => {
  if (!['codex', 'claude'].includes(engine)) throw new Error('engine must be codex or claude')
  if (!Number.isInteger(turnTimeoutMs) || turnTimeoutMs < 10000 || turnTimeoutMs > 14400000) {
    throw new Error('turnTimeoutMs must be an integer from 10000 to 14400000')
  }
  const stateInput = path.resolve(stateRoot)
  const lexicalStateRelative = path.relative(path.resolve(plan.root), stateInput)
  if (lexicalStateRelative === '' || (!lexicalStateRelative.startsWith(`..${path.sep}`) && lexicalStateRelative !== '..' && !path.isAbsolute(lexicalStateRelative))) {
    throw new Error('state root must be outside the project root so workers cannot edit the authoritative ledger')
  }
  await mkdir(stateInput, { recursive: true })
  const [projectReal, stateBase] = await Promise.all([realpath(plan.root), realpath(stateInput)])
  const stateRelative = path.relative(projectReal, stateBase)
  if (stateRelative === '' || (!stateRelative.startsWith(`..${path.sep}`) && stateRelative !== '..' && !path.isAbsolute(stateRelative))) {
    throw new Error('state root must be outside the project root so workers cannot edit the authoritative ledger')
  }
  const runId = `${timestampId()}-${randomUUID().slice(0, 8)}`
  const runDir = path.join(stateBase, runId)
  await mkdir(path.join(runDir, 'evidence'), { recursive: true })
  const now = new Date().toISOString()
  const protectedBaseline = await snapshotArtifacts(plan.root, plan.protected)
  const state = {
    version: STATE_VERSION,
    run_id: runId,
    state_path: path.join(runDir, 'state.json'),
    run_dir: runDir,
    created_at: now,
    updated_at: now,
    status: 'active',
    phase: 'tasks',
    objective: plan.objective,
    project_root: plan.root,
    plan_path: planPath,
    plan_sha256: sha256(rawPlan),
    range: plan.range,
    engine: { provider: engine, model, turn_timeout_ms: turnTimeoutMs },
    cursor: 0,
    tasks: plan.tasks.map(task => ({
      ...task,
      status: 'pending',
      baseline: null,
      passed_snapshot: null,
      session_id: null,
      active_taint: null,
      pending_blocker: null,
      attempts: [],
      summary: null,
      blocked_reason: null,
    })),
    final_verify: plan.final_verify,
    protected: plan.protected,
    protected_baseline: protectedBaseline,
    final_receipt: null,
    final_attempts: [],
    active_final_taint: null,
    blocked_reason: null,
  }
  await writeState(state)
  return state
}

export const writeState = async state => {
  state.updated_at = new Date().toISOString()
  await mkdir(path.dirname(state.state_path), { recursive: true })
  const temp = `${state.state_path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temp, state.state_path)
}

export const readState = async statePath => {
  const absolute = path.resolve(statePath)
  const parsed = JSON.parse(await readFile(absolute, 'utf8'))
  if (parsed.version !== STATE_VERSION || parsed.state_path !== absolute) {
    throw new Error(`invalid or moved state file: ${absolute}`)
  }
  return parsed
}

export const resolveStatePath = async (value, stateRoot = defaultStateRoot()) => {
  const direct = path.resolve(value)
  if (existsSync(direct)) return direct
  const byId = path.join(path.resolve(stateRoot), value, 'state.json')
  if (existsSync(byId)) return byId
  throw new Error(`run state not found: ${value}`)
}

const hashPath = async target => {
  let info
  try {
    info = await lstat(target)
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, kind: 'missing', sha256: null }
    throw error
  }
  if (info.isSymbolicLink()) {
    const link = await readlink(target)
    return { exists: true, kind: 'symlink', sha256: sha256(`symlink\0${link}`) }
  }
  if (info.isFile()) {
    return { exists: true, kind: 'file', sha256: sha256(await readFile(target)) }
  }
  if (info.isDirectory()) {
    const entries = (await readdir(target)).sort()
    const parts = []
    for (const entry of entries) {
      const child = await hashPath(path.join(target, entry))
      parts.push(`${entry}\0${child.kind}\0${child.sha256 ?? ''}`)
    }
    return { exists: true, kind: 'directory', sha256: sha256(parts.join('\n')) }
  }
  return { exists: true, kind: 'other', sha256: sha256(`${info.mode}:${info.size}`) }
}

export const snapshotArtifacts = async (root, artifacts) => {
  const snapshot = {}
  for (const artifact of artifacts) {
    const target = resolveWithin(root, artifact, 'artifact')
    await assertPhysicalWithin(root, target, `artifact ${artifact}`)
    snapshot[artifact] = await hashPath(target)
  }
  return snapshot
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
    } else {
      child.kill()
    }
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

const runCheck = async (root, check) => {
  const cwd = resolveWithin(root, check.cwd, `verifier ${check.name} cwd`)
  await assertPhysicalWithin(root, cwd, `verifier ${check.name} cwd`)
  const started = new Date().toISOString()
  const result = await new Promise(resolve => {
    const child = spawn(check.argv[0], check.argv.slice(1), {
      cwd,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let outputOverflow = false
    let spawnError = null
    let settled = false
    let hardTimer = null
    const timer = setTimeout(() => {
      timedOut = true
      terminateTree(child, 'SIGTERM')
      hardTimer = setTimeout(() => terminateTree(child, 'SIGKILL'), 2000)
      hardTimer.unref()
    }, check.timeout_ms)
    timer.unref()
    const append = (stream, chunk) => {
      const next = stream === 'stdout' ? stdout + chunk : stderr + chunk
      if (stream === 'stdout') stdout = next.slice(0, MAX_LOG_BYTES)
      else stderr = next.slice(0, MAX_LOG_BYTES)
      if (next.length > MAX_LOG_BYTES && !outputOverflow) {
        outputOverflow = true
        terminateTree(child, 'SIGTERM')
        hardTimer = setTimeout(() => terminateTree(child, 'SIGKILL'), 2000)
        hardTimer.unref()
      }
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => append('stdout', chunk))
    child.stderr.on('data', chunk => append('stderr', chunk))
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (hardTimer) clearTimeout(hardTimer)
      const error = spawnError ||
        (timedOut ? `TimeoutError: verifier exceeded ${check.timeout_ms}ms` : null) ||
        (outputOverflow ? `OutputLimitError: verifier exceeded ${MAX_LOG_BYTES} characters` : null)
      resolve({ code, signal, stdout, stderr, error, timedOut, outputOverflow })
    }
    child.on('error', error => {
      spawnError = `${error.name}: ${error.message}`
      finish(null, null)
    })
    child.on('close', finish)
  })
  const exitCode = Number.isInteger(result.code) ? result.code : null
  return {
    name: check.name,
    argv: check.argv,
    cwd: check.cwd,
    timeout_ms: check.timeout_ms,
    started_at: started,
    finished_at: new Date().toISOString(),
    exit_code: exitCode,
    signal: result.signal ?? null,
    error: result.error,
    timed_out: result.timedOut,
    output_overflow: result.outputOverflow,
    stdout: result.stdout,
    stderr: result.stderr,
    stdout_sha256: sha256(result.stdout),
    stderr_sha256: sha256(result.stderr),
    passed: exitCode === 0 && result.error === null,
  }
}

const safeLabel = value => String(value).replace(/[^a-zA-Z0-9_.-]/g, '_')

const writeReceipt = async (runDir, label, receipt) => {
  const evidenceDir = path.join(runDir, 'evidence')
  await mkdir(evidenceDir, { recursive: true })
  const base = safeLabel(label)
  for (let i = 0; i < receipt.checks.length; i++) {
    const check = receipt.checks[i]
    const stdoutPath = path.join(evidenceDir, `${base}-check-${i + 1}.stdout.log`)
    const stderrPath = path.join(evidenceDir, `${base}-check-${i + 1}.stderr.log`)
    await writeFile(stdoutPath, check.stdout, 'utf8')
    await writeFile(stderrPath, check.stderr, 'utf8')
    check.stdout_log = stdoutPath
    check.stderr_log = stderrPath
    delete check.stdout
    delete check.stderr
  }
  const receiptPath = path.join(evidenceDir, `${base}.json`)
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  return receiptPath
}

export const diffSnapshots = (before, after) => [...new Set([
  ...Object.keys(before ?? {}),
  ...Object.keys(after ?? {}),
])].filter(key =>
  before?.[key]?.sha256 !== after?.[key]?.sha256 ||
  before?.[key]?.exists !== after?.[key]?.exists ||
  before?.[key]?.kind !== after?.[key]?.kind)

const runTrackedChecks = async ({ root, checks: definitions, artifacts, protectedPaths, artifactStart, protectedStart }) => {
  const checks = []
  let artifactCheckpoint = artifactStart
  let protectedCheckpoint = protectedStart
  const artifactMutations = new Set()
  const protectedMutations = new Set()
  for (const definition of definitions) {
    const check = await runCheck(root, definition)
    const nextArtifacts = await snapshotArtifacts(root, artifacts)
    const nextProtected = await snapshotArtifacts(root, protectedPaths)
    check.mutated_artifacts = diffSnapshots(artifactCheckpoint, nextArtifacts)
    check.mutated_protected_paths = diffSnapshots(protectedCheckpoint, nextProtected)
    check.mutated_artifacts.forEach(item => artifactMutations.add(item))
    check.mutated_protected_paths.forEach(item => protectedMutations.add(item))
    checks.push(check)
    artifactCheckpoint = nextArtifacts
    protectedCheckpoint = nextProtected
  }
  return {
    checks,
    artifacts: artifactCheckpoint,
    protected: protectedCheckpoint,
    artifact_mutations: [...artifactMutations],
    protected_mutations: [...protectedMutations],
  }
}

export const verifyTask = async ({ state, task, attemptNumber }) => {
  const afterWorker = await snapshotArtifacts(state.project_root, task.artifacts)
  const missing = Object.entries(afterWorker).filter(([, value]) => !value.exists).map(([key]) => key)
  const symlinks = Object.entries(afterWorker).filter(([, value]) => value.kind === 'symlink').map(([key]) => key)
  const changed = diffSnapshots(task.baseline, afterWorker)
  const protectedBefore = await snapshotArtifacts(state.project_root, state.protected ?? [])
  const tracked = await runTrackedChecks({
    root: state.project_root,
    checks: task.verify,
    artifacts: task.artifacts,
    protectedPaths: state.protected ?? [],
    artifactStart: afterWorker,
    protectedStart: protectedBefore,
  })
  const checks = tracked.checks
  const afterChecks = tracked.artifacts
  const protectedAfter = tracked.protected
  const verifierMutations = tracked.artifact_mutations
  const verifierProtectedMutations = tracked.protected_mutations
  const protectedMutations = diffSnapshots(state.protected_baseline ?? {}, protectedAfter)
  const tainted = verifierMutations.length > 0 || verifierProtectedMutations.length > 0
  const passed = missing.length === 0 && checks.every(check => check.passed) &&
    symlinks.length === 0 && (!task.require_change || changed.length > 0) &&
    !tainted && protectedMutations.length === 0
  const receipt = {
    kind: 'task-verification',
    run_id: state.run_id,
    task_id: task.id,
    attempt: attemptNumber,
    plan_sha256: state.plan_sha256,
    verified_at: new Date().toISOString(),
    baseline: task.baseline,
    artifacts_before_checks: afterWorker,
    artifacts: afterChecks,
    changed_artifacts: changed,
    missing_artifacts: missing,
    symlink_artifacts: symlinks,
    verifier_mutated_artifacts: verifierMutations,
    verifier_mutated_protected_paths: verifierProtectedMutations,
    protected_before_checks: protectedBefore,
    protected_artifacts: protectedAfter,
    protected_mutations: protectedMutations,
    tainted,
    restore_snapshot: afterWorker,
    protected_restore_snapshot: state.protected_baseline ?? {},
    require_change: task.require_change,
    checks,
    passed,
  }
  const receiptPath = await writeReceipt(state.run_dir, `task-${task.id}-attempt-${attemptNumber}`, receipt)
  const failed = [
    ...missing.map(item => `missing artifact: ${item}`),
    ...symlinks.map(item => `declared artifact must not be a symlink: ${item}`),
    ...(task.require_change && changed.length === 0 ? ['no declared artifact changed from the frozen baseline'] : []),
    ...verifierMutations.map(item => `verifier mutated declared artifact: ${item}`),
    ...verifierProtectedMutations.map(item => `verifier mutated protected path: ${item}`),
    ...protectedMutations.map(item => `protected path changed: ${item}`),
    ...checks.filter(check => !check.passed).map(check =>
      `${check.name}: exit=${check.exit_code ?? 'none'}${check.error ? ` ${check.error}` : ''}`),
  ]
  return {
    passed,
    receipt_path: receiptPath,
    artifact_snapshot: afterChecks,
    changed_artifacts: changed,
    tainted,
    restore_snapshot: afterWorker,
    protected_restore_snapshot: state.protected_baseline ?? {},
    failed,
    failure_signature: passed ? null : sha256(JSON.stringify({ artifacts: afterChecks, failed })),
    checks: checks.map(check => ({
      name: check.name,
      passed: check.passed,
      exit_code: check.exit_code,
      error: check.error,
      mutated_artifacts: check.mutated_artifacts,
      mutated_protected_paths: check.mutated_protected_paths,
      stdout_log: check.stdout_log,
      stderr_log: check.stderr_log,
    })),
  }
}

export const verifyRange = async (state, { attemptNumber = 1 } = {}) => {
  const artifacts = [...new Set(state.tasks.flatMap(task => task.artifacts))]
  const beforeChecks = await snapshotArtifacts(state.project_root, artifacts)
  const missing = Object.entries(beforeChecks).filter(([, value]) => !value.exists).map(([key]) => key)
  const symlinks = Object.entries(beforeChecks).filter(([, value]) => value.kind === 'symlink').map(([key]) => key)
  const definitions = []
  for (const task of state.tasks) {
    for (const check of task.verify) definitions.push({ ...check, name: `task ${task.id}: ${check.name}` })
  }
  for (const check of state.final_verify) definitions.push({ ...check, name: `final: ${check.name}` })
  const protectedBefore = await snapshotArtifacts(state.project_root, state.protected ?? [])
  const tracked = await runTrackedChecks({
    root: state.project_root,
    checks: definitions,
    artifacts,
    protectedPaths: state.protected ?? [],
    artifactStart: beforeChecks,
    protectedStart: protectedBefore,
  })
  const checks = tracked.checks
  const current = tracked.artifacts
  const protectedAfter = tracked.protected
  const verifierMutations = tracked.artifact_mutations
  const verifierProtectedMutations = tracked.protected_mutations
  const protectedMutations = diffSnapshots(state.protected_baseline ?? {}, protectedAfter)
  const tainted = verifierMutations.length > 0 || verifierProtectedMutations.length > 0
  const changedSincePass = {}
  for (const task of state.tasks) {
    changedSincePass[task.id] = diffSnapshots(task.passed_snapshot, current)
      .filter(item => task.artifacts.includes(item))
  }
  const passed = missing.length === 0 && symlinks.length === 0 && checks.every(check => check.passed) &&
    !tainted && protectedMutations.length === 0
  const receipt = {
    kind: 'range-verification',
    run_id: state.run_id,
    attempt: attemptNumber,
    plan_sha256: state.plan_sha256,
    range: state.range,
    verified_at: new Date().toISOString(),
    artifacts: current,
    missing_artifacts: missing,
    symlink_artifacts: symlinks,
    verifier_mutated_artifacts: verifierMutations,
    verifier_mutated_protected_paths: verifierProtectedMutations,
    protected_before_checks: protectedBefore,
    protected_artifacts: protectedAfter,
    protected_mutations: protectedMutations,
    tainted,
    restore_snapshot: beforeChecks,
    protected_restore_snapshot: state.protected_baseline ?? {},
    changed_since_task_pass: changedSincePass,
    checks,
    passed,
  }
  const receiptPath = await writeReceipt(state.run_dir, `range-final-attempt-${attemptNumber}`, receipt)
  return {
    passed,
    receipt_path: receiptPath,
    attempt: attemptNumber,
    tainted,
    restore_snapshot: beforeChecks,
    protected_restore_snapshot: state.protected_baseline ?? {},
    failed: [
      ...missing.map(item => `missing artifact: ${item}`),
      ...symlinks.map(item => `declared artifact must not be a symlink: ${item}`),
      ...verifierMutations.map(item => `verifier mutated declared artifact: ${item}`),
      ...verifierProtectedMutations.map(item => `verifier mutated protected path: ${item}`),
      ...protectedMutations.map(item => `protected path changed: ${item}`),
      ...checks.filter(check => !check.passed).map(check =>
        `${check.name}: exit=${check.exit_code ?? 'none'}${check.error ? ` ${check.error}` : ''}`),
    ],
  }
}

const renderCommands = task => task.verify.map(check =>
  `- ${check.name}: ${JSON.stringify(check.argv)} (cwd ${check.cwd})`).join('\n')

export const buildTaskPrompt = ({ state, task, feedback = null, fresh = false }) => {
  const completed = state.tasks.filter(item => item.status === 'passed').map(item =>
    `- Task ${item.id}: ${item.title} — ${item.summary}`).join('\n') || '- none'
  const retry = feedback ? `\n## Authoritative verifier feedback\n\n${feedback}\n` : ''
  const resumeNote = state.resume_note ? `\n## User/controller resume note\n\n${state.resume_note}\n` : ''
  const blockerChallenge = task.pending_blocker ? `
## Unconfirmed blocker claim from another worker

Another fresh worker claimed it needed: ${task.pending_blocker.needs_user.join('; ') || task.pending_blocker.summary}
Independently inspect the workspace and try a different approach. Repeat status "blocked" only if the need is truly user-only and state the same concrete need in needs_user.
` : ''
  return `# Salvo leg task ${task.id} of ${state.range.from}..${state.range.to}

You are the executor for exactly one frozen task. Work in the existing project at ${state.project_root}.
Do not renumber tasks, expand scope, modify Salvo's external ledger, or claim that your own checks are authoritative.
Your final response is only a candidate submission. A controller outside your session reruns every verifier and is the only component allowed to mark the task passed.
${fresh ? 'This is a fresh-context recovery attempt. Re-inspect the workspace instead of trusting a previous approach.\n' : ''}
## Leg objective

${state.objective}

## Previously passed tasks

${completed}

## Current task

**${task.id}. ${task.title}**

${task.instructions}

## Acceptance criteria

${task.acceptance.map(item => `- ${item}`).join('\n')}

## Declared evidence surface

Artifacts that must exist${task.require_change ? ' and at least one must change from the task baseline' : ''}:
${task.artifacts.map(item => `- ${item}`).join('\n')}

External verifiers the controller will rerun with shell disabled:
${renderCommands(task)}
${retry}
${resumeNote}
${blockerChallenge}
## Working rules

1. Inspect relevant files before editing.
2. Implement the task fully and run useful checks yourself.
3. Do not edit unrelated user changes or commit unless the task explicitly says to.
4. If a user-only product decision or missing authority makes completion impossible, return status "blocked" and state the exact need in needs_user.
5. Otherwise return status "candidate". Never use "passed" or "done" as a status; only the controller can pass the task.
`
}

export const readVerificationFeedback = receiptPath => {
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    const lines = []
    if (receipt.missing_artifacts?.length) lines.push(`Missing artifacts: ${receipt.missing_artifacts.join(', ')}`)
    if (receipt.require_change && receipt.changed_artifacts?.length === 0) {
      lines.push('None of the declared artifacts changed from the frozen task baseline.')
    }
    if (receipt.verifier_mutated_artifacts?.length) {
      lines.push(`Verifier commands mutated declared artifacts (checks must be read-only): ${receipt.verifier_mutated_artifacts.join(', ')}`)
    }
    if (receipt.protected_mutations?.length) {
      lines.push(`Protected acceptance paths changed and must be restored: ${receipt.protected_mutations.join(', ')}`)
    }
    for (const check of receipt.checks?.filter(item => !item.passed) ?? []) {
      lines.push(`${check.name} failed (exit ${check.exit_code ?? 'none'}).`)
      const stderr = check.stderr_log && existsSync(check.stderr_log) ? readFileSync(check.stderr_log, 'utf8') : ''
      const stdout = check.stdout_log && existsSync(check.stdout_log) ? readFileSync(check.stdout_log, 'utf8') : ''
      const excerpt = (stderr || stdout).slice(-4000)
      if (excerpt) lines.push(`Last output:\n${excerpt}`)
    }
    return lines.join('\n\n') || 'The external verifier rejected the candidate without additional output.'
  } catch (error) {
    return `Could not read verifier receipt: ${error.message}`
  }
}

export const summarizeState = state => ({
  run_id: state.run_id,
  status: state.status,
  phase: state.phase,
  objective: state.objective,
  range: state.range,
  engine: state.engine,
  tasks: state.tasks.map(task => {
    const last = task.attempts.at(-1) ?? null
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      attempts: task.attempts.length,
      summary: task.summary,
      blocked_reason: task.blocked_reason,
      last_attempt: last ? {
        number: last.number,
        status: last.status,
        engine_error: last.engine_error,
        engine_logs: last.engine_logs,
        receipt_path: last.verification?.receipt_path ?? null,
        verification_failed: last.verification?.failed ?? null,
        controller_error: last.verification?.controller_error ?? null,
        tainted: last.verification?.tainted ?? false,
      } : null,
    }
  }),
  final_receipt: state.final_receipt,
  final_attempt_count: state.final_attempts?.length ?? 0,
  blocked_reason: state.blocked_reason,
  state_path: state.state_path,
})
