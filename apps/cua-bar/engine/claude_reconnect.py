"""Non-blocking update notices for the Claude process that owns a CUA bridge.

Claude's MCP Connected indicator describes the transport, not whether an already running server has loaded an
update. The current hook launcher can compare that server with the installed engine and explain the difference.
Only process identifiers and code versions are inspected; no tool input, transcript, or command line is retained.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

from bridge_records import private_directory
import cuabar_host


NOTICE_EVENTS = frozenset(('UserPromptSubmit', 'PreToolUse'))
CUA_TOOLS = frozenset(('js', 'js_reset', 'turn_ended', 'status', 'repair'))
IDENT = re.compile(r'^[A-Za-z0-9_.:-]{1,200}$')
VERSION = re.compile(r'^[0-9A-Za-z.+_-]{1,64}$')


def process_command(pid):
    """Used only as a legacy version hint, never printed or written to the notice record."""
    try:
        result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'command='],
                                capture_output=True, text=True, timeout=2, check=True)
        return result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def _session(payload):
    value = payload.get('claude_session_id', payload.get('session_id'))
    return value if isinstance(value, str) and IDENT.fullmatch(value) else None


def _scope(state, owner, session):
    return Path(state)/'claude-reconnect-notices'/('%d-%d' % owner)/hashlib.sha256(session.encode()).hexdigest()


def _claim(state, owner, session, installed):
    """Concurrent hooks emit at most once for this Claude session and installed code identity."""
    folder = _scope(state, owner, session)
    for directory in (Path(state), Path(state)/'claude-reconnect-notices', folder.parent, folder):
        private_directory(directory)
    target = json.dumps(installed, sort_keys=True, separators=(',', ':')).encode()
    path = folder/(hashlib.sha256(target).hexdigest()+'.json')
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    except FileExistsError:
        return False
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump({'schema_version': 1, 'notified': True}, output)
            output.write('\n')
    except BaseException:
        try:
            path.unlink()
        except OSError:
            pass
        raise
    return True


def forget_notices(state, owner, payload):
    """SessionEnd removes only the notice directory belonging to this exact process and session."""
    session = _session(payload)
    if payload.get('hook_event_name') != 'SessionEnd' or session is None:
        return
    folder = _scope(state, owner, session)
    try:
        for directory in (Path(state), Path(state)/'claude-reconnect-notices', folder.parent, folder):
            info = directory.lstat()
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077):
                return
        for path in folder.glob('*.json'):
            info = path.lstat()
            if stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077:
                path.unlink()
        folder.rmdir()
        try:
            folder.parent.rmdir()
        except OSError:
            pass
    except OSError:
        pass


def _version(value):
    return value if isinstance(value, str) and VERSION.fullmatch(value) else None


def _message(statuses, installed):
    installed_version = _version(installed.get('version'))
    versions = sorted({_version(status.get('running_version')) for status in statuses}
                      - {None})
    target = '설치 '+installed_version if installed_version else '새로 설치된 코드'
    if any(status.get('state') == 'unknown' for status in statuses):
        reason = '이 Claude의 cuabar MCP 실행 버전을 확인할 수 없습니다'
    else:
        reason = '이 Claude의 cuabar MCP가 설치된 코드와 달라 재연결이 필요합니다'
    details = ', '.join((['연결 '+', '.join(versions)] if versions else [])+[target])
    return ('CUA Bar: '+reason+' ('+details+'). Claude에서 '+cuabar_host.reconnect_command()+'를 실행해 주세요. '
            'Connected 표시는 연결 여부만 나타냅니다.')


def hook_output(state, owner, payload, read_record, process_identity, installed=None,
                compare_runtime=None, read_command=process_command):
    """A Claude hook JSON response, or None. Never grants permission, blocks, or reconnects anything.

    The existing lifecycle reader and process identity function are injected so both paths enforce the same
    private-record and PID/start-time checks. The optional identity/comparison arguments are for isolated tests.
    """
    event, session = payload.get('hook_event_name'), _session(payload)
    if event not in NOTICE_EVENTS or session is None:
        return None
    if event == 'PreToolUse' and cuabar_host.tool_name(payload.get('tool_name')) not in CUA_TOOLS:
        return None
    if installed is None or compare_runtime is None:
        from runtime_identity import installed_identity, runtime_status
        installed = installed_identity() if installed is None else installed
        compare_runtime = runtime_status if compare_runtime is None else compare_runtime
    statuses = []
    for path in (Path(state)/'bridges').glob('bridge-*/bridge.json'):
        record = read_record(path)
        if (not record or record.get('owner_pid') != owner[0]
                or ('owner_started_at' in record and record['owner_started_at'] != owner[1])):
            continue
        pid, started = record.get('pid'), record.get('started_at')
        expected = (os.getuid(), owner[0], started)
        if (type(pid) is not int or pid <= 1 or type(started) is not int
                or started < owner[1] or process_identity(pid) != expected):
            continue
        # Before 0.8.16 the record did not carry the owner's start time. Its live PPID must still be this
        # verified Claude process, and it must have started after that owner; an explicit mismatch is rejected.
        command = read_command(pid) if not record.get('version') else None
        if process_identity(pid) != expected:
            continue
        status = compare_runtime(record, installed, command=command)
        if status.get('reconnect_required') is True:
            statuses.append(status)
    if not statuses or not _claim(state, owner, session, installed):
        return None
    message = _message(statuses, installed)
    return {'systemMessage': message, 'hookSpecificOutput': {'hookEventName': event,
        'additionalContext': message+' MCP transport connectivity does not confirm that the installed CUA Bar '
            'update is loaded. Use the cuabar status tool to compare the running code, installed code, and hooks. '
            'The cuabar repair tool can restore managed hooks for the explicitly selected Claude profile; it does '
            'not reconnect this MCP process. If status still requires reconnection, tell the user to reconnect '
            'cuabar with '+cuabar_host.reconnect_command()+'. Do not report the connection as up to date.'}}
