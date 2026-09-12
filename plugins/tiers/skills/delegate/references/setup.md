# /tiers:delegate setup

Read `${CLAUDE_PLUGIN_DATA}/delegate.json` (defaults if missing:
`{"model":"opus","enabled":false,"pin":"all","prose":[".md",".mdx",".rst",".txt"],"small_edit_chars":200,"log":true}`).

Ask three questions in one AskUserQuestion call, each with a "그대로 유지" option showing the current value:

1. **model** — tier for `tiers:worker` and for pinned Agent calls: opus (Recommended) / sonnet / haiku / fable.
2. **pin** — which Agent calls get that model when they omit one: all (Recommended) / worker.
3. **small_edit_chars** — largest single code Edit the main session may still make while on: 200 (Recommended) / 0 / 500. Other values via Other.

`prose` is not asked. Say in one line that it defaults to `.md .mdx .rst .txt`, that `[]` turns the rule off, and that a different list is edited by hand in the file.

Write the result to `${CLAUDE_PLUGIN_DATA}/delegate.json` (create the directory if needed), keeping `enabled`, `prose` and `log`. Show the saved JSON and say it applies immediately.

Do not edit plugin files; the plugin directory is a read-only cache.
