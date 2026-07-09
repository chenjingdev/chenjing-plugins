import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runVolley } from './harness.mjs'

const unionForm = (over = {}) => ({
  definition: 'Enumerates contradictions, one finding per section.',
  fold: 'union',
  volley: 3,
  isolation: 'sealed',
  invention: 'forbidden',
  criteria_from: 'request',
  anchors: { kind: 'closed_list', values: ['A', 'B', 'C'], source: 'test' },
  residual: '',
  ...over,
})

test('fold none (volley 1) passes the single result through, schema-free', async () => {
  const form = {
    definition: 'Renames a function across the repo.',
    fold: 'none', volley: 1, isolation: 'tooled', invention: 'allowed',
    criteria_from: 'request', residual: '',
  }
  const { result, calls } = await runVolley(
    { form, shooterPrompt: 'DO THE WORK', target: null, model: null },
    () => 'work done, 12 files changed')
  assert.equal(result.kind, 'single')
  assert.equal(result.result, 'work done, 12 files changed')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].opts.schema, undefined)
  assert.equal(calls[0].opts.agentType, undefined) // tooled -> default agent
})

test('union: dedup by closed-list anchor, counts distinct shooters, sealed agentType, enum in schema', async () => {
  const byShot = {
    'shot:1': { findings: [{ anchor: 'A', content: 'x1' }, { anchor: 'B', content: 'y1' }] },
    'shot:2': { findings: [{ anchor: 'A', content: 'x2' }] },
    'shot:3': { findings: [{ anchor: 'C', content: 'z3' }, { anchor: 'A', content: 'x3' }] },
  }
  const { result, calls } = await runVolley(
    { form: unionForm(), shooterPrompt: 'P', target: null, model: null },
    (prompt, opts) => byShot[opts.label])
  assert.equal(result.kind, 'folded')
  assert.equal(result.fold, 'union')
  assert.equal(result.volley, 3)
  assert.equal(result.items.length, 3)
  const a = result.items[0]
  assert.equal(a.anchor, 'A')
  assert.equal(a.count, 3)
  assert.equal(a.entries.length, 3)
  assert.equal(calls.length, 3)
  for (const c of calls) {
    assert.equal(c.opts.agentType, 'salvo:shooter') // sealed -> starved no-tools agent
    assert.deepEqual(c.opts.schema.properties.findings.items.properties.anchor.enum, ['A', 'B', 'C'])
  }
})

test('vote: keeps items with count >= threshold, reports dropped groups', async () => {
  const byShot = {
    'shot:1': { findings: [{ anchor: 'A', content: 'x1' }, { anchor: 'B', content: 'y1' }] },
    'shot:2': { findings: [{ anchor: 'A', content: 'x2' }, { anchor: 'B', content: 'y2' }] },
    'shot:3': { findings: [{ anchor: 'A', content: 'x3' }, { anchor: 'C', content: 'z3' }] },
  }
  const { result } = await runVolley(
    { form: unionForm({ fold: 'vote', vote_threshold: 2 }), shooterPrompt: 'P', target: null, model: null },
    (prompt, opts) => byShot[opts.label])
  assert.equal(result.kind, 'folded')
  assert.equal(result.fold, 'vote')
  assert.equal(result.threshold, 2)
  assert.deepEqual(result.items.map(i => [i.anchor, i.count]), [['A', 3], ['B', 2]])
  assert.equal(result.dropped, 1)
})

test('void: one failed shooter voids the volley with no partial items (M8/AC6)', async () => {
  const { result } = await runVolley(
    { form: unionForm(), shooterPrompt: 'P', target: null, model: null },
    (prompt, opts) => (opts.label === 'shot:2' ? null
      : { findings: [{ anchor: 'A', content: 'x' }] }))
  assert.equal(result.kind, 'void')
  assert.match(result.reason, /2/)
  assert.equal(result.items, undefined)
})

const TARGET = 'The quick brown fox jumps over the lazy dog'
const quoteForm = () => unionForm({ anchors: { kind: 'quote' } })

test('quote anchors: non-verbatim anchor triggers a corrective re-request (M11), spans overlap-merge', async () => {
  let shot2Calls = 0
  const impl = (prompt, opts) => {
    if (opts.label === 'shot:2') {
      shot2Calls++
      if (shot2Calls === 1) return { findings: [{ anchor: 'purple cow', content: 'bad' }] }
      return { findings: [{ anchor: 'brown fox', content: 'good' }] }
    }
    if (opts.label === 'shot:1') return { findings: [{ anchor: 'quick brown fox', content: 'c1' }] }
    return { findings: [{ anchor: 'lazy dog', content: 'c3' }] }
  }
  const { result, calls } = await runVolley(
    { form: quoteForm(), shooterPrompt: 'P', target: TARGET, model: null }, impl)
  assert.equal(calls.length, 4) // 3 shots + 1 re-request
  const reRequest = calls.filter(c => c.opts.label === 'shot:2')[1]
  assert.match(reRequest.prompt, /purple cow/) // corrective prompt names the bad anchor
  assert.equal(result.kind, 'folded')
  assert.equal(result.items.length, 2) // 'quick brown fox' + 'brown fox' overlap-merged
  assert.equal(result.items[0].anchor, 'quick brown fox') // longer member represents the group
  assert.equal(result.items[0].count, 2)
})

test('quote anchors: persistently non-conforming shooter voids the volley after 2 re-requests', async () => {
  const impl = (prompt, opts) =>
    opts.label === 'shot:2'
      ? { findings: [{ anchor: 'purple cow', content: 'bad' }] }
      : { findings: [{ anchor: 'lazy dog', content: 'ok' }] }
  const { result, calls } = await runVolley(
    { form: quoteForm(), shooterPrompt: 'P', target: TARGET, model: null }, impl)
  assert.equal(result.kind, 'void')
  assert.equal(calls.filter(c => c.opts.label === 'shot:2').length, 3) // initial + 2 re-requests
})

test('model override rides through to every agent call (A5)', async () => {
  const { calls } = await runVolley(
    { form: unionForm(), shooterPrompt: 'P', target: null, model: 'haiku' },
    () => ({ findings: [{ anchor: 'A', content: 'x' }] }))
  for (const c of calls) assert.equal(c.opts.model, 'haiku')
})
