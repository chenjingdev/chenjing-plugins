---
name: delegate
description: Use when the user runs /tiers:delegate — the switch for the tiers delegate hook. `on`/`off` turns the whole hook on or off (role text at session start, model pinning, code-edit denial in the main session, prose-edit denial for the worker, brief check), `status` shows config and recent handoffs, `setup` changes the tier, `<task>` turns it on and does the task. The working rules arrive from the role text the hook injects, its deny messages and the worker's replies, not from this skill.
argument-hint: "on | off | status | setup | <작업>"
disable-model-invocation: true
---

# delegate

Config: `${CLAUDE_PLUGIN_DATA}/delegate.json`, read on every hook call, so changes apply at once.
Defaults: `{"model":"opus","enabled":false,"pin":"all","prose":[".md",".mdx",".rst",".txt"],"small_edit_chars":200,"log":true}`

Arguments: $ARGUMENTS

| Arguments | Do |
|---|---|
| `on` / `off` | Read the config (create the directory and file with the defaults if missing), set `enabled`, write it back keeping the other keys. Confirm in one line: mode, worker model, pin scope. After `on`, follow `references/role.md` (relative to this skill's base directory); the hook injects that same file on its own at the next session start or compaction. |
| `status` or empty | Print enabled, model, pin, prose, small_edit_chars, log, the data dir path, whether `TIERS_DELEGATE` is set, and the three newest files in `${CLAUDE_PLUGIN_DATA}/handoffs/`. Do not run a task. |
| `setup` | Follow `references/setup.md` (relative to this skill's base directory). Do not run a task. |
| anything else | TASK = the arguments. If `enabled` is false, set it to true first and say so. Then do TASK following `references/role.md` (relative to this skill's base directory); when you reach for the wrong tool the hook says what to do instead. |
