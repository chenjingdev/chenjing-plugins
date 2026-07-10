import {
  buildTaskPrompt,
  diffSnapshots,
  readState,
  readVerificationFeedback,
  snapshotArtifacts,
  verifyRange,
  verifyTask,
  writeState,
} from './core.mjs'
import { invokeEngine } from './adapters.mjs'

const now = () => new Date().toISOString()

const logDefault = message => process.stderr.write(`[salvo leg] ${message}\n`)

const lastRejectedAttempt = task => [...task.attempts].reverse().find(attempt => attempt.verification && !attempt.verification.passed)

const markInterruptedAttempt = task => {
  const attempt = task.attempts.at(-1)
  if (!attempt || attempt.status !== 'running') return
  attempt.finished_at = now()
  attempt.status = 'controller_interrupted'
  attempt.engine_error = 'controller resumed while the task was still marked running; no pass was inferred'
  attempt.verification = null
}

const invokeTask = async ({ state, task, invoke, log }) => {
  if (!task.baseline) {
    task.baseline = await snapshotArtifacts(state.project_root, task.artifacts)
    await writeState(state)
  }
  if (task.status === 'running') {
    markInterruptedAttempt(task)
    task.session_id = null
  }
  if (task.attempts.length >= task.max_attempts) {
    task.status = 'blocked'
    task.blocked_reason = `attempt budget exhausted after ${task.attempts.length} attempt(s)`
    state.status = 'blocked'
    state.blocked_reason = `task ${task.id}: ${task.blocked_reason}`
    await writeState(state)
    return null
  }
  const previous = lastRejectedAttempt(task)
  const sameFailure = previous && task.attempts.filter(attempt =>
    attempt.verification?.failure_signature === previous.verification.failure_signature).length >= 2
  if (sameFailure) task.session_id = null
  const feedback = previous ? readVerificationFeedback(previous.verification.receipt_path) : null
  const attemptNumber = task.attempts.length + 1
  const attempt = {
    number: attemptNumber,
    started_at: now(),
    finished_at: null,
    status: 'running',
    session_id: task.session_id,
    fresh_context: !task.session_id,
    candidate: null,
    engine_error: null,
    engine_logs: null,
    verification: null,
  }
  task.status = 'running'
  task.attempts.push(attempt)
  await writeState(state)
  log(`task ${task.id}/${state.range.to}: ${task.title} — attempt ${attemptNumber}/${task.max_attempts}${task.session_id ? ' (resume)' : ' (fresh)'}`)
  const prompt = buildTaskPrompt({ state, task, feedback, fresh: !task.session_id })
  try {
    const result = await invoke({
      engine: state.engine.provider,
      root: state.project_root,
      prompt,
      sessionId: task.session_id,
      model: state.engine.model,
      timeoutMs: state.engine.turn_timeout_ms,
      runDir: state.run_dir,
      label: `task-${task.id}-attempt-${attemptNumber}`,
      onSessionId: sessionId => { task.session_id = sessionId },
    })
    task.session_id = result.session_id ?? task.session_id
    attempt.session_id = task.session_id
    attempt.candidate = result.candidate
    attempt.engine_logs = result.logs ?? null
    attempt.finished_at = now()
    attempt.status = 'candidate'
    task.status = 'candidate'
    state.resume_note = null
    await writeState(state)
    return attempt
  } catch (error) {
    attempt.finished_at = now()
    attempt.status = 'engine_failed'
    attempt.engine_error = error.message
    task.session_id = null
    if (task.attempts.length >= task.max_attempts) {
      task.status = 'blocked'
      task.blocked_reason = `engine failed ${task.attempts.length} time(s): ${error.message}`
      state.status = 'blocked'
      state.blocked_reason = `task ${task.id}: ${task.blocked_reason}`
    } else {
      task.status = 'rework'
    }
    await writeState(state)
    log(`task ${task.id} engine failure: ${error.message}`)
    return null
  }
}

const evaluateCandidate = async ({ state, task, attempt, log }) => {
  if (attempt.candidate.status === 'blocked') {
    const needsUser = [...new Set(attempt.candidate.needs_user.map(item => item.trim()).filter(Boolean))].sort()
    const claim = {
      needs_user: needsUser,
      summary: attempt.candidate.summary,
      signature: JSON.stringify(needsUser),
    }
    const confirmed = needsUser.length > 0 && task.pending_blocker?.signature === claim.signature
    if (confirmed) {
      attempt.status = 'blocked_confirmed'
      task.status = 'blocked'
      task.blocked_reason = needsUser.join('; ')
      state.status = 'blocked'
      state.blocked_reason = `task ${task.id}: independently confirmed user input needed: ${task.blocked_reason}`
      await writeState(state)
      log(`task ${task.id} needs user input after fresh-context confirmation: ${task.blocked_reason}`)
      return false
    }
    attempt.status = 'blocker_unconfirmed'
    task.pending_blocker = claim
    task.session_id = null
    if (task.attempts.length >= task.max_attempts) {
      task.status = 'blocked'
      task.blocked_reason = needsUser.length
        ? `blocker was not independently confirmed before the attempt budget ended: ${needsUser.join('; ')}`
        : 'worker exhausted the attempt budget without a concrete user-only need'
      state.status = 'blocked'
      state.blocked_reason = `task ${task.id}: ${task.blocked_reason}`
    } else {
      task.status = 'rework'
    }
    await writeState(state)
    log(`task ${task.id} blocker claim requires a fresh-context confirmation`)
    return false
  }
  task.pending_blocker = null
  let verification
  try {
    verification = await verifyTask({ state, task, attemptNumber: attempt.number })
  } catch (error) {
    attempt.finished_at = now()
    attempt.status = 'controller_failed'
    attempt.verification = { passed: false, controller_error: error.message, tainted: false }
    task.status = 'blocked'
    task.blocked_reason = `controller verification error: ${error.message}`
    state.status = 'blocked'
    state.blocked_reason = `task ${task.id}: ${task.blocked_reason}`
    await writeState(state)
    log(task.blocked_reason)
    return false
  }
  attempt.verification = verification
  attempt.finished_at = now()
  if (verification.passed) {
    attempt.status = 'passed'
    task.status = 'passed'
    task.passed_snapshot = verification.artifact_snapshot
    task.summary = attempt.candidate.summary
    task.blocked_reason = null
    task.active_taint = null
    state.cursor += 1
    await writeState(state)
    log(`task ${task.id} passed external verification (${verification.receipt_path})`)
    return true
  }
  attempt.status = 'rejected'
  if (verification.tainted) {
    task.active_taint = verification
    task.status = 'blocked'
    task.blocked_reason = `controller verifier mutated the workspace (${verification.failed.join('; ')}); restore the receipt's frozen pre-check snapshot before retrying: ${verification.receipt_path}`
    state.status = 'blocked'
    state.blocked_reason = `task ${task.id}: ${task.blocked_reason}`
    await writeState(state)
    log(`task ${task.id} blocked because its verifier mutated the workspace (${verification.receipt_path})`)
    return false
  }
  task.active_taint = null
  const sameSignatureCount = task.attempts.filter(item =>
    item.verification?.failure_signature === verification.failure_signature).length
  if (sameSignatureCount >= 2) task.session_id = null
  if (task.attempts.length >= task.max_attempts) {
    task.status = 'blocked'
    task.blocked_reason = `external verification failed after ${task.attempts.length} attempt(s): ${verification.failed.join('; ')}`
    state.status = 'blocked'
    state.blocked_reason = `task ${task.id}: ${task.blocked_reason}`
  } else {
    task.status = 'rework'
  }
  await writeState(state)
  log(`task ${task.id} rejected by external verification: ${verification.failed.join('; ')}`)
  return false
}

const runFinalGate = async ({ state, log }) => {
  state.phase = 'final_verification'
  await writeState(state)
  log('running every selected task verifier again, then the range regression gate')
  const attemptNumber = (state.final_attempts ?? []).length + 1
  let receipt
  try {
    receipt = await verifyRange(state, { attemptNumber })
  } catch (error) {
    receipt = {
      passed: false,
      receipt_path: null,
      attempt: attemptNumber,
      tainted: false,
      controller_error: error.message,
      failed: [`controller verification error: ${error.message}`],
    }
  }
  state.final_attempts ??= []
  state.final_attempts.push(receipt)
  state.final_receipt = receipt
  state.active_final_taint = receipt.tainted ? receipt : null
  if (receipt.passed) {
    state.status = 'complete'
    state.phase = 'complete'
    state.blocked_reason = null
    await writeState(state)
    log(`range ${state.range.from}..${state.range.to} complete (${receipt.receipt_path})`)
    return true
  }
  state.status = 'blocked'
  state.phase = 'final_verification'
  state.blocked_reason = `final regression failed: ${receipt.failed.join('; ')}`
  await writeState(state)
  log(state.blocked_reason)
  return false
}

export const reopenBlocked = async (state, { note = null } = {}) => {
  if (state.status !== 'blocked') return { reopened: false, state }
  const currentTask = state.tasks[state.cursor]
  const taint = state.phase === 'final_verification'
    ? state.active_final_taint
    : currentTask?.active_taint
  if (taint?.tainted) {
    const artifacts = state.phase === 'final_verification'
      ? [...new Set(state.tasks.flatMap(task => task.artifacts))]
      : currentTask.artifacts
    const currentArtifacts = await snapshotArtifacts(state.project_root, artifacts)
    const currentProtected = await snapshotArtifacts(state.project_root, state.protected ?? [])
    const artifactDiff = diffSnapshots(taint.restore_snapshot ?? {}, currentArtifacts)
    const protectedDiff = diffSnapshots(taint.protected_restore_snapshot ?? {}, currentProtected)
    if (artifactDiff.length || protectedDiff.length) {
      state.blocked_reason = `workspace is still tainted by a verifier; restore artifacts [${artifactDiff.join(', ') || 'none'}] and protected paths [${protectedDiff.join(', ') || 'none'}] to the frozen pre-check snapshot before retrying`
      await writeState(state)
      return { reopened: false, state }
    }
    if (state.phase === 'final_verification') state.active_final_taint = null
    else currentTask.active_taint = null
  }

  state.status = 'active'
  state.blocked_reason = null
  if (state.phase === 'tasks') {
    if (currentTask) {
      currentTask.status = 'rework'
      currentTask.blocked_reason = null
      currentTask.session_id = null
      currentTask.pending_blocker = null
      currentTask.max_attempts = Math.min(currentTask.max_attempts + 1, 20)
    }
    state.resume_note = note
  } else if (state.phase === 'final_verification') {
    const failedTaskIds = (state.final_receipt?.failed ?? []).flatMap(item => {
      const match = /^task (\d+):/.exec(item)
      return match ? [Number(match[1])] : []
    })
    const repairIndex = failedTaskIds.length
      ? Math.max(0, state.tasks.findIndex(task => task.id === failedTaskIds[0]))
      : state.tasks.length - 1
    const task = state.tasks[repairIndex]
    state.phase = 'tasks'
    state.cursor = repairIndex
    task.status = 'rework'
    task.blocked_reason = null
    task.session_id = null
    task.max_attempts = Math.min(task.max_attempts + 1, 20)
    const finalFeedback = `Final range verification failed: ${(state.final_receipt?.failed ?? []).join('; ')}. Evidence: ${state.final_receipt?.receipt_path ?? 'unavailable'}`
    state.resume_note = [finalFeedback, note].filter(Boolean).join('\n\n')
  }
  await writeState(state)
  return { reopened: true, state }
}

export const drive = async (statePath, { invoke = invokeEngine, log = logDefault } = {}) => {
  const state = await readState(statePath)
  if (state.status === 'complete') return state
  if (state.status === 'blocked') return state
  if (state.phase === 'final_verification') {
    await runFinalGate({ state, log })
    return state
  }
  while (state.cursor < state.tasks.length && state.status === 'active') {
    const task = state.tasks[state.cursor]
    if (task.status === 'passed') {
      state.cursor += 1
      await writeState(state)
      continue
    }
    let attempt
    if (task.status === 'candidate') {
      attempt = task.attempts.at(-1)
    } else {
      attempt = await invokeTask({ state, task, invoke, log })
    }
    if (state.status === 'blocked') break
    if (!attempt) continue
    await evaluateCandidate({ state, task, attempt, log })
  }
  if (state.status === 'active' && state.cursor >= state.tasks.length) {
    await runFinalGate({ state, log })
  }
  return state
}
