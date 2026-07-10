# System Specification: salvo — routing door (/salvo) with a parallel-run engine

**Created**: 2026-07-09
**Status**: Draft
**Gate**: passed (D-14 revision, round 2, 2026-07-09 — 0 confirmed blocking, readers opus ×3; report in `.spec/gate-report.md`, prior cycle frozen at docs/003-gate-report.md)

> **v0.11 scope note (2026-07-10):** this specification governs the legacy
> `/salvo:salvo` routing-door experiment only. The new cross-host
> Leg (`$leg` in Codex, `/salvo:leg` in Claude Code) is an independent
> user-facing runner with its own executable contract in `skills/leg/`; it is
> not a sub-skill routed by this door. The
> routing-door module is expected to move to the future behavior layer rather
> than define Salvo's user-facing identity.

<!-- A system-level implementation contract.
     Principle: nail down all the "axes" (state, boundaries, contracts, error
     taxonomy) and delegate the "values" (algorithm details, field names,
     formats) as implementation-defined. No pseudocode. -->

## 1. Purpose & Scope

salvo is a **routing door**: one registered command, `/salvo`, in front of a
growing set of sub-skills bundled with the plugin. The user states work in
plain language without knowing what sub-skills exist; the door discovers them
from disk at request time and routes to the one whose routing card matches.
This is the context-economy design the plugin is built around: no matter how
many sub-skills ship, the only thing standing in session context is the
door's own description — the inventory is never loaded wholesale, and the
user never needs to memorize it (D-12).

The routing decision itself is mechanical (D-14): an isolated classifier
agent reduces the request to a schema-enforced switch vector (§2.5), and a
code table over that vector — not an LLM's direct pick — selects the
destination: a sub-skill, or the engine.

Behind the routing layer sits the built-in **engine**, and its founding
claim: **one LLM pass is a guess; a salvo — N independent passes merged by
pure code — is a measurement.** When no routing card matches, the door fills
an ad-hoc intake form and the engine dispatches it as a run set (measurement)
or a single-run delegation, or rejects it — all decided by one mechanism, the
**intake form**. All actual work runs **outside the invoking session** —
inside one Workflow-tool call per dispatch (M14); the invoking session only
routes, announces, merges, reports, and archives.

Vocabulary used throughout (each defined in §2):

- **Run**: one isolated execution of the task — an agent spawned inside the
  dispatch Workflow call by the workflow script's code (M14).
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
- **Sub-skill**: a directory bundled with the plugin, next to the door,
  carrying a routing card plus its implementation — a **run preset** (an
  intake form the engine executes) or a **procedural sub-skill** (an
  instruction document the door follows). Bundled-only: authored in the
  plugin repository and shipped with releases, never created at runtime.
- **Routing card**: what every sub-skill carries for routing — a
  one-short-paragraph human statement ("route here when …") plus a
  machine-readable condition over switch names (§2.5); the condition is what
  the routing table evaluates.
- **Switch vector**: the schema-enforced set of request features (§2.5) the
  classifier extracts; the routing table's only input (D-14).
- **Classifier**: the isolated agent that produces the switch vector —
  sealed, it sees the request text and the switch schema, nothing else.

**In scope (v1)**

1. The `/salvo` routing surface (single door) and the live routing-card scan.
2. The intake form schema and its coherence rules.
3. The form-filling procedure (ad-hoc forms).
4. Delegation (single-run dispatch) under the same form.
5. Rejection and referral behavior.
6. Run-record archiving.
7. The sub-skill discovery contract — routing cards — so promoted forms have
   a defined landing place, even though v1 ships with zero sub-skills.
8. The switch-vector classification and the mechanical routing table (D-14).

**Out of scope (v1)**

- Re-registering the legacy presets (sweep, vet).
- The promotion procedure itself (turning a run record into a preset).
- New named presets (split, fork-detection, plain-handoff).
- Any engine, ledger state machine, or self-running loop: **the platform never
  auto-repeats a run set.** Re-running is an explicit user (or driving-session)
  act.
- The `/spec` plugin (a separate product since the D-8 split; fully decoupled
  per D-10).
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
| `definition` | Runner prompt construction, report header (routing matches on routing cards, not this field — D-12) |
| `merge` (+ `vote_threshold`, `pick_criterion` + route) | Merge step (selects the rule; evaluates mechanical pick); judge-agent dispatch (judged pick); router (merge = `none` ⇒ delegation path) |
| `runs` | Dispatch step (how many runs to spawn) |
| `isolation` | Dispatch step (grants or withholds tools/repository access per run) |
| `invention` | Runner prompt construction (adds/omits the no-invention clause) |
| `criteria_from` | Runner prompt construction (embeds request text or document content) |
| `anchors` | Merge step (dedup / vote matching key) |
| `notes` | Form-filling (applies it as a runner-prompt or merge constraint); human review of run records (form-evolution signal) |

### 2.2 Sub-skills, presets, and ad-hoc forms

- **Sub-skill** (persistent, bundled-only): a sibling directory carrying a
  routing card — a one-short-paragraph human statement of when requests route
  here, plus a machine-readable condition over switch names (§2.5) that the
  routing table evaluates. Two kinds: a **run preset** additionally carries an intake form file,
  which the engine executes as-is; a **procedural sub-skill** additionally
  carries an instruction document the door follows after routing. The set of
  directories carrying a routing card **is** the registry — there is no
  separate index file. Sub-skills are never registered as top-level skills
  (M12): only the door is registered, and the card scan happens live at
  request time. Creation is an authoring act in the plugin repository —
  designed, tested, versioned, shipped; the runtime never creates one (M13;
  the read-only install cache also makes it physically impossible). v1 ships
  zero sub-skills; the contract exists so promotion has a landing place.
- **Ad-hoc form** (ephemeral): an intake form filled for one dispatch, plus
  the runner prompt built from it. It lives for one run set; only its form
  survives (as a run record).

### 2.3 Run set, Run, Report

- **Run** (ephemeral): one agent execution spawned inside the dispatch
  Workflow call (M14). Receives ONLY the runner prompt built from the form
  (plus embedded target content per `criteria_from`). Receives no
  conversation history and no sibling output (isolated).
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

Persistent. One file per routed or dispatched invocation under the salvo
data directory
`~/.claude/plugins/data/salvo-chenjing-plugins/records/` (user-level, outside
the plugin install — the install cache is read-only and replaced wholesale on
every update; run records must survive updates and accumulate across projects,
D-6; directory renamed from `residue/` to `records/` by D-7), written before
dispatch (engine) or before the sub-skill's instructions are followed
(routed, D-14). Contains: the routing block — switch vector, destination,
matched condition (D-14) — a timestamp, and a 1-sentence digest of the
originating request; an engine dispatch additionally stores every IntakeForm
field and an `outcome` field (`pending` at write time; updated to `merged`
\| `void` \| `delegated` after the dispatch — the update is the only
mutation). A sub-skill handoff writes `outcome: routed` at write time and is
never mutated.

**Format identity (interop contract)**: the serialization format of a
RunRecord and of a preset's intake form file MUST be identical, so that
promotion is a file copy plus a skill wrapper. The concrete syntax
(YAML/JSON/Markdown) is implementation-defined but single: one format
everywhere.

### 2.5 SwitchVector

The routing contract type (D-14): a small, closed set of request features the
classifier extracts under a schema; the routing table and the form-filling
prior are its only consumers. Every switch has a reader (M3 applies):

| Switch | Type | Reader |
|---|---|---|
| `enumerable_findings` | bool | merge prior (`union`/`vote` territory); sub-skill conditions |
| `wants_confidence` | bool | merge prior (`vote` over `union`) |
| `candidate_selection` | bool | merge prior (`pick`) |
| `unattended_ok` | bool | reject prior (false ⇒ the work likely needs the user mid-execution) |
| `touches_environment` | bool | isolation prior (`tooled` vs `sealed`); sub-skill conditions |
| `target_kind` | enum `document` \| `repository` \| `conversation` \| `none` | criteria/embedding prior; sub-skill conditions |

- The switches restate the intake form's own decision axes — they are not a
  new ontology (the D-1 concern); the form's axes already survived gate
  rounds and live dispatches.
- The vector is consumed twice: (1) the routing table matches each
  sub-skill's condition against it — the most specific satisfied condition
  (largest number of matched clauses) wins, ties break lexicographically by
  sub-skill name, no satisfied condition ⇒ engine; (2) the form-filling step
  starts from the switch prior (S6).
- The vector, the chosen destination, and the matched condition are recorded
  in the run record (§2.4): routing is recountable — re-evaluating the table
  on the recorded vector must reproduce the destination (AC8).
- Amending the switch list is a ledger act, like a form-field change; the
  evidence is the records pile (recorded vectors vs realized forms show
  which switches discriminate and which are dead).

## 3. State Model

States of one /salvo invocation:

| State | Entered when | Left when |
|---|---|---|
| `RECEIVED` | `/salvo <request>` invoked | Always → `ROUTING` |
| `ROUTING` | From `RECEIVED` | The routing workflow returns the switch vector and the table's pick (code, D-14): a run preset wins → `ARMED` (using its bundled form); a procedural sub-skill wins → `ROUTED`; no condition satisfied, or classifier failure (engine fallback, noted in the record) → `DRAFTING` |
| `ROUTED` | A procedural sub-skill won the routing table | Terminal for the door: run record written (`outcome: routed`), one announcement line names the sub-skill, then control passes to that sub-skill's own instructions (if those instructions dispatch runs, they do so through the engine, whose states apply to that dispatch) |
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
2. The door collects the routing conditions of the bundled sub-skills (from
   their card files) and launches the routing workflow: an isolated
   classifier agent reduces the request to the switch vector (§2.5), then the
   script's code evaluates the conditions against the vector — the most
   specific satisfied condition wins, ties break lexicographically, no match
   ⇒ engine. A run preset win → its bundled form is used (skip to step 4). A
   procedural win → run record written (`outcome: routed`), one announcement
   line names the sub-skill, then the door follows that sub-skill's
   instructions and its own flow ends (`ROUTED`). Engine — including the
   classifier-failure fallback, which the record notes — → step 3. With zero
   sub-skills the table holds no conditions and always yields engine. The
   LLM's only routing role is flipping switches inside a schema; the
   destination pick is code (M15).
3. The form-filling step drafts an IntakeForm from the request. Filling logic:
   the `definition` is derived from the request's target and asked-for output
   shape; `merge` is chosen by what the outputs can be mechanically merged on;
   the remaining fields follow. Form-filling starts from the switch prior
   (S6): `candidate_selection` ⇒ `pick`; `enumerable_findings` +
   `wants_confidence` ⇒ `vote`; `enumerable_findings` ⇒ `union`;
   `unattended_ok` false ⇒ probe the reject branch; `touches_environment` ⇒
   `tooled`. The prior is a default, not a cage — the form may diverge where
   the request contradicts it; the vector and the final form land in the same
   record, so divergence is visible evidence. **The engine-shape decision is
   the form itself**:
   - `merge` fillable with `union`/`vote`/`pick` → measurement (runs ≥ 2).
   - No merge possible but the work can run unattended in another session →
     delegation (`runs` = 1, `merge` = `none`).
   - The work requires the user's input mid-execution → cannot fill the form
     → `REJECTED` with the unfillable aspect named.
4. Coherence check C1–C6 (pure code / mechanical). One failure → one silent
   re-draft; second failure → `REJECTED`.
5. RunRecord written (`outcome: pending`; includes the routing block, D-14).
6. One announcement line: definition digest, runs count, merge rule. No
   confirmation wait.
7. Dispatch `runs` runs in parallel, each isolated (runner prompt only;
   target content embedded per `criteria_from`; no conversation history; no
   sibling visibility). For `merge` ∈ {`union`, `vote`}, each run's output
   is validated against the `{anchor, content}`-list schema at the dispatch
   layer, which re-requests non-conforming output; only conforming output
   leaves this step.
8. On any run failure — an error, no result, or output still non-conforming
   (structure or anchor vocabulary) after the dispatch layer's re-requests:
   run set void — report the failure only, update run record `outcome: void`,
   stop. No partial merge.
9. Merge. `union`/`vote`: executed as code — a deterministic program (not an
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
10. Report: merged result + runs count + merge rule, each item shown with
    its anchor and (for vote) its tally — or, for `runs` = 1, the raw
    result + the single-run label. Update run record `outcome`.

Failure behavior is inlined above (steps 3, 4, 8); the error types are
classified in §5.

## 5. Error Taxonomy

| Error | Condition | Handling |
|---|---|---|
| `rejected_unfillable` | The form cannot be filled because the work needs the user in the loop mid-execution (interactive co-editing, mid-course decisions only the user can make) | Report which form aspect is unfillable and suggest a plain session; stop. No dispatch, no run record. |
| `rejected_incoherent` | Form-filling output violates C1–C6 twice in a row | Report the violated rule; stop. No dispatch, no run record. |
| `rejected_missing_target` | `criteria_from` = `document` but the referenced document does not exist (C5) | Report the missing reference; stop before dispatch. |
| `routing_fallback` | The routing workflow fails: classifier error, or a vector still non-conforming after the dispatch layer's re-requests | Non-fatal: the destination defaults to the engine; the run record and the announcement note the fallback. Sub-skill routing is skipped for this invocation. |
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
  completes, before any run is spawned. A routed invocation writes its record
  (`outcome: routed`) before the sub-skill's instructions are followed.
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
- M9 **One form for everything the engine runs**: measurement, delegation —
  every engine dispatch passes through the same IntakeForm; there is no
  form-less engine path. A procedural sub-skill owns its behavior after
  routing; when it dispatches runs, it does so through the engine and under
  this rule.
- M10 **Format identity**: RunRecord serialization ≡ preset intake form
  serialization (§2.4).
- M11 **Schema-enforced run outputs**: for `merge` ∈ {`union`, `vote`},
  run output conformance — structure and anchor vocabulary — is enforced
  at the dispatch layer (validation + re-request). Non-conforming output is
  never repaired after the fact by an LLM rewriting it — it either becomes
  conforming at the source or the run counts as failed.
- M12 **Door-only registration**: sub-skills are never registered as
  top-level skills; the door is the only registered surface, and discovery is
  the live routing-card scan. Session context carries one skill description
  regardless of how many sub-skills ship.
- M13 **Bundled-only sub-skills**: the runtime never creates, edits, or
  persists a sub-skill. Runtime artifacts are ad-hoc forms and run records
  only; sub-skill creation is plugin-repo authoring (promotion = the
  developer's loop over the records pile).
- M14 **Workflow dispatch** (D-13): the routing classification (D-14) and
  every engine dispatch — run sets, delegations, and the pick judge — each
  run as exactly ONE Workflow-tool call; runs are agents spawned inside those
  calls by the workflow scripts' code. The invoking session never dispatches
  a run through the Agent tool directly: the Workflow layer is where M11's
  schema enforcement and M1's code merge live, and its code-driven control
  flow keeps run outputs out of the invoking session's context.
- M15 **Mechanical routing** (D-14): the destination — sub-skill vs engine —
  is selected by code evaluating sub-skill conditions against the
  classifier's schema-enforced switch vector. No LLM, invoking session or
  agent, picks the destination directly; the classifier's entire role is the
  vector. Vector, destination, and matched condition are recorded
  (recountable routing, AC8).

**SHOULD**

- S1 Default `runs` = 3; default `vote_threshold` = majority.
- S2 `runs` > 5 only on the user's explicit request for that scale.
- S3 Run-record filenames carry a sortable timestamp.
- S4 The announcement line and the report echo the same definition digest, so
  the user can match a report to its run record.
- S5 Prefer `isolation` = `sealed` whenever the target content can be embedded
  in the runner prompt; use `tooled` only when the work requires touching the
  environment (repository search, file edits).
- S6 Form-filling starts from the switch prior (§4 step 3); divergence is
  permitted and needs no ceremony — the vector and the final form share one
  record, which is the divergence evidence.

**MAY** (implementation-defined)

- Run model/effort choice per dispatch (the dispatch API itself is fixed to
  the Workflow tool by M14/D-13).
- The concrete serialization syntax for forms/run records (subject to M10).
- Runner prompt wording, report layout, span-overlap details for
  quote-vocabulary anchors.
- The routing-card file name/format, and card tie-breaking when two cards
  both match (v1 has zero sub-skills; revisit at first promotion).
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
- **AC4 — no spec special-casing.** When the user runs `/salvo write a spec
  for feature X`, the request flows through the ordinary form like any other
  generation work (typically a `pick` run over N candidate drafts, or a
  `runs`-1 delegation); the door does not invoke or name another plugin's
  skill.
- **AC5 — routing priority.** Given a bundled sub-skill whose routing
  condition is satisfied by the request's switch vector: a run preset's
  bundled form is used with no new form drafted; a procedural sub-skill is
  followed without any form being filled. In both cases the announcement
  names the sub-skill and the run record's routing block names the matched
  condition; a request satisfying no condition still falls through to the
  ad-hoc engine.
- **AC6 — void run set.** Given a measurement dispatch of 3 where one run
  fails to complete, then the report contains no partial findings, states the
  failure, and the run record `outcome` is `void`.
- **AC7 — judged pick.** When the user runs `/salvo draft 3 versions of this
  README intro and pick the clearest one`, then the filled form has `merge` =
  `pick`, `runs` = 3, `pick_criterion` route `judged`; exactly one judge
  agent runs, receiving only the 3 candidates and the criterion text; the
  report names the selected candidate and carries the label "판단 선택" with
  the criterion text.
- **AC8 — recountable routing.** For any /salvo invocation that routes (to a
  sub-skill or the engine), the run record contains the switch vector, the
  destination, and the matched condition (or the engine/fallback marker);
  re-evaluating the routing table on the recorded vector reproduces the
  recorded destination.

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
| D-9 | Handoff clarification (2026-07-09, amends D-8's referral clause): the split decouples packaging/activation only — at runtime the door does auto-invoke `/spec:spec`: announce the handoff in one line, then invoke the `spec:spec` skill with the user's request (name it instead only when the spec plugin is absent). Within-plugin auto-chaining is pre-approved: `spec` → `spec-gate` inside the spec plugin, and this door → its own sub-skills, including future promoted presets (create-then-invoke included). Cross-plugin package bundling remains rejected | User clarification: the split targeted activation coupling, not runtime routing; announce-and-stop made the user re-type a request the door already held | Announce-and-stop referral (D-8's first reading — a re-typing tax); re-merging the plugins (reverses D-8) |
| D-10 | Spec decoupling, final (2026-07-09, supersedes D-8's referral clause and all of D-9): salvo and spec are separate products — the door neither invokes nor names the spec plugin. The spec-shaped-request branch is removed from routing (state `REFERRED` and error `referred_to_spec` deleted): a request for a spec/design document flows through the ordinary form like any work (typically `pick` over N candidate drafts, or a `runs`-1 delegation); interview-style co-editing still hits `rejected_unfillable`. Each skill auto-triggers independently from plain language via its own description | User clarification: using salvo must not funnel anyone into the spec interview — they may not want a spec at all; D-9's auto-invoke was the session's misreading of that instruction | D-9 auto-invoke (funnels the user into a product they did not choose); D-8 announce-and-stop referral (still steers); a soft mention without invocation (still couples the products) |
| D-11 | Spec relocation (2026-07-09): this document dogfoods the spec plugin's 0.2.0 location contract — the living spec moves from `specs/003-parallel-run-platform/SPEC.md` to `SPEC.md` at the plugin root (the plugin, not the multi-plugin repo, is the project unit), and the numbered `specs/` directory is retired. The gate artifacts move verbatim to `docs/003-gate-report.md` / `docs/003-dashboard.html` as frozen history: they predate the uncommitted-`.spec/` rule and stay committed as the pass evidence. Future revisions amend this document via ledger rows, never a new numbered spec | User consistency push (2026-07-09): the repo kept the numbered layout the 0.2.0 contract had just abolished; the "it's historical" defense was already rejected once for this directory's own name | Leaving the numbered dir as history (same excuse rejected for `003-weapon-platform`); repo-root SPEC.md (wrong project unit — this repo hosts several plugins); moving gate artifacts into `.spec/` (that dir is uncommitted by contract, but the pass evidence must stay committed) |
| D-12 | Router identity (2026-07-09): `/salvo` is redefined as the **routing door** over bundled sub-skills — routing is the product; the parallel-run platform is the built-in engine behind it. Adds the routing-card contract (§2.2): every sub-skill carries a card ("route here when …") the door scans live at request time; run presets carry a form the engine executes, procedural sub-skills carry instructions the door follows. Sub-skills are bundled-only (M13) — the runtime never creates one; the user-side exception path is the ad-hoc engine (form → run → record), and promotion stays a developer-side authoring loop over the records pile. Only the door is registered (M12), so session context carries one description no matter how many sub-skills ship | User correction (2026-07-09): salvo's founding intent is routing — skills will multiply, they cannot all sit in context, and users cannot be expected to know the inventory; the spec's platform-first framing made the engine look like the product (the author's second identity misreading, after D-9) | Runtime user-created sub-skills (read-only install cache; no versioning, no gate, quality drift; would need a second scan root in the data dir — deferred until records show demand); pre-building presets for every anticipated situation (speculative design, re-rejected per D-4 — the ad-hoc engine already floors every case); registering sub-skills as top-level skills (context cost grows per skill — defeats the door's purpose) |
| D-13 | Dispatch API fixed to the Workflow tool (2026-07-09, post-gate amendment like D-6): the MAY hedge "Agent tool vs Workflow tool" is retired and M14 added — every engine dispatch is one Workflow call whose script spawns the runs; the vocabulary drops the "subagent/workflow" phrasing. No implementation change: the engine has been Workflow-only since v1 (`run-workflow.js`, M4's one-call rule) | User reading (2026-07-09): the hedged wording made a Workflow-based system read as subagent-based — a reader confusion is a spec defect; the Workflow layer is also load-bearing (M11 schema enforcement at the `agent()` dispatch, M1 merge as script code, run outputs never entering the invoking session's context), so the freedom was never real | Keeping the hedge (misleads readers; the implementation could not actually switch to bare Agent-tool dispatch without losing M11's dispatch-layer schema enforcement); dispatching runs via the Agent tool from the invoking session (no schema parameter, control flow returns to the LLM between runs, outputs land in session context) |
| D-14 | Mechanical switch routing (2026-07-09): routing is mechanized now, not at first promotion. An isolated classifier agent (sealed: request text + switch schema only) reduces the request to a schema-enforced switch vector (§2.5 — 6 switches restating the intake form's own axes), and a code table evaluates sub-skill conditions against it (most-specific wins, lexicographic tie-break, no match ⇒ engine; classifier failure ⇒ engine fallback, noted — `routing_fallback`). The vector doubles as the form-filling prior (S6); every routed or dispatched invocation records vector + destination + matched condition (AC8; outcome `routed` added); routing cards gain a machine condition beside the prose; classification runs as its own Workflow call (M14 extended); M15 added | User decision (2026-07-09), overriding the author's wait-for-first-promotion recommendation: take the mechanism's guarantees now — recountable, testable routing plus a mechanical union/vote/pick prior (the exact spot all three D-12 gate readers independently flagged as vaguest). The D-1 ontology risk is contained: the switches restate the form's shipped axes rather than invent new ones, and recorded vectors make the vocabulary itself evidence-refinable | Waiting for the first promotion (author's recommendation — rejected: the prior and the recording pay rent even with one destination); LLM-direct card matching (unrecountable, untestable, misroutes invisible); a full pre-form ontology (D-1's rejected 6-axis shape — switches deliberately stop at destination + prior and never fill the form) |

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
- A2: *(withdrawn by D-10 — the spec-referral branch was removed; no referral
  exists to record.)*
- A3: The run record `outcome` update after a dispatch is the only permitted
  mutation of a run record file.
- A4: *(withdrawn by D-10 — spec-shaped requests are no longer special-cased
  in routing.)*
- A5: Run model/effort selection follows the harness defaults unless the
  user names a tier in the request.
- A6: The announcement line is in the user's conversation language; the
  intake form and run record contents are in English (machine-facing,
  consistent with SPEC/gate conventions).
