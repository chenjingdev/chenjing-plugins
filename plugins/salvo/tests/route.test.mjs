import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runRoute } from './harness.mjs'

// ---- routing table (route-workflow.js) -------------------------------------

// A fixed switch vector the stubbed classifier returns for every routing test.
const VECTOR = {
  enumerable_findings: true,
  wants_confidence: false,
  candidate_selection: false,
  unattended_ok: true,
  touches_environment: false,
  target_kind: 'document',
}
const stub = (vector = VECTOR) => () => vector
const routeArgs = (conditions, model = null) => ({ request: 'enumerate the contradictions in plan.md', conditions, model })

test('classifier is the isolated salvo:runner, defaults to haiku, sees only the request', async () => {
  const { result, calls } = await runRoute(routeArgs([]), stub())
  assert.equal(calls.length, 1)
  const c = calls[0]
  assert.equal(c.opts.agentType, 'salvo:runner') // isolated no-tools classifier (M2)
  assert.equal(c.opts.model, 'haiku') // default tier when the door passes model: null
  assert.equal(c.opts.phase, 'Classify')
  assert.deepEqual(c.opts.schema.required, [
    'enumerable_findings', 'wants_confidence', 'candidate_selection',
    'unattended_ok', 'touches_environment', 'target_kind',
  ])
  assert.equal(c.opts.schema.additionalProperties, false)
  assert.match(c.prompt, /enumerate the contradictions in plan\.md/) // request embedded
  assert.deepEqual(result.switches, VECTOR)
})

test('model override rides through to the classifier', async () => {
  const { calls } = await runRoute(routeArgs([], 'sonnet'), stub())
  assert.equal(calls[0].opts.model, 'sonnet')
})

test('most-specific condition wins: a 2-clause match beats a 1-clause match', async () => {
  const conditions = [
    { name: 'wide', kind: 'preset', requires: { enumerable_findings: true } },
    { name: 'narrow', kind: 'procedural', requires: { enumerable_findings: true, target_kind: 'document' } },
  ]
  const { result } = await runRoute(routeArgs(conditions), stub())
  assert.equal(result.kind, 'routed')
  assert.equal(result.destination, 'narrow')
  assert.equal(result.destination_kind, 'procedural')
  assert.deepEqual(result.matched, { name: 'narrow', requires: { enumerable_findings: true, target_kind: 'document' } })
  assert.equal(result.fallback, false)
  assert.deepEqual(result.switches, VECTOR)
})

test('lexicographic tie-break on equal clause count', async () => {
  const conditions = [
    { name: 'zeta', kind: 'preset', requires: { enumerable_findings: true } },
    { name: 'alpha', kind: 'preset', requires: { touches_environment: false } },
  ]
  const { result } = await runRoute(routeArgs(conditions), stub())
  assert.equal(result.destination, 'alpha') // both satisfied, 1 clause each -> smallest name
})

test('an unsatisfied clause disqualifies the whole condition (every key must match)', async () => {
  const conditions = [
    // enumerable_findings matches, but candidate_selection is false in the vector.
    { name: 'partial', kind: 'preset', requires: { enumerable_findings: true, candidate_selection: true } },
  ]
  const { result } = await runRoute(routeArgs(conditions), stub())
  assert.equal(result.destination, 'engine')
  assert.equal(result.destination_kind, null)
  assert.equal(result.matched, null)
  assert.equal(result.fallback, false)
})

test('empty conditions -> engine (v1 ships zero sub-skills), vector still recorded', async () => {
  const { result } = await runRoute(routeArgs([]), stub())
  assert.equal(result.destination, 'engine')
  assert.equal(result.matched, null)
  assert.deepEqual(result.switches, VECTOR)
  assert.equal(result.fallback, false)
})

test('classifier failure -> engine fallback (routing_fallback), non-fatal', async () => {
  const conditions = [{ name: 'narrow', kind: 'preset', requires: { enumerable_findings: true } }]
  const { result } = await runRoute(routeArgs(conditions), () => null)
  assert.equal(result.destination, 'engine')
  assert.equal(result.fallback, true)
  assert.equal(result.switches, null)
  assert.equal(result.matched, null)
})

test('determinism: same vector + conditions twice yields identical results (AC8)', async () => {
  const conditions = [
    { name: 'wide', kind: 'preset', requires: { enumerable_findings: true } },
    { name: 'narrow', kind: 'procedural', requires: { enumerable_findings: true, target_kind: 'document' } },
  ]
  const a = await runRoute(routeArgs(conditions), stub())
  const b = await runRoute(routeArgs(conditions), stub())
  assert.deepEqual(a.result, b.result)
})

// ---- record.mjs routing block (scripts/record.mjs) -------------------------

const RECORD = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '../skills/salvo/scripts/record.mjs')

const FORM = {
  definition: 'Enumerates contradictions in plan.md, one finding per section.',
  merge: 'union', runs: 3, isolation: 'sealed', invention: 'forbidden',
  criteria_from: 'request',
  anchors: { kind: 'closed_list', values: ['One', 'Two'], source: 'headings' },
  notes: '',
}
const ROUTING = {
  kind: 'routed', destination: 'engine', destination_kind: null, matched: null,
  switches: VECTOR, fallback: false,
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'salvo-route-'))
  writeFileSync(path.join(dir, 'form.json'), JSON.stringify(FORM))
  writeFileSync(path.join(dir, 'routing.json'), JSON.stringify(ROUTING))
  return {
    formFile: path.join(dir, 'form.json'),
    routingFile: path.join(dir, 'routing.json'),
    root: path.join(dir, 'records'),
  }
}
function run(args) {
  try {
    return { code: 0, out: execFileSync('node', [RECORD, ...args], { encoding: 'utf8' }) }
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

test('record.mjs new --routing stores the routing block beside the form (AC8)', () => {
  const { formFile, routingFile, root } = setup()
  const r = run(['new', '--form', formFile, '--routing', routingFile, '--digest', 'enumerate contradictions', '--root', root])
  assert.equal(r.code, 0)
  const record = JSON.parse(readFileSync(r.out.trim(), 'utf8'))
  assert.deepEqual(record.routing, ROUTING)
  assert.deepEqual(record.form, FORM)
  assert.equal(record.outcome, 'pending')
})

test('record.mjs new writes a routed-only record (--outcome routed, no form)', () => {
  const { routingFile, root } = setup()
  const r = run(['new', '--routing', routingFile, '--digest', 'handoff to sub-skill', '--outcome', 'routed', '--root', root])
  assert.equal(r.code, 0)
  const record = JSON.parse(readFileSync(r.out.trim(), 'utf8'))
  assert.deepEqual(record.routing, ROUTING)
  assert.equal('form' in record, false) // routed handoff carries no form
  assert.equal(record.outcome, 'routed')
  assert.equal(readdirSync(root).length, 1)
})

test('record.mjs new rejects --outcome values other than routed', () => {
  const { formFile, routingFile, root } = setup()
  const r = run(['new', '--form', formFile, '--routing', routingFile, '--digest', 'd', '--outcome', 'merged', '--root', root])
  assert.equal(r.code, 2)
})

test('record.mjs new without --routing is unchanged (legacy call: form-only envelope)', () => {
  const { formFile, root } = setup()
  const r = run(['new', '--form', formFile, '--digest', 'legacy call', '--root', root])
  assert.equal(r.code, 0)
  const record = JSON.parse(readFileSync(r.out.trim(), 'utf8'))
  assert.equal('routing' in record, false)
  assert.deepEqual(record.form, FORM)
  assert.equal(record.outcome, 'pending')
})
