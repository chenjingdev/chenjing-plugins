---
name: vet
description: "Use when the user runs /fableus:vet — an opt-in answer gate for one important question: draft the answer as C-n anchored atomic claims, verify it in parallel with 3 different-lens validators (fixed to opus), and reflect only 2-vote confirmed rebuttals."
argument-hint: "<question> — the important question to verify before answering"
disable-model-invocation: true
---

# /fableus:vet — Opt-in answer gate

For one important question: the session drafts C-n claims with premises
measured directly, the bundled engine
(`${CLAUDE_PLUGIN_ROOT}/skills/vet/engine.js`) spawns 3 different-lens
validators (fixed to opus) in parallel, and pure code aggregates only
(anchor + category) 2-vote agreement into confirmed rebuttals. The session
revises by reflecting only confirmed rebuttals and shows the change log
transparently. This skill is manual opt-in only — the layer-1/layer-2
discipline does not auto-trigger it (FR-010).

**Not for coverage requests.** /vet gates the *precision* of one answer — its
validators verify the draft's claims, they do not hunt what the draft missed.
For a "find all X" / audit / exhaustive-review request (a recall problem), use
/fableus:sweep instead.

**Language**: Deliver the /vet answer and its change log in the user's
conversation language. (Unlike /spec and /spec-gate, /vet produces no persisted
document — its output lives only in this conversation turn.)

## Procedure

### 1. Input
- Question = $ARGUMENTS. If empty, use the question only when it is obvious from
  the immediately preceding conversation; otherwise ask for it in one line.
- If the question is too large to fit in a single turn, reject it and recommend
  narrowing it (no splitting).

### 2. Draft (written by the session itself)
- Decompose the question into sub-questions and **measure the premises
  directly** (verify files with Read/Grep/Glob — do not defer this to the
  validators).
- Break the answer into atomic claims and prefix each claim with a stable
  anchor:

  ```
  - C-1: <atomic claim 1> (evidence: <file:line or reasoning>)
  - C-2: <atomic claim 2> …
  ```
- Draft model = whatever this session's model already is (FR-011). Only in the
  bench does the author run it from an opus session to pin the draft to opus —
  the skill has no separate bench branch.

### 3. Verification (engine call, round 1)
`Workflow({scriptPath: '${CLAUDE_PLUGIN_ROOT}/skills/vet/engine.js', args: {question: <question>, draft: <full draft>, round: 1}})`

- Pass `args` as a **real JSON object** — do not wrap it as a JSON string.
- If `${CLAUDE_PLUGIN_ROOT}` remains literally in the path, use this skill's
  base directory + `/engine.js`.
- If the return has an `error` (e.g., a missing anchor), fix the draft and call
  again.

### 4. Handling the result
- **`unverified: true`** → deliver the draft as-is with no revision, but put a
  banner at the top:
  `⚠ Verification incomplete — validators failed (<failedLenses>), still failing after 1 retry. The answer below is an unverified draft.`
  Stop (FR-017 — never swallow the answer).
- **Zero confirmed rebuttals** → the draft is final immediately. Do not run
  re-verification (0 extra calls, SC-003). Go to step 5 and close out with
  "no changes".
- **≥1 confirmed rebuttal** → revise the draft to reflect all confirmed
  rebuttals. Preserve anchors when revising (the same claim keeps the same C-n;
  do not reuse a number when a claim is deleted). Do not use informational
  rebuttals as grounds for a revision (FR-015 — display only). Then:
  **re-verify exactly once** — call the engine again with the full revised
  draft at `round: 2` (FR-016, full re-verification). If confirmed rebuttals
  remain in the round 2 result, reflect them but mark them "unresolved" and
  stop — there is no third call.

### 5. Final output (in one message)
The final answer body + a change-log section:

```
## Change log (/vet)
- C-3 [fact-error · 2 votes (fact,logic)]: "<gist before>" → "<gist after>" — evidence: <evidence summary>
- (r2 unresolved) C-7 [logic-flaw · 2 votes]: <what was reflected> — persisted at re-verification, reflected then stopped
- (informational · no forced revision) C-5 [unsupported · 1 vote (intent)]: <gist>
- Verification cost: <sum of stats.validatorCalls> validator calls (r1: N, r2: M)
```

If there are zero confirmed rebuttals, make the first line
`- No changes (0 confirmed rebuttals)`.
The `/vet` output exists only in this conversation turn — do not save it to a
file (one-shot).

## Do NOT
- Force a revision based on an informational (1-vote) rebuttal (FR-015).
- A third verification / convergence loop (FR-016 — re-verification is exactly
  once, only when revising).
- Proceed on a partial aggregation or withhold the answer (FR-017).
- Run a best-of-N competition among multiple drafts — out of scope for v1 (FR-019).
- Pass only a file path to the validators — the engine passes the draft inline
  (FR-013).
