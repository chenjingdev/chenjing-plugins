---
name: leg
description: "Use for a mid-size mission — a rough idea that needs autonomous progress with a report at the end, roughly a 3-4 task stretch: '이거 진행해줘', 'take this the next stretch', 'run with this and tell me where you stopped'. The runner decomposes the mission into a small declared task list (≤4), drives it autonomously WITH verification inside each task, and STOPS at the first decision that forks on your product preference (not correctness) — then leaves a 30-second plain-language handoff at legs/NNN.md. Supports a checkpoint ('task N까지만') and a dial (max top-level tasks). NOT for a single quick question (answer it directly) and NOT for full loop engineering that already has a detailed up-front design (that is 10+ tasks with a plan; leg is the gap between one-shot and the loop)."
argument-hint: "<rough mission> [through task N] [max tasks] — the mission to drive one leg on, optional checkpoint, optional dial override"
---

# /salvo:leg — mid-range autonomous driving harness

A one-shot answers one question; loop engineering runs ten-plus tasks but only
after a detailed design already exists. Between them sits the everyday case: a
rough idea that needs someone to actually move it forward, but where hovering to
steer every few minutes is the exact cost you are trying to avoid — especially
while swapping across three or four parallel projects. A **leg** is one pass of
that middle ground: decompose the rough mission into a small declared task list,
drive it autonomously (verification folded into each task), and stop at the
**variation point** — the first decision that forks on your product *taste or
direction* rather than on correctness. Then hand off a report you can absorb in
30 seconds and answer from, without opening another file or reaching for a
search engine. The stop is the product: the runner does the parts a machine
should decide and returns exactly the parts only you should.

**Language**: This SKILL.md is English because it is machine-facing instruction.
The **product** — the handoff file at `legs/NNN.md` and everything reported in
the conversation — is written in the **user's conversation language** (Korean
for this user; A-5). The 30-second recovery in MUST-5 is a language property,
not just a structure one: sections 1–2 must read in the user's own language, in
plain register, with no term that forces a lookup.

## Procedure

### 1. Start — locate, inherit, declare (Flow 1)

**Resolve where legs live.** `legs/` sits at the **git top-level of the project
being worked on** (`git rev-parse --show-toplevel`; fall back to the current
working directory if not a git repo). Create `legs/` if it is absent. The leg
`id` is the **highest existing 3-digit filename + 1**, or `001` if the directory
is empty. This is per-project, monotonic, and survives session end — the chain
of `legs/*.md` becomes the project's decision history.

**Inherit (SHOULD-2).** If a prior handoff exists, read the **highest-numbered**
`legs/*.md`. Also read any project spec/plan documents that already exist (search
the conventional numbered-spec location, e.g. `specs/NNN-*/`); if none, proceed
with coarser declaration and skip contradiction detection. The spec, when
present, tells you roughly *how big one task is* — use it only to calibrate
granularity, never as a source of new scope.

**Declare (the safety layer you can dial).** Restate the mission in **one plain
line** (quote the user's words, then your one-line plain-language restatement),
then declare **1–4 top-level tasks**. Default cap is **4**; a per-invocation
override is parsed from the invocation (e.g. "max 3 tasks", "task 6개까지"). The
cap counts **top-level entries only** and is the single designated removal point
of the safety layer — raising it moves the product toward loop engineering, so
it stays independent of the LLM judgment layer: it is a fixed number the user
dials, not something the runner reasons its way past. Aim for 3–4 tasks on a
typical leg (SHOULD-1); fewer only when the mission is genuinely smaller. Coarse
declarations are expected — refinement happens while working (step 3), not up
front.

**On inheritance, re-declare — do not raw-copy.** A continuation leg folds the
prior handoff's `not_done` tasks + its next-leg candidates + the user's answers
to the last "Your turn" into a **fresh ≤4 top-level declaration** that preserves
their intent. Re-derive the list each leg (consistent with the per-leg
declaration model); do not auto-populate the old entries verbatim. The user's
answers are ground truth for direction.

**Then go — do not wait (A-2).** Display the declaration and enter execution
**without** waiting for confirmation. A confirmation stop would add exactly the
swap-interrupt this product exists to remove; the user can interrupt at any time.
If the mission is empty **and** nothing is inheritable, ask one line and do not
guess (`missing_mission`).

**Parse the checkpoint (MUST-8).** If the invocation scopes autonomy in natural
language ("task 2까지만", "through task 2 only", or an explicit int), record
checkpoint N. N binds to the **Nth top-level declared task, by declaration
order** (a dropped task keeps its slot) — and task numbers only exist *after*
you declare, so bind it then. If N is greater than the number of declared tasks,
the checkpoint simply **never fires** and the leg ends normally on completion or
cap. Completing top-level task N is then a stop condition even with budget left
and no fork seen.

### 2. Execute, with verification inside each task (Flow 2, MUST-3)

Run the declared tasks **in order**. Verification of a task's own result is
**part of that task**, not a later phase and never skippable: run the code, run
the test, measure — instruction-level discipline. A task is `done` **only with
evidence** of an actual check (the test output, the command you ran, a one-line
description of a manual check). "It should work" is not evidence — a task whose
result was not checked is `not_done`, never `done`. The reason: the handoff must
carry only *verified* results plus preference-fork decisions; pushing an
unchecked result to the user for review is the failure this product refuses.

After each task, record its `status` + `evidence`. Before starting the next task,
check the stop conditions (step 5).

If work reveals that the project's spec/plan documents are **wrong** on a point
you measured, do **not** edit those documents (MUST-9). Record a correction
**proposal** for the "Your turn" section — a direction change belongs to the
user at the variation point, not to the runner's own authority.

### 3. Refine in-leg — split recursively, drop with reason, NEVER add (Flow 2.5, MUST-2)

Before executing a task, ask: *can this be completed and verified in one focused
stretch?* If not, **split it into subtasks** (same plain-language rule). A subtask
may split again; the recursion ends when the answer is yes, then execute.
Subtasks **never count toward the dial** — the cap governs top-level declarations
only. A parent is `done` when all its non-dropped subtasks are `done`.

The boundary is **asymmetric, and this asymmetry is the whole safety model**:

- **Splitting is safe** — it decomposes a declared task, staying inside its
  scope, so the mechanical cap keeps its force.
- **Dropping is safe** — a task found unnecessary or wrong is marked `dropped`
  with a **one-line reason** (if every subtask of a parent is dropped, the parent
  is `dropped`/`not_done` with a reason).
- **Adding top-level work is forbidden.** Newly discovered work goes into the
  handoff as a **next-leg candidate** or a **"Your turn"** item — never into the
  running leg. This is why the cap is trustworthy: the user set a number, and no
  amount of mid-leg discovery can inflate it past that number without a new
  invocation.

### 4. Weapons — use salvo's arsenal on your own judgment (Flow 3, MUST-7)

The runner is the arm that wields the arsenal; it may invoke salvo weapons inside
a leg on its own judgment. The **leg invocation itself is the user's explicit
delegation** (MUST-7, the FR-010 amendment) — invoking `/salvo:vet` inside a leg
does not violate 001-vet-v1 FR-010's "gate fires only on explicit call", because
the leg call *is* that explicit call.

- **`/salvo:sweep`** when a task hits a recall need — "find all X", audit,
  exhaustive coverage.
- **`/salvo:vet`** when one high-stakes answer needs a precision check before you
  build on it.
- **`/salvo:spec-gate`** when the leg produced a spec-like document to harden.

Weapon use counts toward **no task budget** by itself and **MUST be logged in the
handoff appendix** (which weapon, why, one-line result). On weapon failure
(engine error, spawn failure), **proceed without it** and note the failure in the
appendix — a weapon failure **never aborts the leg** by itself.

### 5. Stop at the fork — the runner's core skill (§3 running, MUST-4)

Before each next task, check whether any stop condition has fired:

- **(a) preference fork** — the next decision would change the **direction or
  taste** of the product rather than its correctness. Written criterion: *would
  the user's answer change what the product feels like or aims for, not whether
  it works?* If yes, **stop rather than choose** — even if budget remains. Attach
  **exactly one recommendation** per fork, with its reason.
- **(b) mission_complete** — all non-dropped top-level tasks `done` and verified.
- **(c) cap_hit** — the declared top-level budget is consumed with the mission's
  natural scope not fully covered (the remainder becomes next-leg candidates).
- **(d) stuck** — the **same approach failed 2 times** on one task: two failed
  attempts sharing the **same core hypothesis / method** (LLM judgment, like fork
  detection). Stop; in the handoff, list the attempted hypotheses **in plain
  language** and recommend a **fresh-eye handover**.
- **(e) unverifiable** — work is done but its check **cannot be run**. Mark the
  task `not_done` with evidence "built but unverified"; an unverified result MUST
  be labeled, never presented as done.
- **(f) checkpoint** — top-level task N (step 1) completed.

`ending_reason` is **reporting vocabulary only** — every value routes to the same
behavior (write the handoff, reason first). When several fire at once, pick the
**first line's** reason by recovery value:
**preference_fork > checkpoint > stuck/unverifiable > cap_hit > mission_complete**.
This picks only which word leads the report; it never branches policy.

### 6. Finish the in-progress task or note it — never start new work (Flow 4)

Once a stop condition fires: if a task is in progress, **finish it only if it can
be finished without starting new work**; otherwise mark it `not_done` with a
one-line note. **No new task may start** in the stopping state.

### 7. Write the handoff, then report inline (Flow 4, MUST-1)

Write `legs/<id>.md` in the fixed 5-section format below. Sections 1–2 obey the
plain-language rule (MUST-5). Then **report in the conversation**: the **verdict
line + "Your turn" section inline**, plus the handoff path (SHOULD-3 — the rest
lives in the file). **Every ending writes a handoff** — all six reasons, reason
stated first; there is no ending that produces no report.

**On file-write failure** (`handoff_write_failed`): emit the **full handoff
content into the conversation** instead. The report must never be swallowed.

### 8. Next leg is a new invocation (MUST-6)

`handed_off` is terminal. The runner does **not** auto-chain into a next leg —
the next leg starts only when the user invokes `/salvo:leg` again, at which point
it inherits per step 1. Returning control to the user at every leg end is the v1
contract; automatic chaining is a future dial-raise, not a v1 behavior.

## Handoff file template (`legs/<id>.md`)

Sections in **this fixed order** (ordered by 30-second-recovery priority). Write
sections 1–2 in the user's language for a **product owner, not an engineer** —
because the reader is swapping between three or four projects and must recover in
30 seconds without a search engine or translator. Any unavoidable technical term
carries a **one-line gloss in place**; all real technical detail goes to the
appendix (section 5).

```
# Leg <id> — <mission in one plain line>

## 1. Verdict            (what you asked → done / not done, + ending reason, one sentence)
## 2. Your turn          (each preference-fork decision: concrete options + ONE recommendation + why.
                          If the ending has no fork, keep this section and write "결정할 것 없음 / no decision required".)
## 3. Task ledger        (the declared task tree; per-leaf status {done|not_done|dropped} + evidence; dropped carries its reason)
## 4. Next-leg candidates (1–3 plain-language suggestions — newly discovered work lands here, never in this leg)
## 5. Appendix           (technical detail, weapon-usage log [weapon · why · one-line result], file/line refs; ALL jargon lives here)
```

**Worked example of the target register** (verdict + Your-turn pair; kept in
Korean inside this English body precisely because it is an example of the
*product's* register — this is the user-approved plain register to match):

> **시킨 일:** 메모 검색이 하위 폴더에서 안 되던 문제 → 고쳤고, 실제로 돌려서
> 확인까지 끝남.
> **당신 차례:** 검색 결과를 '최근 수정 우선'으로 할지 '제목 일치 우선'으로
> 할지 — 제품 취향 문제라 멈췄음. 추천: 제목 일치 우선(안 그러면 어제 만진
> 파일만 계속 위에 뜸).

Note what makes it a good pair: the verdict says *done and actually checked* (not
"should work"); the fork is a genuine taste choice, not a correctness one; there
is exactly one recommendation with a plain, concrete reason. No jargon reaches
the reader.

## Do NOT

- **Add top-level tasks after declaration.** Split (recursively) and drop (with a
  reason) are the only structural moves. New scope goes to next-leg candidates or
  "Your turn", never into the running leg — the dial only means something if
  nothing can inflate it mid-leg.
- **Auto-chain into a next leg.** `handed_off` is terminal (MUST-6); the next leg
  is a fresh user invocation.
- **Edit the project's spec/plan documents.** A measured contradiction becomes a
  correction **proposal** in "Your turn" (MUST-9) — the runner never patches
  direction on its own authority.
- **Start new work in the stopping state.** Finish the in-progress task only if it
  needs no new work; otherwise mark it `not_done` with a note.
- **Present an unchecked result as done.** No evidence → `not_done` (MUST-3);
  "built but unverified" must be labeled as such.
- **Choose at a preference fork.** Stop and hand the fork back with one
  recommendation (MUST-4) — budget remaining is not a license to pick the user's
  taste for them.
- **Let a weapon failure abort the leg.** Proceed without it, note it in the
  appendix (Flow 3.3).
- **Put jargon in handoff sections 1–2.** Product-owner register only; unavoidable
  terms get an in-place gloss, technical detail goes to the appendix (MUST-5).
- **Commit the project's changes unless the mission asks.** Leave work in the
  working tree — the handoff's appendix carries the file refs the user needs to
  review it; committing is the user's call at the variation point.
- **End a leg without a handoff.** If the file write fails, emit the full handoff
  into the conversation (Flow 4.4) — no ending is ever silent.
