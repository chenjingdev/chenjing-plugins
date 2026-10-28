"""Record and private control endpoint of one Claude CUA bridge process.

`S/bridges/bridge-<random>/` (0700) holds `bridge.json` (0600, always replaced atomically) and `control.sock` (0600).
The record says who this bridge is, what it is connected to and which scopes are open; the engine reads it and,
through the socket, asks the bridge to release. The socket takes one JSON line and answers one JSON line:

    {"action": "status",  "pid": <pid>, "started_at": <epoch>}  ->  {"ok", "busy", "open_scopes"}
    {"action": "release", "pid": <pid>, "started_at": <epoch>}  ->  {"released", "reason", "scope_count"}

A request with another pid or start time, another action, bad JSON, more than 1 KB, or no newline within 2 s is
closed without an answer. Further keys in a request are ignored. There is no way to name a session, a turn or a tool:
a release ends only what this bridge opened.
Every failure to set any of this up leaves the bridge running without records (see host_mcp.serve).

The bridge gives its name (`bridge-<pid>-<started_at>`) to the relay of its own thread, and on the way out ends the
runtimes whose relay record carries that name: the host keeps an owned thread and its runtime until Codex quits.
"""
import asyncio
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile

import bridge_records as records


class BridgeControl:
    IN_FLIGHT_WAIT = 2.5
    READ_TIMEOUT = 2.0
    MAX_REQUEST = 1024

    def __init__(self, adapter, state=None, in_flight_wait=None):
        self.adapter = adapter
        self.state = Path(state) if state is not None else records.state_dir()
        self.in_flight_wait = self.IN_FLIGHT_WAIT if in_flight_wait is None else in_flight_wait
        self.pid = os.getpid()
        self.owner_pid = os.getppid()
        self.cwd = os.getcwd()
        self.started_at = None
        self.writer_id = None
        self.directory = None
        self.control_path = None
        self.server = None
        self.handlers = set()
        self.release_lock = asyncio.Lock()
        self.finished = False

    async def start(self):
        records.private_directory(self.state)
        root = records.private_directory(self.state/'bridges')
        self.started_at = records.process_started_at(self.pid)
        self.writer_id = 'bridge-%d-%d' % (self.pid, self.started_at)
        self.directory = Path(tempfile.mkdtemp(prefix='bridge-', dir=str(root)))
        try:
            os.chmod(self.directory, 0o700)
            socket = self.directory/'control.sock'
            self.server = await asyncio.start_unix_server(self.handle, path=str(socket), limit=self.MAX_REQUEST)
            os.chmod(socket, 0o600)
            self.control_path = str(socket)
            self.write()
        except BaseException:
            await self.discard()
            raise
        self.adapter.on_change = self.refresh
        self.adapter.on_call = self.record_call
        self.adapter.on_browser_blocked = self.record_browser_blocked
        self.adapter.owner = self.writer_id

    def record(self, **changes):
        view = self.adapter.snapshot()
        record = {'schema_version': 1, 'kind': 'bridge', 'pid': self.pid, 'started_at': self.started_at,
                  'owner_pid': self.owner_pid, 'cwd': self.cwd, 'control_path': self.control_path,
                  'host': view['host'], 'session_id': view['session_id'], 'turn_id': view['turn_id'],
                  'connected_at': view['connected_at'], 'last_call_at': view['last_call_at'], 'busy': view['busy'],
                  'scopes': view['scopes'], 'cleanup': view['cleanup'], 'updated_at': records.utc_now()}
        record.update(changes)
        return record

    def write(self, **changes):
        records.write_json_atomic(self.directory/'bridge.json', self.record(**changes))

    def refresh(self):
        """Bring the record up to date. A write that fails is skipped; the next change writes again."""
        if self.finished:
            return
        try:
            self.write()
        except Exception:
            pass

    def record_call(self, tool, ok, ms, session_id, relay, error=None, texts=()):
        """One activity line per tool call, only while no relay in front of the runtime writes it already.

        The line of a failed call also says why, in one of the words of records.FAILURES, and keeps what its answer
        said (`texts`, clipped to one line) while the person asked for it."""
        if relay or self.finished:
            return
        entry = {'at': records.utc_now(), 'writer': self.writer_id, 'session_id': session_id, 'tool': tool,
                 'ok': bool(ok), 'ms': int(ms), 'cwd': self.cwd}
        if not ok:
            entry['error'] = error if error in records.FAILURES else 'error'
            text = records.error_text(texts)
            if text is not None and records.keeps_error_text(self.state):
                entry['error_text'] = text
        try:
            records.append_activity(self.state, entry)
        except Exception:
            pass

    def record_browser_blocked(self, app_version):
        """Codex refused the browser to this bridge's conversation: the same note a release by id leaves when Codex
        refuses it (records.remember_browser_blocked), so the app stops offering releases this Codex version refuses."""
        if self.finished:
            return
        try:
            records.remember_browser_blocked(self.state, app_version)
        except Exception:
            pass

    def identified(self, request):
        if not isinstance(request, dict):
            return False
        pid, started_at = request.get('pid'), request.get('started_at')
        return (type(pid) is int and pid == self.pid and type(started_at) is int and started_at == self.started_at)

    async def handle(self, reader, writer):
        task = asyncio.current_task()
        self.handlers.add(task)
        try:
            request = json.loads(await asyncio.wait_for(reader.readuntil(b'\n'), self.READ_TIMEOUT))
            if not self.identified(request):
                return
            action = request.get('action')
            if action == 'status':
                reply = {'ok': True, 'busy': self.adapter.active_tool_calls > 0, 'open_scopes': len(self.adapter.scopes)}
            elif action == 'release':
                async with self.release_lock:
                    reply = await self.adapter.release_scopes(wait=self.in_flight_wait)
            else:
                return
            writer.write((json.dumps(reply)+'\n').encode())
            await writer.drain()
        except Exception:
            pass
        finally:
            self.handlers.discard(task)
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

    async def stop(self):
        """Stop answering: no new request, and none half-way while the bridge releases for its exit."""
        if self.server is not None:
            self.server.close()
        handlers = list(self.handlers)
        for task in handlers:
            task.cancel()
        await asyncio.gather(*handlers, return_exceptions=True)
        if self.server is not None:
            await self.server.wait_closed()
            self.server = None
        self.unlink('control.sock')

    def unlink(self, name):
        try:
            (self.directory/name).unlink()
        except FileNotFoundError:
            pass

    def stop_runtimes(self, run=subprocess.run, kill=os.kill):
        """End the runtimes the host started for this bridge's threads; returns how many were signalled (R8).

        Each runs the relay, whose record names this bridge. Only the cua-repl process that is the parent of such a
        relay and still a child of the host the relay started under is signalled. The relay then ends the runtime
        behind it when its input closes, and releases on the way whatever is still open.
        """
        if self.writer_id is None:
            return 0
        stopped = 0
        for path in sorted((self.state/'relays').glob('relay-*/relay.json')):
            try:
                data = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            if not isinstance(data, dict) or data.get('owner') != self.writer_id:
                continue
            relay, root, host = data.get('pid'), data.get('root_pid'), data.get('app_server_pid')
            if not all(type(value) is int and value > 1 for value in (relay, root, host)):
                continue
            try:
                listed = run(['/bin/ps', '-o', 'pid=,ppid=,command=', '-p', '%d,%d' % (relay, root)],
                             capture_output=True, text=True, timeout=2, env={'LC_ALL': 'C'}).stdout
            except (OSError, subprocess.SubprocessError):
                continue
            procs = {}
            for line in listed.splitlines():
                fields = line.split(None, 2)
                if len(fields) == 3 and fields[0].isdigit() and fields[1].isdigit():
                    procs[int(fields[0])] = (int(fields[1]), fields[2])
            if (procs.get(relay, (None,))[0] != root or procs.get(root, (None,))[0] != host
                    or '/@oai/cua-repl/' not in procs[root][1]):
                continue
            try:
                kill(root, signal.SIGTERM)
                stopped += 1
            except OSError:
                pass
        return stopped

    async def finalize(self):
        """The record's last write: removed when nothing is open, else left as not confirmed without its socket.

        The runtimes of this bridge's threads are ended first: nothing will use them again."""
        self.finished = True
        self.adapter.on_change = self.adapter.on_call = self.adapter.on_browser_blocked = None
        if self.directory is None:
            return
        try:
            self.stop_runtimes()
        except Exception:
            pass
        try:
            await self.stop()
            if self.adapter.snapshot()['cleanup'] == 'none':
                await self.discard()
            else:
                self.write(cleanup='not_confirmed', busy=False, host=None)
        except Exception:
            pass

    async def discard(self):
        """Take the whole directory away."""
        if self.server is not None:
            self.server.close()
            self.server = None
        if self.directory is None:
            return
        try:
            for entry in list(self.directory.iterdir()):
                entry.unlink()
            self.directory.rmdir()
        except OSError:
            pass
