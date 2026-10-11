---
name: computer-use
description: Use the installed Codex Computer Use MCP to inspect and operate Mac desktop apps and browsers from Claude Code. Use when the user requests GUI work through Codex CUA.
---

# Mac computer use

Use this plugin's MCP tools for the user's requested computer or browser task.
The tools execute in a dedicated thread on the running Codex host. Read and
follow the live tool descriptions and the API documentation returned by the
runtime; do not invent APIs from ordinary Node.js or Playwright examples.

- On the first `js` call or after `js_reset`, execute exactly one documented
  CUA entrypoint, such as `await cua.getState();`, then read its documentation.
- Choose the app, browser, or tab the user requested. Retain the returned handle
  and follow the live documentation for subsequent actions.
- The native REPL is restricted. Do not assume the `process` global or arbitrary
  filesystem paths are available. Use the documented image output facilities
  to return screenshots; Claude's scratchpad is not automatically writable.
- Keep browser and runtime security refusals intact. Report an unsupported action
  or blocked URL rather than retrying it through another route.
- When finished with this connection's CUA work, call `turn_ended` with `{}` if
  advertised. The bridge supplies its own thread and turn identifiers.
- If the host is unavailable, use the `setup` skill and `codex-cua doctor`.
  Retry discovery after reconnecting; do not replay uncertain clicks or submits.

Codex's native engine handles operations, but Claude chooses the commands and
does not inherit an existing Codex chat or its complete harness instructions.
