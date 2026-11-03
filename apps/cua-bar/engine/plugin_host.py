"""`plugin-mcp`: the MCP entry point of the cuabar Claude Code plugin (0.9.0).

Claude Code starts it from the plugin's folder in its plugin cache. It does what CUA Bar does when it starts, then
runs the bridge from the engine copy:
  - CUA Bar handles this Mac when its own user MCP `cuabar` is registered or the app is running. Two bridges would
    attach CUA twice, so the plugin stands by (plugin_standby: an MCP with no tools that says why) and leaves the app's
    engine copies, hooks and registration alone.
  - Otherwise `install-engine` from this folder: the private copy ~/.local/share/codex-cua/engine/<version>/, the
    Python environment, the `codex-cua` command, the Codex wrapper and login environment, the relay copy, `current`.
    CUA Bar's managed Claude hooks are not added; the plugin brings its own.
  - `current` is never moved back: when it points to a newer version than this plugin (a conversation that is still on
    an older plugin reconnects after an update), that copy runs instead. Two plugin versions would otherwise take
    `current` from each other, and each switch closes the bridges of the other (0.8.18).
  - Ended connections are released in the background (`release --ended --connections-only`), as the app does by
    itself; that never reaches the browser.
  - The bridge runs with CUABAR_HOST=plugin, so it says the plugin's wording and asks `unlock-reset` itself after an
    unlock failure (cuabar_host, bridge_control).
A setup that fails stands by too, with the reason, so Claude shows why instead of a server that would not start.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

import cuabar_host

APP_EXECUTABLE = '/CUABar.app/Contents/MacOS/cua-bar'
MAX_CLAUDE_JSON = 64*1024*1024


def claude_json_path(home, environment):
    config = environment.get('CLAUDE_CONFIG_DIR', '')
    return (Path(config).expanduser() if config else Path(home))/'.claude.json'


def app_mcp_registered(home, environment):
    """True when Claude Code has a user MCP named `cuabar`: CUA Bar's (or one a person made the same way)."""
    path = claude_json_path(home, environment)
    try:
        if path.stat().st_size > MAX_CLAUDE_JSON:
            return False
        servers = json.loads(path.read_text()).get('mcpServers')
    except (OSError, ValueError, AttributeError):
        return False
    return isinstance(servers, dict) and cuabar_host.APP_SERVER in servers


def app_running(run=subprocess.run):
    """True when a CUA Bar process of this user runs, wherever its bundle is (`comm` is the executable's path)."""
    try:
        listing = run(['/bin/ps', '-x', '-o', 'comm='], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                      text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return any(line.strip().endswith(APP_EXECUTABLE) for line in listing.splitlines())


def standby_reason(home=None, environment=None, run=subprocess.run):
    home = Path.home() if home is None else Path(home)
    environment = os.environ if environment is None else environment
    if app_mcp_registered(home, environment):
        return 'app_mcp'
    if app_running(run):
        return 'app_running'
    return None


def engine_root(ctx, plugin_root):
    """The engine copy the bridge runs from: this plugin's version, installed now, or a newer `current`."""
    from engine_install import install_engine, linked_version, manifest_version, surely_lower
    from engine_core import ENGINE_DIRECTORY
    setup = ctx.setup
    version = manifest_version(setup.validated_plugin_root(plugin_root))
    engines = setup.support_root(ctx.home)/ENGINE_DIRECTORY
    current = linked_version(engines)
    if current is not None and surely_lower(version, current):
        try:
            return setup.validated_plugin_root(engines/current, current)
        except (OSError, ValueError, RuntimeError):
            pass
    return Path(install_engine(ctx, plugin_root, claude_hooks=False)['root'])


def release_ended(python, root, environment):
    try:
        subprocess.Popen([str(python), str(root/'setup.py'), 'release', '--ended', '--connections-only', '--json'],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True, env=environment)
    except OSError:
        pass


def stand_by(plugin_root, reason, detail=None):
    arguments = [sys.executable, str(Path(plugin_root)/'plugin_standby.py'), reason] + ([detail] if detail else [])
    os.execve(sys.executable, arguments, dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))


def run_plugin_mcp(plugin_root, setup_module=None):
    reason = standby_reason()
    if reason is not None:
        stand_by(plugin_root, reason)
    environment = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
    environment[cuabar_host.HOST_ENV] = cuabar_host.PLUGIN
    from engine_core import Context
    from engine_install import reason as failure_reason
    # stdout is the MCP stream. Until the bridge runs, whatever setup, pip or venv print goes to stderr, which Claude
    # keeps in this server's log.
    stream = os.dup(1)
    try:
        os.dup2(2, 1)
        ctx = Context(plugin_root, setup=setup_module)
        root = engine_root(ctx, plugin_root)
        python = ctx.setup.ensure_dependencies(ctx.home)
    except Exception as error:
        os.dup2(stream, 1)
        stand_by(plugin_root, 'setup_failed', failure_reason(error))
    os.dup2(stream, 1)
    os.close(stream)
    release_ended(python, root, environment)
    os.execve('/bin/sh', ['/bin/sh', str(root/'start-mcp.sh')], environment)
