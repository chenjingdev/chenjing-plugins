#!/usr/bin/env node
// Mechanical validation of a salvo IntakeForm (SPEC 003 §2.1): field types,
// enums, required-iff presence, and coherence rules C1-C6 — checkable without
// an LLM by design. Accepts a bare form or a record envelope ({form, ...}).
// Prints one violation per line as "<rule>: <message>"; exit 1 on any.
import { readFileSync, existsSync } from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('usage: check_form.mjs <form.json>')
  process.exit(2)
}

let doc
try {
  doc = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  console.error(`F: unreadable JSON — ${e.message}`)
  process.exit(2)
}

const form = doc && typeof doc.form === 'object' && doc.form !== null ? doc.form : doc
const errors = []
const err = (rule, msg) => errors.push(`${rule}: ${msg}`)

// M3: every field has a reader — an unknown field has none.
const KNOWN = ['definition', 'merge', 'vote_threshold', 'pick', 'runs',
  'isolation', 'invention', 'criteria_from', 'criteria_ref', 'anchors', 'notes']
for (const k of Object.keys(form)) {
  if (!KNOWN.includes(k)) err('M3', `unknown field "${k}" has no reader`)
}

const MERGES = ['union', 'vote', 'pick', 'none']
if (typeof form.definition !== 'string' || form.definition.trim() === '')
  err('F', 'definition must be a non-empty string')
if (!MERGES.includes(form.merge)) err('F', `merge must be one of ${MERGES.join('|')}`)
if (!Number.isInteger(form.runs) || form.runs < 1)
  err('F', 'runs must be an integer >= 1')
if (!['sealed', 'tooled'].includes(form.isolation)) err('F', 'isolation must be sealed|tooled')
if (!['forbidden', 'allowed'].includes(form.invention)) err('F', 'invention must be forbidden|allowed')
if (!['request', 'document', 'runner'].includes(form.criteria_from))
  err('F', 'criteria_from must be request|document|runner')
if (typeof form.notes !== 'string')
  err('F', 'notes must be present as a string (may be empty)')

// C1: runs = 1 <=> merge = none (both directions).
if ((form.runs === 1) !== (form.merge === 'none'))
  err('C1', 'runs = 1 iff merge = none (both directions)')

// C2 + C6: anchors required for union/vote, absent otherwise, vocabulary code-checkable.
const needsAnchors = form.merge === 'union' || form.merge === 'vote'
if (needsAnchors) {
  if (form.anchors == null || typeof form.anchors !== 'object') {
    err('C2', `merge = ${form.merge} requires anchors`)
  } else if (!['closed_list', 'quote'].includes(form.anchors.kind)) {
    err('C6', 'anchors.kind must be closed_list|quote (free-form vocabularies are not permitted)')
  } else if (form.anchors.kind === 'closed_list' &&
    (!Array.isArray(form.anchors.values) || form.anchors.values.length === 0 ||
      !form.anchors.values.every(v => typeof v === 'string' && v.length > 0))) {
    err('C6', 'closed_list anchors require a non-empty string array in anchors.values')
  }
} else if ('anchors' in form) {
  err('C2', `anchors must be absent when merge = ${form.merge}`)
}

// C3: vote threshold present, sane, and only for vote.
if (form.merge === 'vote') {
  if (!Number.isInteger(form.vote_threshold) || form.vote_threshold < 2 ||
    form.vote_threshold > form.runs)
    err('C3', 'vote requires an integer vote_threshold with 2 <= threshold <= runs')
} else if ('vote_threshold' in form) {
  err('C3', 'vote_threshold must be absent unless merge = vote')
}

// C4: pick criterion + declared route; mechanical route needs a program.
if (form.merge === 'pick') {
  const p = form.pick
  if (p == null || typeof p !== 'object' || typeof p.criterion !== 'string' ||
    p.criterion.trim() === '' || !['mechanical', 'judged'].includes(p.route)) {
    err('C4', 'pick requires pick.criterion (non-empty) and pick.route = mechanical|judged')
  } else if (p.route === 'mechanical') {
    const prog = p.program
    if (prog == null || !['shortest', 'longest', 'command'].includes(prog.kind)) {
      err('C4', 'mechanical pick requires pick.program.kind = shortest|longest|command')
    } else if (prog.kind === 'command' &&
      (typeof prog.command !== 'string' || prog.command.trim() === '')) {
      err('C4', 'pick.program.kind = command requires pick.program.command')
    }
  } else if ('program' in p) {
    err('C4', 'pick.program must be absent when route = judged')
  }
} else if ('pick' in form) {
  err('C4', 'pick must be absent unless merge = pick')
}

// C5: referenced document must exist at form completion time.
if (form.criteria_from === 'document') {
  if (typeof form.criteria_ref !== 'string' || form.criteria_ref.trim() === '') {
    err('C5', 'criteria_from = document requires criteria_ref')
  } else if (!existsSync(form.criteria_ref)) {
    err('C5', `referenced document does not exist: ${form.criteria_ref}`)
  }
} else if ('criteria_ref' in form) {
  err('C5', 'criteria_ref must be absent unless criteria_from = document')
}

if (errors.length > 0) {
  console.log(errors.join('\n'))
  process.exit(1)
}
console.log('OK')
