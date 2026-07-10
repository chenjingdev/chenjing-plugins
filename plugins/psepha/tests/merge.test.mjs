import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkflow } from './harness.mjs'

const unionForm = (over = {}) => ({
  definition: 'Enumerates contradictions, one finding per section.',
  merge: 'union',
  runs: 3,
  isolation: 'sealed',
  invention: 'forbidden',
  criteria_from: 'request',
  anchors: { kind: 'closed_list', values: ['A', 'B', 'C'], source: 'test' },
  notes: '',
  ...over,
})

test('merge none (runs 1) passes the single result through, schema-free', async () => {
  const form = {
    definition: 'Renames a function across the repo.',
    merge: 'none', runs: 1, isolation: 'tooled', invention: 'allowed',
    criteria_from: 'request', notes: '',
  }
  const { result, calls } = await runWorkflow(
    { form, runnerPrompt: 'DO THE WORK', target: null, model: null },
    () => 'work done, 12 files changed')
  assert.equal(result.kind, 'single')
  assert.equal(result.result, 'work done, 12 files changed')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].opts.schema, undefined)
  assert.equal(calls[0].opts.agentType, undefined) // tooled -> default agent
})

test('union: dedup by closed-list anchor, counts distinct runs, sealed agentType, enum in schema', async () => {
  const byRun = {
    'run:1': { findings: [{ anchor: 'A', content: 'x1' }, { anchor: 'B', content: 'y1' }] },
    'run:2': { findings: [{ anchor: 'A', content: 'x2' }] },
    'run:3': { findings: [{ anchor: 'C', content: 'z3' }, { anchor: 'A', content: 'x3' }] },
  }
  const { result, calls } = await runWorkflow(
    { form: unionForm(), runnerPrompt: 'P', target: null, model: null },
    (prompt, opts) => byRun[opts.label])
  assert.equal(result.kind, 'merged')
  assert.equal(result.merge, 'union')
  assert.equal(result.runs, 3)
  assert.equal(result.items.length, 3)
  const a = result.items[0]
  assert.equal(a.anchor, 'A')
  assert.equal(a.count, 3)
  assert.equal(a.entries.length, 3)
  assert.equal(calls.length, 3)
  for (const c of calls) {
    assert.equal(c.opts.agentType, 'psepha:runner') // sealed -> isolated no-tools agent
    assert.deepEqual(c.opts.schema.properties.findings.items.properties.anchor.enum, ['A', 'B', 'C'])
  }
})

test('vote: keeps items with count >= threshold, reports dropped groups', async () => {
  const byRun = {
    'run:1': { findings: [{ anchor: 'A', content: 'x1' }, { anchor: 'B', content: 'y1' }] },
    'run:2': { findings: [{ anchor: 'A', content: 'x2' }, { anchor: 'B', content: 'y2' }] },
    'run:3': { findings: [{ anchor: 'A', content: 'x3' }, { anchor: 'C', content: 'z3' }] },
  }
  const { result } = await runWorkflow(
    { form: unionForm({ merge: 'vote', vote_threshold: 2 }), runnerPrompt: 'P', target: null, model: null },
    (prompt, opts) => byRun[opts.label])
  assert.equal(result.kind, 'merged')
  assert.equal(result.merge, 'vote')
  assert.equal(result.threshold, 2)
  assert.deepEqual(result.items.map(i => [i.anchor, i.count]), [['A', 3], ['B', 2]])
  assert.equal(result.dropped, 1)
})

test('void: one failed run voids everything with no partial items (M8/AC6)', async () => {
  const { result } = await runWorkflow(
    { form: unionForm(), runnerPrompt: 'P', target: null, model: null },
    (prompt, opts) => (opts.label === 'run:2' ? null
      : { findings: [{ anchor: 'A', content: 'x' }] }))
  assert.equal(result.kind, 'void')
  assert.match(result.reason, /2/)
  assert.equal(result.items, undefined)
})

const TARGET = 'The quick brown fox jumps over the lazy dog'
const quoteForm = () => unionForm({ anchors: { kind: 'quote' } })

test('quote anchors: non-verbatim anchor triggers a corrective re-request (M11), spans overlap-merge', async () => {
  let run2Calls = 0
  const impl = (prompt, opts) => {
    if (opts.label === 'run:2') {
      run2Calls++
      if (run2Calls === 1) return { findings: [{ anchor: 'purple cow', content: 'bad' }] }
      return { findings: [{ anchor: 'brown fox', content: 'good' }] }
    }
    if (opts.label === 'run:1') return { findings: [{ anchor: 'quick brown fox', content: 'c1' }] }
    return { findings: [{ anchor: 'lazy dog', content: 'c3' }] }
  }
  const { result, calls } = await runWorkflow(
    { form: quoteForm(), runnerPrompt: 'P', target: TARGET, model: null }, impl)
  assert.equal(calls.length, 4) // 3 runs + 1 re-request
  const reRequest = calls.filter(c => c.opts.label === 'run:2')[1]
  assert.match(reRequest.prompt, /purple cow/) // corrective prompt names the bad anchor
  assert.equal(result.kind, 'merged')
  assert.equal(result.items.length, 2) // 'quick brown fox' + 'brown fox' overlap-merged
  assert.equal(result.items[0].anchor, 'quick brown fox') // longer member represents the group
  assert.equal(result.items[0].count, 2)
})

test('quote anchors: persistently non-conforming run voids everything after 2 re-requests', async () => {
  const impl = (prompt, opts) =>
    opts.label === 'run:2'
      ? { findings: [{ anchor: 'purple cow', content: 'bad' }] }
      : { findings: [{ anchor: 'lazy dog', content: 'ok' }] }
  const { result, calls } = await runWorkflow(
    { form: quoteForm(), runnerPrompt: 'P', target: TARGET, model: null }, impl)
  assert.equal(result.kind, 'void')
  assert.equal(calls.filter(c => c.opts.label === 'run:2').length, 3) // initial + 2 re-requests
})

test('model override rides through to every agent call (A5)', async () => {
  const { calls } = await runWorkflow(
    { form: unionForm(), runnerPrompt: 'P', target: null, model: 'haiku' },
    () => ({ findings: [{ anchor: 'A', content: 'x' }] }))
  for (const c of calls) assert.equal(c.opts.model, 'haiku')
})

test('args delivered as a JSON string are normalized before the run starts', async () => {
  const { result } = await runWorkflow(
    JSON.stringify({ form: unionForm(), runnerPrompt: 'P', target: null, model: null }),
    () => ({ findings: [{ anchor: 'A', content: 'x' }] }))
  assert.equal(result.kind, 'merged')
  assert.equal(result.items[0].anchor, 'A')
})
