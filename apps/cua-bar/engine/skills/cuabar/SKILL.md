---
name: cuabar
description: Use the installed CUA MCP to inspect and operate Mac desktop apps and browsers from Claude Code. Use when the user asks to use CUA, including requests like "cuabar 써서", "cua 써서", requests GUI work through Codex CUA, or asks why CUA does not connect.
---

# Mac computer use

Use the `cuabar` MCP tools for the user's requested computer or browser task.
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
  `turn_ended` never connects to Codex and never reopens it: if the Codex host
  connection was lost it only answers that the turn could not be ended. Do not
  retry it; the next CUA tool call reconnects.
- If a call fails because the Codex host connection was lost (the error says so,
  for example after Codex quit or was updated), that call was not sent again and
  its outcome may be unknown. The next CUA call reconnects by itself and may open
  Codex in the background. Do not replay uncertain actions such as clicks, submits
  or sends: look at the current state first and decide from what you see. Treat
  the first `js` call after reconnecting like the first call of a new connection,
  since earlier handles may be gone.
- If the host is unavailable, run `~/.local/bin/codex-cua doctor --probe --json`
  (`status --json` and `diagnose` release and stop nothing either) and say
  which of setup, transport, tool discovery and a native call failed. Broken
  setup is fixed by CUA Bar's 고치기 or by the user running `codex-cua setup`;
  with no `codex-cua` at all, setup never ran: point the user to CUA Bar, which installs and repairs it. Codex running without the host needs one restart by the user
  (CUA Bar's 다시 켜기, or ⌘Q and reopen once the Codex work is done); never
  quit or force-quit Codex yourself. Retry discovery after reconnecting; do not
  replay uncertain clicks or submits.
- If a call fails because the Mac is locked and its automatic unlock could not
  unlock it (the error says "automatic unlock could not unlock it"), CUA Bar
  restarts the computer-use service so that the next call tries the automatic
  unlock again, up to five times in one lock. Wait about 30 seconds and call
  again, at most five times; make each a call that only looks, such as
  `await cua.getState();`, and go on with the task once one works. If the last
  one still fails, or an error says automatic unlock is paused because physical
  input was detected, that the request cannot be associated with a ChatGPT
  thread, or only that the Mac is locked, stop and ask the user to unlock the
  Mac. Never try to unlock the Mac or restart the service yourself.
- Never replace a connection failure with a separately launched CUA engine,
  model proxy, changed permissions or automatic approval. Keep request
  payloads, screenshots and secrets out of diagnostic output.
- Do not run `codex-cua release`, `release-session`, `stop`, `restart-codex` or
  `unlock-reset` yourself and never pass `--user`; point the user to the CUA Bar
  button or the command instead.

Codex's native engine handles operations, but Claude chooses the commands and
does not inherit an existing Codex chat or its complete harness instructions.
