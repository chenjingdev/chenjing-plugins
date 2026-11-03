"""Local status and managed hook repair use fake adapters and private, temporary engine copies only."""
import asyncio
import json
from pathlib import Path
import shutil
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import mcp_health as health
from runtime_identity import installed_identity


SOURCE = Path(__file__).resolve().parents[1]/'engine'


class HealthCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cuabar-health-')
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name).resolve()
        self.engine = self.home/'.local/share/codex-cua/engine/0.8.17'
        self.environment = {'PATH': '/fixture/no-executables', 'SECRET_MUST_NOT_PASS': 'private-fixture-value'}
        self.settings = self.home/'.claude/settings.json'

    def install(self):
        self.engine.mkdir(parents=True, mode=0o700)
        for parent in (self.engine.parent, self.engine.parent.parent):
            parent.chmod(0o700)
        manifest = self.engine/'.claude-plugin'
        manifest.mkdir(mode=0o700)
        (manifest/'plugin.json').write_text('{"name":"cuabar","version":"0.8.17"}\n')
        for name in ('mcp_health.py', 'runtime_identity.py', 'claude_hook_setup.py', 'claude_hook_profiles.py',
                     'cuabar_host.py'):
            shutil.copyfile(SOURCE/name, self.engine/name)
        for name in ('host_mcp.py', 'mcp_stdio.py'):
            (self.engine/name).write_text('# fixture engine component\n')
        for path in self.engine.rglob('*'):
            path.chmod(0o700 if path.is_dir() else 0o600)
        (self.engine.parent/'current').symlink_to(self.engine.name)

    def adapter(self, stale=False, connected=True):
        identity = installed_identity(self.home)
        if stale:
            identity = {'version': '0.8.16', 'revision': 'a'*64}
        return SimpleNamespace(runtime_identity=identity, connected=connected,
            snapshot=Mock(return_value={'busy': False, 'scopes': [{'session_id': 'MUST_NOT_REPORT_SESSION'}]}),
            ensure_connected=AsyncMock(side_effect=AssertionError('health never opens a native host')))

    def write_settings(self, value, directory=None):
        directory = self.settings.parent if directory is None else directory
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = directory/'settings.json'
        path.write_text(json.dumps(value)+'\n')
        path.chmod(0o600)
        return path


class HealthTests(HealthCase):
    def test_status_distinguishes_an_old_runtime_from_a_connected_native_host(self):
        self.install()
        adapter = self.adapter(stale=True)
        answer = health.read_health(adapter, self.home, self.environment)
        self.assertEqual(answer['runtime']['state'], 'reconnect_required')
        self.assertTrue(answer['runtime']['reconnect_required'])
        self.assertEqual(answer['runtime']['running_version'], '0.8.16')
        self.assertEqual(answer['runtime']['installed_version'], '0.8.17')
        self.assertEqual(answer['native_connection'], 'connected')
        self.assertEqual(answer['next_action'], 'reconnect_mcp')
        self.assertEqual(answer['hooks'], 'missing')
        self.assertEqual(answer['open_scope_count'], 1)
        rendered = json.dumps(answer)
        self.assertNotIn('MUST_NOT_REPORT_SESSION', rendered)
        self.assertNotIn(str(self.home), rendered)
        self.assertNotIn(self.environment['SECRET_MUST_NOT_PASS'], rendered)
        adapter.ensure_connected.assert_not_called()

    def test_current_runtime_and_ready_hooks_can_be_healthy_while_host_is_disconnected(self):
        self.install()
        health.repair_hooks_local(self.home, self.environment)
        adapter = self.adapter(connected=False)
        answer = health.read_health(adapter, self.home, self.environment)
        self.assertEqual(answer['runtime']['state'], 'current')
        self.assertEqual(answer['hooks'], 'ready')
        self.assertEqual(answer['native_connection'], 'disconnected')
        self.assertEqual(answer['next_action'], 'next_cua_call_reconnects_native_host')
        adapter.ensure_connected.assert_not_called()

    def test_missing_installation_is_unknown_and_read_only(self):
        answer = health.read_health(self.adapter(), self.home, self.environment)
        self.assertEqual(answer['runtime']['state'], 'unknown')
        self.assertFalse(answer['runtime']['reconnect_required'])
        self.assertEqual(list(self.home.iterdir()), [])

    def test_status_and_repair_specs_are_separate_and_local(self):
        specs = health.tool_specs()
        self.assertEqual([item['name'] for item in specs], ['status', 'repair'])
        self.assertEqual([item['annotations']['readOnlyHint'] for item in specs], [True, False])
        self.assertTrue(all(item['annotations']['idempotentHint'] for item in specs))
        self.assertTrue(all(item['annotations']['openWorldHint'] is False for item in specs))
        specs[0]['inputSchema']['properties']['broken'] = {}
        self.assertEqual(health.TOOL_SPECS[0]['inputSchema']['properties'], {})

    def test_helper_restores_hooks_preserving_permissions_and_other_handlers(self):
        self.install()
        original = {'permissions': {'allow': ['Read'], 'deny': ['Bash']}, 'model': 'fixture',
                    'hooks': {'Stop': [{'hooks': [{'type': 'command', 'command': '/fixture/other'}]}]}}
        self.write_settings(original)
        first = health.repair_hooks_local(self.home, self.environment)
        self.assertEqual((first['state'], first['changed']), ('ready', True))
        installed = json.loads(self.settings.read_text())
        self.assertEqual(installed['permissions'], original['permissions'])
        self.assertEqual(installed['model'], original['model'])
        self.assertEqual(installed['hooks']['Stop'][0], original['hooks']['Stop'][0])
        self.assertNotIn(str(self.home), json.dumps(first))
        before = self.settings.stat()
        second = health.repair_hooks_local(self.home, self.environment)
        self.assertEqual((second['state'], second['changed']), ('ready', False))
        self.assertEqual(self.settings.stat().st_ino, before.st_ino)

    def test_helper_repairs_only_the_explicit_profile_without_discovering_company(self):
        self.install()
        company = self.write_settings({'keep': 'company'}, self.home/'.claude-ubion')
        selected = self.home/'explicit-profile'
        answer = health.repair_hooks_local(self.home, {**self.environment, 'CLAUDE_CONFIG_DIR': str(selected)})
        self.assertEqual(answer['state'], 'ready')
        self.assertTrue((selected/'settings.json').is_file())
        self.assertFalse(self.settings.exists())
        self.assertEqual(json.loads(company.read_text()), {'keep': 'company'})

    def test_disabled_policy_and_invalid_settings_are_not_changed(self):
        self.install()
        for value in ({'disableAllHooks': True}, {'allowManagedHooksOnly': True}):
            with self.subTest(value=value):
                self.write_settings(value)
                before = self.settings.read_bytes(), self.settings.stat().st_ino
                answer = health.repair_hooks_local(self.home, self.environment)
                self.assertEqual((answer['state'], answer['changed']), ('disabled', False))
                self.assertEqual((self.settings.read_bytes(), self.settings.stat().st_ino), before)
        self.settings.write_text('{invalid')
        self.assertEqual(health.repair_hooks_local(self.home, self.environment)['state'], 'conflict')
        self.assertEqual(self.settings.read_text(), '{invalid')
        self.assertFalse((self.engine.parent.parent/'claude-hook-profiles.json').exists())


class RepairTests(HealthCase, unittest.IsolatedAsyncioTestCase):
    async def test_an_inflight_cua_request_defers_repair_without_starting_a_helper(self):
        self.install()
        adapter = self.adapter(stale=True)
        adapter.snapshot.return_value = {'busy': True, 'scopes': [{'session_id': 'PRIVATE'}]}
        with patch.object(health.asyncio, 'create_subprocess_exec') as execute:
            answer = await health.repair_health(adapter, self.home, self.environment)
        self.assertEqual(answer['hook_repair'], {'state': 'deferred', 'changed': False,
                                               'error': 'cua_request_in_flight'})
        self.assertFalse(answer['repaired'])
        self.assertTrue(answer['runtime']['reconnect_required'])
        self.assertFalse(self.settings.exists())
        execute.assert_not_called()

    async def test_current_installed_helper_repairs_hooks_but_does_not_claim_the_old_bridge_was_reconnected(self):
        self.install()
        adapter = self.adapter(stale=True)
        answer = await health.repair_health(adapter, self.home, self.environment)
        self.assertEqual(answer['hook_repair'], {'state': 'ready', 'changed': True})
        self.assertTrue(answer['repaired'])
        self.assertEqual(answer['hooks'], 'ready')
        self.assertTrue(answer['runtime']['reconnect_required'])
        self.assertEqual(answer['next_action'], 'reconnect_mcp')
        adapter.ensure_connected.assert_not_called()
        self.assertEqual(stat.S_IMODE(self.settings.stat().st_mode), 0o600)
        self.assertFalse(list(self.engine.rglob('__pycache__')))

    async def test_no_installed_helper_creates_no_files(self):
        answer = await health.repair_health(self.adapter(), self.home, self.environment)
        self.assertEqual(answer['hook_repair']['error'], 'installed_repair_helper_unavailable')
        self.assertFalse(answer['repaired'])
        self.assertEqual(list(self.home.iterdir()), [])

    async def test_untrusted_or_symlink_helper_is_not_executed(self):
        self.install()
        helper = self.engine/'mcp_health.py'
        helper.chmod(0o666)
        with patch.object(health.asyncio, 'create_subprocess_exec') as execute:
            answer = await health.repair_health(self.adapter(), self.home, self.environment)
        self.assertEqual(answer['hook_repair']['error'], 'installed_repair_helper_unavailable')
        execute.assert_not_called()
        elsewhere = self.home/'elsewhere.py'
        helper.rename(elsewhere)
        helper.symlink_to(elsewhere)
        with patch.object(health.asyncio, 'create_subprocess_exec') as execute:
            answer = await health.repair_health(self.adapter(), self.home, self.environment)
        self.assertEqual(answer['hook_repair']['error'], 'installed_repair_helper_unavailable')
        execute.assert_not_called()

    async def test_disabled_and_conflicting_hooks_never_start_a_helper(self):
        self.install()
        for value in ({'disableAllHooks': True}, {'allowManagedHooksOnly': True}, {'hooks': []}):
            self.write_settings(value)
            before = self.settings.read_bytes()
            with patch.object(health.asyncio, 'create_subprocess_exec') as execute:
                answer = await health.repair_health(self.adapter(), self.home, self.environment)
            self.assertFalse(answer['repaired'])
            self.assertEqual(self.settings.read_bytes(), before)
            execute.assert_not_called()

    async def fake_process(self, data=b'', code=0, hang=False):
        reader = asyncio.StreamReader()
        if not hang:
            reader.feed_data(data)
            reader.feed_eof()
        process = SimpleNamespace(stdout=reader, returncode=code)
        async def wait():
            return process.returncode
        def kill():
            process.returncode = -9
            reader.feed_eof()
        process.wait = AsyncMock(side_effect=wait)
        process.kill = Mock(side_effect=kill)
        return process

    async def test_helper_receives_fixed_arguments_and_only_the_explicit_nonsecret_environment(self):
        self.install()
        payload = {'schema_version': 1, 'kind': health.HELPER_KIND, 'state': 'ready', 'changed': False}
        process = await self.fake_process(json.dumps(payload).encode())
        environment = {**self.environment, 'CLAUDE_CONFIG_DIR': str(self.home/'explicit-profile'),
                       'OP_SERVICE_ACCOUNT_TOKEN': 'MUST_NOT_PASS', 'CLAUDE_PID': '123'}
        with patch.object(health.asyncio, 'create_subprocess_exec', new=AsyncMock(return_value=process)) as execute:
            answer = await health._run_helper(self.engine/'mcp_health.py', self.home, environment)
        self.assertEqual(answer, {'state': 'ready', 'changed': False})
        args, kwargs = execute.call_args
        self.assertEqual(args, ('/usr/bin/python3', '-B', str(self.engine/'mcp_health.py'), '--repair-hooks', '--json'))
        self.assertEqual(set(kwargs['env']), {'HOME', 'PATH', 'LC_ALL', 'PYTHONDONTWRITEBYTECODE', 'CLAUDE_CONFIG_DIR'})
        self.assertEqual(kwargs['stdin'], asyncio.subprocess.DEVNULL)
        self.assertEqual(kwargs['stderr'], asyncio.subprocess.DEVNULL)
        process.kill.assert_not_called()

    async def test_helper_response_is_bounded_and_untrusted_errors_are_not_reported(self):
        self.install()
        for raw, code, expected in ((b'{invalid', 0, 'invalid_helper_reply'),
                                    (b'{}', 0, 'invalid_helper_reply'),
                                    (b'', 2, 'hook_repair_failed'),
                                    (b'x'*(health.MAX_REPLY+1), None, 'helper_reply_too_large')):
            with self.subTest(expected=expected):
                process = await self.fake_process(raw, code)
                with patch.object(health.asyncio, 'create_subprocess_exec', new=AsyncMock(return_value=process)):
                    answer = await health._run_helper(self.engine/'mcp_health.py', self.home, self.environment)
                self.assertEqual(answer['error'], expected)
                if code is None:
                    process.kill.assert_called_once()
        value = {'schema_version': 1, 'kind': health.HELPER_KIND, 'state': 'failed', 'changed': True,
                 'error': '/private/path/MUST_NOT_REPORT'}
        self.assertEqual(health._sanitize_reply(value), {'state': 'failed', 'changed': True})

    async def test_helper_timeout_and_cancellation_stop_only_the_helper(self):
        self.install()
        process = await self.fake_process(hang=True, code=None)
        with patch.object(health.asyncio, 'create_subprocess_exec', new=AsyncMock(return_value=process)), \
                patch.object(health, 'REPAIR_SECONDS', .01):
            answer = await health._run_helper(self.engine/'mcp_health.py', self.home, self.environment)
        self.assertEqual(answer['error'], 'hook_repair_timeout')
        self.assertEqual(answer['outcome'], 'unconfirmed')
        process.kill.assert_called_once()
        process = await self.fake_process(hang=True, code=None)
        with patch.object(health.asyncio, 'create_subprocess_exec', new=AsyncMock(return_value=process)):
            task = asyncio.create_task(health._run_helper(self.engine/'mcp_health.py', self.home, self.environment))
            await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        process.kill.assert_called_once()


if __name__ == '__main__':
    unittest.main()
