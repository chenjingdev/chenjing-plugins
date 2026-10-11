---
name: setup
description: Install, diagnose, or reconnect this macOS Codex Computer Use plugin for Claude Code. Use for initial setup, a missing Codex host, or a plugin connection failure.
---

# Set up Codex Computer Use

This plugin connects to an existing Codex desktop host on the same Mac. Read
`${CLAUDE_PLUGIN_ROOT}/README.md` for the current installation contract.

1. Run `"${CLAUDE_PLUGIN_ROOT}/setup.sh" install`. This prepares the plugin's
   private Python environment and `~/.local/bin/codex-cua` command.
2. Run `~/.local/bin/codex-cua doctor --probe --json` and read the summary.
3. If a host is already ready, use it. If Codex is closed, run
   `~/.local/bin/codex-cua start`. If it is running without the host listener,
   explain that the user's active Codex work must finish before a normal quit
   and `codex-cua start`. Do not force-quit an app or end other chats.
4. Recheck the host. Explain whether setup, transport, tool discovery and a native
   call each succeeded. A process being present is not proof of working CUA.
5. Open a fresh Claude session when an already-loaded MCP remains on the old
   version. Use the plugin's native tool descriptions for a harmless first call.

Never replace a connection failure with a separately launched CUA engine, model
proxy, changed permissions or automatic approval. The launcher preserves native
model and permission settings. Do not print request payloads, screenshots, or
secrets in diagnostic logs. Do not replay a failed GUI action during recovery.
