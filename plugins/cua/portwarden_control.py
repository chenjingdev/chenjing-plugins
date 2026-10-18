"""Private, connection-scoped cleanup endpoint. No caller-chosen tool or scope."""
import asyncio
import datetime
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile


class PortwardenControl:
    def __init__(self, adapter, state=None):
        self.adapter = adapter
        self.root = state or Path.home()/'Library/Caches/portwarden-cua'
        self.directory = None
        self.server = None
        self.lock = asyncio.Lock()

    async def start(self):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = self.root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise RuntimeError('Private control directory required.')
        self.directory = Path(tempfile.mkdtemp(prefix='relay-', dir=str(self.root)))
        os.chmod(self.directory, 0o700)
        socket = self.directory/'control.sock'
        self.server = await asyncio.start_unix_server(self.handle, path=str(socket), limit=2048)
        os.chmod(socket, 0o600)
        # The C locale keeps lstart parseable on non-English systems.
        birth = subprocess.check_output(['ps', '-p', str(os.getpid()), '-o', 'lstart='], text=True,
                                        env=dict(os.environ, LC_ALL='C')).strip()
        started = datetime.datetime.strptime(birth, '%a %b %d %H:%M:%S %Y').timestamp()*1000
        record = {'schemaVersion': 1, 'relayKind': 'host-frontend', 'relayPid': os.getpid(),
                  'rootPid': os.getpid(), 'relayStartedAt': started, 'controlPath': str(socket)}
        file = self.directory/'relay.json'
        file.write_text(json.dumps(record))
        os.chmod(file, 0o600)

    async def handle(self, reader, writer):
        try:
            raw = await asyncio.wait_for(reader.readline(), 2)
            data = json.loads(raw)
            if (data.get('action') != 'release' or data.get('rootPid') != os.getpid()
                    or data.get('relayPid') != os.getpid()):
                return
            async with self.lock:
                self.adapter.stopping = True
                deadline = asyncio.get_running_loop().time()+2.5
                while self.adapter.active_tool_calls and asyncio.get_running_loop().time()<deadline:
                    await asyncio.sleep(0.025)
                if self.adapter.active_tool_calls:
                    result = {'released': False, 'reason': 'request_in_flight'}
                else:
                    result = await self.adapter.release_turn()
                if not result.get('released'):
                    self.adapter.stopping = False
                writer.write((json.dumps(result)+'\n').encode())
                await writer.drain()
        except Exception:
            pass
        finally:
            writer.close()
            try: await writer.wait_closed()
            except ConnectionError: pass

    async def close(self):
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
        if self.directory is not None:
            for filename in ('control.sock', 'relay.json'):
                try: (self.directory/filename).unlink()
                except FileNotFoundError: pass
            try: self.directory.rmdir()
            except FileNotFoundError: pass
