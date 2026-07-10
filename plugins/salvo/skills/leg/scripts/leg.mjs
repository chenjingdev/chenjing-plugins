#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import {
  createRun,
  defaultStateRoot,
  loadPlan,
  readState,
  resolveStatePath,
  summarizeState,
} from './core.mjs'
import { drive, reopenBlocked } from './runner.mjs'

const USAGE = `salvo leg — external evidence-gated task runner

Usage:
  node leg.mjs check-plan <plan.json> [--tasks N..M]
  node leg.mjs start <plan.json> --tasks N..M --engine codex|claude [--model MODEL] [--turn-timeout-ms MS]
  node leg.mjs resume <run-id|state.json> [--retry-blocked] [--note TEXT]
  node leg.mjs status <run-id|state.json> [--json]

Exit codes:
  0  selected range passed every task verifier and the final regression gate
  2  run is blocked; inspect status/evidence and resume deliberately
  64 invalid plan or command line
`

const parseArgs = argv => {
  const positionals = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (!item.startsWith('--')) {
      positionals.push(item)
      continue
    }
    const key = item.slice(2)
    if (['json', 'retry-blocked'].includes(key)) {
      flags[key] = true
      continue
    }
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`--${key} requires a value`)
    flags[key] = argv[++i]
  }
  return { positionals, flags }
}

const parseRange = value => {
  if (!value) return {}
  const match = /^(\d+)\.\.(\d+)$/.exec(value)
  if (!match) throw new Error('--tasks must look like N..M')
  return { from: Number(match[1]), to: Number(match[2]) }
}

const ALLOWED_FLAGS = {
  'check-plan': new Set(['tasks']),
  start: new Set(['tasks', 'engine', 'model', 'turn-timeout-ms', 'state-root', 'json']),
  resume: new Set(['retry-blocked', 'note', 'state-root', 'json']),
  status: new Set(['state-root', 'json']),
}

const assertAllowedFlags = (command, flags) => {
  const allowed = ALLOWED_FLAGS[command]
  if (!allowed) return
  for (const flag of Object.keys(flags)) {
    if (!allowed.has(flag)) throw new Error(`unknown flag for ${command}: --${flag}`)
  }
}

const printSummary = (state, json = false) => {
  const summary = summarizeState(state)
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    return
  }
  process.stdout.write(`run: ${summary.run_id}\n`)
  process.stdout.write(`status: ${summary.status} (${summary.phase})\n`)
  process.stdout.write(`range: ${summary.range.from}..${summary.range.to}\n`)
  for (const task of summary.tasks) {
    process.stdout.write(`- ${task.id}. [${task.status}] ${task.title} — attempts ${task.attempts}${task.summary ? ` — ${task.summary}` : ''}\n`)
  }
  if (summary.blocked_reason) process.stdout.write(`blocked: ${summary.blocked_reason}\n`)
  if (summary.final_receipt?.receipt_path) process.stdout.write(`final evidence: ${summary.final_receipt.receipt_path}\n`)
  process.stdout.write(`state: ${summary.state_path}\n`)
}

const checkPlan = async (planFile, flags) => {
  const { plan, planPath } = await loadPlan(planFile, parseRange(flags.tasks))
  const printable = {
    plan: planPath,
    objective: plan.objective,
    root: plan.root,
    range: plan.range,
    tasks: plan.tasks.map(task => ({
      id: task.id,
      title: task.title,
      instructions: task.instructions,
      acceptance: task.acceptance,
      artifacts: task.artifacts,
      verifiers: task.verify.map(check => ({ name: check.name, argv: check.argv, cwd: check.cwd })),
      require_change: task.require_change,
      max_attempts: task.max_attempts,
    })),
    protected: plan.protected,
    final_verifiers: plan.final_verify.map(check => ({ name: check.name, argv: check.argv, cwd: check.cwd })),
  }
  process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`)
}

const start = async (planFile, flags) => {
  if (!['codex', 'claude'].includes(flags.engine)) throw new Error('--engine must be codex or claude')
  if (!flags.tasks) throw new Error('start requires an explicit --tasks N..M range')
  const loaded = await loadPlan(planFile, parseRange(flags.tasks))
  const model = flags.model ?? (flags.engine === 'codex'
    ? (process.env.SALVO_CODEX_MODEL || 'gpt-5.4')
    : (process.env.SALVO_CLAUDE_MODEL || null))
  const state = await createRun({
    plan: loaded.plan,
    rawPlan: loaded.raw,
    planPath: loaded.planPath,
    engine: flags.engine,
    model,
    turnTimeoutMs: flags['turn-timeout-ms'] ? Number(flags['turn-timeout-ms']) : 1800000,
    stateRoot: flags['state-root'] ?? defaultStateRoot(),
  })
  process.stdout.write(`started ${state.run_id}; frozen tasks ${state.range.from}..${state.range.to}; state ${state.state_path}\n`)
  const result = await drive(state.state_path)
  printSummary(result, flags.json)
  if (result.status !== 'complete') process.exitCode = 2
}

const resume = async (run, flags) => {
  const statePath = await resolveStatePath(run, flags['state-root'] ?? defaultStateRoot())
  const state = await readState(statePath)
  if (state.status === 'blocked') {
    if (!flags['retry-blocked']) {
      printSummary(state, flags.json)
      process.exitCode = 2
      return
    }
    const reopened = await reopenBlocked(state, { note: flags.note ?? null })
    if (!reopened.reopened) {
      printSummary(reopened.state, flags.json)
      process.exitCode = 2
      return
    }
  }
  const result = await drive(statePath)
  printSummary(result, flags.json)
  if (result.status !== 'complete') process.exitCode = 2
}

const main = async argv => {
  const [command, ...rest] = argv
  if (!command || ['help', '-h', '--help'].includes(command)) {
    process.stdout.write(USAGE)
    return
  }
  const { positionals, flags } = parseArgs(rest)
  assertAllowedFlags(command, flags)
  if (command === 'check-plan') {
    if (positionals.length !== 1) throw new Error('check-plan requires one plan file')
    await checkPlan(positionals[0], flags)
    return
  }
  if (command === 'start') {
    if (positionals.length !== 1) throw new Error('start requires one plan file')
    await start(positionals[0], flags)
    return
  }
  if (command === 'resume') {
    if (positionals.length !== 1) throw new Error('resume requires one run id or state file')
    await resume(positionals[0], flags)
    return
  }
  if (command === 'status') {
    if (positionals.length !== 1) throw new Error('status requires one run id or state file')
    const statePath = await resolveStatePath(positionals[0], flags['state-root'] ?? defaultStateRoot())
    printSummary(await readState(statePath), flags.json)
    return
  }
  throw new Error(`unknown command: ${command}`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`salvo leg: ${error.message}\n`)
    process.exitCode = 64
  })
}

export { main }
