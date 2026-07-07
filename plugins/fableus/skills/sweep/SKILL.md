---
name: sweep
description: "Use when the user wants EVERY instance found, not just a good answer — 'find all X', 'audit for all Y', 'catch every bug/case', 'exhaustive/complete review', 'don't miss any', 'full coverage', '빠짐없이 / 전부 찾아'. Spawns N independent finder subagents in parallel and unions their findings by a mechanical rule, because a single pass reliably misses a few items and independent passes miss *different* ones — so the union recovers what either alone drops. This is a recall tool. To gate the precision of one already-drafted answer instead, use /fableus:vet."
argument-hint: "<what to find> — the target defect or pattern to hunt exhaustively, and where"
---

# /fableus:sweep — Exhaustive-recall union sweep

For a "find every X" request, one pass is not enough and a sharper critic does
not fix it. Spawn N independent finder subagents in parallel over the same
mission, then union their findings with a pure mechanical rule. The recall win
comes entirely from independence: each pass misses a few items, but the misses
are uncorrelated, so what one pass drops the other tends to catch.

**Measured basis (B7, 2026-07-07 — 12 planted bugs in a fixture audit):**
- A single opus finder recalled 11/12, 11/12, 12/12 across three runs — and the
  misses differed run to run (one run dropped the tag bug, another the regex
  bug). No single pass is trustworthy for "all".
- Two *independent* passes, unioned, hit 12/12: the uncorrelated misses covered
  each other. A third pass added nothing.
- /fableus:vet on the same task (one draft plus three lens-validators) recalled
  11/12 at ~3x the cost. That is the tell: validators *check the draft's claims*
  (precision) — they do not *hunt what the draft never found* (recall). A "find
  all" request is a recall problem, so it wants N independent finders and a
  mechanical union, not the vet draft-and-verify structure.

**Language**: Deliver the union report in the user's conversation language. Like
/vet, sweep persists no document — its output lives only in this conversation
turn.

## Procedure

### 1. Frame the hunt
- Target = $ARGUMENTS: *what* to find and *where* (the scope). If either is
  unclear, pin it down in one line before spawning — every finder must run the
  exact same mission, or their misses stop being comparable and the union loses
  its meaning.
- Sanity-check the shape of the request. Sweep answers "did we find them all?"
  (recall). If the request is really "is this one answer correct?" (precision),
  that is /fableus:vet — redirect and stop.

### 2. Spawn N=2 independent finders, in parallel
- With the Agent tool, spawn **N=2** finder subagents (default model opus, with
  full read/search/run tool access — these must *measure* the codebase, so not
  the tool-less cold-reader). Issue them in **one message** so they run
  concurrently.
- Hand every finder the **identical** mission prompt, and tell none of them how
  many peers exist. Independence is the entire mechanism: two finders that
  share context or see each other's list develop *correlated* blind spots, and
  the union collapses back to a single pass's recall. Uncorrelated misses are
  the only reason two passes beat one (B7: the two runs dropped different bugs).
- Mission prompt to give each finder:

  ```
  Exhaustively hunt for <target> across <scope>. Find every instance — this is
  a recall task, missing one is the failure mode.

  For each finding, report exactly:
  - anchor: file:line
  - mechanism: one line — how the defect actually bites
  - evidence: what you measured to confirm it (a Read/Grep excerpt or a run you
    executed). No speculation. An unmeasured "maybe" is worthless here: it can't
    be mechanically merged and it pollutes the union — only report what you
    verified by looking.

  Return a flat list. Do not rank, dedupe against anything, or summarize.
  ```

### 3. Union — a pure mechanical rule, no judge
- Merge the finders' lists by a **fixed rule**, not by re-reading and deciding
  which findings are "real":
  - Two findings with **matching anchor AND matching mechanism** = the same
    finding. Merge into one entry and tag which passes found it.
  - Anything else = **keep both**. A near-duplicate you drop is exactly the item
    the second pass existed to catch; when in doubt, keep it.
- Do **not** hand the union to an LLM judge to reconcile. This is the same
  refusal spec-gate makes (D-10): the subjectivity you spun up independent
  finders to escape would creep straight back in at the aggregation step. The
  merge key stays mechanical — anchor + mechanism.
- Note the symmetry with spec-gate, which reuses the same independent-parallel
  machinery but takes the **intersection** (2-vote agreement) to gate
  *precision*. Sweep takes the **union** to maximize *recall*. Same readers,
  opposite aggregation — pick by whether you fear false positives or misses.

### 4. Adaptive termination
- Look at whether the two passes **disagreed**: does the union contain any
  finding that only one pass produced?
  - **Zero single-found items** (the passes returned the same set) → stop at
    N=2. Agreement is positive evidence there is nothing left to catch. B7:
    once the union hit 12/12 with the passes agreeing, a third pass yielded 0.
    That measurement is why N=2 is the default and escalation is on-evidence
    only, not automatic.
  - **≥1 single-found item** (the union is strictly larger than either pass) →
    the inter-pass misses are real, so more may be hiding. Spawn one more
    independent pass and union it in. Keep going while each added pass
    contributes a new finding; stop the round a pass adds zero.

### 5. Report the union
Present the merged list to the user. For each finding: anchor, mechanism,
evidence, and **which passes found it**. Split the list two ways:
- **Corroborated** (found by all passes) — high confidence.
- **Single-pass** (found by only one finder) — real recall value, but only one
  finder measured it, so flag each as a re-verification candidate. These are
  exactly where an independent second look pays off.

### 6. Optional handoff to /fableus:vet
Sweep maximizes recall — it does not check that each finding is *characterized*
correctly. If the user also wants each finding's claim gated for precision, hand
the union to /fableus:vet. The two tools are orthogonal: sweep = recall (did we
find everything?), vet = precision (is each claim right?).

## Do NOT
- Let finders see each other's output or know how many peers exist — shared
  context correlates their blind spots, and the union decays to single-pass
  recall.
- Resolve the union with an LLM judge or by "using judgment" — merge strictly by
  anchor + mechanism (D-10); the rejected subjectivity must not re-enter at
  aggregation.
