"""Reading and cleaning the records that bridges and relays keep (see the records description in the plan).

State directory S: bridges/bridge-*/bridge.json, relays/relay-*/relay.json (each with a control.sock while the
writer runs) and activity.jsonl. The engine only reads them, except for two kinds of cleanup that belong to it:
deleting dead records that hold no open scope, and removing the scopes of a session after a confirmed release.
Nothing here ever reads a tool argument or result: the records do not contain any.
"""
from collections import namedtuple
from contextlib import contextmanager
import fcntl
import json
import os
import re
import socket
import stat
import tempfile
import time

from engine_core import SESSION_ID, parse_iso

SUBDIR = {'bridge': 'bridges', 'relay': 'relays'}
FILENAME = {'bridge': 'bridge.json', 'relay': 'relay.json'}
NAME = re.compile(r'^(bridge|relay)-[A-Za-z0-9_-]{1,64}$')
WRITER = re.compile(r'^(bridge|relay)-([0-9]{1,10})-([0-9]{1,12})$')
TOOL = re.compile(r'^[A-Za-z0-9_.:-]{1,64}$')
MAX_RECORD_BYTES = 256*1024
ACTIVITY_TAIL_BYTES = 512*1024
RELEASED_FILE = 'engine-released.json'
# A release answer comes after 2.5 s for a running call and then up to 5 s for every open scope (a bridge has no
# overall cap, a relay stops at 10 s); the connection itself is quick.
MIN_RELEASE_REPLY = 13.0
RELEASE_BASE = 3.0
RELEASE_PER_SCOPE = 5.0
Scope = namedtuple('Scope', 'session_id first last')


def _private(info, uid, kind):
    return (kind(info.st_mode) and info.st_uid == uid and not stat.S_IMODE(info.st_mode) & 0o077)


def private_directory(path, uid):
    try:
        return _private(os.lstat(path), uid, stat.S_ISDIR)
    except OSError:
        return False


def _valid_session(value):
    return isinstance(value, str) and SESSION_ID.match(value) is not None


def bridge_name(value):
    """`value` when it is the name of a bridge (`bridge-<pid>-<started_at>`), else None.

    A relay that a bridge started carries that name, in its record and in every activity line it writes (`owner`)."""
    match = WRITER.fullmatch(value) if isinstance(value, str) else None
    return value if match is not None and match.group(1) == 'bridge' else None


class Record:
    """One bridge or relay record. `live` is decided from the process table (engine_inventory.mark_live)."""

    def __init__(self, kind, directory, data):
        self.kind = kind
        self.directory = directory
        self.data = data
        self.pid = data['pid']
        self.started_at = int(data['started_at'])
        self.live = False
        self.scopes = []
        raw = data.get('scopes')
        for item in raw if isinstance(raw, list) else []:
            if isinstance(item, dict) and _valid_session(item.get('session_id')):
                first, last = parse_iso(item.get('first_at')), parse_iso(item.get('last_at'))
                self.scopes.append(Scope(item['session_id'], first, last))

    @property
    def writer(self):
        return '%s-%d-%d' % (self.kind, self.pid, self.started_at)

    @property
    def agent(self):
        return 'claude' if self.kind == 'bridge' else 'codex'

    @property
    def connection_id(self):
        return '%s-%d-%d' % (self.agent, self.pid, self.started_at)

    @property
    def open_sessions(self):
        seen = []
        for scope in self.scopes:
            if scope.session_id not in seen:
                seen.append(scope.session_id)
        return seen

    @property
    def current_session(self):
        value = self.data.get('session_id')
        return value if _valid_session(value) else None

    def sessions(self):
        """Every session this record lists as its own: open scopes, and for a bridge its current thread."""
        found = set(self.open_sessions)
        if self.kind == 'bridge' and self.current_session:
            found.add(self.current_session)
        return found

    def live_sessions(self):
        """The sessions this record's writer is serving right now: a bridge's current thread, a relay's open scopes.

        Other open scopes of a live bridge belong to hosts it has left (after a reconnect); it cannot end them."""
        if self.kind == 'bridge':
            return {self.current_session} if self.current_session else set()
        return set(self.open_sessions)

    def last_scope_time(self, session_id):
        """When the session's scopes were last touched in this record, or None when the record does not say."""
        times = [scope.last if scope.last is not None else scope.first
                 for scope in self.scopes if scope.session_id == session_id]
        times = [item for item in times if item is not None]
        if times:
            return max(times)
        return parse_iso(self.data.get('updated_at'))

    def text(self, key):
        value = self.data.get(key)
        return value if isinstance(value, str) and value else None

    def number(self, key):
        value = self.data.get(key)
        return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None

    def time(self, key):
        return parse_iso(self.data.get(key))

    def path(self, key):
        value = self.text(key)
        return value if value and os.path.isabs(value) and len(value) <= 1024 else None


def build_record(kind, directory, data):
    if (not isinstance(data, dict) or data.get('schema_version') != 1 or data.get('kind') != kind):
        return None
    pid, started = data.get('pid'), data.get('started_at')
    if (not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1
            or not isinstance(started, (int, float)) or isinstance(started, bool)
            or not 1_000_000_000 <= started <= 100_000_000_000):
        return None
    return Record(kind, directory, data)


def read_record(kind, directory, uid):
    """The parsed record in `directory`, or None when the file is missing, unsafe, too big or invalid."""
    try:
        descriptor = os.open(directory/FILENAME[kind], os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
                             | getattr(os, 'O_NONBLOCK', 0))
    except OSError:
        return None
    try:
        info = os.fstat(descriptor)
        if not _private(info, uid, stat.S_ISREG) or info.st_size > MAX_RECORD_BYTES:
            return None
        raw = b''
        while len(raw) <= MAX_RECORD_BYTES:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            raw += chunk
    except OSError:
        return None
    finally:
        os.close(descriptor)
    try:
        data = json.loads(raw.decode('utf-8'))
    except (ValueError, UnicodeError):
        return None
    return build_record(kind, directory, data)


def load_records(state_dir, uid):
    """All readable records. A state directory that is not private and owned is treated as having none."""
    if not private_directory(state_dir, uid):
        return []
    found = []
    for kind in ('bridge', 'relay'):
        parent = state_dir/SUBDIR[kind]
        if not private_directory(parent, uid):
            continue
        try:
            names = sorted(os.listdir(parent))
        except OSError:
            continue
        for name in names:
            directory = parent/name
            if NAME.match(name) and name.startswith(kind+'-') and private_directory(directory, uid):
                record = read_record(kind, directory, uid)
                if record is not None:
                    found.append(record)
    return found


def control_socket(record, uid):
    """The control socket of a record when it is a private socket of this user, else None."""
    path = record.directory/'control.sock'
    try:
        info = os.lstat(path)
    except OSError:
        return None
    return path if _private(info, uid, stat.S_ISSOCK) else None


class ControlError(Exception):
    """kind: missing (no verified socket) · unreachable · no_answer · timeout · invalid"""

    def __init__(self, kind):
        super().__init__(kind)
        self.kind = kind


def release_timeout(record):
    """Seconds to wait for the answer of a `release`: at least 13, more with every scope the record has open."""
    return max(MIN_RELEASE_REPLY, RELEASE_BASE+RELEASE_PER_SCOPE*len(record.scopes))


def control_request(record, action, uid, timeout=MIN_RELEASE_REPLY, connect_timeout=2.0):
    """One request to a live writer's control socket: one JSON line out, one JSON line in.

    The request carries the writer's pid and start time; a writer that does not recognise them, or does not
    know the action, closes the connection without an answer (no_answer). A `release` takes long (see
    release_timeout); a `status` request would pass a short timeout."""
    path = control_socket(record, uid)
    if path is None:
        raise ControlError('missing')
    # pid and started_at exactly as the writer put them in its record: it compares them strictly.
    request = {'action': action, 'pid': record.data['pid'], 'started_at': record.data['started_at']}
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.settimeout(connect_timeout)
        try:
            client.connect(str(path))
        except socket.timeout:
            raise ControlError('timeout') from None
        except OSError:
            raise ControlError('unreachable') from None
        client.settimeout(timeout)
        try:
            client.sendall((json.dumps(request, separators=(',', ':'))+'\n').encode())
            received = b''
            while b'\n' not in received and len(received) < 65536:
                chunk = client.recv(4096)
                if not chunk:
                    break
                received += chunk
        except socket.timeout:
            raise ControlError('timeout') from None
        except OSError:
            raise ControlError('no_answer') from None
    finally:
        client.close()
    if not received.strip():
        raise ControlError('no_answer')
    try:
        reply = json.loads(received.split(b'\n')[0].decode('utf-8'))
    except (ValueError, UnicodeError):
        raise ControlError('invalid') from None
    if not isinstance(reply, dict):
        raise ControlError('invalid')
    return reply


@contextmanager
def state_lock(state_dir, timeout=5.0):
    """Serialise the engine's own rewrites of records; writers never take this lock."""
    descriptor = os.open(state_dir/'engine.lock', os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        deadline = time.monotonic()+timeout
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.02)
        yield
    finally:
        os.close(descriptor)


def _write_atomic(path, data):
    descriptor, temporary = tempfile.mkstemp(dir=str(path.parent), prefix='.engine-')
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(data, output, separators=(',', ':'))
            output.write('\n')
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def delete_record_directory(record, uid):
    """Remove a record's own files and its directory; anything unknown inside keeps the directory."""
    directory = record.directory
    if not private_directory(directory, uid) or not NAME.match(directory.name):
        return False
    try:
        names = os.listdir(directory)
    except OSError:
        return False
    # The record, its socket and the temporary files of an interrupted atomic write (relay.json.<pid>.tmp, .tmp-*).
    for name in names:
        if (name in (FILENAME[record.kind], 'control.sock') or name.endswith('.tmp')
                or name.startswith(('.tmp-', '.engine-'))):
            try:
                if not stat.S_ISDIR(os.lstat(directory/name).st_mode):
                    os.unlink(directory/name)
            except OSError:
                pass
    try:
        os.rmdir(directory)
    except OSError:
        return False
    return True


def remove_sessions(state_dir, uid, record, sessions):
    """Take the scopes of `sessions` out of a dead record after a confirmed release.

    The record is deleted when no open scope is left. Returns True when the record changed."""
    sessions = set(sessions)
    with state_lock(state_dir):
        fresh = read_record(record.kind, record.directory, uid)
        raw = fresh.data.get('scopes') if fresh is not None else None
        if not isinstance(raw, list):
            return False
        kept = [item for item in raw if not (isinstance(item, dict) and item.get('session_id') in sessions)]
        if len(kept) == len(raw):
            return False
        data = dict(fresh.data, scopes=kept)
        if build_record(fresh.kind, fresh.directory, data).scopes:
            # Every other field stays as the writer left it, including updated_at.
            _write_atomic(fresh.directory/FILENAME[fresh.kind], data)
        else:
            delete_record_directory(fresh, uid)
        return True


def read_released(state_dir, uid):
    """{(writer, session_id)} the engine released successfully while the writer's own record still lists them.

    A live writer's record is never rewritten, so the engine remembers here what it has already done and does not
    repeat a browser call for the same session. An unreadable or foreign file is an empty memory."""
    if not private_directory(state_dir, uid):
        return set()
    try:
        descriptor = os.open(state_dir/RELEASED_FILE, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
                             | getattr(os, 'O_NONBLOCK', 0))
    except OSError:
        return set()
    try:
        info = os.fstat(descriptor)
        if not _private(info, uid, stat.S_ISREG) or info.st_size > MAX_RECORD_BYTES:
            return set()
        data = json.loads(os.read(descriptor, MAX_RECORD_BYTES+1).decode('utf-8'))
    except (OSError, ValueError, UnicodeError):
        return set()
    finally:
        os.close(descriptor)
    entries = data.get('released') if isinstance(data, dict) and data.get('schema_version') == 1 else None
    return {(item['writer'], item['session_id']) for item in entries if isinstance(item, dict)
            and isinstance(item.get('writer'), str) and WRITER.match(item['writer'])
            and _valid_session(item.get('session_id'))} if isinstance(entries, list) else set()


def _write_released(state_dir, pairs, stamps):
    data = {'schema_version': 1, 'released': [
        {'writer': writer, 'session_id': session, 'released_at': stamps.get((writer, session))}
        for writer, session in sorted(pairs)]}
    _write_atomic(state_dir/RELEASED_FILE, data)


def _released_stamps(state_dir, uid):
    try:
        data = json.loads((state_dir/RELEASED_FILE).read_text())
        return {(item['writer'], item['session_id']): item.get('released_at') for item in data['released']}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def remember_released(state_dir, uid, writer, session_id, released_at):
    """Note that `session_id`, listed by the live record of `writer`, was released."""
    if not private_directory(state_dir, uid):
        return False
    with state_lock(state_dir):
        pairs, stamps = read_released(state_dir, uid), _released_stamps(state_dir, uid)
        pairs.add((writer, session_id))
        stamps[(writer, session_id)] = released_at
        _write_released(state_dir, pairs, stamps)
        return True


def forget_released(state_dir, uid, writers):
    """Drop what is remembered about records that are gone; `writers` are those that still exist."""
    pairs = read_released(state_dir, uid)
    if not any(writer not in writers for writer, _ in pairs):
        return False
    with state_lock(state_dir):
        pairs, stamps = read_released(state_dir, uid), _released_stamps(state_dir, uid)
        kept = {pair for pair in pairs if pair[0] in writers}
        if kept != pairs:
            _write_released(state_dir, kept, stamps)
        return kept != pairs


def prune(state_dir, uid, record, droppable=(), now=None, min_age=0):
    """Delete a dead record unless it still lists a session outside `droppable` (sessions known to be gone).

    A record written within the last `min_age` seconds is left alone: a writer that has just started must
    never lose its record to a process list that was read a moment too early."""
    with state_lock(state_dir):
        fresh = read_record(record.kind, record.directory, uid)
        if fresh is None or set(fresh.open_sessions) - set(droppable):
            return False
        if now is not None and min_age:
            try:
                if now-os.lstat(fresh.directory/FILENAME[fresh.kind]).st_mtime < min_age:
                    return False
            except OSError:
                return False
        return delete_record_directory(fresh, uid)


def read_activity(state_dir, uid):
    """Every valid line of activity.jsonl that the tail of the file holds, oldest first.

    A line is {"at", "writer", "session_id", "tool", "ok", "ms"}, and a relay that a bridge started adds "owner", that
    bridge's name (None here for a line without one, or with a value that is no bridge's name: the line still counts).
    Anything else in a line is ignored and a line that does not fit is skipped, so a damaged file never breaks the
    status."""
    if not private_directory(state_dir, uid):
        return []
    try:
        descriptor = os.open(state_dir/'activity.jsonl', os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
                             | getattr(os, 'O_NONBLOCK', 0))
    except OSError:
        return []
    try:
        info = os.fstat(descriptor)
        if not _private(info, uid, stat.S_ISREG):
            return []
        offset = max(0, info.st_size-ACTIVITY_TAIL_BYTES)
        os.lseek(descriptor, offset, os.SEEK_SET)
        raw = b''
        while len(raw) <= ACTIVITY_TAIL_BYTES:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            raw += chunk
    except OSError:
        return []
    finally:
        os.close(descriptor)
    found = []
    # The first line of a tail may be cut in half; a half line is not JSON and is skipped like any other bad line.
    for line in raw.decode('utf-8', 'replace').split('\n'):
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if not isinstance(item, dict):
            continue
        at, writer = parse_iso(item.get('at')), item.get('writer')
        tool, ok, ms, session = item.get('tool'), item.get('ok'), item.get('ms'), item.get('session_id')
        if (at is None or not isinstance(writer, str) or not WRITER.match(writer)
                or not isinstance(tool, str) or not TOOL.match(tool) or not isinstance(ok, bool)
                or not isinstance(ms, (int, float)) or isinstance(ms, bool) or not 0 <= ms < 10**9
                or not (session is None or _valid_session(session))):
            continue
        found.append({'at': at, 'writer': writer, 'session_id': session, 'tool': tool, 'ok': ok, 'ms': int(ms),
                      'owner': bridge_name(item.get('owner'))})
    return found
