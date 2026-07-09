import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runVolley } from './harness.mjs'

const pickForm = (pick) => ({
  definition: 'Drafts a README intro and keeps the best of N.',
  fold: 'pick',
  pick,
  volley: 3,
  isolation: 'sealed',
  invention: 'allowed',
  criteria_from: 'request',
  residual: '',
})

test('judged pick: one starved judge sees only candidates + criterion, selection labeled by route', async () => {
  const impl = (prompt, opts) => {
    if (opts.label === 'judge') return { choice: 2, grounds: 'plainest wording' }
    return { candidate: `intro ${opts.label}` }
  }
  const { result, calls } = await runVolley(
    { form: pickForm({ criterion: 'the clearest intro', route: 'judged' }), shooterPrompt: 'WRITE', target: null, model: null },
    impl)
  assert.equal(result.kind, 'picked')
  assert.equal(result.route, 'judged')
  assert.equal(result.choice, 1) // 1-based judge answer -> 0-based index
  assert.equal(result.grounds, 'plainest wording')
  assert.equal(result.candidates.length, 3)
  assert.equal(calls.length, 4)
  const judge = calls.find(c => c.opts.label === 'judge')
  assert.equal(judge.opts.agentType, 'salvo:shooter') // starved judge (M2)
  assert.match(judge.prompt, /the clearest intro/)
  assert.match(judge.prompt, /CANDIDATE 2/)
  assert.ok(!judge.prompt.includes('WRITE')) // judge never sees the shooter prompt
})

test('judged pick: judge failure voids the volley', async () => {
  const impl = (prompt, opts) => (opts.label === 'judge' ? null : { candidate: 'c' })
  const { result } = await runVolley(
    { form: pickForm({ criterion: 'clearest', route: 'judged' }), shooterPrompt: 'W', target: null, model: null },
    impl)
  assert.equal(result.kind, 'void')
})

test('mechanical pick, shortest program: pure JS selection, no judge call', async () => {
  const byShot = { 'shot:1': 'bbb', 'shot:2': 'a', 'shot:3': 'cc' }
  const { result, calls } = await runVolley(
    { form: pickForm({ criterion: 'shortest draft', route: 'mechanical', program: { kind: 'shortest' } }), shooterPrompt: 'W', target: null, model: null },
    (prompt, opts) => ({ candidate: byShot[opts.label] }))
  assert.equal(result.kind, 'picked')
  assert.equal(result.route, 'mechanical')
  assert.equal(result.program, 'shortest')
  assert.equal(result.choice, 1)
  assert.equal(calls.length, 3) // no judge
})

test('mechanical pick, command program: returns candidates for outside evaluation', async () => {
  const { result, calls } = await runVolley(
    { form: pickForm({ criterion: 'passes the check', route: 'mechanical', program: { kind: 'command', command: 'node --check {candidate}' } }), shooterPrompt: 'W', target: null, model: null },
    (prompt, opts) => ({ candidate: `code ${opts.label}` }))
  assert.equal(result.kind, 'candidates')
  assert.equal(result.program, 'command')
  assert.equal(result.candidates.length, 3)
  assert.equal(calls.length, 3)
})

test('pick: a failed shooter voids before any selection', async () => {
  const { result } = await runVolley(
    { form: pickForm({ criterion: 'clearest', route: 'judged' }), shooterPrompt: 'W', target: null, model: null },
    (prompt, opts) => (opts.label === 'shot:3' ? null : { candidate: 'c' }))
  assert.equal(result.kind, 'void')
  assert.match(result.reason, /3/)
})
