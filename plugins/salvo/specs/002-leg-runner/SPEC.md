# System Specification: leg — mid-range autonomous driving harness (/salvo:leg)

**Created**: 2026-07-08
**Status**: Draft
**Gate**: passed

<!-- A system-level implementation contract.
     Principle: nail down all the "axes" (state, boundaries, contracts, error
     taxonomy) and delegate the "values" (algorithm details, field names,
     formats) as implementation-defined. No pseudocode. -->

## 1. Purpose & Scope

One-shot tools handle 1 task; loop engineering handles 10+ tasks but requires
the detailed design to exist up front. Projects that start from a rough idea
need a human to inspect and steer mid-flight, yet swapping across 3-4 parallel
projects makes short-cycle steering exhausting. The leg runner fills the gap:
per invocation it decomposes the user's rough mission into a small declared
task list, drives those tasks autonomously (verification included), and stops
at the point where the next decision forks on the user's product preference —
then hands off a report the user can absorb in 30 seconds. The unit of work is
a **leg**; the stopping point is the **variation point** (변주 지점).

The runner is part of the salvo plugin (the arm that wields the arsenal): it
may invoke salvo weapons (/salvo:vet, /salvo:sweep, /salvo:spec-gate) on its
own judgment inside a leg.

**Out of scope (v1):**
- Cross-project aggregation: no multi-leg queue, no "waiting for your input"
  dashboard across projects (v2 backlog). Parallelism is achieved by running
  multiple sessions/background jobs, one leg cycle each.
- Live auto-refresh HTML view of a leg (v2 backlog; the handoff file is the
  only required surface).
- Automatic leg chaining without user input. Ending a leg always returns
  control to the user in v1; raising the dial toward loop mode is a future
  evolution, not a v1 behavior.
- Changing the internals of existing salvo skills (spec, spec-gate, vet,
  sweep). The single exception is the FR-010 delegation amendment recorded in
  §6 (MUST-7).

## 2. Domain Model

**Leg** (persistent, one file per leg)
- `id`: 3-digit sequence per project (001, 002, …), monotonically increasing,
  derived by scanning the `legs/` directory.
- `mission`: string — the user's rough request, quoted verbatim plus the
  runner's one-line restatement in plain language.
- `declared_tasks`: ordered list of 1–4 top-level Task entries (see below).
  The cap is the dial (default 4) and counts top-level entries only. Declared
  once at leg start; the list MUST NOT gain new top-level entries afterward,
  but entries may be split into subtasks or dropped-with-reason during the
  leg (§4 Flow 2.5). Coarse declarations are expected — refinement happens
  while working, not up front.
- `checkpoint`: optional integer N — a user instruction ("run through task N
  autonomously") that makes completing top-level task N a stop condition
  regardless of remaining budget or forks.
- `ending_reason`: enum — `preference_fork` (reached a variation point),
  `mission_complete` (all declared tasks done and verified),
  `cap_hit` (declared task budget consumed),
  `stuck` (same approach failed 2 times),
  `unverifiable` (work done but its check could not be run),
  `checkpoint` (user-set checkpoint reached).
  This enum is reporting vocabulary only: every value routes to the same
  behavior (write the handoff, reason stated first). It exists so the report's
  first line is typed, not so the runner branches policy.
- `handoff_path`: `<project>/legs/<id>.md`.

**Task** (embedded in Leg)
- `description`: one plain-language line (see §6 MUST-5 for the language
  rule). Verification of the task's own result is part of the task, not a
  separate task: a task whose result was not checked is not `done`.
- `status`: enum — `declared`, `done`, `not_done`, `dropped` (requires a
  one-line reason).
- `evidence`: required when `status = done` — what was actually run or
  measured to confirm the result (test output, a command run, a manual check
  described in one line). "It should work" is not evidence.
- `subtasks`: optional ordered list of Task entries (recursive), created only
  by the refinement flow (§4 Flow 2.5). A parent task is `done` when all its
  non-dropped subtasks are `done`. Subtasks never count toward the dial.

**Handoff** (the file at `handoff_path`; the product's core artifact)
Sections in this fixed order (ordered by 30-second-recovery priority):
1. **Verdict line**: what you asked → done / not done, and the ending reason
   in one sentence.
2. **Your turn**: the preference-fork decisions, each with concrete options
   and the runner's single recommendation plus its reason.
3. **Task ledger**: the declared task list with per-task status and evidence.
4. **Next-leg candidates**: 1–3 plain-language suggestions.
5. **Appendix**: technical detail, weapon-usage log (which salvo skills were
   invoked and why), file/line references. All jargon lives here.

**Dial** (configuration)
- `max_tasks_per_leg`: integer, default 4. Supplied per invocation (argument)
  or omitted for the default. Raising it moves the product toward loop
  engineering; it is the single designated removal point of the safety layer.

## 3. State Model

A leg is in exactly one of four states:

| State | Entered when | Left when |
|---|---|---|
| `declaring` | `/salvo:leg <mission>` is invoked | The runner has restated the mission and displayed the declared task list (1–4 items). Exits to `running` immediately — no confirmation wait. |
| `running` | Declaration displayed | Any stop condition fires: (a) next decision is a preference fork, (b) all declared tasks `done`, (c) task budget consumed, (d) same approach failed 2 times, (e) a task's verification cannot be run, (f) the user-set checkpoint (top-level task N) is reached. Exits to `stopping`. |
| `stopping` | A stop condition fired | The in-progress task (if any) is finished or abandoned-with-note — no new task may start — and the handoff file is written. Exits to `handed_off`. |
| `handed_off` | Handoff file written and reported in conversation | Terminal for this leg. A subsequent `/salvo:leg` in the same project starts a new leg that inherits the latest handoff (see §4 Flow 5). |

There is no paused/resumed state in v1: an interrupted session simply leaves
the leg unfinished, and the next invocation starts a fresh leg that inherits
the last completed handoff.

## 4. Event Flow

**Flow 1 — Leg start**
1. User invokes `/salvo:leg <mission>` (mission may be rough).
2. Runner reads the latest `legs/*.md` if present (inheritance) and any
   project spec/plan documents that already exist — these guide task
   granularity (the spec gives the approximate direction of what one task is).
3. Runner restates the mission in one plain line and declares 1–4 tasks.
4. Runner enters `running` without waiting for confirmation.
   On failure (mission empty and no inheritable context): ask one line, do
   not guess (error `missing_mission`).

**Flow 2 — Task execution**
1. Runner executes declared tasks in order; each task includes its own
   verification (run the code, run the test, measure — instruction-level
   discipline, not a separate phase).
2. After each task, runner records status + evidence.
3. Before starting the next task, runner checks the stop conditions (§3
   `running`). Checking "is the next decision a preference fork?" is the
   LLM-judgment layer; its written criterion: *would the user's answer change
   the direction or taste of the product, rather than its correctness?* If
   yes → stop condition (a).
4. If work reveals that the project's spec/plan documents are wrong on a
   measured point, the runner records a correction proposal for the "Your
   turn" section — it MUST NOT edit those documents on its own authority
   (§6 MUST-9).

**Flow 2.5 — Task refinement (in-leg)**
1. Before executing a task, the runner asks: *can this be completed and
   verified in one focused stretch?* If not, split it into subtasks (same
   plain-language rule). A subtask may split again; recursion ends when the
   answer is yes — then execute.
2. Splitting never adds scope: subtasks must decompose their parent, not
   introduce work outside it. Newly discovered work goes into the handoff as
   a next-leg candidate or a "Your turn" item, never into the running leg.
3. A task discovered to be unnecessary or wrong may be marked `dropped` with
   a one-line reason. Dropping and splitting are safe; adding is not.
4. The handoff's task ledger shows the resulting tree with per-leaf status
   and evidence.
5. Between legs, the user may manually edit the task ledger or the mission in
   the handoff file; such edits are treated as user decisions (Assumption
   A-4) and inherited by the next leg.

**Flow 3 — Weapon use inside a leg**
1. When a task hits a recall-type need ("find all…") the runner may invoke
   /salvo:sweep; when a single high-stakes answer needs a precision check it
   may invoke /salvo:vet; when the leg produced a spec-like document it may
   invoke /salvo:spec-gate.
2. Weapon use is at the runner's discretion (delegated by leg start — §6
   MUST-7), counts toward no task budget by itself, and MUST be logged in the
   handoff appendix (which weapon, why, one-line result).
3. On weapon failure (engine error, spawn failure): the runner proceeds
   without the weapon and notes the failure in the appendix — a weapon
   failure never aborts the leg by itself.

**Flow 4 — Stopping and handoff**
1. A stop condition fires. If a task is in progress: finish it if it can be
   finished without starting new work; otherwise mark `not_done` with a
   one-line note.
2. Write `legs/<id>.md` in the §2 Handoff format. Sections 1–2 obey the
   plain-language rule (§6 MUST-5).
3. Report in conversation: the verdict line + "Your turn" section inline, and
   the handoff path.
4. On failure to write the file (`handoff_write_failed`): emit the full
   handoff content into the conversation instead — the report must never be
   swallowed.

**Flow 5 — Next leg (inheritance)**
1. User answers the "Your turn" items (in conversation or by editing the
   handoff file) and invokes `/salvo:leg` again (with or without a new
   mission).
2. Runner reads the latest handoff, treats the user's answers as decisions
   (they are the ground truth for direction), and starts Flow 1 step 3 with
   that context.

## 5. Error Taxonomy

| Error | Meaning | Handling policy |
|---|---|---|
| `missing_mission` | No mission text and nothing inheritable | Ask the user in one line; do not start a leg. |
| `cap_hit` | Declared task budget consumed before fork/completion | Stop per Flow 4. Handoff verdict line states it first. Not an exception path — a normal, typed ending. |
| `stuck` | Same approach failed 2 times on one task | Stop per Flow 4. Handoff lists the attempted hypotheses (plain language) and recommends a fresh-eye handover, consistent with the salvo hook's stuck-escape rule. |
| `unverifiable` | Work done but its check cannot be run | Mark the task `not_done` ("built but unverified" in evidence), stop per Flow 4. Unverified results MUST be labeled — never presented as done. |
| `handoff_write_failed` | Cannot write `legs/<id>.md` | Emit full handoff content in conversation (Flow 4.4). |
| `weapon_failed` | A salvo skill invoked inside the leg errored | Continue the leg without it; note in appendix (Flow 3.3). |

Unifying policy: **every ending writes the handoff** (file or, failing that,
conversation), with the reason as the first line. There is no ending that
produces no report.

## 6. Invariants (MUST) / Defaults (SHOULD) / Choices (MAY)

- **MUST-1 (unconditional handoff)**: Every leg ending — all six
  `ending_reason` values — produces the handoff, reason stated first.
- **MUST-2 (scope boundary, asymmetric)**: The runner MUST NOT add new
  top-level work after declaration. Declared tasks MAY be split into subtasks
  and MAY be dropped with a stated reason (Flow 2.5) — refinement and removal
  are safe, addition is not. The dial (`max_tasks_per_leg`, default 4) caps
  top-level declarations only.
- **MUST-3 (verification inside the task)**: A task is `done` only with
  evidence of an actual check. Testing after a change is table stakes, not a
  separate task and never skippable.
- **MUST-4 (stop at the fork)**: When the next decision forks on user
  preference/direction, the runner stops rather than choosing — even if
  budget remains. The runner attaches exactly one recommendation per fork.
- **MUST-5 (plain-language report)**: Handoff sections 1–2 are written for a
  reader who is an expert in their own product but not in the implementation
  technology: no unexplained technical terms; an unavoidable term carries a
  one-line gloss in place. Technical detail belongs in the appendix. Success
  standard: readable in one pass without a search engine or translator.
- **MUST-6 (no auto-chaining in v1)**: `handed_off` is terminal; the next leg
  starts only from a user invocation.
- **MUST-7 (weapon delegation, FR-010 amendment)**: Within a leg, invoking
  /salvo:vet does not violate 001-vet-v1 FR-010 ("the gate fires only on the
  user's explicit call"): the leg invocation itself is the user's explicit
  delegation. This amendment MUST be recorded in 001-vet-v1's spec as a
  cross-reference when this system is implemented.
- **MUST-8 (checkpoint obedience)**: When the user scopes autonomy ("run
  through task N"), completing top-level task N is a stop condition even
  with budget remaining and no fork encountered.
- **MUST-9 (spec corrections are proposals)**: The runner MUST NOT edit the
  project's spec/plan documents during a leg; contradictions it measures
  become correction proposals in the handoff's "Your turn" section.
- **SHOULD-1**: Declare 3–4 tasks for a typical leg; fewer only when the
  mission is genuinely smaller. Coarse is fine — Flow 2.5 refines during the
  leg.
- **SHOULD-2**: Inherit the latest handoff at leg start when one exists.
- **SHOULD-3**: Keep the conversation report to the verdict + "Your turn"
  sections; the rest lives in the file.
- **MAY (implementation-defined)**: task decomposition technique; fork
  detection prompting; handoff file formatting beyond section order; appendix
  structure; how the dial is passed (argument syntax).

## 7. Acceptance Criteria

- **AC-1 (autonomous cycle)**: Given a real project and a rough one-line
  mission, When `/salvo:leg` runs, Then the runner declares ≤ 4 plain-language
  tasks, proceeds without any user interaction until a stop condition, and a
  `legs/<id>.md` file exists before the turn ends.
- **AC-2 (30-second recovery, primary SC)**: Given a completed handoff and a
  user returning from a different project, When the user reads only sections
  1–2, Then they can state the next-leg instruction within 30 seconds without
  opening any other file, browser, or translator. Measured in dogfooding by
  self-report per leg; target: pass on ≥ 8 of 10 consecutive legs.
- **AC-3 (jargon gate)**: Given handoff sections 1–2, When reviewed by a
  reader with no knowledge of the codebase, Then every sentence is
  understandable and zero technical terms appear without an in-place gloss.
- **AC-4 (boundary agreement)**: Given ≥ 10 dogfooded legs, When the user
  judges each stop point ("was this the right place to stop?"), Then ≥ 7 of
  10 stops are judged right. This is the bench for the LLM-judgment layer.
- **AC-5 (cap enforcement)**: Given a mission whose natural size exceeds the
  dial, When the declared budget is consumed, Then the runner stops without
  starting undeclared work and the handoff's first line states the cap stop.
- **AC-6 (no swallowed endings)**: Given any of the six ending reasons
  forced in a test scenario, When the leg ends, Then a handoff exists (file,
  or conversation fallback on write failure) with the reason as its first
  line.
- **AC-7 (in-leg refinement)**: Given a coarsely declared task that cannot be
  completed and verified in one focused stretch, When the leg runs, Then the
  handoff's task ledger shows that task as a tree of subtasks with per-leaf
  status and evidence, and no subtask introduces work outside its parent's
  scope.
- **AC-8 (checkpoint)**: Given an invocation scoped "through task 2 only",
  When top-level task 2 completes, Then the runner stops and hands off even
  though budget remains and no preference fork occurred.

## Decision Ledger *(mandatory)*

| # | Decision | Rationale (facts at the time) | Rejected alternatives |
|---|---|---|---|
| I-0 | System mode; new driving system designed as its own spec | New orchestration/state/contract surface regardless of packaging | Feature-mode patch on salvo docs |
| I-1 | Primary SC = context-recovery speed (30 s from handoff to next instruction) | Directly attacks the felt pain (3-4 project swap fatigue); cheaply measurable | Rework reduction (needs counterfactual), evolution capability (indirect), throughput (loose) |
| I-2 | Self-verification is part of every task; the handoff carries only verified results plus preference-fork decisions | User correction: testing after a change is table stakes — the runner must never push an unchecked result to the user for review | Verification as a separate final task; handing off raw results for user checking |
| I-3 | Leg boundary = 3-layer composite: delivery = skill; judgment = LLM with a written stop criterion; safety = mechanical cap (the dial) | Each layer does a different job; cap is the single removal point as models improve (detachable-parts philosophy); judgment layer benchable (AC-4) | Pick-one: skill-only (no enforcement), rule-only (no meaningful boundary), judgment-only (unmeasured trust) |
| I-4 | Task count is declaration-relative: mission → declared list at leg start; cap counts the declaration | An absolute mechanical definition of "task" does not exist, but a per-leg declaration (guided by whatever spec exists) is countable; declaration doubles as the handoff skeleton | Universal task metric (tool calls, commits, time — all inaccurate proxies) |
| I-5 | Packaging = new compartment inside salvo (`/salvo:leg`) | The runner is a consumer of salvo weapons — not a human-only toolset; identity extends from "arsenal" to "arsenal + the arm that wields it"; requires FR-010 delegation amendment (MUST-7) | Separate plugin (splits the runner from its weapons); temporary residence then move (second migration) |
| I-6 | v1 = one leg cycle, single project | Parallelism already achievable via multiple sessions/background jobs; handoff quality is what actually lowers swap cost | Cross-project queue view (v2 backlog), full swap UX |
| I-7 | Handoff = persistent file `legs/NNN.md`, fixed section order, latest-file inheritance | Survives compaction/session end; recovery-priority ordering; chain forms the project's decision history | Conversation-only (conflicts with SC-1), live dashboard (v2) |
| I-8 | Leg-ending standard = ① work is organized to be understood from the handoff in 30 s ② the requested tasks were handled. Ending taxonomy is reporting vocabulary, not policy machinery | User's framing: judge the ending by how it reads and whether the ask was done; all "bad endings" collapse into stating why ② is "no" | Separate per-case policy machinery (auto-extension on cap, hard mid-task kill) |
| I-9 | Plain-language rule for handoff body (MUST-5) | 30-second recovery is a language property, not just structure: an executive-report register, jargon in appendix only | Tech-register report with glossary links (still forces lookup) |
| I-10 | Task structure is fluid within a frozen scope: coarse declaration + in-leg recursive splitting + drop-with-reason; only adding top-level work is forbidden | A perfect task list cannot exist up front; splitting stays inside declared scope so the safety cap keeps its mechanical force (counts top-level only) | Frozen declaration (rejected as rigid); fully mutable list (erodes the budget boundary) |
| I-11 | User checkpoint command ("run through task N") as an additional stop condition | The user can scope autonomy per invocation without waiting for a fork; another face of the dial | Fork-or-budget-only stopping |
| I-12 | Spec corrections found mid-leg are proposals in the handoff, never autonomous edits | Editing the project's spec on the runner's own authority is self-licensing; direction changes belong to the variation point | Runner-applied spec patches; silently ignoring the contradiction |

## Deferred to Implementer *(waiver record)*

(none yet)

## Assumptions

- **A-1**: Dial default `max_tasks_per_leg = 4`; per-invocation override is
  an argument of `/salvo:leg`. (User set the 3-4 band; 4 chosen as the cap.)
- **A-2**: Declare-then-go — the task declaration is displayed but the runner
  does not wait for confirmation before running. Rationale: a confirmation
  stop would add one more swap interrupt per leg, against the product's
  purpose. The user can interrupt at any time.
- **A-3**: `legs/` lives at the project root of the project being worked on.
- **A-4**: Inheritance = the highest-numbered `legs/*.md`; user edits to a
  handoff file are treated as user decisions.
- **A-5**: The handoff body is written in the user's conversation language
  (Korean for this user); this SPEC is English because it is a machine-facing
  contract, but the product's artifact follows the user.
- **A-6**: AC-2/AC-4 numeric targets (8/10, 7/10) are provisional dogfooding
  thresholds; the gate round may adjust them before implementation.
- **A-7**: External users of the salvo plugin are not assumed; migration
  concerns for the FR-010 amendment are local (consistent with the earlier
  rename decision's assumption).
- **A-8**: Task refinement (Flow 2.5) is an internal flow of the runner in
  v1, not a separate user-facing skill; if it proves heavy in dogfooding it
  can be extracted into its own skill later without changing this contract.
