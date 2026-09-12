# /tiers:delegate setup

Read the current `${CLAUDE_PLUGIN_DATA}/delegate.json` first (defaults if missing:
`{"model":"opus","enabled":false,"pin":"all","prose":[".md",".mdx",".rst",".txt"],"small_edit_chars":200,"log":true}`).

One AskUserQuestion call with three questions, each offering "그대로 유지" reflecting the current value:

1. **model** — the tier for `tiers:worker` and for pinned Agent calls: opus (Recommended) / sonnet / haiku / fable.
2. **pin** — which Agent calls get that model when they omit one: all (Recommended: every subagent, so nothing inherits the session model) / worker (only `tiers:worker`).
3. **small_edit_chars** — the largest single Edit the main session may still make to a code file while delegate mode is on: 200 (Recommended) / 0 (none) / 500. Mention that other values can be typed via Other.

`prose` — the extensions the session writes itself and the worker may not touch — is not asked here. Mention in one line that it defaults to `.md .mdx .rst .txt`, that `[]` turns the rule off, and that a project needing a different list edits the file by hand.

Then:

1. Write the result to `${CLAUDE_PLUGIN_DATA}/delegate.json` (create the directory first if needed), keeping `enabled`, `prose` and `log` as they were.
2. Show the saved JSON and remind in one line that it applies immediately and that `on`/`off` turns the whole hook on or off, pinning included.

(Do NOT edit plugin files — the plugin directory is a read-only cache that updates clobber.)
