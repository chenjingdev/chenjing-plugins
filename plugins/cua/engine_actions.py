"""What the menu bar app can ask the engine to do: release, stop and restart Codex.

Safety rules that hold everywhere in this module:
- A process is signalled only after its identity (pid and start time) was verified again a moment before.
- Only connection processes are ever signalled: a bridge, a relay, or a runtime's cua-repl. The Codex app, its
  servers, the AI client that owns a connection, Chrome and cmux-cua are on a protected list that is checked
  before every signal.
- Codex is quit through Apple Events, never killed; restart-codex runs only because a person clicked it.
"""
from collections import namedtuple
from concurrent.futures import ThreadPoolExecutor
import signal
import subprocess

from engine_core import CONNECTION_ID, REASON
from engine_inventory import app_pids, find_installation, lookup, read_host, same_process, snapshot
from engine_records import ControlError, control_request
from engine_release import release_sessions
from engine_status import build_view

RELEASE_TIMEOUT = 14.0     # a relay needs up to 12.5 s: 2.5 s for a running call, then 4 s per scope within 10 s
STOP_GRACE = 8.0
KILL_WAIT = 3.0
QUIT_TIMEOUT = 30.0
HOST_CLOSE_TIMEOUT = 15.0
LAUNCH_TIMEOUT = 20.0
POLL = 0.2
# What a writer may answer that the contract does not know becomes the closest contract reason.
REASON_MAP = {'cleanup_tool_unavailable': 'cleanup_not_confirmed'}

Release = namedtuple('Release', 'released reason count nothing')


# --- release ----------------------------------------------------------------------------------------------

def release_one(ctx, conn, timeout=None):
    """Ask the connection's own control socket to release its scopes.

    nothing is True when a verified writer answered that it holds no scope: there was nothing to release, which
    is not a failure. When no verified endpoint exists nothing can be said, and that is no_trusted_scope too."""
    timeout = RELEASE_TIMEOUT if timeout is None else timeout
    if conn.record is None or not conn.can_release:
        return Release(False, 'no_trusted_scope', 0, False)
    try:
        reply = control_request(conn.record, 'release', ctx.uid, timeout=timeout)
    except ControlError as error:
        if error.kind == 'missing':
            return Release(False, 'no_trusted_scope', 0, False)
        if error.kind == 'timeout':
            return Release(False, 'timeout', 0, False)
        return Release(False, 'relay_unavailable' if conn.record.kind == 'relay' else 'cleanup_not_confirmed', 0, False)
    count = reply.get('scope_count', reply.get('scopeCount'))
    count = count if isinstance(count, int) and not isinstance(count, bool) and count >= 0 else 0
    if reply.get('released') is True:
        return Release(True, None, count, False)
    reason = reply.get('reason')
    reason = REASON_MAP.get(reason, reason)
    if not isinstance(reason, str) or not REASON.match(reason):
        reason = 'cleanup_not_confirmed'
    return Release(False, reason, count, reason == 'no_trusted_scope' and count == 0)


def find_connection(ctx, wanted):
    """(view, connection) for a connection id, or (None, None) when there is no such live connection."""
    if not CONNECTION_ID.match(wanted):
        return None, None
    view = build_view(ctx, with_folders=False, with_checks=False)
    conn = view.find(wanted)
    return (view, conn) if conn is not None else (None, None)


def release_connection(ctx, wanted):
    _, conn = find_connection(ctx, wanted)
    if conn is None:
        return {'ok': False, 'released': False, 'reason': 'not_found', 'scope_count': 0}
    result = release_one(ctx, conn)
    return {'ok': result.released or result.nothing, 'released': result.released, 'reason': result.reason,
            'scope_count': result.count}


def release_ended(ctx):
    """Release every ended connection; then every session of a dead bridge that may be released by id.

    A connection whose owner is still there is never touched: releasing the turn of a conversation that is still
    running would make its next browser calls hang. Sessions of a Codex thread wait for a click."""
    view = build_view(ctx, with_folders=False, with_checks=False)
    results, fine = [], []
    for conn in view.connections:
        if conn.state == 'ended':
            result = release_one(ctx, conn)
            results.append({'connection_id': conn.id, 'released': result.released, 'reason': result.reason})
            fine.append(result.released or result.nothing)
    if results:
        view = build_view(ctx, with_folders=False, with_checks=False)    # the releases above changed the records
    sessions = [item for item in view.maybe_left if item['agent'] == 'claude']
    if sessions:
        outcome = release_sessions(ctx, [item['session_id'] for item in sessions], user=False, view=view)
        grouped = {}
        for item in sessions:
            entry = grouped.setdefault(item['connection_id'], {'released': True, 'reason': None})
            result = outcome[item['session_id']]
            if not result['released']:
                entry['released'] = False
                entry['reason'] = entry['reason'] or result['reason']
        for key, value in grouped.items():
            results.append({'connection_id': key, **value})
            fine.append(value['released'])
    return {'ok': all(fine), 'results': results}


# --- stop -------------------------------------------------------------------------------------------------

def _signal(ctx, conn, number):
    """'sent', 'gone' (nothing of that identity is left), 'denied' or 'unverified'. The identity is checked first."""
    try:
        proc = lookup(ctx, conn.pid)
    except (OSError, subprocess.TimeoutExpired):
        return 'unverified'
    if not same_process(proc, ctx.uid, conn.pid, conn.started):
        return 'gone'
    try:
        ctx.kill(conn.pid, number)
    except ProcessLookupError:
        return 'gone'
    except PermissionError:
        return 'denied'
    return 'sent'


def _wait_gone(ctx, waiting, seconds):
    """The connections whose process is still there after `seconds`. One process list per look."""
    deadline = ctx.clock()+seconds
    waiting = list(waiting)
    while waiting:
        try:
            procs = snapshot(ctx)
        except Exception:
            procs = None    # when in doubt a process counts as running; it is never reported stopped by mistake
        if procs is not None:
            waiting = [conn for conn in waiting if same_process(procs.get(conn.pid), ctx.uid, conn.pid, conn.started)]
        if not waiting or ctx.clock() >= deadline:
            break
        ctx.sleep(POLL)
    return waiting


def stop_connections(ctx, conns, force, protected):
    """Release, then stop the given connections together. One result per connection, in the same order."""
    release = {}
    if conns:
        with ThreadPoolExecutor(max_workers=min(8, len(conns))) as pool:
            futures = [(conn, pool.submit(release_one, ctx, conn)) for conn in conns]
            release = {conn.id: future.result() for conn, future in futures}
    outcome = {}
    waiting = []
    for conn in conns:
        if conn.pid <= 1 or conn.pid == ctx.pid or conn.pid in protected:
            outcome[conn.id] = 'protected'
            continue
        sent = _signal(ctx, conn, signal.SIGTERM)
        outcome[conn.id] = {'sent': 'waiting', 'gone': 'stopped', 'denied': 'denied', 'unverified': 'unverified'}[sent]
        if sent == 'sent':
            waiting.append(conn)
    left = _wait_gone(ctx, waiting, STOP_GRACE)
    for conn in waiting:
        outcome[conn.id] = 'waiting' if conn in left else 'stopped'
    if force and left:
        killed = []
        for conn in left:
            sent = _signal(ctx, conn, signal.SIGKILL)
            if sent in ('denied', 'unverified'):
                outcome[conn.id] = sent
            else:
                killed.append(conn)
        remaining = _wait_gone(ctx, killed, KILL_WAIT)
        for conn in killed:
            outcome[conn.id] = 'waiting' if conn in remaining else 'stopped'
    results = []
    for conn in conns:
        released, reason = release[conn.id].released, release[conn.id].reason
        state = outcome[conn.id]
        stopped = state == 'stopped'
        if not stopped:
            reason = {'waiting': 'timeout', 'denied': 'permission_denied', 'protected': 'protected',
                      'unverified': 'unverified'}[state]
        results.append({'connection_id': conn.id, 'stopped': stopped, 'released': released,
                        'reason': None if released and stopped else reason})
    return results


def stop_connection(ctx, wanted, force=False):
    view, conn = find_connection(ctx, wanted)
    if conn is None:
        return {'ok': False, 'stopped': False, 'released': False, 'reason': 'not_found'}
    result = stop_connections(ctx, [conn], force, view.protected_pids())[0]
    return {'ok': result['stopped'], 'stopped': result['stopped'], 'released': result['released'],
            'reason': result['reason']}


def stop_group(ctx, group, force=False):
    """Group stop covers claude and codex connections only; cmux-cua and the rest are never connections."""
    view = build_view(ctx, with_folders=False, with_checks=False)
    conns = [conn for conn in view.connections if group == 'all' or conn.agent == group]
    results = stop_connections(ctx, conns, force, view.protected_pids())
    stopped = sum(1 for item in results if item['stopped'])
    return {'ok': stopped == len(results), 'stopped': stopped, 'failed': len(results)-stopped, 'results': results}


# --- restart Codex ----------------------------------------------------------------------------------------

def restart_codex(ctx, quit_timeout=QUIT_TIMEOUT, host_timeout=HOST_CLOSE_TIMEOUT, launch_timeout=LAUNCH_TIMEOUT):
    """Quit the Codex app normally (Apple Events, never a force quit) and open it again.

    Opening goes through `open -g` without extra settings, so the login session's environment (set by the login
    agent) decides how Codex starts. Only the user's click may run this."""
    installation = find_installation(ctx)
    if installation is None:
        return {'ok': False, 'reason': 'not_running'}
    procs = snapshot(ctx)
    if not app_pids(procs, installation, ctx.uid):
        return {'ok': False, 'reason': 'not_running'}
    host = read_host(ctx, procs)
    running_host = host.registry if host.state in ('ready', 'starting') else None
    previous_host = [running_host.get(key) for key in ('owner_pid', 'backend_pid', 'desktop_proxy_pid')] if running_host else []
    try:
        ctx.run(['/usr/bin/osascript', '-e', 'tell application id "%s" to quit' % installation.bundle_id], timeout=10)
    except subprocess.TimeoutExpired:
        pass    # a quit confirmation can keep the call open; the wait below decides
    except OSError:
        return {'ok': False, 'reason': 'quit_cancelled'}
    deadline = ctx.clock()+quit_timeout
    while app_pids(snapshot(ctx), installation, ctx.uid):
        if ctx.clock() >= deadline:
            return {'ok': False, 'reason': 'quit_cancelled'}
        ctx.sleep(POLL)
    # The host that ran inside the app closes its files a moment after the app is gone; opening Codex earlier
    # would find its lease taken and start Codex without a host.
    deadline = ctx.clock()+host_timeout
    while any(snapshot(ctx).get(pid) is not None for pid in previous_host if isinstance(pid, int)):
        if ctx.clock() >= deadline:
            break
        ctx.sleep(POLL)
    try:
        opened = ctx.run(['/usr/bin/open', '-g', '-a', str(installation.app_path)], timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return {'ok': False, 'reason': 'relaunch_failed'}
    if opened.returncode != 0:
        return {'ok': False, 'reason': 'relaunch_failed'}
    deadline = ctx.clock()+launch_timeout
    while not app_pids(snapshot(ctx), installation, ctx.uid):
        if ctx.clock() >= deadline:
            return {'ok': False, 'reason': 'relaunch_failed'}
        ctx.sleep(POLL)
    return {'ok': True, 'reason': None}
