// run-workflow.js — a Workflow-tool sandbox script, NOT a node module.
// It runs inside the Workflow tool's sandbox and relies on sandbox features a
// plain `node` run does not provide: top-level `return`, the injected globals
// (agent / parallel / log / phase / args / budget), and a pure-literal
// `export const meta`. That is why it lives under references/ and not scripts/:
// putting it in scripts/ would wrongly imply `node` can execute it. The test
// harness reads this exact file, strips the `export ` keyword, and wraps the
// body in an AsyncFunction so the merge logic is tested as it ships.

export const meta = {
  name: 'psepha-run',
  description: 'Run N independent isolated agents in parallel and merge their outputs by code',
  phases: [
    { title: 'Run', detail: 'N isolated runners in parallel' },
    { title: 'Merge', detail: 'code tally / judge pick' },
  ],
}

// args (built by the /psepha door from the intake form):
//   form: IntakeForm            — the completed form, verbatim
//   runnerPrompt: string        — the ONLY thing a runner ever sees (M2)
//   target: string|null         — target text; required when anchors.kind === 'quote'
//   model: string|null          — tier override only when the user named one (A5)
//
// Returns exactly one of (see SKILL.md §6):
//   {kind:'single', result} | {kind:'merged', ...} | {kind:'picked', ...}
//   | {kind:'candidates', ...} | {kind:'void', reason}

// args may arrive as a JSON string depending on the caller's serialization
// path — normalize before reading anything (stringified args would otherwise
// crash the run before a single runner starts; caught by the v0.6.0 smoke).
const input = typeof args === 'string' ? JSON.parse(args) : args

const form = input.form
const N = form.runs
const sealed = form.isolation === 'sealed'

// Sealed runs use the no-tools psepha:runner agent; tooled runs use the default
// workflow agent. Both are isolated from conversation history by construction —
// the prompt is all they get (M2).
const agentOpts = () => {
  const o = {}
  if (sealed) o.agentType = 'psepha:runner'
  if (input.model) o.model = input.model
  return o
}

// Dispatch-layer conformance re-requests (M11). Never a retry of a *failed*
// run (M8) — only a rejection of non-conforming output at the source.
const RE_REQUESTS = 2

phase('Run')

// ---- merge: none (runs 1 — delegation / single run) ------------------------
if (form.merge === 'none') {
  const result = await agent(input.runnerPrompt, { ...agentOpts(), label: 'run:1', phase: 'Run' })
  if (result === null) return { kind: 'void', reason: 'the single run failed to complete' }
  return { kind: 'single', result }
}

// ---- merge: union / vote (counting — pure code, M1) ------------------------
if (form.merge === 'union' || form.merge === 'vote') {
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
    findings.filter(f => !input.target.includes(f.anchor)).map(f => f.anchor)

  const runOne = async i => {
    let prompt = input.runnerPrompt
    for (let attempt = 0; attempt <= RE_REQUESTS; attempt++) {
      const out = await agent(prompt, { ...agentOpts(), schema: FINDINGS, label: `run:${i + 1}`, phase: 'Run' })
      if (out === null) return null // run failed — no retry (M8)
      if (form.anchors.kind === 'closed_list') return out.findings
      const bad = quoteInvalid(out.findings)
      if (bad.length === 0) return out.findings
      log(`run:${i + 1} returned ${bad.length} non-verbatim anchor(s); re-requesting (${attempt + 1}/${RE_REQUESTS})`)
      prompt = input.runnerPrompt +
        `\n\nYour previous output was rejected: these anchor values are not verbatim substrings of the target: ${JSON.stringify(bad)}. Every anchor must be copied character-for-character from the target text.`
    }
    return null // still non-conforming after re-requests → counts as failed (M11)
  }

  const perRun = await parallel(Array.from({ length: N }, (_, i) => () => runOne(i)))
  const failed = perRun.map((r, i) => (r === null ? i + 1 : null)).filter(x => x !== null)
  if (failed.length > 0) {
    return { kind: 'void', reason: `run(s) ${failed.join(', ')} failed or stayed non-conforming — no partial merge` }
  }

  phase('Merge')
  // Anchor identity: exact equality for closed lists; exact equality or span
  // overlap for quotes (both anchors are verified substrings by now).
  const span = anchor => {
    const start = input.target.indexOf(anchor)
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
  perRun.forEach((findings, runIdx) => {
    for (const f of findings) {
      const g = groups.find(g => sameAnchor(g.anchor, f.anchor))
      if (g) {
        if (f.anchor.length > g.anchor.length) g.anchor = f.anchor // longest member represents the group
        g.entries.push({ run: runIdx + 1, anchor: f.anchor, content: f.content })
      } else {
        groups.push({ anchor: f.anchor, entries: [{ run: runIdx + 1, anchor: f.anchor, content: f.content }] })
      }
    }
  })
  for (const g of groups) g.count = new Set(g.entries.map(e => e.run)).size

  if (form.merge === 'union') {
    return {
      kind: 'merged', merge: 'union', runs: N,
      items: groups.map(g => ({ anchor: g.anchor, count: g.count, entries: g.entries })),
    }
  }
  const kept = groups.filter(g => g.count >= form.vote_threshold)
  return {
    kind: 'merged', merge: 'vote', runs: N, threshold: form.vote_threshold,
    items: kept.map(g => ({ anchor: g.anchor, count: g.count, entries: g.entries })),
    dropped: groups.length - kept.length,
  }
}

// ---- merge: pick -----------------------------------------------------------
// Each run returns one complete candidate artifact (§2.3).
const CANDIDATE = {
  type: 'object',
  additionalProperties: false,
  required: ['candidate'],
  properties: { candidate: { type: 'string', minLength: 1 } },
}
const outputs = await parallel(Array.from({ length: N }, (_, i) => () =>
  agent(input.runnerPrompt, { ...agentOpts(), schema: CANDIDATE, label: `run:${i + 1}`, phase: 'Run' })))
const failedRuns = outputs.map((r, i) => (r === null ? i + 1 : null)).filter(x => x !== null)
if (failedRuns.length > 0) {
  return { kind: 'void', reason: `run(s) ${failedRuns.join(', ')} failed — no partial merge` }
}
const candidates = outputs.map(s => s.candidate)

phase('Merge')
const pick = form.pick
if (pick.route === 'mechanical') {
  if (pick.program.kind === 'shortest' || pick.program.kind === 'longest') {
    let choice = 0
    for (let i = 1; i < candidates.length; i++) {
      const better = pick.program.kind === 'shortest'
        ? candidates[i].length < candidates[choice].length
        : candidates[i].length > candidates[choice].length
      if (better) choice = i
    }
    return { kind: 'picked', route: 'mechanical', program: pick.program.kind, choice, candidates }
  }
  // kind === 'command': the stated test command must run outside this sandbox —
  // hand the conforming candidates back for scripts/pick_command.mjs.
  return { kind: 'candidates', route: 'mechanical', program: 'command', candidates }
}

// route === 'judged': ONE isolated judge — candidates + criterion text only (M2).
// A judge failure voids the run like a runner failure (§4 step 10).
const judgePrompt = [
  'You are the judge of a psepha pick. Select exactly one candidate by this criterion:',
  pick.criterion,
  '',
  ...candidates.map((c, i) => `--- CANDIDATE ${i + 1} ---\n${c}`),
  '',
  `Return the chosen candidate's number (1-${N}) and one sentence of grounds.`,
].join('\n')
const judgeOpts = { agentType: 'psepha:runner', label: 'judge', phase: 'Merge' }
if (input.model) judgeOpts.model = input.model
const verdict = await agent(judgePrompt, {
  ...judgeOpts,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['choice', 'grounds'],
    properties: {
      choice: { type: 'integer', minimum: 1, maximum: N },
      grounds: { type: 'string' },
    },
  },
})
if (verdict === null) return { kind: 'void', reason: 'the pick judge failed — no selection' }
return { kind: 'picked', route: 'judged', choice: verdict.choice - 1, grounds: verdict.grounds, candidates }
