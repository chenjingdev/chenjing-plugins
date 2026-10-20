---
name: setup
description: Install, diagnose, or reconnect the macOS CUA plugin for Claude Code. Use for initial setup, a missing Codex host, or a plugin connection failure.
---

# Set up CUA

This plugin connects to an existing Codex desktop host on the same Mac. Read
`${CLAUDE_PLUGIN_ROOT}/README.md` for the current installation contract.

1. Run `"${CLAUDE_PLUGIN_ROOT}/setup.sh" install`. This prepares the plugin's
   private Python environment, `~/.local/bin/codex-cua`, the relay files and the
   login environment that makes an ordinarily opened Codex start as the host.
2. Run `~/.local/bin/codex-cua doctor --probe --json` and read the summary. For
   diagnosis, `~/.local/bin/codex-cua status --json` (host, setup parts,
   connections) and `~/.local/bin/codex-cua diagnose` (plain text that is safe to
   paste into a chat) release and stop nothing (`status` only clears the records
   of connections that are gone); use them next to `doctor`.
3. After setup, a Codex that the user opens the usual way (Dock, Spotlight, after
   an update) gets the host through the login environment. A closed Codex is
   opened in the background when a new Claude conversation connects to CUA at its
   start, and by the next CUA call after a lost connection. So:
   - If a host is already ready, use it.
   - If Codex is closed, do not start it yourself. The fresh Claude session of
     step 5 opens it in the background when its CUA connection starts; recheck the
     host after that.
   - If Codex is running without the host (`status --json` shows `codex.running`
     while `host.state` is not `ready`, `starting` or `stopping`, usually because Codex
     was already open before setup), the user restarts it once: with CUA Bar's
     다시 켜기, or by finishing the Codex work, quitting normally (⌘Q) and opening
     it again. Explain that this interrupts Codex work in progress. Never
     force-quit an app, do not quit Codex unasked, and do not end other chats.
   - `setup.login_environment` in `status --json` should be `ready`. If it is
     `missing` or `stale`, run step 1 again. If it is `conflict` (another setting
     already uses those variables), say so and do not overwrite that setting; an
     ordinarily opened Codex does not get the host then.
4. Recheck the host. Explain whether setup, transport, tool discovery and a native
   call each succeeded. A process being present is not proof of working CUA.
5. Open a fresh Claude session when an already-loaded MCP remains on the old
   version. Use the plugin's native tool descriptions for a harmless first call.

Never replace a connection failure with a separately launched CUA engine, model
proxy, changed permissions or automatic approval. The launcher preserves native
model and permission settings. Do not print request payloads, screenshots, or
secrets in diagnostic logs. Do not replay a failed GUI action during recovery.
Do not run `release`, `release-session`, `stop` or `restart-codex` yourself and
never pass `--user`; point the user to the CUA Bar button or the command instead.
