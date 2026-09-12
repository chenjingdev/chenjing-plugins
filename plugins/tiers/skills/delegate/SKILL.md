---
name: delegate
description: Use when the user runs /tiers:delegate — the everyday delegation layer of tiers. The main session plans, briefs, verifies and writes human-facing documents; `tiers:worker` writes the code; `tiers:scout` does wide lookups. `on`/`off` turns the whole hook on or off (model pinning included), `status` shows config and recent handoffs, `setup` changes the tier, `<task>` runs the protocol once.
argument-hint: "on | off | status | setup | <작업>"
disable-model-invocation: true
---

# delegate

Config: `${CLAUDE_PLUGIN_DATA}/delegate.json`, read on every hook call, so changes apply at once.
Defaults: `{"model":"opus","enabled":false,"pin":"all","prose":[".md",".mdx",".rst",".txt"],"small_edit_chars":200,"log":true}`

While `enabled` is true the hook pins the model of Agent calls, denies code edits in the main session, denies prose edits by the worker, and rejects worker briefs missing the four sections. Off, it does nothing.

## Dispatch

Arguments: $ARGUMENTS

| Arguments | Do |
|---|---|
| `on` / `off` | Read the config (create the directory and file with the defaults if missing), set `enabled`, write it back keeping the other keys. Confirm in one line: mode, worker model, pin scope. |
| `status` or empty | Print enabled, model, pin, prose, small_edit_chars, log, the data dir path, whether `TIERS_DELEGATE` is set, and the three newest files in `${CLAUDE_PLUGIN_DATA}/handoffs/`. Then print the rules digest. Do not run a task. |
| `setup` | Follow `references/setup.md` (relative to this skill's base directory). Do not run a task. |
| anything else | TASK = the arguments. Run the protocol once, now, whether the hook is on or off. |

## Protocol — one work item

1. Read the specific files the brief will cite, yourself. Send wide questions ("every caller of X", "what did we decide about Y") to `tiers:scout` as a question; it returns excerpts with provenance.
2. Write the brief, four sections with real content:
   - `## 목표 (Goal)` — what to achieve in the user's terms; how you resolved ambiguity.
   - `## 맥락 (Context)` — files with line refs, conventions, decisions made in this conversation and why, rejected alternatives. The worker has none of this.
   - `## 범위 (Scope)` — files to touch and not, what the user does not want, decisions left to the worker.
   - `## 완료 기준 (Done when)` — observable criteria and the exact verification commands.
3. Spawn `tiers:worker` with the Agent tool (`subagent_type: "tiers:worker"`, the brief as the prompt). No `model`; the hook pins it. No Workflow.
4. On `BLOCKED:` answer with SendMessage to the same agent. Never spawn a new worker for the old one's question. If the same spot blocks twice, run `/tiers:delegate off`, do that part yourself, run `on`.
5. Verify: `git diff`, run the done-when commands, read "Decisions I made", "Open / Risks", "Docs for the session". Fix-ups go to the same worker.
6. Write the prose yourself: README lines, handoff notes, any text a person reads, in your own words. The worker's report is material, not copy.
7. Same files, same sitting: reuse the worker. New area, or a worker that reports confused: start a new one.
8. Report to the user: what changed, how you verified it, what the worker decided, what remains.

## Rules digest (print with `status`)

- Code is the worker's; the session plans, briefs, verifies, and writes every human-facing document.
- Narrow reading is the session's; wide sweeps are the scout's (excerpts + provenance, no conclusions).
- One worker per work item; questions and fix-ups go back to it.
- The session may still write: prose files, /tmp, `${CLAUDE_PLUGIN_DATA}/delegate.json`, one code Edit under `small_edit_chars`.
- `off` stops the whole hook, pinning included; `TIERS_DELEGATE=off` does it for one session; `pin: all|worker` sets how far pinning reaches while on.
