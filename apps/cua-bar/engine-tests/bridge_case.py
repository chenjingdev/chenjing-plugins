"""Shared setup for the bridge tests that run in this process: temp roots, a fake host, helpers. Never the real Codex.

Every path a test touches is inside one temp directory (short, because a Unix socket path is limited to 104 bytes);
HOME and the state directory variables point there, so nothing of the real user folders is read or written.
"""
import asyncio
import faulthandler
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import bridge_control
import host_mcp
import mcp_stdio
from fake_host import FakeHost, private_socket

ISO = r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$'


class BridgeCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # A deadlock in the code under test must end the run with a stack trace, not hang it for good.
        faulthandler.dump_traceback_later(120, exit=True)
        self.addCleanup(faulthandler.cancel_dump_traceback_later)
        self.temp = tempfile.TemporaryDirectory(dir='/tmp', prefix='cb')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root/'home'
        self.home.mkdir()
        self.state = self.root/'state'
        self.host_state = self.root/'host'
        environment = patch.dict(os.environ, {'HOME': str(self.home), 'CODEX_CUA_STATE_DIR': str(self.state)})
        environment.start()
        self.addCleanup(environment.stop)
        self.hosts, self.connects, self.sockets = [], [], []
        self.output, self.logs = [], []
        self.next_id = 100
        connector = patch.object(host_mcp, 'unix_connect', new=self.connect)
        connector.start()
        self.addCleanup(connector.stop)

    async def asyncTearDown(self):
        for sock in self.sockets:
            sock.close()

    # The fake host side.
    async def connect(self, **kwargs):
        self.connects.append(kwargs)
        return self.hosts[len(self.connects)-1]

    def add_host(self, **options):
        host = FakeHost(**options)
        self.hosts.append(host)
        return host

    def socket(self):
        """A new endpoint the bridge accepts as a private Unix socket; every call makes another one."""
        directory = self.root/('endpoint%d' % len(self.sockets))
        directory.mkdir(mode=0o700)
        sock, path = private_socket(directory)
        self.sockets.append(sock)
        return path

    # The bridge side.
    def plain_adapter(self, **options):
        adapter = host_mcp.HostMcp(Path('/fixture/codex'), self.socket(), emit=self.output.append, log=self.logs.append,
                                   startup_timeout=10.0, cleanup_timeout=2.0, **options)
        self.addAsyncCleanup(adapter.close)
        return adapter

    def registered_adapter(self):
        adapter = mcp_stdio.build_adapter(self.host_state, emit=self.output.append, log=self.logs.append,
                                          startup_timeout=10.0, cleanup_timeout=2.0)
        self.addAsyncCleanup(adapter.close)
        return adapter

    async def start_control(self, adapter, **options):
        control = bridge_control.BridgeControl(adapter, state=self.state, **options)
        await control.start()
        self.addAsyncCleanup(control.finalize)
        return control

    async def initialize(self, adapter):
        await adapter.handle({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': '2025-06-18', 'capabilities': {}}})
        self.assertNotIn('error', self.output[-1])

    def call(self, name='js', **extra):
        self.next_id += 1
        return {'jsonrpc': '2.0', 'id': self.next_id, 'method': 'tools/call',
                'params': {'name': name, 'arguments': {} if name == 'turn_ended' else {'code': 'PRIVATE_SCRIPT'}, **extra}}

    async def run_call(self, adapter, name='js'):
        message = self.call(name)
        await adapter.handle(message)
        return self.reply(message['id'])

    def reply(self, ident):
        return next(item for item in reversed(self.output) if item.get('id') == ident)

    async def settle(self, predicate, seconds=10.0):
        deadline = asyncio.get_running_loop().time()+seconds
        while not predicate():
            if asyncio.get_running_loop().time() > deadline:
                self.fail('The expected state was not reached')
            await asyncio.sleep(0.005)

    # The control endpoint.
    def record(self, control):
        return json.loads((control.directory/'bridge.json').read_text())

    async def exchange(self, control, data, wait=15.0):
        """Send raw bytes to the control socket; the reply as JSON, or None when it closed without answering."""
        reader, writer = await asyncio.open_unix_connection(control.control_path)
        try:
            writer.write(data)
            await writer.drain()
            line = await asyncio.wait_for(reader.read(65536), wait)
        finally:
            writer.close()
        return json.loads(line) if line else None

    async def ask(self, control, action, **override):
        request = {'action': action, 'pid': control.pid, 'started_at': control.started_at}
        request.update(override)
        return await self.exchange(control, json.dumps(request).encode()+b'\n')
