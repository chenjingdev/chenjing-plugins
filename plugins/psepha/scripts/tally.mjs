#!/usr/bin/env node
// Dev-side promotion tally (read-only). Reads the run-record pile and prints
// the three signals the promotion loop (D-12) counts:
//   1. form families      — same executable shape recurring → preset candidate
//   2. prior divergences  — switch vector suggested X, form chose Y → element candidate
//   3. gap notes          — "gap:" / "divergence:" lines in notes → element candidate
// Thresholds: 3 occurrences flag a candidate. Legacy field names (fold/volley/
// residual, pre-D-7) are normalized so old records count too.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DIR = process.argv[2] ||
  path.join(os.homedir(), '.claude/plugins/data/psepha-chenjing-plugins/records')
const THRESHOLD = 3

const LEGACY = { fold: 'merge', volley: 'runs', residual: 'notes' }
const records = readdirSync(DIR).filter(f => f.endsWith('.json')).sort().map(f => {
  const raw = JSON.parse(readFileSync(path.join(DIR, f), 'utf8'))
  const form = raw.form
    ? Object.fromEntries(Object.entries(raw.form).map(([k, v]) => [LEGACY[k] ?? k, v]))
    : null
  return { file: f, ...raw, form }
})

console.log(`records: ${records.length}  (${DIR})\n`)

// 1. form families — merge · invention · criteria_from is the executable shape;
//    runs/isolation are listed as variants inside a family.
const families = new Map()
for (const r of records.filter(r => r.form)) {
  const key = `${r.form.merge} · invention:${r.form.invention} · criteria:${r.form.criteria_from}`
  if (!families.has(key)) families.set(key, [])
  families.get(key).push(r)
}
console.log('## form families (>= ' + THRESHOLD + ' → PRESET CANDIDATE)')
for (const [key, rs] of [...families.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const mark = rs.length >= THRESHOLD ? '  << PRESET CANDIDATE' : ''
  console.log(`- ${key}  ×${rs.length}${mark}`)
  for (const r of rs) {
    console.log(`    ${r.started_at?.slice(0, 10) ?? '????'}  runs:${r.form.runs} ${r.form.isolation}  [${r.outcome}]  ${r.digest}`)
  }
}

// 2. prior divergences — re-evaluate the S6 prior in code on the recorded
//    switch vector and compare with the form actually used (routing block
//    exists from v0.10.0 onward).
const prior = s => s.candidate_selection ? 'pick'
  : s.enumerable_findings && s.wants_confidence ? 'vote'
  : s.enumerable_findings ? 'union'
  : 'none'
const routed = records.filter(r => r.routing?.switches)
const divergences = new Map()
for (const r of routed.filter(r => r.form)) {
  const want = prior(r.routing.switches)
  if (want === r.form.merge) continue
  const key = `prior:${want} → form:${r.form.merge}`
  if (!divergences.has(key)) divergences.set(key, [])
  divergences.get(key).push(r)
}
console.log(`\n## prior divergences (${routed.length} records carry a switch vector; >= ${THRESHOLD} same divergence → ELEMENT CANDIDATE)`)
if (routed.length === 0) console.log('- none yet: all records predate v0.10.0 routing')
for (const [key, rs] of divergences) {
  const mark = rs.length >= THRESHOLD ? '  << ELEMENT CANDIDATE' : ''
  console.log(`- ${key}  ×${rs.length}${mark}`)
  for (const r of rs) console.log(`    ${r.digest}\n      note: ${r.form.notes || '(none — convention violation: divergence needs a note)'}`)
}

// 3. gap notes — the machine-greppable convention: "gap: ..." for constraints
//    no field carries, "divergence: <switch> — <reason>" when overriding the prior.
const gaps = []
for (const r of records.filter(r => r.form?.notes)) {
  for (const m of r.form.notes.match(/(?:gap|divergence):[^\n]*/gi) ?? []) {
    gaps.push({ tag: m.trim(), digest: r.digest })
  }
}
console.log(`\n## gap notes (>= ${THRESHOLD} similar → ELEMENT CANDIDATE)`)
if (gaps.length === 0) console.log('- none recorded')
for (const g of gaps) console.log(`- ${g.tag}\n    from: ${g.digest}`)
