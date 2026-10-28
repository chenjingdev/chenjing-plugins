import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import mcp_stdio


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name)
        self.record = {'schema_version': 1, 'status': 'ready',
            'mechanism': 'original_app_server_unix_websocket',
            'owner_pid': os.getpid(), 'backend_pid': os.getpid(),
            'desktop_proxy_pid': os.getpid(), 'socket_path': '/private/test/host.sock'}
        self.write()

    def tearDown(self):
        self.temp.cleanup()

    def write(self):
        self.path = self.state/'host.json'
        self.path.write_text(json.dumps(self.record))
        self.path.chmod(0o600)

    def test_the_bridge_knows_the_codex_version_of_its_registered_host(self):
        from test_runtime_paths import fake_app
        app, native, _ = fake_app(self.state/'Applications')
        import asyncio

        async def made():           # the adapter's locks want a loop on Python 3.9
            return mcp_stdio.build_adapter(self.state, emit=lambda message: None, log=lambda event: None)
        adapter = asyncio.run(made())
        self.assertIsNone(adapter.codex_app_version(), 'no host registered yet')
        adapter.registry = dict(self.record, native_cli=str(native))
        self.assertEqual(adapter.codex_app_version(), 'fixture')
        adapter.registry = dict(self.record, native_cli='/elsewhere/codex')
        self.assertIsNone(adapter.codex_app_version())

    def test_owned_live_registry_resolves_without_starting_a_process(self):
        with patch('subprocess.Popen', side_effect=AssertionError('No process may start')):
            self.assertEqual(mcp_stdio.endpoint_from_registry(self.state), Path('/private/test/host.sock'))

    def test_public_registry_and_parent_are_rejected(self):
        self.path.chmod(0o644)
        with self.assertRaises(mcp_stdio.BridgeFailure):
            mcp_stdio.endpoint_from_registry(self.state)
        self.path.chmod(0o600)
        self.state.chmod(0o755)
        with self.assertRaises(mcp_stdio.BridgeFailure):
            mcp_stdio.endpoint_from_registry(self.state)
        self.state.chmod(0o700)

    def test_symlink_registry_is_rejected(self):
        target = self.state/'other.json'
        self.path.rename(target)
        self.path.symlink_to(target)
        with self.assertRaises(mcp_stdio.BridgeFailure):
            mcp_stdio.endpoint_from_registry(self.state)

    def test_stale_process_binding_is_rejected(self):
        with patch('os.kill', side_effect=ProcessLookupError):
            with self.assertRaises(mcp_stdio.BridgeFailure):
                mcp_stdio.endpoint_from_registry(self.state)

    def test_unready_or_wrong_mechanism_is_rejected(self):
        for changes in ({'status': 'closed'}, {'status': 'stopping', 'stopping_at': '2026-10-21T00:00:00Z'},
                        {'mechanism': 'standalone'}, {'owner_pid': True}, {'socket_path': 'relative.sock'}):
            original = dict(self.record)
            self.record.update(changes)
            self.write()
            with self.assertRaises(mcp_stdio.BridgeFailure):
                mcp_stdio.endpoint_from_registry(self.state)
            self.record = original


if __name__ == '__main__':
    unittest.main()
