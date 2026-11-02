"""Real stdio EOF from only a disposable MCP process talking to a fake native host."""
import json
import os
import select
import shutil
import time
import unittest

import test_bridge_process as process_fixture


class UpdateProcessTests(unittest.TestCase):
    setUp = process_fixture.ProcessTests.setUp
    start = process_fixture.ProcessTests.start
    connected = process_fixture.ProcessTests.connected
    host_log = process_fixture.ProcessTests.host_log
    records = process_fixture.ProcessTests.records

    def installed_copy(self):
        engines = self.root/'home/.local/share/codex-cua/engine'
        engines.mkdir(parents=True, mode=0o700)
        version = json.loads((process_fixture.PLUGIN/'.claude-plugin/plugin.json').read_text())['version']
        current = engines/version
        shutil.copytree(process_fixture.PLUGIN, current,
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store'))
        (engines/'current').symlink_to(version)
        return current

    @staticmethod
    def update_copy(current):
        path = current/'host_mcp.py'
        path.write_bytes(path.read_bytes()+b'\n# A fixture update; never imported or executed.\n')

    def test_updated_idle_mcp_closes_stdout_without_waiting_for_client_stdin_to_close(self):
        current = self.installed_copy()
        child = self.connected()
        self.assertFalse(child.process.stdin.closed)
        self.update_copy(current)
        self.assertEqual(child.finish(timeout=10), 0)
        self.assertFalse(child.process.stdin.closed, 'server shutdown must not depend on client EOF')
        self.assertIn('installed_update_closing_old_mcp', child.stderr)
        self.assertEqual([item for item in self.host_log() if 'tool' in item], [])
        self.assertEqual(self.records(), [])

    def test_update_during_native_action_returns_its_result_then_closes_after_scope_cleanup(self):
        current = self.installed_copy()
        stub = process_fixture.STUB.replace(
            "        host.hold(os.environ['FAKE_HOST_HOLD'])",
            """        gate = host.hold(os.environ['FAKE_HOST_HOLD'])
        import asyncio
        from pathlib import Path
        async def finish_fixture_action():
            while not Path(os.environ['FAKE_HOST_LOG']+'.gate').exists():
                await asyncio.sleep(0.01)
            gate.set()
        asyncio.create_task(finish_fixture_action())""")
        (self.root/'stub/websockets/__init__.py').write_text(stub)
        child = self.connected(hold='js')
        action = {'jsonrpc': '2.0', 'id': 50, 'method': 'tools/call', 'params': process_fixture.SECRET_CALL}
        child.process.stdin.write((json.dumps(action)+'\n').encode())
        child.process.stdin.flush()
        deadline = time.monotonic()+10
        while time.monotonic() < deadline and not [item for item in self.host_log() if item.get('tool') == 'js']:
            time.sleep(0.01)
        self.assertEqual([item['tool'] for item in self.host_log()], ['js'])
        self.update_copy(current)
        seen = b''
        while time.monotonic() < deadline and b'installed_update_waiting_for_requests' not in seen:
            readable, _, _ = select.select([child.process.stderr], [], [], 0.05)
            if readable:
                seen += os.read(child.process.stderr.fileno(), 4096)
        self.assertIn(b'installed_update_waiting_for_requests', seen)
        self.assertIsNone(child.process.poll(), 'an action that already ran must finish first')
        blocked = child.request('tools/call', {'name': 'js_reset', 'arguments': {}})
        self.assertEqual(blocked['error']['code'], -32004)
        self.assertIn('/mcp reconnect cuabar', blocked['error']['message'])
        self.assertEqual([item['tool'] for item in self.host_log()], ['js'])
        (self.root/'fake-host.log.gate').write_text('finish')
        result = child.lines.get(timeout=5)
        self.assertEqual(result['id'], 50)
        self.assertEqual(result['result']['content'][0]['text'], 'PRIVATE_RESULT')
        self.assertEqual(child.finish(timeout=10), 0)
        self.assertEqual([item['tool'] for item in self.host_log() if 'tool' in item], ['js', 'turn_ended'])
        self.assertEqual(self.records(), [])

    def test_missing_installation_does_not_close_an_otherwise_connected_mcp(self):
        child = self.connected()
        # A ping after the watcher's ordinary first check is enough: no installation means no stale assertion.
        self.assertEqual(child.request('ping')['result'], {})
        self.assertIsNone(child.process.poll())
        child.end_input()
        self.assertEqual(child.finish(), 0)
