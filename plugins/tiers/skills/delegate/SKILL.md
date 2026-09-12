---
name: delegate
description: Use when the user runs /tiers:delegate — the everyday delegation layer of tiers. The main session keeps judgment (intent, narrow reading, the brief, verification) and hands implementation to the pinned-tier `tiers:worker`; wide lookups go to `tiers:scout`. `on`/`off` toggles hook enforcement, `status` shows config and recent handoffs, `setup` changes the tier, and `<task>` runs the protocol once.
argument-hint: "on | off | status | setup | <작업>"
disable-model-invocation: true
---

# delegate — plan here, implement there

tiers pins the tier of everything you fan out. `/tiers:ultracode` does it for Workflow runs; this
skill does it for ordinary work through the Agent tool, and adds the discipline that makes a
handoff survive: a structured brief, an ask-back channel, and verification by the session that
holds the context.

The plugin's hook (`hooks/guard.js`) already does three things whether or not this skill is
loaded: it pins the model of Agent calls that omit one, and — when enforcement is on — it denies
implementation edits in the main session and rejects worker briefs that lack the four sections.
Config lives in `${CLAUDE_PLUGIN_DATA}/delegate.json` and is read on every call, so changes apply
immediately, no restart.

## Dispatch — decide by arguments

Arguments: $ARGUMENTS

| Arguments | Action |
|---|---|
| `on` / `off` | Read `${CLAUDE_PLUGIN_DATA}/delegate.json` (create the directory and file if missing; defaults below), set `enforce` to true/false, write it back keeping the other keys, then confirm in one line: mode, worker model, pin scope. |
| `status` or empty | Read the config (or say the defaults are in effect), then print: enforce, model, pin, small_edit_chars, log, the data dir path, whether `TIERS_DELEGATE` is set in this environment, and the three most recent files under `${CLAUDE_PLUGIN_DATA}/handoffs/` if any. Finish with the five-line rules digest below. Do not run a task. |
| `setup` | Read `references/setup.md` (relative to this skill's base directory) and follow it. Do not run a task. |
| anything else | TASK = the arguments. Run the protocol below once, now, regardless of whether enforcement is on. |

Defaults when the file is missing:
`{"model":"opus","enforce":false,"pin":"all","small_edit_chars":200,"log":true}`

## The protocol — one work item

1. **Narrow reading, yourself.** Read the specific files the brief will cite. Do not delegate the
   reading that feeds your own judgment. Anything wide — "find every caller", "what did we decide
   about X last month", "how does this library handle Y" — goes to `tiers:scout` with a *question*,
   not keywords; it returns verbatim excerpts with provenance and no conclusions.
2. **Write the brief.** Four sections, real content in each. Korean or English headings.
   - `## 목표 (Goal)` — what to achieve in the user's terms, plus how you resolved anything ambiguous.
   - `## 맥락 (Context)` — what you already found: files with line refs, conventions, decisions made
     in this conversation and *why*, rejected alternatives. The worker starts with none of this.
   - `## 범위 (Scope)` — files to touch and not to touch, what the user explicitly does not want,
     and which decisions you hand to the worker's discretion.
   - `## 완료 기준 (Done when)` — observable criteria and the exact verification commands.
3. **Spawn `tiers:worker`** with the Agent tool (`subagent_type: "tiers:worker"`, the brief as the
   prompt). Do not pass `model`; the hook pins it. Do not wrap this in a Workflow.
4. **Answer BLOCKED in place.** If the worker returns a message starting with `BLOCKED:`, reply
   with SendMessage to that same agent — its context is intact. Never spawn a fresh worker to
   answer a question the old one asked. If the same spot blocks twice, the gap lives in your head:
   run `/tiers:delegate off`, make that part yourself, run `on` again.
5. **Verify yourself.** `git diff`, run the done-when commands, read the worker's "Decisions I
   made" and "Open / Risks". Send fix-ups to the same worker as a follow-up message.
6. **Reuse or refresh.** The next task on the same files in the same sitting goes to the same
   worker. When the area changes, or the worker's report shows it is confused or carrying a lot of
   context, start a new one.
7. **Report to the user** in your own words: what changed, what you verified and how, which
   decisions were delegated and what the worker chose, what remains.

## Rules digest (print with `status`)

- Implementation is the worker's, without exception; the session plans, briefs, verifies.
- Narrow reading for the brief is the session's; wide sweeps are the scout's (excerpts + provenance, no conclusions).
- One worker per work item; questions and fix-ups go back to that worker, not to a new one.
- Escape hatches: one Edit under `small_edit_chars`; writes under /tmp; `/tiers:delegate off` for analysis sessions or a repeating BLOCKED loop; `TIERS_DELEGATE=off` for one session.
- Model pinning of Agent calls stays on even when enforcement is off (`pin: all|worker|off`).
