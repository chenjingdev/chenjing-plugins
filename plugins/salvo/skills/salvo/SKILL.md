---
name: salvo
description: "The salvo door — state work in plain language and the platform routes it: fires a preset weapon, forges an improvised weapon (N independent starved shooters + a declared fold, counted by code), dispatches a single-shot delegation, refers spec work to /spec, or names why it cannot fire. Use this whenever the user invokes /salvo, wants work fanned out to several independent agents and merged, wants a measured (recountable) result instead of one model's opinion, or wants work done outside the current session. Usage: /salvo <request>"
---

# /salvo — the weapon-platform door

One shot is a guess; a salvo — N independent passes folded by pure code — is a
measurement. This skill is the single door: every request becomes an intake
form (신고서), and the form itself is the routing decision.

**First principle (제1원칙)**: this session routes, announces, transcribes,
and archives. The shots run in ONE Workflow call and every count comes out of
code — the workflow script and the bundled scripts — which is what keeps each
number recountable and this session's context clean enough to stay a fair
courier.

**Language**: announcement and report in the user's conversation language;
forms and residue in English (machine-facing, A6).

Paths: `<base>` = this skill's base directory. Residue lives at
`~/.claude/plugins/data/salvo-chenjing-plugins/residue/` (D-6; the default of
`residue.mjs`).

## 1. Route

Decide in this order:

1. **Spec-shaped request** — the asked-for deliverable is a design or spec
   document → point the user to `/salvo:spec` and stop. No form, no residue.
2. **Preset scan** — list sibling skills carrying a form:
   `ls <base>/../*/intake-form.json`. Read each file's `.form.definition` and
   compare it against the request (this comparison is routing judgment — the
   code-only rule M1 binds the fold, not routing). On a match, use that form
   as-is and continue at §4; the announcement names the preset — that is how
   the user sees preset priority. (v1 ships zero presets, so today this falls
   through.)
3. Otherwise — **forge** an improvised weapon (§2).

## 2. Forge

The routing decision IS the form: whether this request is a measurement, a
delegation, or unfillable is discovered by trying to fill the fields, in this
order.

1. **definition** — 1–2 sentences naming the input target and the output
   shape.
2. **fold** — ask what the shooter outputs can be merged on:
   - Findings matchable on an identity key → `union` (enumerate everything
     found) or `vote` (keep what ≥ threshold shooters independently agree
     on — choose vote when the user asks for confidence over coverage).
   - N complete artifacts of which one should survive → `pick`, plus
     `pick.criterion` and its route: `mechanical` when the criterion maps to
     a program — set `pick.program` to `{"kind":"shortest"}`,
     `{"kind":"longest"}`, or `{"kind":"command","command":"<cmd with
     {candidate}>"}` (a stated test command). A criterion that maps to no
     program routes `judged` — a starved judge selects and the report says
     so.
   - No fold, but the work runs unattended in another session → delegation:
     `volley: 1`, `fold: "none"`.
   - The work needs the user mid-execution (co-editing, mid-course decisions
     only the user can make) → **reject**: name the unfillable aspect in one
     line, suggest a plain session, stop. No dispatch, no residue.
3. **volley** — default 3; above 5 only when the user explicitly asked for
   that scale.
4. **isolation** — `sealed` whenever the target content fits in the shooter
   prompt (embed it — sealing is what guarantees independence, S5); `tooled`
   only when the work must touch the repository or environment (search,
   edits, running tests).
5. **invention** — `forbidden` for inspection weapons (shooters report only
   what is in the target); `allowed` for generation and delegation.
6. **criteria_from** — `request` (embed the user's request text), `document`
   (+ `criteria_ref` path — the document must exist, C5), or `shooter` (the
   shooter's own judgment).
7. **anchors** (only for `union`/`vote`) — declare a code-checkable
   vocabulary (C6):
   - closed list:
     `node <base>/scripts/extract_anchors.mjs <target> --mode headings`
     (or `--mode regex --pattern '<re>'`); put the printed array into
     `anchors.values` with `"kind": "closed_list"` and note the extraction in
     `anchors.source`. The values land in the shooter output schema as the
     allowed anchors.
   - or `"kind": "quote"` — shooters anchor by verbatim quotation and the
     workflow validates every quote as a substring of the target.
8. **residual** — any constraint no field above carries, or `""`. It rides
   into the shooter prompt's Rules block and stays in the residue as the
   form-evolution signal.

Write the finished form as JSON to a temp file (shape below — the same shape
`check_form.mjs` validates):

```json
{
  "definition": "…", "fold": "union|vote|pick|none",
  "vote_threshold": 2, "pick": { "criterion": "…", "route": "…", "program": { "kind": "…" } },
  "volley": 3, "isolation": "sealed|tooled", "invention": "forbidden|allowed",
  "criteria_from": "request|document|shooter", "criteria_ref": "…",
  "anchors": { "kind": "closed_list|quote", "values": ["…"], "source": "…" },
  "residual": ""
}
```

(Conditional fields appear only where their condition holds — `check_form.mjs`
rejects both missing-when-required and present-when-forbidden.)

## 3. Coherence — run the code, not your judgment

`node <base>/scripts/check_form.mjs <form.json>` — prints `OK` or the violated
rules. On a violation: re-draft the form once, silently, and re-run. On a
second violation: reject — report the violated rule to the user
(`rejected_incoherent`) and stop. A missing `criteria_ref` document is C5
(`rejected_missing_target`).

## 4. Residue before dispatch (M5)

```
node <base>/scripts/residue.mjs new --form <form.json> --digest "<one-sentence digest of the request>"
```

It prints the record path — keep it for the outcome update (§7). The record
is on disk before any shooter exists, so even an interrupted firing leaves
its trace.

## 5. Announce, then fire (M7)

Print exactly one line in the user's language — definition digest, volley
count, fold rule; name the preset if one matched. Then fire immediately: the
announcement is the user's chance to interrupt, so it stands in for asking
permission. Example: `발사: "plan.md의 모순 열거" — 3발, union 접기`.

## 6. Fire — one Workflow call (M4)

1. Build the shooter prompt from
   `<base>/references/shooter-prompt-template.md`: replace the placeholders
   per its comments, then delete the comments. Sealed forms embed the full
   target content — the finished prompt is everything a shooter will ever
   see (M2).
2. Call the Workflow tool with:
   - `scriptPath`: `<base>/references/volley-workflow.js`
   - `args`: `{ "form": <the form>, "shooterPrompt": "<the prompt>",
     "target": <target text when anchors.kind is "quote", else null>,
     "model": <tier name only when the user named one, else null> }`
   The script fires N shooters in parallel (sealed → the no-tools
   `salvo:shooter` agent; tooled → the default agent), enforces the output
   schema at the dispatch layer (closed-list anchors as a schema enum; quote
   anchors substring-validated with up to 2 conformance re-requests), requires
   all N to succeed, and folds by code (M1/M11). A volley can take minutes —
   wait for it.
3. Act on the returned object's `kind`:
   - `folded` / `single` / `picked` → report (§7).
   - `candidates` (mechanical pick, command program) → write each candidate to
     a temp file and run
     `node <base>/scripts/pick_command.mjs --command '<the stated command>' <files…>`;
     the printed `choice` names the winner. Report as a mechanical pick.
   - `void` → report the failure only (§7).

## 7. Report, then close the residue

Transcribe the returned object — every number in the report comes from the
script, none from your own recount:

- **folded**: header `N발 일제사격, {union|vote} 접기` (for vote add the
  threshold and how many groups fell below it), then each item as its anchor,
  its count, and the contributing contents. Echo the announcement's
  definition digest so the user can match report to residue (S4).
- **picked**: show the selected candidate with the criterion text, labeled
  `기계 선택` (mechanical — name the program) or `판단 선택` (judged — quote
  the judge's grounds) (M6).
- **single**: the raw result plus the literal label `한 발은 짐작` (M6).
- **void**: state which shooter failed and that no partial fold exists;
  re-firing is the user's explicit choice (M8).

Then close the record:

```
node <base>/scripts/residue.mjs outcome <record-path> <folded|void|delegated>
```

`folded` for measurements and picks, `delegated` for volley-1 dispatches,
`void` for failures.

## What keeps the platform honest

- Counting lives in code (`volley-workflow.js`, `scripts/`) — the overlap
  count is the platform's only added information over a single pass, and it
  stays recountable because no LLM touches it (M1).
- Shooters and the judge see only their own prompt (M2): starving them is
  what makes N shots N independent measurements instead of one opinion echoed
  N times.
- A failed shooter voids the whole volley (M8): a partial fold would report a
  denominator that never fired.
- Every dispatch passes through the same form (M9) and leaves residue before
  firing (M5) — the residue pile, not design taste, decides which weapons
  earn promotion to presets.
