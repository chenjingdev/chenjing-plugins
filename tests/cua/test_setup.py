"""Installer/control tests use private fixtures, fake dependencies and fake hosts."""
import asyncio
import contextlib
import fcntl
import io
import json
import os
from pathlib import Path
import shutil
import stat
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

    def test_the_binding_is_what_names_the_engine_folder_and_a_rebinding_follows(self):
        first = self.make_plugin('engine/0.4.0', '0.4.0')
        second = self.make_plugin('engine/0.4.1', '0.4.1')
        for path in (first, second):
            setup.write_private(self.root/'source.json', json.dumps({'schema_version': 1,
                'plugin_id': setup.PLUGIN_ID, 'source_root': str(path)}))
            self.assertEqual(setup.resolve_plugin_root(self.home), path)

    def test_the_plugin_registry_of_claude_code_is_never_read(self):
        self.bind()
        registry = self.home/'.claude/plugins/installed_plugins.json'
        registry.parent.mkdir(parents=True)
        other = self.make_plugin('cache/0.4.1', '0.4.1')
        valid = {'version': 2, 'plugins': {setup.PLUGIN_ID: [
            {'scope': 'user', 'installPath': str(other), 'version': '0.4.1'}]}}
        for label, content in (('a registered plugin', json.dumps(valid)), ('not json at all', '{{{'),
                               ('two user records', json.dumps({'plugins': {setup.PLUGIN_ID: [
                                   {'scope': 'user', 'installPath': str(self.plugin)}]*2}})),
                               ('a record of another version', json.dumps({'plugins': {setup.PLUGIN_ID: [
                                   {'scope': 'user', 'installPath': str(self.plugin), 'version': 'wrong'}]}}))):
            with self.subTest(label):
                registry.write_text(content)
                self.assertEqual(setup.resolve_plugin_root(self.home), self.plugin)
        # Without a binding a registered plugin is no help: the command needs `install-engine` first.
        (self.root/'source.json').unlink()
        registry.write_text(json.dumps(valid))
        with self.assertRaises(OSError):
            setup.resolve_plugin_root(self.home)

    def test_a_binding_that_is_not_ours_or_names_no_engine_is_refused(self):
        for binding in ({'schema_version': 2, 'plugin_id': setup.PLUGIN_ID, 'source_root': str(self.plugin)},
                        {'schema_version': 1, 'plugin_id': 'other@x', 'source_root': str(self.plugin)},
                        {'schema_version': 1, 'plugin_id': setup.PLUGIN_ID, 'source_root': 7},
                        {'schema_version': 1, 'plugin_id': setup.PLUGIN_ID, 'source_root': 'relative/path'},
                        {'schema_version': 1, 'plugin_id': setup.PLUGIN_ID, 'source_root': str(self.home/'gone')},
                        [1]):
            setup.write_private(self.root/'source.json', json.dumps(binding))
            with self.assertRaises((RuntimeError, OSError)):
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
        # A fake app, so that a Codex installed on the machine running the tests is never read.
        app, native, _ = fake_app(self.home/'Applications')
        environment = {'CODEX_CUA_APP_PATH': str(app)}
        target = self.home/'.local/bin/codex-cua'
        target.parent.mkdir(parents=True)
        target.write_text('unrelated')
        with patch.object(setup, 'ensure_dependencies', side_effect=AssertionError('No bootstrap')):
            with self.assertRaises(RuntimeError):
                setup.install_command(self.plugin, self.home, environment)
        self.assertEqual(target.read_text(), 'unrelated')
        target.unlink()
        with patch.object(setup, 'ensure_dependencies', return_value=self.root/'venv/bin/python3'):
            self.assertEqual(setup.install_command(self.plugin, self.home, environment), target)
        self.assertIn('--control "$@"', target.read_text())
        launcher = (self.root/'start-desktop-cli.sh').read_text()
        self.assertIn('--control ensure --exec-wrapper -- "$@"', launcher)
        self.assertIn(setup.FALLBACK_ENV+'='+str(native), launcher)
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

    def test_readiness_check_without_repair_never_waits_creates_or_installs(self):
        # Another process is repairing the environment right now, so the setup lock is held.
        lock = open(self.root/'.setup.lock', 'a+')
        self.addCleanup(lock.close)
        os.chmod(self.root/'.setup.lock', 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        with patch.object(setup, 'venv_ready', return_value=False), \
             patch.object(setup.subprocess, 'run', side_effect=AssertionError('No installation')), \
             patch.object(setup.time, 'sleep', side_effect=AssertionError('No waiting')):
            with self.assertRaises(RuntimeError):
                setup.ensure_dependencies(self.home, repair=False)
        self.assertFalse((self.root/'venv').exists())
        with patch.object(setup, 'venv_ready', return_value=True):
            self.assertEqual(setup.ensure_dependencies(self.home, repair=False), self.root/'venv/bin/python3')

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

    def no_app(self):
        # Without an app of its own the launcher text is written without looking at the machine's real /Applications.
        return {'CODEX_CUA_APP_PATH': str(self.home/'no-such.app')}

    def with_relay_files(self):
        shutil.copytree(Path(setup.__file__).parent/'relay', self.plugin/'relay')

    def test_setup_copies_the_relay_files_to_the_support_directory(self):
        self.with_relay_files()
        with patch.object(setup, 'ensure_dependencies', return_value=self.root/'venv/bin/python3'):
            setup.install_command(self.plugin, self.home, self.no_app())
        directory = self.root/'relay'
        for name in ('relay.mjs', 'node-repl-relay'):
            self.assertEqual((directory/name).read_bytes(), (Path(setup.__file__).parent/'relay'/name).read_bytes())
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((directory/'node-repl-relay').stat().st_mode), 0o700)
        self.assertEqual(setup.relay_status(self.home), 'ready')
        # A second setup after a plugin update replaces what changed and nothing else.
        (directory/'relay.mjs').write_text('stale')
        with patch.object(setup, 'ensure_dependencies', return_value=self.root/'venv/bin/python3'):
            setup.install_command(self.plugin, self.home, self.no_app())
        self.assertEqual((directory/'relay.mjs').read_bytes(), (Path(setup.__file__).parent/'relay/relay.mjs').read_bytes())

    def test_a_plugin_without_relay_files_still_sets_up_and_doctor_says_so(self):
        with patch.object(setup, 'ensure_dependencies', return_value=self.root/'venv/bin/python3'):
            setup.install_command(self.plugin, self.home, self.no_app())
        self.assertTrue((self.home/'.local/bin/codex-cua').is_file())
        self.assertFalse((self.root/'relay').exists())
        self.assertEqual(setup.relay_status(self.home), 'missing')

    def test_setup_says_whether_the_relay_files_are_in_place(self):
        output = io.StringIO()
        with patch.object(setup, 'install_command', return_value=Path('/fixture/codex-cua')), \
             patch.object(setup, 'install_login_environment', return_value='ready'), \
             patch.object(setup, 'relay_status', return_value='ready'), contextlib.redirect_stdout(output):
            self.assertEqual(setup.main(['setup']), 0)
        self.assertIn('Relay files: ready', output.getvalue().splitlines())

    def test_doctor_reports_the_relay_files(self):
        app, _, _ = fake_app(self.home/'Applications')
        environment = {'CODEX_CUA_APP_PATH': str(app)}
        report = lambda: setup.doctor(self.plugin, home=self.home, environment=environment)['relay']
        self.assertEqual(report(), 'missing')
        self.with_relay_files()
        self.assertTrue(setup.install_relay(self.plugin, self.home))
        self.assertEqual(report(), 'ready')
        (self.root/'relay/relay.mjs').write_text('cut off')
        self.assertEqual(report(), 'invalid')
        (self.root/'relay/relay.mjs').unlink()
        self.assertEqual(report(), 'missing')
        with patch('relay_install.relay_files_status', side_effect=RuntimeError):
            self.assertEqual(report(), 'invalid')

    def test_uninstall_removes_the_relay_directory_and_still_finishes_when_that_fails(self):
        for failing in (False, True):
            self.root.mkdir(parents=True, mode=0o700, exist_ok=True)
            self.bind()
            self.with_relay_files() if not (self.plugin/'relay').exists() else None
            self.assertTrue(setup.install_relay(self.plugin, self.home))
            state = self.home/'state'
            state.mkdir(exist_ok=True)
            seen = []
            real = shutil.rmtree
            def remove(path, *args, **kwargs):
                seen.append(((self.root/'relay').exists(), Path(path)))
                return real(path, *args, **kwargs)
            patches = [patch.object(setup, 'remove_login_environment'), patch.object(setup.shutil, 'rmtree', side_effect=remove)]
            if failing:
                patches.append(patch('relay_install.remove_relay_files', side_effect=OSError('PRIVATE')))
            with contextlib.ExitStack() as stack:
                for item in patches:
                    stack.enter_context(item)
                self.assertEqual(setup.uninstall(self.home, {'CODEX_HOST_CUA_STATE_DIR': str(state)}), 0)
            self.assertFalse(self.root.exists())
            # The relay directory goes on its own first; if that fails, the support directory takes it along anyway.
            self.assertEqual([path for _, path in seen], [self.root] if failing else [self.root/'relay', self.root])

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

    @staticmethod
    def slow_to_leave(seconds, hang_in_call=False):
        """A host connection whose thread takes `seconds` to leave (and, with `hang_in_call`, whose call never ends)."""
        class SlowToLeave:
            def __init__(self, *args, **kwargs):
                self.emit, self.log = kwargs['emit'], kwargs['log']
                self.tool_names = {'js', 'js_reset'}
            async def boot(self):
                pass
            async def handle(self, request):
                if hang_in_call: await asyncio.sleep(60)
                self.emit({'id': 'doctor', 'result': {'isError': False, 'content': [{'type': 'text', 'text': 'inventory'}]}})
            async def close(self):
                await asyncio.sleep(seconds)
                return {'owned_thread_unsubscribe': 'confirmed', 'connection_close': 'confirmed'}
        return SlowToLeave

    async def leave(self, seconds, cut, **options):
        began = time.monotonic()
        with patch('host_mcp.HostMcp', self.slow_to_leave(seconds, **options)):
            report = await setup.probe_host({'socket_path': '/fake/socket'}, 30, cut=cut)
        return report, time.monotonic()-began

    async def test_a_test_that_is_cut_gives_the_host_one_second_to_take_the_thread_back(self):
        # The app kills a test it gave up on two seconds after it asked it to end; the rest of --timeout is not for the cleanup.
        cut = setup.Cut()
        cut.set()
        report, seconds = await self.leave(1.6, cut)
        self.assertTrue(0.9 < seconds < 1.5, seconds)
        self.assertEqual(report['cleanup'], {'connection_close': 'unconfirmed', 'owned_thread_unsubscribe': 'unconfirmed'})
        self.assertEqual(report['status'], 'cleanup_unconfirmed')

    async def test_a_test_nobody_cut_leaves_the_host_the_rest_of_its_time(self):
        report, seconds = await self.leave(1.6, setup.Cut())
        self.assertTrue(1.5 < seconds < 2.5, seconds)
        self.assertEqual(report['status'], 'checked')
        self.assertEqual(report['cleanup'], {'connection_close': 'confirmed', 'owned_thread_unsubscribe': 'confirmed'})

    async def test_a_test_that_is_cancelled_is_cut_and_leaves_in_a_second(self):
        cut = setup.Cut()
        with patch('host_mcp.HostMcp', self.slow_to_leave(60, hang_in_call=True)):
            task = asyncio.ensure_future(setup.probe_host({'socket_path': '/fake/socket'}, 30, cut=cut))
            await asyncio.sleep(0.2)                    # the call is on its way
            began = time.monotonic()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertTrue(cut.is_set())
        self.assertLess(time.monotonic()-began, 2.0)


if __name__ == '__main__':
    unittest.main()
