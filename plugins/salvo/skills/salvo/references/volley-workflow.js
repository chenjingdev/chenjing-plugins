export const meta = {
  name: 'salvo-volley',
  description: 'Fire N starved shooters in parallel and fold their outputs by code',
  phases: [
    { title: 'Fire', detail: 'N starved shooters in parallel' },
    { title: 'Fold', detail: 'code tally / judge pick' },
  ],
}

// args (built by the /salvo door from the intake form):
//   form: IntakeForm            — the completed form, verbatim
//   shooterPrompt: string       — the ONLY thing a shooter ever sees (M2)
//   target: string|null         — target text; required when anchors.kind === 'quote'
//   model: string|null          — tier override only when the user named one (A5)
//
// Returns exactly one of (see SKILL.md §6):
//   {kind:'single', result} | {kind:'folded', ...} | {kind:'picked', ...}
//   | {kind:'candidates', ...} | {kind:'void', reason}

const form = args.form
const N = form.volley
const sealed = form.isolation === 'sealed'

// Sealed shooters run as the no-tools salvo:shooter agent; tooled shooters use
// the default workflow agent. Both are starved of conversation history by
// construction — the prompt is all they get (M2).
const agentOpts = () => {
  const o = {}
  if (sealed) o.agentType = 'salvo:shooter'
  if (args.model) o.model = args.model
  return o
}

// Dispatch-layer conformance re-requests (M11). Never a retry of a *failed*
// shooter (M8) — only a rejection of non-conforming output at the source.
const RE_REQUESTS = 2

phase('Fire')

// ---- fold: none (volley 1 — delegation / single shot) ----------------------
if (form.fold === 'none') {
  const result = await agent(args.shooterPrompt, { ...agentOpts(), label: 'shot:1', phase: 'Fire' })
  if (result === null) return { kind: 'void', reason: 'the single shooter failed to complete' }
  return { kind: 'single', result }
}

// ---- fold: union / vote (counting — pure code, M1) --------------------------
if (form.fold === 'union' || form.fold === 'vote') {
  const FINDINGS = {
    type: 'object',
    additionalProperties: false,
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['anchor', 'content'],
          properties: {
            // Closed-list vocabularies are enforced INSIDE the schema (I-6);
            // quote vocabularies are substring-validated below.
            anchor: form.anchors.kind === 'closed_list'
              ? { type: 'string', enum: form.anchors.values }
              : { type: 'string', minLength: 1 },
            content: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  }

  const quoteInvalid = findings =>
    findings.filter(f => !args.target.includes(f.anchor)).map(f => f.anchor)

  const fireOne = async i => {
    let prompt = args.shooterPrompt
    for (let attempt = 0; attempt <= RE_REQUESTS; attempt++) {
      const out = await agent(prompt, { ...agentOpts(), schema: FINDINGS, label: `shot:${i + 1}`, phase: 'Fire' })
      if (out === null) return null // shooter failed — no retry (M8)
      if (form.anchors.kind === 'closed_list') return out.findings
      const bad = quoteInvalid(out.findings)
      if (bad.length === 0) return out.findings
      log(`shot:${i + 1} returned ${bad.length} non-verbatim anchor(s); re-requesting (${attempt + 1}/${RE_REQUESTS})`)
      prompt = args.shooterPrompt +
        `\n\nYour previous output was rejected: these anchor values are not verbatim substrings of the target: ${JSON.stringify(bad)}. Every anchor must be copied character-for-character from the target text.`
    }
    return null // still non-conforming after re-requests → counts as failed (M11)
  }

  const perShooter = await parallel(Array.from({ length: N }, (_, i) => () => fireOne(i)))
  const failed = perShooter.map((r, i) => (r === null ? i + 1 : null)).filter(x => x !== null)
  if (failed.length > 0) {
    return { kind: 'void', reason: `shooter(s) ${failed.join(', ')} failed or stayed non-conforming — no partial fold` }
  }

  phase('Fold')
  // Anchor identity: exact equality for closed lists; exact equality or span
  // overlap for quotes (both anchors are verified substrings by now).
  const span = anchor => {
    const start = args.target.indexOf(anchor)
    return [start, start + anchor.length]
  }
  const sameAnchor = (a, b) => {
    if (form.anchors.kind === 'closed_list') return a === b
    if (a === b) return true
    const [s1, e1] = span(a)
    const [s2, e2] = span(b)
    return s1 < e2 && s2 < e1
  }
  const groups = []
  perShooter.forEach((findings, shooter) => {
    for (const f of findings) {
      const g = groups.find(g => sameAnchor(g.anchor, f.anchor))
      if (g) {
        if (f.anchor.length > g.anchor.length) g.anchor = f.anchor // longest member represents the group
        g.entries.push({ shooter: shooter + 1, anchor: f.anchor, content: f.content })
      } else {
        groups.push({ anchor: f.anchor, entries: [{ shooter: shooter + 1, anchor: f.anchor, content: f.content }] })
      }
    }
  })
  for (const g of groups) g.count = new Set(g.entries.map(e => e.shooter)).size

  if (form.fold === 'union') {
    return {
      kind: 'folded', fold: 'union', volley: N,
      items: groups.map(g => ({ anchor: g.anchor, count: g.count, entries: g.entries })),
    }
  }
  const kept = groups.filter(g => g.count >= form.vote_threshold)
  return {
    kind: 'folded', fold: 'vote', volley: N, threshold: form.vote_threshold,
    items: kept.map(g => ({ anchor: g.anchor, count: g.count, entries: g.entries })),
    dropped: groups.length - kept.length,
  }
}

// ---- fold: pick -------------------------------------------------------------
throw new Error('pick: implemented in the next commit')
