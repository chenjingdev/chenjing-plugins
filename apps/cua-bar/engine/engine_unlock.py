"""`codex-cua unlock-reset`: lets the Codex computer-use service try its automatic unlock again (F8).

While the Mac is locked, the service (SkyComputerUseService) tries to unlock it for a CUA call at most twice per lock,
and counts again only once it sees the Mac unlocked or when it starts anew. A try that fails, and every call after
both have, is answered "The Mac is locked and automatic unlock could not unlock it" until a person unlocks the Mac.
This command ends the service with SIGTERM after a call failed that way; the next CUA call starts it again (macOS opens
it on demand), and its automatic unlock tries anew. One restart for each such failure, up to LIMIT in one lock, so an
AI that calls again after each makes the automatic unlock try LIMIT more times. The menu bar app runs it after a call
failed that way; it decides everything itself, so running it at any other time changes nothing.

It changes nothing unless all of these hold, looked at in this order (the reason it answers otherwise):
  - this user's session on the console has its screen locked now (`not_locked`);
  - fewer than LIMIT restarts were made in this lock (`limit`);
  - since the lock began and since the last restart, a call failed with `unlock_failed` (`not_needed`);
  - no CUA call of a connection is running; it waits up to IN_FLIGHT_WAIT seconds for them (`call_in_flight`, or
    `status_unreadable` when the connections cannot be read);
  - the service runs as this user from a Codex Computer Use app, and the running process meets SERVICE_REQUIREMENT:
    signed by OpenAI's team as com.openai.sky.CUAService (`not_running`, `not_ours`).
It never sends SIGKILL: a service still there STOP_WAIT seconds after its SIGTERM is left as it is (`still_running`).
Every SIGTERM it sent is a line in the activity log (tool `unlock_reset`, writer `engine-<pid>-<start>`), which is how
the next run counts the restarts of this lock. One run at a time (`busy`).
"""
import fcntl
import os
import plistlib
import signal
import subprocess

from bridge_records import append_activity
from engine_core import iso
from engine_inventory import lookup, same_process, snapshot
from engine_records import private_directory, read_activity

LIMIT = 5                     # restarts per lock (the person's choice, 2026-10-25)
IN_FLIGHT_WAIT = 15.0
STOP_WAIT = 10.0
POLL = 0.5
RESET_TOOL = 'unlock_reset'
LOCK_FILE = 'unlock-reset.lock'
SERVICE_SUFFIX = '/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService'
SERVICE_REQUIREMENT = ('identifier "com.openai.sky.CUAService" and anchor apple generic '
                       'and certificate leaf[subject.OU] = "2DC432GLL2"')
CF_EPOCH = 978307200          # 2001-01-01 in Unix time, where CFAbsoluteTime counts from
LOCK_TIME_RANGE = 30*86400    # a lock time older than this is not believed


def console_lock(ctx):
    """(locked, locked_at): whether this user's session on the console has its screen locked now, and since when in
    Unix time (None when the registry does not say). (False, None) when the registry cannot be read."""
    try:
        result = ctx.run(['/usr/sbin/ioreg', '-n', 'Root', '-d1', '-a'], timeout=5)
        root = plistlib.loads((result.stdout or '').encode('utf-8'))
    except Exception:
        return False, None
    users = root.get('IOConsoleUsers') if isinstance(root, dict) else None
    for user in users if isinstance(users, list) else []:
        if (isinstance(user, dict) and user.get('kCGSSessionUserIDKey') == ctx.uid
                and user.get('kCGSSessionOnConsoleKey') is True):
            if user.get('CGSSessionScreenIsLocked') is not True:
                return False, None
            return True, lock_time(user.get('CGSSessionScreenLockedTime'), ctx.clock())
    return False, None


def lock_time(value, now):
    """The lock's start in Unix time from the registry's seconds (since 1970, or since 2001); None when it is missing or
    not a time of the last LOCK_TIME_RANGE."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    epoch = float(value) if value > 1e9 else float(value)+CF_EPOCH
    return epoch if now-LOCK_TIME_RANGE <= epoch <= now+60 else None


def is_restart(line):
    return line['writer'].startswith('engine-') and line['tool'] == RESET_TOOL


def worked(line):
    """A call that worked, so the screen could be used then (an AI's own turn_ended says nothing about that)."""
    return line['ok'] and not line['writer'].startswith('engine-') and line['tool'] != 'turn_ended'


def this_lock(lines, locked_at):
    """(restarts, failures) of this lock: the restarts made since it began, and the `unlock_failed` calls after the last
    of them. Without the lock's start, the lock is what came after the last call that worked."""
    since = locked_at
    if since is None:
        since = max((line['at'] for line in lines if worked(line)), default=0)
    restarts = [line for line in lines if is_restart(line) and line['at'] >= since]
    after = max([since]+[line['at'] for line in restarts])
    failures = [line for line in lines if line['error'] == 'unlock_failed' and line['at'] > after]
    return restarts, failures


def calls_running(ctx):
    from engine_status import build_view
    view = build_view(ctx, with_folders=False, with_checks=False)
    return any(conn.busy for conn in view.connections)


def service_path(command):
    """The executable of a Codex Computer Use service's command line, or None for any other command. Its path has spaces
    of its own, so the command must start with it: an argument begins at a space before a slash (`grep /…/Sky…`)."""
    end = command.find(SERVICE_SUFFIX)
    if end <= 0 or not command.startswith('/') or ' /' in command[:end]:
        return None
    end += len(SERVICE_SUFFIX)
    return command[:end] if end == len(command) or command[end] == ' ' else None


def services(ctx):
    return [proc for proc in snapshot(ctx).values() if proc.uid == ctx.uid and service_path(proc.command)]


def signed(ctx, pid):
    """The running process meets SERVICE_REQUIREMENT (codesign checks the process itself, not a file)."""
    try:
        result = ctx.run(['/usr/bin/codesign', '--verify', '-R='+SERVICE_REQUIREMENT, str(pid)], timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def stop(ctx, proc):
    """SIGTERM to a service whose identity was verified again just before; True once it is gone. Never SIGKILL."""
    if not same_process(lookup(ctx, proc.pid), ctx.uid, proc.pid, proc.start):
        return True
    try:
        ctx.kill(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    deadline = ctx.clock()+STOP_WAIT
    while same_process(lookup(ctx, proc.pid), ctx.uid, proc.pid, proc.start):
        if ctx.clock() >= deadline:
            return False
        ctx.sleep(POLL)
    return True


def record(ctx, ok, ms):
    """The restart's line in the activity log; a log that cannot be written leaves the restart uncounted."""
    me = lookup(ctx, ctx.pid)
    if me is None:
        return
    entry = {'at': iso(ctx.clock()), 'writer': 'engine-%d-%d' % (me.pid, me.start), 'session_id': None,
             'tool': RESET_TOOL, 'ok': ok, 'ms': max(0, int(ms))}
    if not ok:
        entry['error'] = 'error'
    try:
        append_activity(ctx.state_dir, entry)
    except Exception:
        pass


def unlock_reset(ctx):
    locked, locked_at = console_lock(ctx)
    answer = {'ok': False, 'reason': None, 'restarts': 0, 'limit': LIMIT, 'locked_at': iso(locked_at)}
    if not locked:
        return dict(answer, reason='not_locked')
    state = ctx.state_dir
    if not private_directory(state, ctx.uid):
        return dict(answer, reason='not_needed')       # no activity log, so no call has failed
    try:
        guard = os.open(state/LOCK_FILE, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    except OSError:
        return dict(answer, reason='busy')
    try:
        try:
            fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return dict(answer, reason='busy')
        return _reset(ctx, answer, locked_at)
    finally:
        os.close(guard)


def _reset(ctx, answer, locked_at):
    restarts, failures = this_lock(read_activity(ctx.state_dir, ctx.uid), locked_at)
    answer['restarts'] = len(restarts)
    if len(restarts) >= LIMIT:
        return dict(answer, reason='limit')
    if not failures:
        return dict(answer, reason='not_needed')
    deadline = ctx.clock()+IN_FLIGHT_WAIT
    while True:
        try:
            running = calls_running(ctx)
        except Exception:
            return dict(answer, reason='status_unreadable')
        if not running:
            break
        if ctx.clock() >= deadline:
            return dict(answer, reason='call_in_flight')
        ctx.sleep(POLL)
    try:
        found = services(ctx)
    except Exception:
        return dict(answer, reason='status_unreadable')
    if not found:
        return dict(answer, reason='not_running')     # the next call starts one, with its tries
    ours = [proc for proc in found if signed(ctx, proc.pid)]
    if not ours:
        return dict(answer, reason='not_ours')
    # A person may have unlocked the Mac while the calls ended: then the service counts again by itself.
    if not console_lock(ctx)[0]:
        return dict(answer, reason='not_locked')
    begun = ctx.clock()
    gone = all([stop(ctx, proc) for proc in ours])
    record(ctx, gone, (ctx.clock()-begun)*1000)
    answer['restarts'] = len(restarts)+1
    return dict(answer, ok=gone, reason=None if gone else 'still_running')
