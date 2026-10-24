"""The Claude bridge accepts a cua_repl server that is not the bundled plugin only when it is this plugin's relay.

Mock host as in test_host_mcp; no live Codex, no socket."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import relay_install
from test_host_mcp import FakeProxy, HOST_THREAD
from test_relay_install import Machine, relay_entry

PLUGIN_ROOT = Path(__file__).resolve().parents[1]/'engine'
spec = importlib.util.spec_from_file_location('host_mcp', PLUGIN_ROOT/'host_mcp.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
SOCKET = Path('/fixture/existing-host.sock')
REJECTED = 'not identified as the original bundled CUA plugin'


class RelayHost(FakeProxy):
    """A host whose cua_repl server has no plugin identity, and which answers config/read."""

    def __init__(self, config=None, config_error=False, plugin_id=None, **options):
        super().__init__(plugin_id=plugin_id, **options)
        self.config = config
        self.config_error = config_error
        self.config_reads = []
        self.setup_reads = []

    async def answer(self, message):
        if message.get('method') != 'config/read':
            return await super().answer(message)
        # Before thread/start the bridge reads the configuration to set up its thread; only later reads ask who the
        # server is.
        started = any(item.get('method') == 'thread/start' for item in self.received)
        (self.config_reads if started else self.setup_reads).append(message['params'])
        if self.config_error:
            self.emit({'id': message['id'], 'error': {'code': -32601, 'message': 'config/read is not supported'}})
        else:
            self.emit({'id': message['id'], 'result': {'config': self.config if self.config is not None else {}, 'origins': {}}})


class RelayBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/tmp', prefix='rbr-')
        self.addCleanup(self.temp.cleanup)
        self.machine = Machine(Path(self.temp.name).resolve())
        relay_install.refresh_relay_files(self.machine.plugin, self.machine.data)
        self.state = self.machine.root/'host-state'
        self.state.mkdir(mode=0o700)
        self.adapters = []
        # Whatever the bridge records or reads lands in this fake Mac, never in the real home or state folders.
        self.records = self.machine.root/'cua-state'
        self.records.mkdir(mode=0o700)
        for patcher in (patch.object(Path, 'home', return_value=self.machine.home),
                        patch.dict(os.environ, {'HOME': str(self.machine.home), 'CODEX_CUA_STATE_DIR': str(self.records),
                                                'CODEX_HOST_CUA_STATE_DIR': str(self.state)})):
            patcher.start()
            self.addCleanup(patcher.stop)

    async def asyncTearDown(self):
        for adapter in self.adapters:
            await adapter.close()

    def registry(self, **changes):
        record = {'schema_version': 1, 'status': 'ready', 'relay': True, 'relay_launcher': str(self.machine.launcher),
                  'socket_path': str(SOCKET), 'mechanism': 'original_app_server_unix_websocket'}
        record.update(changes)
        (self.state/'host.json').write_text(json.dumps(record))
        (self.state/'host.json').chmod(0o600)

    def connect(self, **options):
        host = RelayHost(**options)

        async def start(rpc):                       # the socket checks belong to test_host_mcp
            rpc.connection = host
            rpc.reader_task = asyncio.create_task(rpc.read())
        output, logs = [], []
        adapter = bridge.HostMcp(Path('/fixture/codex'), SOCKET, emit=output.append, log=logs.append,
                                 startup_timeout=1.0, cleanup_timeout=0.3, native_cua_root=self.machine.cua)
        adapter.rpc.start = start.__get__(adapter.rpc)
        self.adapters.append(adapter)
        return adapter, host, output

    async def initialize(self, adapter):
        await adapter.handle({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18'}})

    def shown(self, **changes):
        return {'mcp_servers': {'cua_repl': relay_entry(self.machine, **changes)}}

    async def assert_connected(self, adapter, host, output):
        self.assertNotIn('error', output[-1], output[-1])
        self.assertTrue(adapter.initialized)
        await adapter.handle({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'js', 'arguments': {'code': 'x'}}})
        self.assertEqual(output[-1]['result'], host.result)
        sent = next(m for m in host.received if m.get('method') == 'mcpServer/tool/call')
        self.assertEqual(sent['params']['threadId'], HOST_THREAD)

    async def assert_rejected(self, adapter, host, output):
        self.assertIn(REJECTED, output[-1]['error']['message'])
        self.assertFalse(adapter.initialized)
        self.assertFalse(any(m.get('method') == 'mcpServer/tool/call' for m in host.received), 'nothing is ever called on it')
        self.assertTrue(any(m.get('method') == 'thread/unsubscribe' for m in host.received), 'the owned thread is cleaned up')
        self.assertTrue(host.was_closed)

    async def test_config_read_that_shows_the_relay_in_front_of_the_bundled_runtime_is_accepted(self):
        adapter, host, output = self.connect(config=self.shown())
        await self.initialize(adapter)
        await self.assert_connected(adapter, host, output)
        self.assertEqual(host.config_reads, [{'includeLayers': False}])

    async def test_a_host_that_does_not_show_the_server_is_judged_by_the_registry(self):
        self.registry()
        for config, error in (({}, False), (None, True)):
            adapter, host, output = self.connect(config=config, config_error=error)
            await self.initialize(adapter)
            await self.assert_connected(adapter, host, output)

    async def test_a_registry_without_the_flag_or_for_another_host_is_no_evidence(self):
        for changes in ({'relay': False}, {'relay_launcher': str(self.machine.data/'relay/other')},
                        {'socket_path': '/fixture/other-host.sock'}):
            self.registry(**changes)
            adapter, host, output = self.connect(config={})
            await self.initialize(adapter)
            await self.assert_rejected(adapter, host, output)
        (self.state/'host.json').unlink()
        adapter, host, output = self.connect(config={})
        await self.initialize(adapter)
        await self.assert_rejected(adapter, host, output)

    async def test_look_alikes_are_rejected_even_when_the_registry_claims_a_relay(self):
        self.registry()
        env = relay_entry(self.machine)['env']
        for label, config in {
            'another launcher': self.shown(env=dict(env, CUA_REPL_NODE_REPL_PATH=str(self.machine.data/'relay/other'))),
            'another native runtime': self.shown(env=dict(env, CODEX_CUA_NATIVE_RUNTIME='/elsewhere/node_repl')),
            'another command': self.shown(command='/usr/bin/node'),
            'another script': self.shown(args=['/elsewhere/cua-repl.mjs']),
            'the bundled definition itself, which is not the relay': self.shown(env=dict(env, CUA_REPL_NODE_REPL_PATH=str(self.machine.cua/'bin/node_repl'))),
        }.items():
            with self.subTest(label):
                adapter, host, output = self.connect(config=config)
                await self.initialize(adapter)
                await self.assert_rejected(adapter, host, output)

    async def test_a_launcher_that_others_could_replace_is_rejected_either_way(self):
        self.registry()
        for config in (self.shown(), {}):
            for mode in (0o770, 0o777):
                self.machine.launcher.chmod(mode)
                adapter, host, output = self.connect(config=config)
                await self.initialize(adapter)
                await self.assert_rejected(adapter, host, output)
            self.machine.launcher.chmod(0o700)

    async def test_a_server_that_reports_another_plugin_is_never_the_relay(self):
        self.registry()
        adapter, host, output = self.connect(config=self.shown(), plugin_id='unrelated-plugin@market')
        await self.initialize(adapter)
        await self.assert_rejected(adapter, host, output)
        self.assertEqual(host.config_reads, [], 'the host is not even asked')

    async def test_the_host_is_asked_once_while_the_runtime_is_starting(self):
        adapter, host, output = self.connect(config=self.shown(), states=['notStarted', 'starting', 'starting', 'connected'])
        await self.initialize(adapter)
        await self.assert_connected(adapter, host, output)
        self.assertEqual(sum(m.get('method') == 'mcpServerStatus/list' for m in host.received), 4)
        self.assertEqual(host.config_reads, [{'includeLayers': False}])

    async def test_a_server_that_is_the_bundled_plugin_never_needs_any_of_this(self):
        adapter, host, output = self.connect(config=None, plugin_id=bridge.NATIVE_PLUGIN_ID)
        await self.initialize(adapter)
        await self.assert_connected(adapter, host, output)
        self.assertEqual(host.config_reads, [])


if __name__ == '__main__':
    unittest.main()
