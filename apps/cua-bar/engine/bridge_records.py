"""Records the Claude bridge leaves for the engine: state directory, private atomic files, process identity, activity.

Every helper may fail; the caller treats a failure as "no records". The CUA connection itself never fails because a
record could not be written. Nothing written through here may carry tool arguments or results, js code or titles,
URLs, page text, screenshots, environment values or tokens: callers pass identifiers, names, flags and times only.
"""
import datetime
import fcntl
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time

STATE_ENV = 'CODEX_CUA_STATE_DIR'
ACTIVITY_FILE = 'activity.jsonl'
ACTIVITY_LOCK = 'activity.lock'
ACTIVITY_MAX_BYTES = 256*1024
ACTIVITY_KEEP_LINES = 200


def utc_now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def state_dir(environment=None, home=None):
    """`$CODEX_CUA_STATE_DIR` when it is set and absolute, else `~/Library/Caches/codex-cua`."""
    environment = os.environ if environment is None else environment
    value = environment.get(STATE_ENV)
    if value and os.path.isabs(value):
        return Path(value)
    return (Path.home() if home is None else Path(home))/'Library/Caches/codex-cua'


def private_directory(path):
    """Create the directory (0700) when it is missing; require a real directory of this user without group/other bits.

    An existing directory with other bits is refused, never repaired: it is not ours to change.
    """
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError('The records directory must be a private directory owned by this user (0700).')
    return path


def process_started_at(pid, run=subprocess.run):
    """Process start in integer epoch seconds, read the way every reader reads it: `ps lstart` in the C locale."""
    result = run(['/bin/ps', '-p', str(pid), '-o', 'lstart='], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                 text=True, timeout=5, check=True, env=dict(os.environ, LC_ALL='C'))
    return int(datetime.datetime.strptime(result.stdout.strip(), '%a %b %d %H:%M:%S %Y').timestamp())


def write_json_atomic(path, value):
    """A 0600 file replaced in one rename, so a reader sees the old or the new content and never half of it."""
    descriptor, name = tempfile.mkstemp(dir=str(path.parent), prefix='.tmp-')
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(value, output, separators=(',', ':'))
            output.write('\n')
        os.replace(name, path)
    except BaseException:
        try:
            os.unlink(name)
        except OSError:
            pass
        raise


def append_activity(state, entry, max_bytes=ACTIVITY_MAX_BYTES, keep=ACTIVITY_KEEP_LINES):
    """One line per call, one `write` per line. Past `max_bytes` the newest `keep` lines are kept."""
    line = (json.dumps(entry, separators=(',', ':'))+'\n').encode()
    descriptor = os.open(state/ACTIVITY_FILE, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        os.write(descriptor, line)
        size = os.fstat(descriptor).st_size
    finally:
        os.close(descriptor)
    if size > max_bytes:
        compact_activity(state, keep)


def compact_activity(state, keep=ACTIVITY_KEEP_LINES):
    """Rewrite the file with its newest lines. A busy lock means someone else is doing it, so this writer just moves on."""
    lock = os.open(state/ACTIVITY_LOCK, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return
        path = state/ACTIVITY_FILE
        # A line without its newline is a write still in progress; it is left out.
        lines = [line for line in path.read_bytes().splitlines(keepends=True) if line.endswith(b'\n')][-keep:]
        descriptor, name = tempfile.mkstemp(dir=str(state), prefix='.activity-')
        try:
            with os.fdopen(descriptor, 'wb') as output:
                output.write(b''.join(lines))
            os.replace(name, path)
        except BaseException:
            try:
                os.unlink(name)
            except OSError:
                pass
            raise
    finally:
        os.close(lock)
