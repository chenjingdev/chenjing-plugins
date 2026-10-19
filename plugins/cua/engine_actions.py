"""What the menu bar app can ask the engine to do: release, stop and restart Codex.

Safety rules that hold everywhere in this module:
- A process is signalled only after its identity (pid and start time) was verified again a moment before.
- Only connection processes are ever signalled: a bridge, a relay, a runtime's cua-repl, or the one `cmux-cua mcp`
  process that was asked for by its id. A stopped Claude connection also ends the cua-repl of its own thread, which
  Codex would keep until it quits. The Codex app, its servers, the AI client that owns a connection, Chrome
  and the cmux-cua daemon are on a protected list that is checked before every signal. For every other kind of stop
  that list holds all of cmux-cua, and a group stop never reaches it.
- Codex is quit through Apple Events, never killed; restart-codex runs only because a person clicked it.
"""
from collections import namedtuple
from concurrent.futures import ThreadPoolExecutor
import signal
import subprocess

from engine_core import CONNECTION_ID, REASON
from engine_inventory import (app_pids, cmux_mode, find_installation, is_cua_repl, lookup, read_host, same_process,
                              snapshot)
from engine_records import ControlError, control_request, release_timeout
from engine_release import book_release, release_sessions
from engine_status import CmuxConnection, build_view

STOP_GRACE = 8.0
KILL_WAIT = 3.0
QUIT_TIMEOUT = 30.0
QUIT_REFUSED_GRACE = 3.0     # after a quit event that was answered with an error, Codex may still be on its way out
HOST_CLOSE_TIMEOUT = 15.0
LAUNCH_TIMEOUT = 20.0
POLL = 0.2
# What a writer may answer that the contract does not know becomes the closest contract reason.
REASON_MAP = {'cleanup_tool_unavailable': 'cleanup_not_confirmed'}

Release = namedtuple('Release', 'released reason count nothing')
Runtime = namedtuple('Runtime', 'pid started')       # the cua-repl of a stopped Claude connection's thread
NO_RELEASE = Release(False, None, 0, False)      # a connection without a release step: nothing was asked, nothing failed


# --- release ----------------------------------------------------------------------------------------------

UNCONFIRMED = 'cleanup_not_confirmed'


def _ask_release(ctx, conn, timeout):
    """One release request to the connection's control socket: (the Release it comes to, whether the writer itself
    answered that it could not confirm the end of a turn)."""
    try:
        reply = control_request(conn.record, 'release', ctx.uid, timeout=timeout)
    except ControlError as error:
        if error.kind == 'missing':
            return Release(False, 'no_trusted_scope', 0, False), False
        if error.kind == 'timeout':
            return Release(False, 'timeout', 0, False), False
        return Release(False, 'relay_unavailable' if conn.record.kind == 'relay' else UNCONFIRMED, 0, False), False
    count = reply.get('scope_count', reply.get('scopeCount'))
    count = count if isinstance(count, int) and not isinstance(count, bool) and count >= 0 else 0
    if reply.get('released') is True:
        return Release(True, None, count, False), False
    asked = reply.get('reason')
    reason = REASON_MAP.get(asked, asked)
    if not isinstance(reason, str) or not REASON.match(reason):
        reason = UNCONFIRMED
    return Release(False, reason, count, reason == 'no_trusted_scope' and count == 0), asked == UNCONFIRMED


def release_one(ctx, conn, timeout=None):
    """Ask the connection's own control socket to release its scopes.

    nothing is True when a verified writer answered that it holds no scope: there was nothing to release, which
    is not a failure. When no verified endpoint exists nothing can be said, and that is no_trusted_scope too.

    A writer that answers `cleanup_not_confirmed` waited for the runtime to end a turn and gave up (a limit of a few
    seconds), though the runtime may well have ended it a little later: the tab is closed and the scope stays open (S16).
    It is asked once more, and the second answer is the result. Nothing else is asked twice: a timeout, an endpoint
    that is gone, a call still running or nothing to release are not made better by asking again."""
    if conn.record is None or not conn.can_release:
        return Release(False, 'no_trusted_scope', 0, False)
    timeout = release_timeout(conn.record) if timeout is None else timeout
    result, unconfirmed = _ask_release(ctx, conn, timeout)
    if unconfirmed:
        result, _ = _ask_release(ctx, conn, timeout)
    return result


def book_connection(ctx, records, conn, result):
    """A confirmed release of a connection is also one of every session its writer was serving.

    The dead records that list those sessions are booked as released. A bridge that was killed can never close its
    own scopes, and the runtime it leaves behind lets go of them without telling it; without this the session would
    stay listed for good as one that may have been left behind, though its connection has just let go of it.
    Live records are left alone: the bridge and the relay of one thread both book their own scopes as the release
    goes through them, and a pair the engine remembered for them could hide a later scope of the same session."""
    if result.released and conn.record is not None:
        book_release(ctx, [record for record in records if not record.live], sorted(conn.record.live_sessions()))


def find_connection(ctx, wanted):
    """(view, connection) for a connection id (also a cmux-cua one), or (None, None) when there is no such live one."""
    if not CONNECTION_ID.match(wanted):
        return None, None
    view = build_view(ctx, with_folders=False, with_checks=False)
    conn = view.find(wanted)
    return (view, conn) if conn is not None else (None, None)


def release_connection(ctx, wanted):
    view, conn = find_connection(ctx, wanted)
    if conn is None:
        return {'ok': False, 'released': False, 'reason': 'not_found', 'scope_count': 0}
    if isinstance(conn, CmuxConnection):       # cmux-cua holds no browser lease of ours: there is nothing to release
        return {'ok': False, 'released': False, 'reason': 'unsupported', 'scope_count': 0}
    result = release_one(ctx, conn)
    book_connection(ctx, view.records, conn, result)
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
            book_connection(ctx, view.records, conn, result)
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

def _same(ctx, conn, proc):
    """Whether proc is still the process this connection is: the same pid, user and start time (within a second).
    A cmux-cua connection must also still be a `cmux-cua mcp`, and a runtime a cua-repl: a process can start another
    program under its pid."""
    if not same_process(proc, ctx.uid, conn.pid, conn.started):
        return False
    if isinstance(conn, CmuxConnection):
        return cmux_mode(proc.command) == 'mcp'
    return not isinstance(conn, Runtime) or is_cua_repl(proc.command)


def _signal(ctx, conn, number):
    """'sent', 'gone' (nothing of that identity is left), 'denied' or 'unverified'. The identity is checked first."""
    try:
        proc = lookup(ctx, conn.pid)
    except (OSError, subprocess.TimeoutExpired):
        return 'unverified'
    if not _same(ctx, conn, proc):
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
            waiting = [conn for conn in waiting if _same(ctx, conn, procs.get(conn.pid))]
        if not waiting or ctx.clock() >= deadline:
            break
        ctx.sleep(POLL)
    return waiting


def stop_connections(ctx, conns, force, protected, records=()):
    """Release, then stop the given connections together. One result per connection, in the same order.

    A cmux-cua connection has no release step: its result says `released: false` and has no reason when it stopped.
    `records` are those of the look at the machine the connections come from: what a release let go of is booked in them."""
    release = {conn.id: NO_RELEASE for conn in conns}
    asked = [conn for conn in conns if not isinstance(conn, CmuxConnection)]
    if asked:
        with ThreadPoolExecutor(max_workers=min(8, len(asked))) as pool:
            futures = [(conn, pool.submit(release_one, ctx, conn)) for conn in asked]
            release.update({conn.id: future.result() for conn, future in futures})
        for conn in asked:
            book_connection(ctx, records, conn, release[conn.id])
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
    _end_runtimes(ctx, [Runtime(pid, started) for conn in conns if outcome[conn.id] == 'stopped'
                        for pid, started in sorted(getattr(conn, 'runtimes', ()))
                        if pid > 1 and pid != ctx.pid and pid not in protected], force)
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


def _end_runtimes(ctx, runtimes, force):
    """End the runtimes of Claude connections that stopped (R8). A bridge ends its own when it exits normally; this is
    for one that was killed, or whose conversation is already gone. Nothing of it changes a connection's result."""
    sent = [runtime for runtime in runtimes if _signal(ctx, runtime, signal.SIGTERM) == 'sent']
    left = _wait_gone(ctx, sent, KILL_WAIT)
    if force:
        for runtime in left:
            _signal(ctx, runtime, signal.SIGKILL)


def stop_connection(ctx, wanted, force=False):
    view, conn = find_connection(ctx, wanted)
    if conn is None:
        return {'ok': False, 'stopped': False, 'released': False, 'reason': 'not_found'}
    protected = view.protected_pids(cmux_connections=isinstance(conn, CmuxConnection))
    result = stop_connections(ctx, [conn], force, protected, view.records)[0]
    return {'ok': result['stopped'], 'stopped': result['stopped'], 'released': result['released'],
            'reason': result['reason']}


def stop_group(ctx, group, force=False):
    """Group stop covers claude and codex connections only; a cmux-cua connection is never part of a group.

    "Codex only" leaves alone every codex connection whose session is unknown (R8): a runtime that no record covers,
    or a relay with neither an open scope nor an activity line naming a session. Such a runtime may serve a Claude
    conversation, so it is neither released nor signalled. Each is reported as `unattributed` and counts neither as
    stopped nor as failed. `all` and a single connection do stop them."""
    view = build_view(ctx, with_folders=False, with_checks=False)
    conns = [conn for conn in view.connections if group == 'all' or conn.agent == group]
    skipped = [conn for conn in conns if group == 'codex' and conn.session_id is None]
    done = {item['connection_id']: item for item in stop_connections(
        ctx, [conn for conn in conns if conn not in skipped], force, view.protected_pids(), view.records)}
    results = [{'connection_id': conn.id, 'stopped': False, 'released': False, 'reason': 'unattributed'}
               if conn in skipped else done[conn.id] for conn in conns]
    stopped = sum(1 for item in done.values() if item['stopped'])
    return {'ok': stopped == len(done), 'stopped': stopped, 'failed': len(done)-stopped, 'results': results}


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
        quit_event = ctx.run(['/usr/bin/osascript', '-e', 'tell application id "%s" to quit' % installation.bundle_id], timeout=10)
    except subprocess.TimeoutExpired:
        quit_event = None    # a quit confirmation can keep the call open; the wait below decides
    except OSError:
        return {'ok': False, 'reason': 'quit_cancelled'}
    try:
        return _wait_and_reopen(ctx, installation, previous_host, quit_event, quit_timeout, host_timeout, launch_timeout)
    except Exception:
        # The process list (or anything else) failed after the quit event went out: Codex may be closed, and the
        # answer says it did not come back, so the app offers to open it.
        return {'ok': False, 'reason': 'relaunch_failed'}


def _wait_and_reopen(ctx, installation, previous_host, quit_event, quit_timeout, host_timeout, launch_timeout):
    # A quit that was answered with an error (cancelled, refused) is given only a moment: the app may still be on its
    # way out, because it also answers with an error when it ends before it replies.
    refused = quit_event is not None and quit_event.returncode != 0
    deadline = ctx.clock()+(QUIT_REFUSED_GRACE if refused else quit_timeout)
    while app_pids(snapshot(ctx), installation, ctx.uid):
        if ctx.clock() >= deadline:
            # A quit that Codex took may still take minutes while it finishes its work; the app watches for the end.
            return {'ok': False, 'reason': 'quit_cancelled' if refused else 'quit_pending'}
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
