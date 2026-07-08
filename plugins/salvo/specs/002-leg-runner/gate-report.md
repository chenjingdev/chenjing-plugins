# Gate Report: leg — mid-range autonomous driving harness (/salvo:leg)

> spec: ./SPEC.md
> Pass rule: zero confirmed blocking = passed (G-4) · no round cap (stopping is the user's call) (G-8)

## Round 1 — 2026-07-08T09:45+09:00 — reader: opus ×3

**Verdict: passed**

Machine lint (pre-filter): mandatory sections populated, 0 `[NEEDS CLARIFICATION:` markers, 3,419 words. No warnings recorded.

All three readers returned **zero blocking issues** and an `implementable`
verdict. Confirmed blocking = 0 → passed. The table below aggregates the
discretionary/out-of-scope issues by anchor (informational only — they do not
block and, per G-4, the spec is not inflated to resolve them).

| # | Severity | Category | Title (anchor) | Votes | Status |
|---|---|---|---|---|---|
| R1-1 | discretionary | decision | Checkpoint capture mechanism & binding to post-declaration task indices (§2 checkpoint / MUST-8 / AC-8) | 3/3 | display-only |
| R1-2 | discretionary | term | "Same approach failed 2 times" — identity of an approach (§5 stuck) | 3/3 | display-only |
| R1-3 | discretionary | criteria | AC-2/AC-4 verify only via longitudinal dogfooding self-report (AC-2, AC-4) | 2/3 (+1 verdict mention) | display-only (A-6 already declares them provisional) |
| R1-4 | discretionary | decision | Concrete deliverable form — author as a salvo prompt skill mirroring vet/sweep (I-5) | 2/3 | display-only |
| R1-5 | discretionary | decision | Next-leg inheritance: re-declare using prior handoff as binding seed vs raw carry-forward (Flow 5 / A-4) | 2/3 | display-only (both readers resolve identically: re-declare) |
| R1-6 | discretionary | decision | First-line reason precedence when stop conditions co-fire (§2 ending_reason) | 2/3 | display-only (reporting vocabulary only) |
| R1-7 | discretionary | question | Placement/wording of the FR-010 cross-reference edit in 001-vet-v1 (MUST-7) | 2/3 | display-only |
| R1-8 | discretionary | decision | "Your turn" content when the ending has no fork — state "no decision required" (§2 Handoff / MUST-4) | 2/3 | display-only |
| R1-9 | out-of-scope | — | Runtime capability: a skill invoking other salvo skills inside a leg (Flow 3) | 2/3 | noted — see aggregation note 1 |
| R1-10 | discretionary | decision | Solo items (1/3 each): spec/plan discovery method (R2); cap_hit vs mission_complete labeling (R3); dropped-task completion semantics (R3); legs/ root & id allocation (R3); git commit behavior (R3); hook-reference self-containment (R3); handoff language detection (R1); checkpoint>declared-count clamping (R1) | 1/3 | display-only |

Aggregation notes:
1. R1-9 (skill-to-skill invocation) was raised as an infrastructure dependency
   by two readers. The writing session records the measured fact: salvo skills
   are prompt expansions executed by the session itself, and this very
   authoring session invoked /vet's engine and /spec-gate's readers from within
   a conversation — the capability the readers flagged as assumed is already
   exercised in production. No spec change needed.
2. R1-5: both raising readers independently resolved to the same reading
   (re-derive the declaration each leg, prior handoff and user edits as binding
   context), which matches I-4/I-10's per-leg declaration model. Recorded here
   so the implementer adopts that shared reading.
3. Merge basis: R1-1 merges three same-anchor/same-thesis items; R1-2, R1-3
   likewise. No same-anchor different-thesis splits were needed this round.

### Details

#### Reader 1 (opus)

### BLOCKING

none

### DISCRETIONARY

- **[decision] Concrete deliverable form / authoring mechanism (anchor: I-5, §1)** — how I would decide it: the document specifies behavior exhaustively but never names the artifact (SKILL.md vs. command file vs. code). Since I-5 settles packaging as `/salvo:leg` inside salvo, I would author it as a skill/command definition mirroring the existing `/salvo:vet`, `/salvo:sweep`, `/salvo:spec-gate` weapons' file layout; the container form does not alter any specified behavior.
- **[decision] How the checkpoint is supplied and indexed (anchor: MUST-8, A-1)** — how I would decide it: only the dial is called out as an argument (MAY). I would parse the "run through task N" checkpoint from the natural-language invocation, with N indexing the runner's own declared top-level list (task numbers exist only after the runner declares in Flow 1.3).
- **[decision] Next-leg re-declaration vs. carry-forward of the inherited/edited ledger (anchor: Flow 5, Flow 2.5.5, A-4)** — how I would decide it: Flow 5.2 says the next leg "starts Flow 1 step 3" (re-declare 1–4 tasks), while A-4 says user edits are "inherited." I would resolve this as: re-declare each leg, using the prior handoff and any user edits as binding context/seed, so unfinished tasks reappear in the new declaration but the list is re-derived (consistent with I-4/I-10's per-leg declaration model).
- **[decision] Precedence when several stop conditions fire at once (anchor: §3 running, §2 ending_reason)** — how I would decide it: the enum is "reporting vocabulary only," so behavior is identical; I would pick the most user-salient reason for the verdict's first line (preference_fork > checkpoint > cap_hit > stuck/unverifiable).
- **[decision] Handoff/report language detection (anchor: A-5)** — how I would decide it: write the handoff body in the user's conversation language inferred from the invocation context (Korean for this user), defaulting to the language the mission was written in.
- **[term] "Same approach" in the stuck rule (anchor: §5 stuck, §3 running(d))** — how I would decide it: treat as LLM judgment per I-3 — two attempts on one task sharing the same core hypothesis/method counts as the same approach; the count of 2 and the per-task scope are explicit.
- **[criteria] AC-2 / AC-4 subjective dogfooding thresholds (anchor: AC-2, AC-4)** — how I would decide it: these verify only by human self-report over ≥10 legs and cannot be checked at build time; per A-6 I would implement the behavior and treat 8/10 and 7/10 as provisional post-hoc gates, not implementation blockers. AC-1/5/6/7/8 remain mechanically checkable.
- **[question] Location and wording of the FR-010 cross-reference in 001-vet-v1 (anchor: MUST-7)** — how I would decide it: locate 001-vet-v1's spec in the repo and add a one-line cross-reference near FR-010 pointing to this system's MUST-7; the exact placement/wording is minor and does not fork behavior.
- **[decision] Under-specified edge cases (anchor: §2 Handoff §2 "Your turn", MUST-8)** — how I would decide it: empty "Your turn" on `mission_complete` → state "nothing needed"; checkpoint N greater than the declared count → clamp to run-to-completion; parent whose subtasks are all `dropped` → parent `dropped`/`not_done` with reason.

### OUT-OF-SCOPE

- The runtime mechanism by which the runner invokes another salvo command (`/salvo:vet` etc.) from inside a leg — the spec assumes nested command invocation works (I-5, Flow 3); whether the plugin runtime supports it is an infrastructure concern, not a behavioral item in this document.

### VERDICT

`implementable` — This spec is unusually complete: the Decision Ledger, Assumptions, Error Taxonomy, and MUST/SHOULD/MAY layers close every major fork, so nothing forks the implementation direction. It is over-detailed on rationale and ending-reason taxonomy (twelve ledger entries plus eight assumptions for what is ultimately one LLM-instruction artifact), and under-detailed on the concrete deliverable form, the cross-command invocation mechanism (Flow 3), and how the checkpoint reaches the runner — all resolvable at discretion.

#### Reader 2 (opus)

### BLOCKING
none

### DISCRETIONARY
- **[decision] Checkpoint expression and binding to a not-yet-declared task (anchor: §2 `checkpoint` / MUST-8 / AC-8)** — how I would decide it: the user phrases "run through task N" inline in the invocation; the runner parses it in natural language (it is not in the MAY dial-syntax delegation, but the tool is a prompt skill so intent-parsing is inherent) and binds N to the Nth top-level *declared* task after declaration. If fewer than N tasks are declared, the checkpoint is simply never reached and the leg ends on `mission_complete`/`cap_hit`. The behavior itself (stop after top-level task N even with budget left) is unambiguous in MUST-8/AC-8, so the residual risk is low.
- **[term] "project spec/plan documents that already exist" discovery (anchor: Flow 1.2 / MUST-9)** — how I would decide it: search the repo's conventional spec location (the numbered-spec convention implied by the `001-vet-v1` reference); if none is found, proceed with coarse declaration and skip contradiction detection. Absence only coarsens declaration; it does not fork scope.
- **[decision] "same approach failed 2 times" identity of an "approach" (anchor: §2 `stuck` / Error Taxonomy)** — how I would decide it: treat this as an LLM-judgment call analogous to fork detection (which MAY delegates), counting two failed attempts of the same hypothesis/strategy on one task; list the attempted hypotheses per the taxonomy row.
- **[decision] "Your turn" content when the ending has no preference fork (anchor: §2 Handoff §2 / MUST-4)** — how I would decide it: for `mission_complete`/`cap_hit`/etc. with no fork, keep the section present but state "no decision required"; direction items live in Next-leg candidates (section 4).
- **[decision] Deliverable form and how the "mechanical cap" is enforced (anchor: I-3 / I-5)** — how I would decide it: implement as a salvo prompt skill (consistent with vet/sweep/spec-gate as siblings and I-5 packaging); enforce the dial as a hard numeric rule stated in the prompt ("declare at most N top-level tasks; never add top-level tasks after declaration"), not a separate code harness. "Mechanical" reads as *a fixed number, not a judgment*, relative to the LLM fork layer.
- **[decision] MUST-7 cross-reference edit into the vet spec (anchor: MUST-7)** — how I would decide it: locate `001-vet-v1` in the repo's spec directory and append the FR-010 delegation cross-reference note; the *what* is fixed, only the file path is discretionary.
- **[criteria] AC-2 / AC-4 are validated only by longitudinal dogfooding self-report (anchor: AC-2, AC-4)** — how I would decide it: these cannot be verified at build/delivery time; treat them as dogfooding gates deferred per A-6, not blocking acceptance of the implementation. No build-time instrumentation is required by the spec.
- **[criteria] AC-3 jargon gate / AC-6 forcing all six endings are non-mechanical (anchor: AC-3, AC-6)** — how I would decide it: implement AC-3 to the MUST-5 standard and validate by human review, treating "technical term" as any implementation/codebase term lacking an in-place gloss; for AC-6, construct six contrived scenarios and accept that LLM nondeterminism means the test asserts the *handoff-with-reason-first* contract rather than deterministic reason selection.

### OUT-OF-SCOPE
- **Platform capability — a skill invoking other salvo skills (Flow 3):** the weapon-use flow presumes the runtime lets one skill call `/salvo:vet|sweep|spec-gate`. This is an assumed platform capability (the spec treats salvo weapons as already existing and invocable), not something this spec defines; if the runtime cannot do skill-to-skill invocation, Flow 3 is unbuildable, but that is an infrastructure dependency outside the spec's control.
- **v2 backlog surfaces** — cross-project queue/dashboard and the live auto-refresh HTML leg view are explicitly deferred (§1 Out of scope, I-6, I-7).

### VERDICT
`implementable`. Over-detailed: the Decision Ledger (I-0…I-12) and Assumptions (A-1…A-8) exhaustively pin config, rationale, and rejected alternatives, and the stop conditions are restated three times (§3 state table, §4 Flow 2.3, §5 taxonomy). Under-detailed but resolvable by convention/judgment: the discovery mechanism for existing spec/plan documents, the checkpoint invocation syntax and its binding to runner-declared task indices, and whether the "mechanical cap" is a prompt rule or code — all low-divergence-risk given the delivery=skill decision.

#### Reader 3 (opus)

### BLOCKING
None. See VERDICT — every gap I found resolves against the Decision Ledger, the ACs, or the MAY delegations, without forking scope or direction.

### DISCRETIONARY
- **[decision] Checkpoint capture mechanism and indexing (anchor: §2 Leg.checkpoint / MUST-8 / AC-8)** — how I would decide it: the spec defines the checkpoint but never says how the user supplies it (unlike the dial, whose argument syntax is MAY-delegated), and "task N" references a list the runner declares *after* invocation under declare-then-go (A-2). I would parse it from natural-language scope in the invocation ("through task 2") and also accept an explicit int, mapping N to the Nth top-level declared entry by declaration order (a dropped task keeps its slot). It is chiefly meaningful once a prior leg's ledger exists; on a first leg it applies to the runner's fresh declaration order. Both readings satisfy MUST-8/AC-8, so risk is low.
- **[decision] Continuation-leg task sourcing on inheritance (anchor: Flow 5 / A-4)** — how I would decide it: the spec says a new leg "reads the latest handoff … and starts Flow 1 step 3 with that context" but does not say whether prior `not_done` top-level tasks are auto-carried or re-derived. I would follow the per-leg-declaration model (I-4): fold prior `not_done` tasks + next-leg candidates + the user's answers into a fresh ≤4 top-level declaration that preserves their intent, rather than auto-populating raw entries.
- **[decision] cap_hit vs mission_complete labeling (anchor: §2 ending_reason / AC-5)** — how I would decide it: distinguish by LLM judgment — `mission_complete` only when the mission is judged fully satisfied; `cap_hit` when declared tasks are done but the mission's natural scope has an undeclared remainder (listed as next-leg candidates). Since ending_reason is "reporting vocabulary only," a mislabel changes only the first line, not behavior.
- **[criteria] "all declared tasks done" vs a dropped top-level task (anchor: §3 running(b) / §2 mission_complete)** — how I would decide it: read stop-condition (b) as "all non-dropped top-level tasks done," mirroring the stated parent-done-when-all-non-dropped-subtasks rule.
- **[term] "same approach failed 2 times" (anchor: §2 ending_reason.stuck / §5)** — how I would decide it: treat as the LLM-judgment layer — two materially-similar failed attempts (same hypothesis/fix strategy) on one task triggers `stuck`; the required output (list attempted hypotheses in plain language, recommend fresh-eye handover) is fully stated, so the fuzzy "same approach" boundary is low-stakes.
- **[decision] First-line reason precedence when stop conditions co-fire (anchor: Flow 4 / §2 ending_reason)** — how I would decide it: pick by recovery value, preference_fork > checkpoint > stuck/unverifiable > cap_hit > mission_complete. Reporting-only, low-stakes.
- **[decision] legs/ root resolution, directory creation, id allocation (anchor: A-3 / §2 id)** — how I would decide it: project root = git top-level (fallback cwd); create `legs/` if absent; id = max existing 3-digit + 1, else 001.
- **[decision] Runner git/commit behavior (anchor: §1 / Flow 2)** — how I would decide it: the spec is silent on committing; since the handoff carries file/line refs for review, I would leave changes in the working tree and not auto-commit unless the mission asks.
- **[term] "salvo hook's stuck-escape rule" reference (anchor: §5 stuck)** — how I would decide it: implement the behavior stated inline (recommend fresh-eye handover, list hypotheses); the external hook is cited only for consistency and the needed behavior is self-contained here.

### OUT-OF-SCOPE
- Physical location of the salvo plugin compartment and the `001-vet-v1` spec file that MUST-7 requires me to edit with a cross-reference — repo layout is not in the document; I would locate them in the repo at implementation time.
- General agent action-safety (guarding destructive commands, permission prompts during autonomous execution) — the spec's only stop trigger is the product-preference fork, not safety; this is the platform permission system's job.

### VERDICT
implementable. Over-detailed: the six-value `ending_reason` enum, the parallel §5 error taxonomy, and 12 ledger decisions all converge on one behavior ("write the handoff, reason first"), and the MAY block already absorbs the genuinely fuzzy judgment work. Under-detailed: the checkpoint capture mechanism and the cross-leg task-inheritance mechanics are left implicit, and the primary success criteria (AC-2, AC-4) are subjective dogfooding self-reports with no build-time mechanical check — acceptable per A-6, but they gate on a human campaign rather than the implementation.
