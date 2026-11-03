"""Local MCP health and a bounded repair of CUA Bar's managed Claude hooks.

These operations never touch a native CUA thread, open Codex, reset a REPL, change permissions, or reconnect the
client's MCP transport. Repair runs the currently installed engine's helper, even when the caller is an old bridge.
Only the explicitly selected Claude profile is considered; no credentials or parent process environment are sent.
"""
import asyncio
import copy
import json
import os
from pathlib import Path
import re
import stat
import sys

from claude_hook_setup import inspect_hooks
import cuabar_host
from runtime_identity import RUNNING_IDENTITY, installed_identity, installed_root, runtime_status

REPAIR_SECONDS = 10.0
MAX_REPLY = 16384
HELPER_KIND = 'cuabar_hook_repair'
SAFE_CODE = re.compile(r'^[a-z][a-z0-9_]{0,79}$')
RECONNECT = ('The MCP transport may still show Connected while this bridge runs an older CUA Bar engine. '
             'Run '+cuabar_host.reconnect_command()+' in Claude Code; restart Claude Code if that command is unavailable. '
             'Do not replay an action whose outcome is uncertain.')

TOOL_SPECS = (
    {'name': 'status',
     'description': ('Read CUA Bar runtime freshness, native connection and Claude hook readiness. '
                     'Local only; does not open Codex, inspect the screen, or change anything. '
                     'Use when CUA seems unavailable or after a CUA Bar update.'),
     'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
     'annotations': {'readOnlyHint': True, 'destructiveHint': False, 'idempotentHint': True,
                     'openWorldHint': False}},
    {'name': 'repair',
     'description': ('Repair only CUA Bar\'s managed Claude hook registration in this explicit Claude profile. '
                     'Preserves disabled-hook policy and other settings. Does not reconnect Claude MCP, '
                     'restart Codex, reset CUA, change permissions, or perform a screen action. '
                     'Read status first; an older running bridge still needs /mcp reconnect afterward.'),
     'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
     'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'idempotentHint': True,
                     'openWorldHint': False}},
)


def tool_specs(environment=None):
    """The local tools. The plugin brings its hooks itself, so it has nothing for `repair` to restore."""
    plugin = cuabar_host.plugin(environment)
    return [copy.deepcopy(spec) for spec in TOOL_SPECS if not (plugin and spec['name'] == 'repair')]


def _hooks(home, environment):
    state = inspect_hooks(home, environment.get('CLAUDE_CONFIG_DIR', ''))
    if cuabar_host.plugin(environment) and state in ('ready', 'missing'):
        # The plugin's hooks come with it; the app's managed entries in the settings neither add nor lack anything.
        return 'plugin'
    return state


def read_health(adapter, home=None, environment=None):
    """Content-free health of this bridge, independent of the native host's availability."""
    home = Path.home() if home is None else Path(home)
    environment = os.environ if environment is None else environment
    running = getattr(adapter, 'runtime_identity', RUNNING_IDENTITY)
    running = running if isinstance(running, dict) else RUNNING_IDENTITY
    record = {'version': running.get('version'), 'runtime_revision': running.get('revision')}
    runtime = runtime_status(record, installed_identity(home))
    try:
        snapshot = adapter.snapshot()
    except Exception:
        snapshot = {}
    scopes = snapshot.get('scopes') if isinstance(snapshot, dict) else None
    busy = snapshot.get('busy') is True if isinstance(snapshot, dict) else False
    report = {'schema_version': 1, 'runtime': runtime, 'hooks': _hooks(home, environment),
              'native_connection': 'connected' if getattr(adapter, 'connected', False) is True else 'disconnected',
              'busy': busy, 'open_scope_count': len(scopes) if isinstance(scopes, (list, tuple, set, dict)) else 0}
    if runtime.get('reconnect_required') is True:
        report['next_action'] = 'reconnect_mcp'
        report['message'] = RECONNECT
    elif report['hooks'] == 'missing':
        report['next_action'] = 'repair_hooks'
    elif report['hooks'] in ('disabled', 'conflict', 'failed'):
        report['next_action'] = 'review_hook_settings'
    elif report['native_connection'] == 'disconnected':
        report['next_action'] = 'next_cua_call_reconnects_native_host'
    elif runtime.get('state') != 'current':
        report['next_action'] = 'verify_runtime_or_reconnect_mcp'
    else:
        report['next_action'] = 'none'
    return report


def _helper_path(home):
    root = installed_root(home)
    if root is None:
        return None
    path = root/'mcp_health.py'
    try:
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) & 0o022 or info.st_size > 131072):
            return None
    except OSError:
        return None
    return path


def _helper_environment(home, environment):
    result = {'HOME': str(home), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LC_ALL': 'C',
              'PYTHONDONTWRITEBYTECODE': '1'}
    if 'CLAUDE_CONFIG_DIR' in environment:
        result['CLAUDE_CONFIG_DIR'] = environment['CLAUDE_CONFIG_DIR']
    return result


def _sanitize_reply(value):
    if (not isinstance(value, dict) or value.get('schema_version') != 1 or value.get('kind') != HELPER_KIND
            or value.get('state') not in ('ready', 'disabled', 'conflict', 'failed')
            or type(value.get('changed')) is not bool):
        return {'state': 'failed', 'changed': False, 'error': 'invalid_helper_reply'}
    answer = {'state': value['state'], 'changed': value['changed']}
    code = value.get('error')
    if isinstance(code, str) and SAFE_CODE.fullmatch(code):
        answer['error'] = code
    return answer


async def _run_helper(path, home, environment):
    process = None
    try:
        process = await asyncio.create_subprocess_exec('/usr/bin/python3', '-B', str(path), '--repair-hooks', '--json',
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            cwd=str(path.parent), env=_helper_environment(home, environment))
        async def receive():
            raw = bytearray()
            while True:
                chunk = await process.stdout.read(min(4096, MAX_REPLY+1-len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
                if len(raw) > MAX_REPLY:
                    return {'state': 'failed', 'changed': False, 'error': 'helper_reply_too_large'}
            code = await process.wait()
            if code != 0:
                return {'state': 'failed', 'changed': False, 'error': 'hook_repair_failed'}
            try:
                return _sanitize_reply(json.loads(raw))
            except (ValueError, UnicodeError, RecursionError):
                return {'state': 'failed', 'changed': False, 'error': 'invalid_helper_reply'}
        return await asyncio.wait_for(receive(), REPAIR_SECONDS)
    except asyncio.TimeoutError:
        return {'state': 'failed', 'changed': False, 'error': 'hook_repair_timeout', 'outcome': 'unconfirmed'}
    except (OSError, ValueError, TypeError):
        return {'state': 'failed', 'changed': False, 'error': 'hook_repair_unavailable'}
    finally:
        # Only our short-lived helper may be stopped; it never owns a CUA thread or the caller's MCP transport.
        if process is not None and process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.wait()


async def repair_health(adapter, home=None, environment=None):
    """Restore managed hooks with the installed engine; a stale running process remains stale."""
    home = Path.home() if home is None else Path(home)
    environment = os.environ if environment is None else environment
    before_health = read_health(adapter, home, environment)
    if before_health['busy']:
        return {**before_health, 'hook_repair': {'state': 'deferred', 'changed': False,
                'error': 'cua_request_in_flight'}, 'repaired': False}
    before = _hooks(home, environment)
    if before == 'disabled':
        answer = {'state': 'disabled', 'changed': False, 'error': 'hooks_disabled_by_policy'}
    elif before == 'conflict':
        answer = {'state': 'conflict', 'changed': False, 'error': 'hook_settings_conflict'}
    else:
        path = _helper_path(home)
        answer = ({'state': 'failed', 'changed': False, 'error': 'installed_repair_helper_unavailable'}
                  if path is None else await _run_helper(path, home, environment))
    report = read_health(adapter, home, environment)
    report['hook_repair'] = answer
    report['repaired'] = answer.get('state') == 'ready' and report['hooks'] == 'ready'
    return report


def repair_hooks_local(home=None, environment=None):
    """Helper's fixed action, with paths and arbitrary settings omitted from the protocol response."""
    from claude_hook_profiles import configure_profile
    home = Path.home() if home is None else Path(home)
    environment = os.environ if environment is None else environment
    before = _hooks(home, environment)
    answer = {'schema_version': 1, 'kind': HELPER_KIND, 'state': 'failed', 'changed': False}
    if before == 'disabled':
        return dict(answer, state='disabled', error='hooks_disabled_by_policy')
    if before == 'conflict':
        return dict(answer, state='conflict', error='hook_settings_conflict')
    result = configure_profile(home, environment)
    answer['changed'] = result.get('changed') is True
    after = _hooks(home, environment)
    if result.get('state') == 'ready' and after == 'ready':
        answer['state'] = 'ready'
    elif after == 'disabled':
        answer.update(state='disabled', error='hooks_disabled_by_policy')
    else:
        answer['state'] = 'conflict' if result.get('state') == 'conflict' else 'failed'
        error = result.get('error')
        answer['error'] = error if isinstance(error, str) and SAFE_CODE.fullmatch(error) else 'hook_repair_unconfirmed'
    return answer


def main(arguments=None):
    if list(sys.argv[1:] if arguments is None else arguments) != ['--repair-hooks', '--json']:
        return 2
    try:
        answer = repair_hooks_local()
    except Exception:
        answer = {'schema_version': 1, 'kind': HELPER_KIND, 'state': 'failed', 'changed': False,
                  'error': 'hook_repair_failed'}
    print(json.dumps(answer, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
