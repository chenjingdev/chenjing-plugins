import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  createRun,
  loadPlan,
  readState,
  validatePlan,
} from '../skills/leg/scripts/core.mjs'
import { drive, reopenBlocked } from '../skills/leg/scripts/runner.mjs'

const tempRoot = () => mkdtemp(path.join(os.tmpdir(), 'salvo-leg-'))

const check = (file, expected, name = `check ${file}`) => ({
  name,
  argv: ['node', 'check.mjs', file, expected],
  cwd: '.',
  timeout_ms: 10000,
})

const basePlan = tasks => ({
  version: 1,
  objective: 'complete only after external proof',
  root: '.',
  tasks,
  final_verify: [{
    name: 'range regression',
    argv: ['node', 'final.mjs'],
    cwd: '.',
    timeout_ms: 10000,
  }],
})

const task = (id, file, expected, overrides = {}) => ({
  id,
  title: `write ${file}`,
  instructions: `write exactly ${expected} to ${file}`,
  acceptance: [`${file} contains ${expected}`],
  artifacts: [file],
  verify: [check(file, expected)],
  require_change: true,
  max_attempts: 3,
  ...overrides,
})

const prepare = async (plan, range = {}) => {
  const root = await tempRoot()
  const stateRoot = await tempRoot()
  await writeFile(path.join(root, 'check.mjs'), `
import { readFileSync } from 'node:fs'
const [, , file, expected] = process.argv
process.exit(readFileSync(file, 'utf8') === expected ? 0 : 1)
`, 'utf8')
  await writeFile(path.join(root, 'final.mjs'), `process.exit(0)\n`, 'utf8')
  const planPath = path.join(root, 'plan.json')
  const raw = JSON.stringify(plan, null, 2)
  await writeFile(planPath, raw, 'utf8')
  const loaded = await loadPlan(planPath, range)
  const state = await createRun({
    plan: loaded.plan,
    rawPlan: loaded.raw,
    planPath: loaded.planPath,
    engine: 'codex',
    stateRoot,
  })
  return { root, planPath, state, stateRoot }
}

const candidate = summary => ({
  status: 'candidate',
  summary,
  changed_files: [],
  checks_run: [],
  needs_user: [],
})

const blockedCandidate = need => ({
  status: 'blocked',
  summary: `need ${need}`,
  changed_files: [],
  checks_run: [],
  needs_user: need ? [need] : [],
})

test('plan rejects a task without an external verifier', () => {
  const plan = basePlan([{ ...task(1, 'one.txt', 'one'), verify: [] }])
  assert.throws(() => validatePlan(plan, { planPath: '/tmp/plan.json' }), /external verifier|verify/)
})

test('plan rejects verifier command strings hidden behind a shell', () => {
  const plan = basePlan([task(1, 'one.txt', 'one', {
    verify: [{ name: 'shell string', argv: ['bash', '-c', 'exit 0'], cwd: '.', timeout_ms: 10000 }],
  })])
  assert.throws(() => validatePlan(plan, { planPath: '/tmp/plan.json' }), /must not invoke a shell command string/)
  const envPlan = basePlan([task(1, 'one.txt', 'one', {
    verify: [{ name: 'env shell string', argv: ['env', 'MODE=test', 'bash', '-lc', 'exit 0'], cwd: '.', timeout_ms: 10000 }],
  })])
  assert.throws(() => validatePlan(envPlan, { planPath: '/tmp/plan.json' }), /must not invoke a shell command string/)
})

test('authoritative run state cannot be placed inside the worker project', async () => {
  const root = await tempRoot()
  await writeFile(path.join(root, 'check.mjs'), 'process.exit(0)\n')
  await writeFile(path.join(root, 'final.mjs'), 'process.exit(0)\n')
  const planPath = path.join(root, 'plan.json')
  const raw = JSON.stringify(basePlan([task(1, 'one.txt', 'one')]))
  await writeFile(planPath, raw)
  const loaded = await loadPlan(planPath)
  await assert.rejects(() => createRun({
    plan: loaded.plan,
    rawPlan: loaded.raw,
    planPath: loaded.planPath,
    engine: 'codex',
    stateRoot: path.join(root, '.salvo-state'),
  }), /state root must be outside/)
})

test('selected task range is frozen even if the source plan later changes', async () => {
  const plan = basePlan([task(1, 'one.txt', 'one'), task(2, 'two.txt', 'two'), task(3, 'three.txt', 'three')])
  const { planPath, state } = await prepare(plan, { from: 2, to: 3 })
  await writeFile(planPath, JSON.stringify(basePlan([task(99, 'other.txt', 'other')])), 'utf8')
  const frozen = await readState(state.state_path)
  assert.deepEqual(frozen.tasks.map(item => item.id), [2, 3])
  assert.deepEqual(frozen.range, { from: 2, to: 3 })
})

test('a claimed completion cannot pass without artifact change and verifier success', async () => {
  const plan = basePlan([task(1, 'one.txt', 'one', { max_attempts: 1 })])
  const { state } = await prepare(plan)
  const result = await drive(state.state_path, {
    log: () => {},
    invoke: async () => ({ candidate: candidate('everything is done'), session_id: 'fake-1' }),
  })
  assert.equal(result.status, 'blocked')
  assert.equal(result.tasks[0].status, 'blocked')
  assert.match(result.blocked_reason, /missing artifact|verification failed/)
})

test('failed external proof is fed into a retry and only the passing attempt advances', async () => {
  const plan = basePlan([task(1, 'one.txt', 'one'), task(2, 'two.txt', 'two')])
  const { root, state } = await prepare(plan)
  const calls = []
  const result = await drive(state.state_path, {
    log: () => {},
    invoke: async options => {
      calls.push(options)
      const id = Number(/task-(\d+)-/.exec(options.label)[1])
      const attempt = Number(/attempt-(\d+)/.exec(options.label)[1])
      if (id === 1) await writeFile(path.join(root, 'one.txt'), attempt === 1 ? 'wrong' : 'one')
      if (id === 2) await writeFile(path.join(root, 'two.txt'), 'two')
      return { candidate: candidate(`task ${id} candidate`), session_id: `session-${id}` }
    },
  })
  assert.equal(result.status, 'complete')
  assert.deepEqual(result.tasks.map(item => item.status), ['passed', 'passed'])
  assert.equal(result.tasks[0].attempts.length, 2)
  assert.match(calls[1].prompt, /Authoritative verifier feedback/)
  assert.match(calls[1].prompt, /check one.txt failed/)
})

test('one premature blocker claim gets a fresh-context attempt instead of stopping the leg', async () => {
  const plan = basePlan([task(1, 'one.txt', 'one')])
  const { root, state } = await prepare(plan)
  const calls = []
  const result = await drive(state.state_path, {
    log: () => {},
    invoke: async options => {
      calls.push(options)
      if (calls.length === 1) return { candidate: blockedCandidate('a user decision'), session_id: 'first' }
      await writeFile(path.join(root, 'one.txt'), 'one')
      return { candidate: candidate('solved independently'), session_id: 'second' }
    },
  })
  assert.equal(result.status, 'complete')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].sessionId, null)
  assert.match(calls[1].prompt, /Unconfirmed blocker claim/)
})

test('a concrete blocker stops only after a fresh context independently confirms it', async () => {
  const plan = basePlan([task(1, 'one.txt', 'one')])
  const { state } = await prepare(plan)
  let calls = 0
  const result = await drive(state.state_path, {
    log: () => {},
    invoke: async () => {
      calls++
      return { candidate: blockedCandidate('choose the production account'), session_id: `session-${calls}` }
    },
  })
  assert.equal(result.status, 'blocked')
  assert.equal(calls, 2)
  assert.match(result.blocked_reason, /independently confirmed/)
})

test('a verifier that mutates a declared artifact is rejected even when it exits zero', async () => {
  const plan = basePlan([task(1, 'one.txt', 'one', {
    max_attempts: 1,
    verify: [{
      name: 'mutating verifier',
      argv: ['node', 'mutate.mjs'],
      cwd: '.',
      timeout_ms: 10000,
    }],
  })])
  const { root, state } = await prepare(plan)
  await writeFile(path.join(root, 'mutate.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync('one.txt', 'changed by verifier')\n`)
  const result = await drive(state.state_path, {
    log: () => {},
    invoke: async () => {
      await writeFile(path.join(root, 'one.txt'), 'one')
      return { candidate: candidate('candidate'), session_id: 'fake' }
    },
  })
  assert.equal(result.status, 'blocked')
  assert.match(result.blocked_reason, /verifier mutated declared artifact/)
})

test('a declared artifact cannot be a symlink even when its target would pass', async () => {
  const plan = basePlan([task(1, 'one.txt', 'one', { max_attempts: 1 })])
  const { root, state } = await prepare(plan)
  const result = await drive(state.state_path, {
    log: () => {},
    invoke: async () => {
      await writeFile(path.join(root, 'real.txt'), 'one')
      await symlink('real.txt', path.join(root, 'one.txt'))
      return { candidate: candidate('symlink candidate'), session_id: 'fake' }
    },
  })
  assert.equal(result.status, 'blocked')
  assert.match(result.blocked_reason, /must not be a symlink/)
})

test('a verifier that ignores SIGTERM is hard-stopped by its timeout', async () => {
  const plan = basePlan([task(1, 'one.txt', 'one', {
    max_attempts: 1,
    verify: [{
      name: 'hung verifier',
      argv: ['node', 'hang.mjs'],
      cwd: '.',
      timeout_ms: 100,
    }],
  })])
  const { root, state } = await prepare(plan)
  await writeFile(path.join(root, 'hang.mjs'), `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\n`)
  const started = Date.now()
  const result = await drive(state.state_path, {
    log: () => {},
    invoke: async () => {
      await writeFile(path.join(root, 'one.txt'), 'one')
      return { candidate: candidate('candidate'), session_id: 'fake' }
    },
  })
  assert.equal(result.status, 'blocked')
  assert.ok(Date.now() - started < 5000)
  assert.match(result.blocked_reason, /TimeoutError/)
})

test('an idempotent mutating verifier can never turn its own artifact into a later pass', async () => {
  const plan = basePlan([task(1, 'one.txt', 'unused', {
    max_attempts: 2,
    verify: [{
      name: 'idempotent writer',
      argv: ['node', 'mutate.mjs'],
      cwd: '.',
      timeout_ms: 10000,
    }],
  })])
  const { root, state } = await prepare(plan)
  await writeFile(path.join(root, 'mutate.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync('one.txt', 'FROM_VERIFIER')\n`)
  const result = await drive(state.state_path, {
    log: () => {},
    invoke: async () => ({ candidate: candidate('no worker change'), session_id: 'fake' }),
  })
  assert.equal(result.status, 'blocked')
  assert.notEqual(result.tasks[0].status, 'passed')
  assert.equal(result.cursor, 0)
  assert.equal(result.tasks[0].attempts.length, 1)

  const retry = await reopenBlocked(result)
  assert.equal(retry.reopened, false)
  assert.equal(retry.state.status, 'blocked')
  assert.match(retry.state.blocked_reason, /still tainted/)
})

test('a mutating final verifier stays blocked across resume and preserves each receipt', async () => {
  const plan = {
    ...basePlan([task(1, 'one.txt', 'WORKER')]),
    final_verify: [{
      name: 'mutating final verifier',
      argv: ['node', 'mutate-final.mjs'],
      cwd: '.',
      timeout_ms: 10000,
    }],
  }
  const { root, state } = await prepare(plan)
  await writeFile(path.join(root, 'mutate-final.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync('one.txt', 'FROM_FINAL')\n`)
  const invoke = async () => {
    await writeFile(path.join(root, 'one.txt'), 'WORKER')
    return { candidate: candidate('worker artifact'), session_id: 'fake' }
  }
  const first = await drive(state.state_path, { log: () => {}, invoke })
  assert.equal(first.status, 'blocked')
  assert.equal(first.phase, 'final_verification')
  assert.equal(first.final_receipt.tainted, true)

  const refused = await reopenBlocked(first)
  assert.equal(refused.reopened, false)
  await writeFile(path.join(root, 'one.txt'), 'WORKER')
  const reopened = await reopenBlocked(refused.state)
  assert.equal(reopened.reopened, true)
  const second = await drive(state.state_path, { log: () => {}, invoke })
  assert.equal(second.status, 'blocked')
  assert.equal(second.final_attempts.length, 2)
  assert.notEqual(second.final_attempts[0].receipt_path, second.final_attempts[1].receipt_path)
})

test('the final gate reruns earlier task checks and catches a later regression', async () => {
  const plan = basePlan([task(1, 'one.txt', 'one'), task(2, 'two.txt', 'two')])
  const { root, state } = await prepare(plan)
  const result = await drive(state.state_path, {
    log: () => {},
    invoke: async options => {
      const id = Number(/task-(\d+)-/.exec(options.label)[1])
      if (id === 1) await writeFile(path.join(root, 'one.txt'), 'one')
      if (id === 2) {
        await writeFile(path.join(root, 'two.txt'), 'two')
        await writeFile(path.join(root, 'one.txt'), 'regressed')
      }
      return { candidate: candidate(`task ${id}`), session_id: `fake-${id}` }
    },
  })
  assert.equal(result.tasks[0].status, 'passed')
  assert.equal(result.tasks[1].status, 'passed')
  assert.equal(result.status, 'blocked')
  assert.equal(result.phase, 'final_verification')
  assert.match(result.blocked_reason, /task 1: check one.txt/)
})

test('resuming a non-tainted final regression reopens the failing task for repair', async () => {
  const plan = basePlan([task(1, 'one.txt', 'one'), task(2, 'two.txt', 'two')])
  const { root, state } = await prepare(plan)
  const first = await drive(state.state_path, {
    log: () => {},
    invoke: async options => {
      const id = Number(/task-(\d+)-/.exec(options.label)[1])
      if (id === 1) await writeFile(path.join(root, 'one.txt'), 'one')
      if (id === 2) {
        await writeFile(path.join(root, 'two.txt'), 'two')
        await writeFile(path.join(root, 'one.txt'), 'regressed')
      }
      return { candidate: candidate(`task ${id}`), session_id: `fake-${id}` }
    },
  })
  assert.equal(first.status, 'blocked')
  const reopened = await reopenBlocked(first, { note: 'repair the regression' })
  assert.equal(reopened.reopened, true)
  assert.equal(reopened.state.cursor, 0)
  assert.equal(reopened.state.tasks[0].status, 'rework')

  let repairPrompt = ''
  const repaired = await drive(state.state_path, {
    log: () => {},
    invoke: async options => {
      repairPrompt = options.prompt
      await writeFile(path.join(root, 'one.txt'), 'one')
      return { candidate: candidate('repaired task 1'), session_id: 'repair' }
    },
  })
  assert.equal(repaired.status, 'complete')
  assert.match(repairPrompt, /Final range verification failed/)
  assert.match(repairPrompt, /repair the regression/)
})

test('protected acceptance files cannot be weakened by the worker', async () => {
  const plan = {
    ...basePlan([task(1, 'one.txt', 'one', { max_attempts: 1 })]),
    protected: ['acceptance.mjs'],
  }
  const { root, state } = await prepare(plan)
  await writeFile(path.join(root, 'acceptance.mjs'), 'original', 'utf8')
  // Recreate the run after the protected file exists so its initial hash is frozen.
  const loaded = await loadPlan(path.join(root, 'plan.json'))
  const protectedRun = await createRun({
    plan: loaded.plan,
    rawPlan: loaded.raw,
    planPath: loaded.planPath,
    engine: 'codex',
    stateRoot: await tempRoot(),
  })
  const result = await drive(protectedRun.state_path, {
    log: () => {},
    invoke: async () => {
      await writeFile(path.join(root, 'one.txt'), 'one')
      await writeFile(path.join(root, 'acceptance.mjs'), 'weakened')
      return { candidate: candidate('candidate'), session_id: 'fake' }
    },
  })
  assert.equal(result.status, 'blocked')
  assert.match(result.blocked_reason, /protected path changed/)
  void state
})

test('evidence receipts remain readable JSON after a complete run', async () => {
  const plan = basePlan([task(1, 'one.txt', 'one')])
  const { root, state } = await prepare(plan)
  const result = await drive(state.state_path, {
    log: () => {},
    invoke: async () => {
      await writeFile(path.join(root, 'one.txt'), 'one')
      return { candidate: candidate('candidate'), session_id: 'fake' }
    },
  })
  const receipt = JSON.parse(await readFile(result.final_receipt.receipt_path, 'utf8'))
  assert.equal(receipt.kind, 'range-verification')
  assert.equal(receipt.passed, true)
})
