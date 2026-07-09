# System Specification: salvo — parallel-run platform (/salvo door)

**Created**: 2026-07-09
**Status**: Draft
**Gate**: passed

<!-- A system-level implementation contract.
     Principle: nail down all the "axes" (state, boundaries, contracts, error
     taxonomy) and delegate the "values" (algorithm details, field names,
     formats) as implementation-defined. No pseudocode. -->

## 1. Purpose & Scope

The salvo plugin's founding claim is: **one LLM pass is a guess; a salvo — N
independent passes merged by pure code — is a measurement.** This spec defines
the platform that turns that claim into a single user-facing door, the
`/salvo` command: the user states work in plain language, and the platform
routes it to a registered preset, fills an ad-hoc intake form, dispatches it
as a single-run delegation, or rejects it — all decided by one mechanism, the
**intake form**. All actual work runs **outside the invoking
session** (in subagent/workflow sessions); the invoking session only routes,
announces, merges, reports, and archives.

Vocabulary used throughout (each defined in §2):

- **Run**: one execution — an independent subagent/workflow run of the task.
- **Run set**: the N independent runs fired in parallel plus a declared merge
  rule.
- **Intake form**: the typed form every piece of /salvo work fills before
  dispatch; also the routing mechanism itself.
- **Fill the form**: the internal procedure that fills an intake form from
  scratch when no preset matches. Not a separate user command.
- **Merge**: the aggregation of run outputs. Counting merges (`union`/`vote`)
  are pure code — never an LLM judgment. `pick` selection is mechanical or
  judged per its declared route (§2.1), labeled per M6.
- **Delegation**: the degenerate case — a run set of 1, merge `none` — for
  work that has value outside the session but cannot be merged.
- **Run record**: the archived intake form left after every dispatch; the raw
  material for later promotion of ad-hoc forms into presets.

**In scope (v1)**

1. The `/salvo` routing surface (single door).
2. The intake form schema and its coherence rules.
3. The form-filling procedure (ad-hoc forms).
4. Delegation (single-run dispatch) under the same form.
5. Rejection and referral behavior.
6. Run-record archiving.
7. The preset discovery contract (so promoted forms have a defined landing
   place), even though v1 ships with zero presets.

**Out of scope (v1)**

- Re-registering the legacy presets (sweep, vet).
- The promotion procedure itself (turning a run record into a preset).
- New named presets (split, fork-detection, plain-handoff).
- Any engine, ledger state machine, or self-running loop: **the platform never
  auto-repeats a run set.** Re-running is an explicit user (or driving-session)
  act.
- The `/spec` door and its gate (already shipped separately, v0.5.1).
- Cost accounting, token budgeting, benchmarking harnesses.

## 2. Domain Model

### 2.1 IntakeForm

The single contract type: a definition, the typed fields below, and a notes
valve. Persistent (archived as a run record; also stored inside presets).

| Field | Type | Constraint |
|---|---|---|
| `definition` | string, 1–2 sentences | What difference this run set measures: names the input target and the output shape (e.g. "enumerates contradictions in a given document, emitting one finding per section"). |
| `merge` | enum `union` \| `vote` \| `pick` \| `none` | `union`: merge all outputs, dedup by anchor. `vote`: keep items raised by ≥ threshold runs, matched by anchor. `pick`: select 1 of N outputs per `pick_criterion` and its declared route. `none`: no aggregation — legal only when `runs` = 1. |
| `vote_threshold` | integer ≥ 2 | Required iff `merge` = `vote`. Default: majority = floor(runs/2) + 1. |
| `pick_criterion` | string + route enum `mechanical` \| `judged` | Required iff `merge` = `pick`. The form-filling step declares the evaluation route in the form. `mechanical`: the criterion is code-checkable (e.g. "shortest candidate that passes the stated test command"); a deterministic program evaluates it, running the stated command against candidates when the criterion names one. `judged`: the criterion is free text; an isolated judge agent (input: the N candidate artifacts + the criterion text, nothing else) selects one candidate — the report labels the selection as judgment (M6). |
| `runs` | integer ≥ 1 | Number of runs fired in parallel. `runs` = 1 ⇔ `merge` = `none` (both directions). Default 3. Values > 5 require an explicit user request for that scale. |
| `isolation` | enum `sealed` \| `tooled` | The run set's independence level. `sealed`: runs get no tools and no repository access — target content is embedded in the runner prompt. `tooled`: runs may use tools / touch the repository (required when the target is the repository itself, e.g. code search or a delegation that edits files). Both levels are isolated from conversation history and sibling outputs (M2). |
| `invention` | enum `forbidden` \| `allowed` | `forbidden`: runs may only report what is present in the target; the runner prompt must state this. `allowed`: runs may produce new content (generation-type runs, delegations). |
| `criteria_from` | enum `request` \| `document` \| `runner` | Where judgment criteria come from: the user's request text, a named document (then a path/reference is attached), or the runner's own judgment. |
| `anchors` | string | The identity key the merge matches on. Required iff `merge` ∈ {`union`, `vote`}. Must declare a mechanically checkable vocabulary, one of: (a) a closed list extracted from the target by code at form time (e.g. its section numbers, file paths) and embedded in the runner output schema as the allowed values, or (b) verbatim quotation from the target (code-validated as a substring of the target; matched by exact equality or span overlap). Free-form anchor strings are not permitted. Absent otherwise. |
| `notes` | string, may be empty | The valve: any constraint that fits no field above. Repeated appearance of the same kind of note across run records is the signal that the form needs a new field (form evolution — out of scope to automate). |

**Coherence rules (mechanical, checkable without an LLM):**

- C1: `runs` = 1 ⇔ `merge` = `none`.
- C2: `merge` ∈ {`union`, `vote`} ⇒ `anchors` present.
- C3: `merge` = `vote` ⇒ `vote_threshold` present and ≤ `runs`.
- C4: `merge` = `pick` ⇒ `pick_criterion` present, with its route declared
  (`mechanical` \| `judged`).
- C5: `criteria_from` = `document` ⇒ the referenced document exists at form
  completion time.
- C6: `merge` ∈ {`union`, `vote`} ⇒ the `anchors` vocabulary is one of the two
  code-checkable kinds (closed list or verbatim quote).

**Every field has a reader** (a form field with no consuming code/procedure
is forbidden):

| Field | Reader |
|---|---|
| `definition` | Router (preset matching), runner prompt construction, report header |
| `merge` (+ `vote_threshold`, `pick_criterion` + route) | Merge step (selects the rule; evaluates mechanical pick); judge-agent dispatch (judged pick); router (merge = `none` ⇒ delegation path) |
| `runs` | Dispatch step (how many runs to spawn) |
| `isolation` | Dispatch step (grants or withholds tools/repository access per run) |
| `invention` | Runner prompt construction (adds/omits the no-invention clause) |
| `criteria_from` | Runner prompt construction (embeds request text or document content) |
| `anchors` | Merge step (dedup / vote matching key) |
| `notes` | Form-filling (applies it as a runner-prompt or merge constraint); human review of run records (form-evolution signal) |

### 2.2 Preset and ad-hoc forms

- **Preset** (persistent): a skill directory that contains an intake form
  file. The set of skills carrying an intake form file **is** the registry —
  there is no separate index file. v1 ships zero presets; the contract exists
  so promotion has a landing place.
- **Ad-hoc form** (ephemeral): an intake form filled for one dispatch, plus
  the runner prompt built from it. It lives for one run set; only its form
  survives (as a run record).

### 2.3 Run set, Run, Report

- **Run** (ephemeral): one subagent/workflow execution. Receives ONLY the
  runner prompt built from the form (plus embedded target content per
  `criteria_from`). Receives no conversation history and no sibling output
  (isolated).
- **Run output contract**: when `merge` ∈ {`union`, `vote`}, every run MUST
  return a machine-parseable list of `{anchor, content}` records. This is
  enforced by an output schema at the dispatch layer: non-conforming output is
  re-requested by the dispatch layer itself; output is never repaired
  downstream by an LLM rewriting it. The `anchor` value must conform to the
  form's declared anchor vocabulary — closed-list membership is enforced inside
  the schema itself; verbatim-quote anchors are validated by code (substring
  test against the target). A run that never conforms counts as failed (→ run
  set void, §5). When `merge` = `pick`, each run returns one complete candidate
  artifact. When `merge` = `none`, the single run's result passes through
  unmodified.
- **Run set** (ephemeral): the parallel spawn of `runs` runs. All-or-nothing:
  if any run fails to complete, the run set is void.
- **Report** (ephemeral, delivered to the user): the merged output. Must state
  the `runs` count and the merge rule applied. When `runs` = 1 it must carry
  the literal single-run label "단일 실행 — 교차 검증 없음" (single run — no
  cross-check).

### 2.4 RunRecord

Persistent. One file per dispatch under the salvo data directory
`~/.claude/plugins/data/salvo-chenjing-plugins/records/` (user-level, outside
the plugin install — the install cache is read-only and replaced wholesale on
every update; run records must survive updates and accumulate across projects,
D-6; directory renamed from `residue/` to `records/` by D-7), written when
the form is complete (before dispatch). Contains: every IntakeForm field, a
timestamp, a 1-sentence digest of the originating request, and an `outcome`
field (`pending` at write time; updated to `merged` \| `void` \| `delegated`
after the dispatch — the update is the only mutation).

**Format identity (interop contract)**: the serialization format of a
RunRecord and of a preset's intake form file MUST be identical, so that
promotion is a file copy plus a skill wrapper. The concrete syntax
(YAML/JSON/Markdown) is implementation-defined but single: one format
everywhere.

## 3. State Model

States of one /salvo invocation:

| State | Entered when | Left when |
|---|---|---|
| `RECEIVED` | `/salvo <request>` invoked | Always → `ROUTING` |
| `ROUTING` | From `RECEIVED` | Spec-shaped request → `REFERRED`; a preset's `definition` matches → `ARMED` (using the preset's form); otherwise → `DRAFTING` |
| `REFERRED` | Request is a spec/design authoring request | Terminal: user pointed to `/spec:spec`, nothing ran, no run record |
| `DRAFTING` | Form-filling starts filling a form | Form complete and coherent (C1–C6) → `ARMED`; form cannot be completed (see §5) → `REJECTED`; one coherence failure triggers one silent re-draft, a second → `REJECTED` |
| `REJECTED` | Form impossible or incoherent twice | Terminal: reason reported (which aspect was unfillable), no dispatch, no run record |
| `ARMED` | Form complete (preset or filled) | RunRecord written (`outcome: pending`) → `ANNOUNCED` |
| `ANNOUNCED` | One announcement line printed (form digest: definition, runs, merge) | Immediately → `RUNNING` (no confirmation wait; the user may interrupt) |
| `RUNNING` | Runs spawned in parallel | All complete → `MERGING` (or, when `merge` = `none`, → `REPORTED` directly); any failure → `VOID` |
| `MERGING` | All run outputs collected | Mechanical merge rule applied → `REPORTED` |
| `VOID` | ≥ 1 run failed | Run record `outcome: void` → `REPORTED` (failure report, no partial merge) |
| `REPORTED` | Report delivered (merged / single-run-labeled / void) | Run record `outcome` updated (`merged` \| `delegated` \| `void`) → terminal |

Every state above lists both its entry and its exit; there are no other
states and no transitions besides those listed. Note the platform-level
consequence of "no engine": there is no transition from `REPORTED` back to
any earlier state.

## 4. Event Flow

Primary flow — ad-hoc measurement (v1's main path, zero presets):

1. User invokes `/salvo <request>`.
2. Router checks: is this a spec/design authoring request? If yes → refer to
   `/spec:spec`, stop (no form, no run record).
3. Router scans skills for intake form files (presets). For each, it compares
   the request against the preset's `definition`. On a match, that form is
   used (skip to step 5). With zero presets this always falls through. Routing
   comparisons are the routing session's judgment — the mechanical-only
   constraint (M1) binds the merge step, not routing.
4. The form-filling step drafts an IntakeForm from the request. Filling logic:
   the `definition` is derived from the request's target and asked-for output
   shape; `merge` is chosen by what the outputs can be mechanically merged on;
   the remaining fields follow. **The routing decision is the form itself**:
   - `merge` fillable with `union`/`vote`/`pick` → measurement (runs ≥ 2).
   - No merge possible but the work can run unattended in another session →
     delegation (`runs` = 1, `merge` = `none`).
   - The work requires the user's input mid-execution → cannot fill the form
     → `REJECTED` with the unfillable aspect named.
5. Coherence check C1–C6 (pure code / mechanical). One failure → one silent
   re-draft; second failure → `REJECTED`.
6. RunRecord written (`outcome: pending`).
7. One announcement line: definition digest, runs count, merge rule. No
   confirmation wait.
8. Dispatch `runs` runs in parallel, each isolated (runner prompt only;
   target content embedded per `criteria_from`; no conversation history; no
   sibling visibility). For `merge` ∈ {`union`, `vote`}, each run's output
   is validated against the `{anchor, content}`-list schema at the dispatch
   layer, which re-requests non-conforming output; only conforming output
   leaves this step.
9. On any run failure — an error, no result, or output still non-conforming
   (structure or anchor vocabulary) after the dispatch layer's re-requests:
   run set void — report the failure only, update run record `outcome: void`,
   stop. No partial merge.
10. Merge. `union`/`vote`: executed as code — a deterministic program (not an
    LLM following instructions) matches records by anchor (exact equality for
    closed-list vocabularies; exact equality or span overlap for quote
    vocabularies), then dedups (union) or tallies against `vote_threshold`
    (vote). Same inputs always produce the same merged output; no LLM touches
    the counting. `pick`, route `mechanical`: a deterministic program
    evaluates the criterion, running the stated test command against
    candidates when the criterion names one. `pick`, route `judged`: one
    judge agent — isolated like a run; input is solely the N candidate
    artifacts and the criterion text — selects one candidate. A judge failure
    voids the run set like a run failure.
11. Report: merged result + runs count + merge rule, each item shown with
    its anchor and (for vote) its tally — or, for `runs` = 1, the raw
    result + the single-run label. Update run record `outcome`.

Failure behavior is inlined above (steps 4, 5, 9); the error types are
classified in §5.

## 5. Error Taxonomy

| Error | Condition | Handling |
|---|---|---|
| `referred_to_spec` | Request asks for a spec/design document | Point the user to the `/spec:spec` door; stop. No form, no run record. Not counted as a failure. |
| `rejected_unfillable` | The form cannot be filled because the work needs the user in the loop mid-execution (interactive co-editing, mid-course decisions only the user can make) | Report which form aspect is unfillable and suggest a plain session; stop. No dispatch, no run record. |
| `rejected_incoherent` | Form-filling output violates C1–C6 twice in a row | Report the violated rule; stop. No dispatch, no run record. |
| `rejected_missing_target` | `criteria_from` = `document` but the referenced document does not exist (C5) | Report the missing reference; stop before dispatch. |
| `run_void` | ≥ 1 run fails to complete after dispatch (error, no result, or output still non-conforming — structure or anchor vocabulary — after the dispatch layer's schema re-requests), or the `pick` judge agent fails | No partial merge. Report the failure, set run record `outcome: void`. Re-running is the user's explicit choice. |

## 6. Invariants (MUST) / Defaults (SHOULD) / Choices (MAY)

**MUST**

- M1 **Counting is executed code**: for `union`/`vote`, anchor matching
  (exact equality / span overlap), dedup, tally, and thresholding are
  performed by a deterministic program — never by an LLM following
  instructions, neither the invoking session nor a subagent. The overlap
  count is never an LLM's statement; anchor identity needs no judgment
  because the anchor vocabulary is closed at form time (C6). `pick` follows
  its declared route: mechanical criteria are evaluated by code; judged
  criteria by an isolated judge agent, labeled per M6.
- M2 **Isolated runs**: a run receives only its runner prompt — no
  conversation history and no sibling outputs, at every isolation level.
  Tool/repository access is granted solely per the form's `isolation` field.
  The `pick` judge agent (§4 step 10) is equally isolated: it receives only
  the candidate artifacts and the criterion text.
- M3 **No reader-less fields**: every IntakeForm field maps to a reader per
  §2.1. Adding a field without a reader is a contract violation.
- M4 **Work runs outside**: all runs (including `runs` = 1 delegations)
  run in separate sessions. The invoking session routes, announces, merges,
  reports, archives — it never executes the work itself.
- M5 **Run record before dispatch**: the RunRecord is written when the form
  completes, before any run is spawned.
- M6 **Honest reporting**: every report declares the kind of claim it makes.
  `union`/`vote` reports state N and the merge rule (measured, recountable).
  `pick` reports state the route with the criterion text: "기계 선택"
  (mechanical) or "판단 선택" (selected by an LLM judge). `runs` = 1
  reports carry the single-run label "단일 실행 — 교차 검증 없음" (single run —
  no cross-check) verbatim.
- M7 **Announce-then-run**: exactly one announcement line precedes dispatch;
  the platform never waits for confirmation and never dispatches silently.
- M8 **Single-run**: the platform never auto-repeats or auto-retries a
  run set (individual runs are not retried either — a failed run voids the
  run set per §5).
- M9 **One form for everything**: measurement, delegation — every dispatch
  passes through the same IntakeForm; there is no form-less path.
- M10 **Format identity**: RunRecord serialization ≡ preset intake form
  serialization (§2.4).
- M11 **Schema-enforced run outputs**: for `merge` ∈ {`union`, `vote`},
  run output conformance — structure and anchor vocabulary — is enforced
  at the dispatch layer (validation + re-request). Non-conforming output is
  never repaired after the fact by an LLM rewriting it — it either becomes
  conforming at the source or the run counts as failed.

**SHOULD**

- S1 Default `runs` = 3; default `vote_threshold` = majority.
- S2 `runs` > 5 only on the user's explicit request for that scale.
- S3 Run-record filenames carry a sortable timestamp.
- S4 The announcement line and the report echo the same definition digest, so
  the user can match a report to its run record.
- S5 Prefer `isolation` = `sealed` whenever the target content can be embedded
  in the runner prompt; use `tooled` only when the work requires touching the
  environment (repository search, file edits).

**MAY** (implementation-defined)

- The dispatch API (Agent tool vs Workflow tool) and run model choice,
  provided the chosen API can enforce the run output schema (§2.3, M11).
- The concrete serialization syntax for forms/run records (subject to M10).
- Runner prompt wording, report layout, span-overlap details for
  quote-vocabulary anchors.
- Preset tie-breaking when two presets' definitions both match (v1 has zero
  presets; revisit at first promotion).
- Updating the run record `outcome` field as a second write vs a rename.

## 7. Acceptance Criteria

- **AC1 — ad-hoc measurement.** Given zero presets, when the user runs
  `/salvo find every contradiction in docs/plan.md`, then: a form is filled
  with `merge` = `union`, `runs` = 3, `isolation` = `sealed`,
  `invention` = `forbidden`, `criteria_from` = `document`, `anchors` set; a run record exists under the salvo data directory (§2.4) before any run starts; exactly one
  announcement line precedes dispatch; 3 runs execute in parallel with no
  conversation context; the run output schema's anchor values are the
  section headings extracted from docs/plan.md by code; the report lists
  anchor-deduped findings and states "3 independent runs, union merge".
- **AC2 — delegation.** When the user runs `/salvo rename function A to B
  across the repo and fix the tests`, then the filled form has `runs` = 1,
  `merge` = `none`, `isolation` = `tooled`; exactly one worker runs in a
  separate session; the report
  carries the literal label "단일 실행 — 교차 검증 없음"; the run record `outcome`
  ends as `delegated`.
- **AC3 — rejection.** When the user runs `/salvo let's discuss the design
  together and decide as we go`, then no run is spawned, no run record is
  written, and the reply names the unfillable aspect (user needed in the
  loop) and suggests a plain session.
- **AC4 — referral.** When the user runs `/salvo write a spec for feature X`,
  then no form is drafted, no run record is written, and the reply points to
  `/spec:spec`.
- **AC5 — preset priority.** Given a skill directory containing an intake
  form whose `definition` matches the request, when the user runs a matching
  `/salvo` request, then that preset's form is used and no new form is
  drafted (observable: the announcement names the preset).
- **AC6 — void run set.** Given a measurement dispatch of 3 where one run
  fails to complete, then the report contains no partial findings, states the
  failure, and the run record `outcome` is `void`.
- **AC7 — judged pick.** When the user runs `/salvo draft 3 versions of this
  README intro and pick the clearest one`, then the filled form has `merge` =
  `pick`, `runs` = 3, `pick_criterion` route `judged`; exactly one judge
  agent runs, receiving only the 3 candidates and the criterion text; the
  report names the selected candidate and carries the label "판단 선택" with
  the criterion text.

## Decision Ledger *(mandatory)*

| # | Decision | Rationale (facts at the time) | Rejected alternatives |
|---|---|---|---|
| D-1 | Contract first, ontology after: the intake form is the platform's contract; any deeper ontology is discovered later from residue | The prior atom-methodology debate ended with the 6-axis system explaining everything but selecting nothing; a form with readers selects | Constitution-rank ontology; verb-system-only vocabulary |
| D-2 | Two doors only: `/spec` and `/salvo`; the forge is internal to `/salvo`, not a command | Every extra command is a token that conditions sessions and a surface the user must remember | Per-weapon commands; a separate `/forge` command |
| D-3 | Loops belong to the driving session, not to weapons: single-fire platform | 4-model unanimous convergence in the design round; keeps fold rules mechanical | Engine/ledger state machine; self-running leg runner |
| D-4 | Presets are promoted improvised weapons | Prevents speculative preset design; demand is measured (residue) before a weapon is named | Designing presets up front |
| D-5 | `isolation` (`sealed`/`tooled`) is an explicit form field, not an implicit property | Author's self-check found a contradiction between shooter starvation and delegation's need to edit the repository; the inherited design's volley notion was already a pair (count / independence) | Fixed sealed-only isolation (breaks delegation and repo-search weapons); leaving isolation implicit in prompt wording (reader-less, unenforceable) |
| D-6 | Residue root amended post-gate to the user-level data directory `~/.claude/plugins/data/salvo-chenjing-plugins/residue/` | The installed plugin executes from a read-only cache that updates clobber, so in-tree residue would be erased; residue must accumulate across projects as promotion evidence. User decision at implementation start (2026-07-09) | Literal `plugins/salvo/residue/` (evidence erased on update; dead path outside the dev repo); per-project `.salvo/residue/` (promotion evidence scattered) |
| I-1 | v1 success = forge skeleton: routing + improvised weapon fired end-to-end; sweep/vet re-registration deferred | Build the mother first so re-registration becomes a promotion act on top of it | Presets first (form would harden without live validation); everything in one spec (bloat, longer gate rounds) |
| I-2 | Fired improvised weapons leave their intake form only (residue) | Promotion needs evidence of repeated demand; keeping full outputs is noise | Pure one-shot with no record (promotion evidence evaporates); promotion procedure in scope (re-bloat) |
| I-3 | Preset weapon = a skill carrying an intake form file; no separate index | The skill set is the registry — an index file would be a reader-less duplicate ledger | Single index file (duplication, rot); no registry contract in v1 (promotion has no landing place) |
| I-4 | Non-weapon requests are not rejected but delegated: `/salvo`'s essence is "work happens outside this session"; delegation fills the same form (`volley` = 1, `fold` = `none`) with an honesty label | User correction during interview: dispatching to another session has value even without a fold; a uniform form keeps one intake path and records repeated delegation shapes for promotion | Rejecting all non-measurement requests (loses delegation value); form-less delegation (no promotion trail, two kinds of path inside `/salvo`) |
| I-5 | Defaults bundle: announce-then-fire; volley 3 / majority vote; all-or-nothing volleys; residue at the salvo data directory (path amended by D-6); spec-shaped requests referred to `/spec` | Matches the house convention already shipped in the spec-gate auto-round loop (announce, interruptible, no confirmation wait); all-or-nothing inherits the spec-gate precedent | Confirmation dialog before firing (breaks autonomy); partial-fold on shooter failure (corrupts the measurement) |
| I-6 | Fold substrate (resolves gate R1-1): shooter outputs are schema-enforced `{anchor, content}` lists with dispatch-layer re-request; the anchor vocabulary is closed at form time (closed list extracted from the target by code, or verbatim quotes code-validated as substrings); anchor matching, dedup, tally run as deterministic code — zero LLM presence in the counting path (pick clause amended by I-7) | User decision in gate round 1 (two corrections by the author's interviewer): format divergence is killed upstream by schema enforcement, and anchor-vocabulary divergence is killed upstream the same way, so no semantic matching remains for any LLM to do; the overlap count — the platform's sole added information over a single pass — stays recountable | Invoking-session hand-aggregation (conditioned context, unverifiable); a full LLM aggregator producing merged results and counts (the count becomes one LLM's statement — the guarantee the platform sells disappears); a starved normalizer agent emitting an anchor-equivalence table (unnecessary once the vocabulary is closed upstream); adding an LLM-synthesis ("blend") fold mode now (such requests run as delegation; a fifth mode is promoted only if residue shows repeated demand) |
| I-7 | Pick evaluation (resolves gate R2-1): `pick_criterion` carries a declared route — `mechanical` (evaluated by code, which may run a stated test command against candidates) or `judged` (a starved judge agent receives only the N candidates + the criterion text and selects one; the report carries the "판단 선택" label). M1 narrowed to counting: the no-LLM rule guards the overlap count (union/vote), the platform's measured product; pick has no count to protect | User correction in gate round 2: the counting ban was never meant to cover selection — "all folds mechanical" was the author's over-extension and produced R2-1; honesty is per-fold-mode labeling (measured / mechanical pick / judged pick / single-shot guess), the same treatment LLM synthesis gets in deep-research-style tools | Deferring pick from v1 (unnecessary once the judged route exists — no build burden); restricting criteria to a closed comparator grammar (guts useful free-text criteria); keeping one uniform mechanical-only rule for every fold mode |
| D-7 | Full vocabulary de-metaphorization (2026-07-09): strip the military metaphor from the entire plugin, keeping only the plugin name `salvo`. User decision after a measured inspection (a /salvo union run over the SKILL.md) flagged jargon and label defects. The normative old→new mapping is the table below; all body identifiers (fields, files, agent name, outcome/kind values, M6 labels) move to it; historical ledger rows D-1…D-6 and I-1…I-7 are left verbatim as history and still use the old words | The metaphor added a decoding tax on every read without buying meaning; a measured inspection (not taste) surfaced the label defects; the name `salvo` alone carries the one idea worth keeping — several independent passes merged by code are a measurement | Renaming the plugin too (loses the one-line rationale the name earns); leaving the metaphor (the inspection's findings stand); a partial rename (leaves the contract internally inconsistent between fields and prose) |
| D-8 | spec/spec-gate split into a standalone `spec` plugin (2026-07-09): the interview-driven authoring pair (`/spec:spec` + `/spec:spec-gate`, agent `cold-reader`) moves out of the salvo plugin into its own `spec` plugin; this door's spec-referral target is renamed `/salvo:spec` → `/spec:spec` (the door still refers spec-shaped requests, but announce-and-stop with no auto-invoke, because the destination is now a separate product) | User decision (2026-07-09): interactive spec authoring and code-merged parallel measurement are different products; bundling them in one plugin coupled unrelated release cadences and mislabeled the platform as a spec tool | Keeping both in one plugin (couples two unrelated products, mutual breaking-version churn); auto-invoking `/spec:spec` from the referral (a cross-product jump the user never asked for) |

**D-7 rename table (normative old → new mapping):**

| Old | New |
|---|---|
| `volley` (field) | `runs` |
| `fold` (field/value-set name) | `merge` (values `union`/`vote`/`pick`/`none` unchanged) |
| `residual` (field) | `notes` |
| `criteria_from` value `shooter` | `runner` |
| outcome `folded` | `merged` |
| return kind `folded` | `merged`; returned field `fold` → `merge`, `volley` → `runs` |
| agent `salvo:shooter` | `salvo:runner` |
| `references/volley-workflow.js` | `references/run-workflow.js` |
| `references/shooter-prompt-template.md` | `references/runner-prompt-template.md` |
| `scripts/residue.mjs` | `scripts/record.mjs` |
| `agents/shooter.md` | `agents/runner.md` |
| data dir `…/residue/` | `…/records/` |
| workflow meta `salvo-volley`; phases `Fire`/`Fold`; labels `shot:i` | `salvo-run`; `Run`/`Merge`; `run:i` |
| single-run label "한 발은 짐작" | "단일 실행 — 교차 검증 없음" (single run — no cross-check) |
| shooter → runner; volley/salvo-of-N → "N independent runs"; fire → run/launch; fold → merge; residue → run record; forge → fill the form; improvised weapon → ad-hoc form; preset weapon → preset; weapon platform → the platform; starved → isolated | (prose vocabulary) |

## Deferred to Implementer *(waiver record)*

(none yet — waivers are added by gate rounds)

## Assumptions

- A1: The user-facing door is spelled `/salvo`; the harness-level skill
  naming needed to achieve that invocation path is implementation-defined.
- A2: Referrals (`referred_to_spec`) leave no run record: no form was drafted,
  so there is nothing to archive.
- A3: The run record `outcome` update after a dispatch is the only permitted
  mutation of a run record file.
- A4: A "spec-shaped request" is one whose asked-for deliverable is a design
  or specification document, judged by the router from the request text.
- A5: Run model/effort selection follows the harness defaults unless the
  user names a tier in the request.
- A6: The announcement line is in the user's conversation language; the
  intake form and run record contents are in English (machine-facing,
  consistent with SPEC/gate conventions).
