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
"""
import asyncio
import json
import os
from pathlib import Path
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

    def record_call(self, tool, ok, ms, session_id, relay):
        """One activity line per tool call, only while no relay in front of the runtime writes it already."""
        if relay or self.finished:
            return
        try:
            records.append_activity(self.state, {'at': records.utc_now(), 'writer': self.writer_id,
                                                 'session_id': session_id, 'tool': tool, 'ok': bool(ok), 'ms': int(ms)})
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

    async def finalize(self):
        """The record's last write: removed when nothing is open, else left as not confirmed without its socket."""
        self.finished = True
        self.adapter.on_change = self.adapter.on_call = None
        if self.directory is None:
            return
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
