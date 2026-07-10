import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '../skills/psepha/scripts/check_form.mjs')

function run(doc) {
  const dir = mkdtempSync(path.join(tmpdir(), 'psepha-form-'))
  const file = path.join(dir, 'form.json')
  writeFileSync(file, JSON.stringify(doc))
  try {
    const out = execFileSync('node', [SCRIPT, file], { encoding: 'utf8' })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

const base = () => ({
  definition: 'Enumerates contradictions in a given document, one finding per section.',
  merge: 'union',
  runs: 3,
  isolation: 'sealed',
  invention: 'forbidden',
  criteria_from: 'request',
  anchors: { kind: 'closed_list', values: ['## A', '## B'], source: 'headings' },
  notes: '',
})

test('valid union form passes', () => {
  const r = run(base())
  assert.equal(r.code, 0)
  assert.match(r.out, /OK/)
})

test('envelope with .form is unwrapped', () => {
  const r = run({ form: base(), started_at: 'x', digest: 'd', outcome: 'pending' })
  assert.equal(r.code, 0)
})

test('C1: runs 1 with merge union fails', () => {
  const r = run({ ...base(), runs: 1 })
  assert.equal(r.code, 1)
  assert.match(r.out, /C1/)
})

test('C1: merge none with runs 3 fails', () => {
  const f = base(); delete f.anchors
  const r = run({ ...f, merge: 'none' })
  assert.equal(r.code, 1)
  assert.match(r.out, /C1/)
})

test('delegation form (runs 1, merge none, tooled) passes', () => {
  const f = base(); delete f.anchors
  const r = run({ ...f, merge: 'none', runs: 1, isolation: 'tooled', invention: 'allowed' })
  assert.equal(r.code, 0)
})

test('C2: union without anchors fails', () => {
  const f = base(); delete f.anchors
  const r = run(f)
  assert.equal(r.code, 1)
  assert.match(r.out, /C2/)
})

test('C2: anchors present on a pick merge fails', () => {
  const r = run({ ...base(), merge: 'pick', pick: { criterion: 'clearest intro', route: 'judged' } })
  assert.equal(r.code, 1)
  assert.match(r.out, /C2/)
})

test('C3: vote threshold above runs fails', () => {
  const r = run({ ...base(), merge: 'vote', vote_threshold: 4 })
  assert.equal(r.code, 1)
  assert.match(r.out, /C3/)
})

test('C3: valid vote form passes', () => {
  const r = run({ ...base(), merge: 'vote', vote_threshold: 2 })
  assert.equal(r.code, 0)
})

test('C3: vote_threshold outside vote merge fails', () => {
  const r = run({ ...base(), vote_threshold: 2 })
  assert.equal(r.code, 1)
  assert.match(r.out, /C3/)
})

test('C4: pick without route fails', () => {
  const f = base(); delete f.anchors
  const r = run({ ...f, merge: 'pick', pick: { criterion: 'clearest' } })
  assert.equal(r.code, 1)
  assert.match(r.out, /C4/)
})

test('C4: mechanical pick with command program passes', () => {
  const f = base(); delete f.anchors
  const r = run({ ...f, merge: 'pick', pick: { criterion: 'passes the check', route: 'mechanical', program: { kind: 'command', command: 'node --check {candidate}' } } })
  assert.equal(r.code, 0)
})

test('C4: mechanical pick without program fails', () => {
  const f = base(); delete f.anchors
  const r = run({ ...f, merge: 'pick', pick: { criterion: 'shortest', route: 'mechanical' } })
  assert.equal(r.code, 1)
  assert.match(r.out, /C4/)
})

test('C5: criteria_from document with missing file fails', () => {
  const r = run({ ...base(), criteria_from: 'document', criteria_ref: '/nonexistent/doc.md' })
  assert.equal(r.code, 1)
  assert.match(r.out, /C5/)
})

test('C5: criteria_from document with existing file passes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'psepha-doc-'))
  const doc = path.join(dir, 'doc.md')
  writeFileSync(doc, '# hi')
  const r = run({ ...base(), criteria_from: 'document', criteria_ref: doc })
  assert.equal(r.code, 0)
})

test('C6: free-form anchors kind fails', () => {
  const r = run({ ...base(), anchors: { kind: 'freeform', values: [] } })
  assert.equal(r.code, 1)
  assert.match(r.out, /C6/)
})

test('C6: closed_list with empty values fails', () => {
  const r = run({ ...base(), anchors: { kind: 'closed_list', values: [] } })
  assert.equal(r.code, 1)
  assert.match(r.out, /C6/)
})

test('M3: unknown field is rejected (no reader-less fields)', () => {
  const r = run({ ...base(), color: 'red' })
  assert.equal(r.code, 1)
  assert.match(r.out, /M3/)
})

test('F: missing notes key fails', () => {
  const f = base(); delete f.notes
  const r = run(f)
  assert.equal(r.code, 1)
  assert.match(r.out, /F/)
})
