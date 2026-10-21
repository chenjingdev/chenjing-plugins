"""Targeted release of a session whose owner is gone (R9, decided in E1).

Chrome's extension frees a session's tab leases when the turn that holds them ends, and it needs only the session
id and a turn id of the caller's choosing. So any live runtime can do it: one browser call under (dead session,
new turn) makes the extension register that pair, and `turn_ended` for the same pair then releases every lease the
session holds. The call below only counts the session's tabs; titles, URLs and page content are never read.

This path exists only as an engine command. It is not an MCP tool, an AI cannot choose the session, and the status
command never runs it. It connects to the host the way the bridge does (HostMcp.boot, with its checks) and never
starts Codex. Codex keeps a thread, and the runtime of it, for about half an hour after its last use (not until it
quits, and not only until its last client leaves), so the short-lived thread works in a new folder of its own, and
afterwards the runtime that works there is ended.
"""
import asyncio
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import uuid

from engine_core import SESSION_ID, iso
from engine_inventory import is_cua_repl, lookup, same_process, snapshot, working_folders
from engine_records import remember_released, remove_sessions
from engine_status import build_view

TITLE = 'Release an ended CUA session'
DEFAULT_OPTIONS = {'boot': 15.0, 'call': 45.0, 'end': 10.0, 'cleanup': 5.0}
RUNTIME_WAIT = 3.0
POLL = 0.2
# The whole call is one async function, so its names never clash with those of earlier calls in the same runtime.
SNIPPET = '''await (async () => {
  const { setupBrowserRuntime } = await import(%s);
  const agent = await setupBrowserRuntime();
  const c = await agent.browsers.get("chrome");
  nodeRepl.write("@@count " + (await c.tabs.list()).length);
})();
'''
_VERSION = re.compile(r'^[0-9A-Za-z._+-]{1,64}$')
_COUNT = re.compile(r'@@count ([0-9]{1,6})(?![0-9])')


def chrome_plugin_root(ctx, inv):
    """The Chrome plugin that belongs to the running Codex app: its cache folder for the same version, else the
    copy inside the app bundle."""
    candidates = []
    if inv.app_version and _VERSION.match(inv.app_version):
        candidates.append(ctx.home/'.codex/plugins/cache/openai-bundled/chrome'/inv.app_version)
    if inv.installation is not None:
        candidates.append(inv.installation.app_path/'Contents/Resources/plugins/openai-bundled/plugins/chrome')
    for root in candidates:
        script = root/'scripts/browser-client.mjs'
        try:
            info = os.lstat(script)
            if stat.S_ISREG(info.st_mode) and not stat.S_IMODE(info.st_mode) & 0o022:
                return script.resolve()
        except OSError:
            continue
    return None


def release_code(script):
    return SNIPPET % json.dumps(str(script))


def refusal(view, session, user):
    """Why a session may not be released now, or None. Order: session_live, not_found, needs_user."""
    if not isinstance(session, str) or not SESSION_ID.match(session):
        return 'not_found'
    for record in view.records:
        if record.live and session in record.live_sessions():
            return 'session_live'
    entry = next((item for item in view.maybe_left if item['session_id'] == session), None)
    if entry is None:
        return 'not_found'
    if entry['needs_user'] and not user:
        return 'needs_user'
    return None


def _failure(reason, count=None):
    return {'released': False, 'reason': reason, 'tab_count': count}


def _succeeded(result):
    return isinstance(result, dict) and result.get('isError') is not True


def _count(result):
    """The number of tabs from the one line the snippet writes. Nothing else of the output is looked at."""
    content = result.get('content') if isinstance(result, dict) else None
    for item in content if isinstance(content, list) else []:
        if isinstance(item, dict) and item.get('type') == 'text' and isinstance(item.get('text'), str):
            match = _COUNT.search(item['text'])
            if match:
                return int(match.group(1))
    return None


def _ignore(_):
    return None


def native_cua_root(registry):
    from runtime_paths import installation_from_native_cli, InstallationError
    try:
        return installation_from_native_cli(registry.get('native_cli', '')).cua_root
    except (InstallationError, TypeError, OSError):
        return None


async def _release_one(adapter, session, code, options):
    from host_mcp import BridgeFailure, RpcFailure
    turn = str(uuid.uuid4())
    scope = {'session_id': session, 'turn_id': turn}
    meta = {'thread_id': adapter.thread_id, 'threadId': adapter.thread_id, 'x-codex-turn-metadata': scope}

    def call(tool, arguments, timeout):
        return asyncio.wait_for(adapter.rpc.request('mcpServer/tool/call', {
            'threadId': adapter.thread_id, 'server': adapter.server, 'tool': tool,
            'arguments': arguments, '_meta': meta}), timeout)
    end = {'hook_event_name': 'Stop', 'session_id': session, 'turn_id': turn}
    try:
        result = await call('js', {'code': code, 'title': TITLE}, options['call'])
    except asyncio.TimeoutError:
        try:
            # The call may still have registered the pair; ending it is harmless if it did not.
            await call('turn_ended', end, options['end'])
        except (asyncio.TimeoutError, BridgeFailure, RpcFailure):
            pass
        return _failure('timeout')
    except (BridgeFailure, RpcFailure):
        return _failure('cleanup_not_confirmed')
    count = _count(result) if _succeeded(result) else None
    if count is None:
        # The browser could not be reached through the runtime: a targeted release is impossible now.
        return _failure('unsupported')
    try:
        ended = await call('turn_ended', end, options['end'])
    except asyncio.TimeoutError:
        return _failure('timeout', count)
    except (BridgeFailure, RpcFailure):
        return _failure('cleanup_not_confirmed', count)
    if not _succeeded(ended):
        return _failure('cleanup_not_confirmed', count)
    return {'released': True, 'reason': None, 'tab_count': count}


async def _release_batch(ctx, view, sessions, script, options, user, folder=None):
    """Release several sessions through one short-lived thread (working in `folder`); returns session -> result."""
    from host_mcp import HostMcp
    registry = view.inv.host.registry
    adapter = HostMcp(None, Path(registry['socket_path']), native_cua_root=native_cua_root(registry),
                      emit=_ignore, log=_ignore, startup_timeout=options['boot'],
                      cleanup_timeout=options['cleanup'])
    if folder is not None:
        adapter.thread_cwd = folder
    code = release_code(script)
    results = {}
    try:
        started = asyncio.get_running_loop().time()
        try:
            await asyncio.wait_for(adapter.boot(), options['boot']+2)
        except Exception as error:
            # HostMcp reports its own deadline as a failure, not as a timeout; the time that passed tells.
            slow = (isinstance(error, asyncio.TimeoutError)
                    or asyncio.get_running_loop().time()-started >= options['boot']*0.9)
            if slow:
                reason = 'timeout'
            else:
                reason = 'cleanup_not_confirmed' if os.path.exists(registry['socket_path']) else 'not_running'
            return {session: _failure(reason) for session in sessions}
        for session in sessions:
            # Nothing may have started to list the session since it was checked.
            reason = refusal(build_view(ctx, with_folders=False, with_checks=False), session, user)
            results[session] = _failure(reason) if reason else await _release_one(adapter, session, code, options)
    finally:
        try:
            await asyncio.wait_for(adapter.close(), options['cleanup']+3)
        except Exception:
            pass
    return results


def end_thread_runtimes(ctx, folder, host_pid, since, wait=lambda: True):
    """End the runtime that Codex started for the short-lived thread: a cua-repl of this user right under the host's
    app-server, started since the thread was asked for, that works in the thread's own folder. Returns how many.

    The runtimes are waited for until they are gone, a few seconds at most; `wait()` is asked before every look and
    says whether to go on waiting. A cleanup that is being cut short signals them and does not wait."""
    try:
        found = [proc for proc in snapshot(ctx).values()
                 if proc.uid == ctx.uid and proc.ppid == host_pid and proc.start >= since-1 and is_cua_repl(proc.command)]
    except Exception:
        return 0
    folders = working_folders(ctx, [proc.pid for proc in found])
    wanted = {folder, os.path.realpath(folder)}
    ended = []
    for proc in found:
        if folders.get(proc.pid) not in wanted:
            continue
        try:
            current = lookup(ctx, proc.pid)
            if (same_process(current, ctx.uid, proc.pid, proc.start) and current.ppid == host_pid
                    and is_cua_repl(current.command)):
                ctx.kill(proc.pid, signal.SIGTERM)
                ended.append(proc)
        except (OSError, subprocess.TimeoutExpired):
            continue
    deadline = ctx.clock()+RUNTIME_WAIT
    left = list(ended)
    while left and ctx.clock() < deadline and wait():          # its folder is removed once it is gone
        ctx.sleep(POLL)
        try:
            procs = snapshot(ctx)
        except Exception:
            break
        left = [proc for proc in left if same_process(procs.get(proc.pid), ctx.uid, proc.pid, proc.start)]
    return len(ended)


def book_release(ctx, records, sessions):
    """Write down, in the records that list them, that `sessions` were released for sure.

    A dead record can no longer write for itself: the scopes of those sessions are taken out of it (and it goes when
    none is left). A live writer's record is not ours to rewrite, so the release is remembered in the engine's own
    file instead.

    Without this a session stays listed by the dead bridge that opened it, as one that may have been left behind,
    though a runtime or a targeted release has let go of it."""
    for session in sessions:
        for record in records:
            if session not in record.open_sessions:
                continue
            try:
                if not record.live:
                    remove_sessions(ctx.state_dir, ctx.uid, record, {session})
                else:
                    remember_released(ctx.state_dir, ctx.uid, record.writer, session, iso(ctx.clock()))
            except OSError:
                pass


def release_sessions(ctx, sessions, user=False, view=None, options=None):
    """session id -> {'released', 'reason', 'tab_count'} for each session asked about."""
    options = dict(DEFAULT_OPTIONS, **(options or {}))
    view = view or build_view(ctx, with_folders=False, with_checks=False)
    results, allowed = {}, []
    for session in dict.fromkeys(sessions):
        reason = refusal(view, session, user)
        if reason:
            results[session] = _failure(reason)
        else:
            allowed.append(session)
    if not allowed:
        return results
    if view.inv.host.state != 'ready' or not isinstance(view.inv.host.registry, dict):
        results.update({session: _failure('not_running') for session in allowed})
        return results
    script = chrome_plugin_root(ctx, view.inv)
    if script is None:
        results.update({session: _failure('unsupported') for session in allowed})
        return results
    try:
        folder = tempfile.mkdtemp(prefix='codex-cua-release-')
    except OSError:
        folder = None      # the thread works where the engine does, and Codex keeps its runtime for about half an hour
    since = ctx.clock()
    try:
        outcome = asyncio.run(_release_batch(ctx, view, allowed, script, options, user, folder))
    except Exception:
        outcome = {}       # nothing could be confirmed; every session says so below
    finally:
        if folder is not None:
            end_thread_runtimes(ctx, folder, view.inv.host.registry.get('backend_pid'), since)
            shutil.rmtree(folder, ignore_errors=True)
    for session in allowed:
        result = outcome.get(session) or _failure('cleanup_not_confirmed')
        results[session] = result
        if result['released']:
            book_release(ctx, view.records, [session])
    return results


def release_session_command(ctx, session, user=False, options=None):
    result = release_sessions(ctx, [session], user=user, options=options)[session]
    return {'ok': result['released'], 'released': result['released'], 'reason': result['reason'],
            'tab_count': result['tab_count']}
