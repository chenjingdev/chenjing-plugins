"""Installer/control tests use private fixtures, fake dependencies and fake hosts."""
import asyncio
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch
import setup
from test_runtime_paths import fake_app


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve()
        self.root = setup.support_root(self.home)
        self.root.mkdir(parents=True, mode=0o700)
        self.plugin = self.make_plugin('source', '0.4.0')

    def tearDown(self):
        self.temp.cleanup()

    def make_plugin(self, directory, version):
        path = self.home/directory
        (path/'.claude-plugin').mkdir(parents=True)
        (path/'.claude-plugin/plugin.json').write_text(json.dumps({'name': 'cua', 'version': version}))
        for name in ('runtime_paths.py', 'start-mcp.sh'):
            (path/name).write_text('fixture')
        (path/'setup.py').write_text(Path(setup.__file__).read_text())
        return path

    def bind(self):
        setup.write_private(self.root/'source.json', json.dumps({'schema_version': 1,
            'plugin_id': setup.PLUGIN_ID, 'source_root': str(self.plugin)}))

    def registry(self, records):
        path = self.home/'.claude/plugins/installed_plugins.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'version': 2, 'plugins': records}))

    def test_exact_public_registration_follows_cache_updates(self):
        self.bind()
        first = self.make_plugin('cache/0.4.0', '0.4.0')
        second = self.make_plugin('cache/0.4.1', '0.4.1')
        for path, version in ((first, '0.4.0'), (second, '0.4.1')):
            self.registry({setup.PLUGIN_ID: [{'scope': 'user', 'installPath': str(path), 'version': version}],
                           'cua@unrelated': [{'scope': 'user', 'installPath': '/bad'}]})
            self.assertEqual(setup.resolve_plugin_root(self.home), path)

    def test_invalid_public_registration_never_uses_source_fallback(self):
        self.bind()
        for records in ([{'scope': 'user', 'installPath': str(self.plugin), 'version': 'wrong'}],
                        [{'scope': 'project', 'installPath': str(self.plugin)}],
                        [{'scope': 'user', 'installPath': str(self.plugin)}]*2):
            self.registry({setup.PLUGIN_ID: records})
            with self.assertRaises(RuntimeError):
                setup.resolve_plugin_root(self.home)

    def test_fallback_binding_is_private_and_symlink_is_rejected(self):
        self.bind()
        self.assertEqual(setup.resolve_plugin_root(self.home), self.plugin)
        binding = self.root/'source.json'
        binding.chmod(0o644)
        with self.assertRaises(RuntimeError):
            setup.resolve_plugin_root(self.home)
        binding.chmod(0o600)
        original = self.root/'original.json'
        binding.rename(original)
        binding.symlink_to(original)
        with self.assertRaises(RuntimeError):
            setup.resolve_plugin_root(self.home)

    def test_install_preserves_unrelated_command_and_writes_owned_dispatcher(self):
        target = self.home/'.local/bin/codex-cua'
        target.parent.mkdir(parents=True)
        target.write_text('unrelated')
        with patch.object(setup, 'ensure_dependencies', side_effect=AssertionError('No bootstrap')):
            with self.assertRaises(RuntimeError):
                setup.install_command(self.plugin, self.home)
        self.assertEqual(target.read_text(), 'unrelated')
        target.unlink()
        with patch.object(setup, 'ensure_dependencies', return_value=self.root/'venv/bin/python3'):
            self.assertEqual(setup.install_command(self.plugin, self.home), target)
        self.assertIn('--control "$@"', target.read_text())
        launcher = (self.root/'start-desktop-cli.sh').read_text()
        self.assertIn('--control ensure --exec-wrapper -- "$@"', launcher)
        self.assertNotIn(str(self.plugin), launcher)
        self.assertEqual((self.root/'source.json').stat().st_mode & 0o777, 0o600)

    def test_native_argv_flags_pass_through_without_becoming_setup_options(self):
        arguments = ['--help', '--json', '--timeout', '999', '--probe', '-c', 'fixture=1', 'app-server']
        with patch.object(setup, 'ensure_dependencies', return_value=Path('/fixture/python')), \
             patch.object(setup.os, 'execve') as execute:
            setup.main(['ensure', '--exec-wrapper', '--', *arguments])
        self.assertEqual(execute.call_args.args[1], ['/fixture/python', str(Path(setup.__file__).with_name('desktop_cli_wrapper.py')), *arguments])

    def test_existing_runtime_package_repair_never_recreates_venv_and_has_no_stdout(self):
        python = self.root/'venv/bin/python3'
        python.parent.mkdir(parents=True)
        python.write_text('fixture')
        stdout = io.StringIO()
        with patch.object(setup, 'venv_ready', side_effect=[False, False, True]), \
             patch.object(setup.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)) as run, \
             contextlib.redirect_stdout(stdout):
            self.assertEqual(setup.ensure_dependencies(self.home), python)
        self.assertEqual(stdout.getvalue(), '')
        self.assertEqual(run.call_count, 2)
        self.assertIn('websockets==12.0', run.call_args.args[0])
        self.assertIs(run.call_args.kwargs['stdout'], setup.sys.stderr)

    def test_concurrent_dependency_bootstraps_are_serialized(self):
        ready = [False]
        commands = []
        errors = []
        def fake_run(command, **kwargs):
            if '--version' in command:
                return types.SimpleNamespace(returncode=0)
            commands.append(command)
            time.sleep(0.05)
            if 'venv' in command:
                python = self.root/'venv/bin/python3'
                python.parent.mkdir(parents=True)
                python.write_text('fixture')
            else:
                ready[0] = True
            return types.SimpleNamespace(returncode=0)
        def run():
            try:
                setup.ensure_dependencies(self.home)
            except Exception as error:
                errors.append(type(error).__name__)
        with patch.object(setup, 'venv_ready', side_effect=lambda root: ready[0]), \
             patch.object(setup.subprocess, 'run', side_effect=fake_run):
            threads = [threading.Thread(target=run) for _ in range(2)]
            for thread in threads: thread.start()
            for thread in threads: thread.join(timeout=3)
        self.assertFalse(errors)
        self.assertEqual(sum('pip' in command for command in commands), 1)
        self.assertEqual(sum('venv' in command for command in commands), 1)

    def test_partial_owned_venv_repairs_missing_pip_without_recreation(self):
        python = self.root/'venv/bin/python3'
        python.parent.mkdir(parents=True)
        python.write_text('fixture')
        with patch.object(setup, 'venv_ready', side_effect=[False, False, True]), \
             patch.object(setup.subprocess, 'run', side_effect=[types.SimpleNamespace(returncode=1),
                        types.SimpleNamespace(returncode=0), types.SimpleNamespace(returncode=0)]) as run:
            self.assertEqual(setup.ensure_dependencies(self.home), python)
        commands = [call.args[0] for call in run.call_args_list]
        self.assertEqual(commands[0], [str(python), '-I', '-m', 'pip', '--version'])
        self.assertEqual(commands[1], [str(python), '-I', '-m', 'ensurepip', '--upgrade'])
        self.assertIn('websockets==12.0', commands[2])
        self.assertFalse(any('venv' in command for command in commands))

    def test_ready_host_start_is_noop_and_ordinary_app_start_never_quits(self):
        with patch('mcp_stdio.read_host_registry', return_value={}), \
             patch('runtime_paths.discover_installation', side_effect=AssertionError('No app discovery')), \
             patch.object(setup, 'install_command', side_effect=AssertionError('No installation')):
            self.assertEqual(setup.start_host(self.plugin, {}, self.home), 0)
        app, _, _ = fake_app(self.home/'Applications')
        with patch('mcp_stdio.read_host_registry', side_effect=FileNotFoundError), \
             patch.object(setup, 'app_processes', return_value=[123]), \
             patch.object(setup.subprocess, 'run', side_effect=AssertionError('No app commands')):
            self.assertEqual(setup.start_host(self.plugin, {'CODEX_CUA_APP_PATH': str(app)}, self.home), 1)

    def test_app_process_inventory_matches_exact_executable_including_spaces(self):
        executable = Path('/Applications/Fake Codex.app/Contents/MacOS/ChatGPT')
        output = ' 12 '+str(executable)+'\n 13 '+str(executable)+' suffix\n 14 /unrelated/ChatGPT\n'
        with patch.object(setup.subprocess, 'run', return_value=types.SimpleNamespace(stdout=output)):
            self.assertEqual(setup.app_processes(executable), [12])

    def test_offline_doctor_is_content_free_and_never_bootstraps(self):
        app, _, _ = fake_app(self.home/'Applications')
        before = sorted(str(item) for item in self.home.rglob('*'))
        with patch.object(setup, 'venv_ready', return_value=False), \
             patch.object(setup, 'ensure_dependencies', side_effect=AssertionError('No writes')):
            report = setup.doctor(self.plugin, home=self.home, environment={'CODEX_CUA_APP_PATH': str(app)})
        self.assertEqual(report['installation'], 'verified_assets')
        self.assertEqual(report['cua'], 'not_checked')
        self.assertEqual(report['operational_readiness'], 'not_checked')
        self.assertNotIn(str(self.home), json.dumps(report))
        self.assertEqual(before, sorted(str(item) for item in self.home.rglob('*')))

    def test_uninstall_refuses_live_or_uncertain_host_and_preserves_support(self):
        self.bind()
        state = self.home/'state'
        state.mkdir()
        (state/'host.json').write_text(json.dumps({'owner_pid': os.getpid()}))
        with self.assertRaises(RuntimeError):
            setup.uninstall(self.home, {'CODEX_HOST_CUA_STATE_DIR': str(state)})
        self.assertTrue((self.root/'source.json').exists())
        with patch.object(setup.os, 'kill', side_effect=PermissionError), self.assertRaises(RuntimeError):
            setup.uninstall(self.home, {'CODEX_HOST_CUA_STATE_DIR': str(state)})

    def test_requested_probe_without_dependencies_is_failure_and_never_connects(self):
        with patch.object(setup, 'venv_ready', return_value=False), \
             patch('runtime_paths.discover_installation', side_effect=OSError), \
             patch('mcp_stdio.read_host_registry', return_value={'socket_path': '/fake/socket'}), \
             patch.object(setup, 'probe_host', side_effect=AssertionError('No runtime connection')):
            report = setup.doctor(self.plugin, probe=True, home=self.home, environment={})
        self.assertEqual(report['status'], 'dependencies_missing')
        self.assertEqual(report['cua'], 'not_checked')


class ProbeTests(unittest.IsolatedAsyncioTestCase):
    async def check(self, result=None, approval=False, cleanup=True, slow=False):
        class FakeHost:
            def __init__(self, *args, **kwargs):
                self.emit, self.log = kwargs['emit'], kwargs['log']
                self.tool_names = {'js', 'js_reset'}
            async def boot(self):
                if slow: await asyncio.sleep(2)
            async def handle(self, request):
                if approval: self.log('unsupported_owned_thread_interaction')
                self.emit({'id': 'doctor', 'result': result})
            async def close(self):
                return {'owned_thread_unsubscribe': 'confirmed' if cleanup else 'unconfirmed',
                        'connection_close': 'confirmed'}
        with patch('host_mcp.HostMcp', FakeHost):
            return await setup.probe_host({'socket_path': '/fake/socket'}, 0.2 if slow else 5)

    async def test_success_discards_inventory_and_ids(self):
        report = await self.check({'isError': False, 'content': [{'type': 'text', 'text': 'PRIVATE_UI_SENTINEL'}]})
        self.assertEqual(report['status'], 'checked')
        self.assertEqual(report['response_count'], 1)
        self.assertNotIn('PRIVATE_UI_SENTINEL', json.dumps(report))
        self.assertEqual(report['operational_readiness'], 'not_checked')

    async def test_approval_error_marker_empty_and_bad_content_are_not_success(self):
        for result in ({'isError': True}, {'content': None}, {'content': []},
                       {'isError': False, 'content': [{'type': 'text', 'text': 'TypeError: PRIVATE_EXCEPTION'}]}):
            report = await self.check(result)
            self.assertEqual(report['status'], 'failed')
            self.assertNotIn('PRIVATE_EXCEPTION', json.dumps(report))
        self.assertEqual((await self.check({}, approval=True))['status'], 'approval_required')

    async def test_deadline_and_unconfirmed_cleanup_remain_explicit(self):
        self.assertEqual((await self.check(slow=True))['status'], 'timeout')
        result = {'isError': False, 'content': [{'type': 'text', 'text': 'inventory'}]}
        self.assertEqual((await self.check(result, cleanup=False))['status'], 'cleanup_unconfirmed')


if __name__ == '__main__':
    unittest.main()
