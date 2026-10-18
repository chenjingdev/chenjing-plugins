"""Autostart and login-environment tests use fake apps and fake launchd; no GUI opens."""
import json
import os
from pathlib import Path
import plistlib
import tempfile
import threading
import types
import unittest
from unittest.mock import patch
import host_autostart
import setup
from test_runtime_paths import fake_app


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class AutostartTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve()
        self.state = self.home/'state'
        self.app, self.native, _ = fake_app(self.home/'Applications')
        self.environment = {'CODEX_CUA_APP_PATH': str(self.app)}
        self.clock = Clock()
        self.commands = []

    def tearDown(self):
        self.temp.cleanup()

    def run_host(self, registry, front=('com.cmuxterm.app',), processes=()):
        fronts = list(front)
        def run(command, **kwargs):
            self.commands.append(command)
            return types.SimpleNamespace(returncode=0, stdout='')
        def current_front():
            return fronts.pop(0) if len(fronts) > 1 else fronts[0]
        with patch.object(host_autostart.subprocess, 'run', side_effect=run), \
             patch.object(host_autostart, 'app_processes', return_value=list(processes)), \
             patch.object(host_autostart, 'front_bundle', side_effect=current_front):
            return host_autostart.ensure_host(self.state, registry, self.environment, self.home,
                                              sleep=self.clock.sleep, clock=self.clock)

    def opened(self):
        return [command for command in self.commands if command[:2] == ['/usr/bin/open', '-g']]

    def test_ready_host_is_returned_without_opening_anything(self):
        self.assertEqual(self.run_host(lambda state: {'socket_path': '/ready'}), {'socket_path': '/ready'})
        self.assertEqual(self.commands, [])
        self.assertFalse(self.state.exists())

    def test_closed_app_opens_hidden_with_launcher_env_and_focus_returns(self):
        calls = []
        def registry(state):
            calls.append(state)
            if len(calls) < 4:
                raise FileNotFoundError
            return {'socket_path': '/ready'}
        result = self.run_host(registry, front=('com.cmuxterm.app', 'com.cmuxterm.app', 'com.openai.codex'))
        self.assertEqual(result, {'socket_path': '/ready'})
        [command] = self.opened()
        self.assertEqual(command[:5], ['/usr/bin/open', '-g', '-j', '-a', str(self.app)])
        self.assertIn('CODEX_CLI_PATH='+str(self.home/'.local/share/codex-cua/start-desktop-cli.sh'), command)
        self.assertIn('CODEX_HOST_CUA_STATE_DIR='+str(self.state), command)
        self.assertIn('CODEX_HOST_CUA_NATIVE_CLI='+str(self.native), command)
        self.assertEqual(self.commands[-1], ['/usr/bin/open', '-b', 'com.cmuxterm.app'])
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)

    def test_focus_is_left_alone_when_codex_never_takes_front(self):
        calls = []
        def registry(state):
            calls.append(state)
            if len(calls) < 3:
                raise FileNotFoundError
            return {}
        self.run_host(registry)
        self.assertNotIn(['/usr/bin/open', '-b', 'com.cmuxterm.app'], self.commands)

    def test_running_app_without_host_is_never_quit_or_reopened(self):
        with self.assertRaises(host_autostart.AutostartFailure) as raised:
            self.run_host(lambda state: (_ for _ in ()).throw(FileNotFoundError), processes=(123,))
        self.assertIn('Quit Codex normally', str(raised.exception))
        self.assertEqual(self.commands, [])

    def test_timeout_brings_codex_forward_for_hidden_prompts(self):
        self.environment['CODEX_HOST_CUA_AUTOSTART_TIMEOUT'] = '2'
        with self.assertRaises(host_autostart.AutostartFailure) as raised:
            self.run_host(lambda state: (_ for _ in ()).throw(FileNotFoundError))
        self.assertIn('login or permission', str(raised.exception))
        self.assertEqual(len(self.opened()), 1)
        self.assertEqual(self.commands[-1], ['/usr/bin/open', '-b', 'com.openai.codex'])

    def test_concurrent_sessions_open_the_app_once(self):
        ready = threading.Event()
        opened = []
        def registry(state):
            if not ready.is_set():
                raise FileNotFoundError
            return {'socket_path': '/ready'}
        def run(command, **kwargs):
            if command[:2] == ['/usr/bin/open', '-g']:
                opened.append(command)
                ready.set()
            return types.SimpleNamespace(returncode=0, stdout='')
        results = []
        def session():
            results.append(host_autostart.ensure_host(self.state, registry, self.environment, self.home))
        with patch.object(host_autostart.subprocess, 'run', side_effect=run), \
             patch.object(host_autostart, 'app_processes', return_value=[]), \
             patch.object(host_autostart, 'front_bundle', return_value=None):
            threads = [threading.Thread(target=session) for _ in range(4)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(10)
        self.assertEqual(len(opened), 1)
        self.assertEqual(results, [{'socket_path': '/ready'}]*4)


class LoginEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve()
        self.launchd = {}
        self.environment = {'CODEX_HOST_CUA_STATE_DIR': str(self.home/'state')}

    def tearDown(self):
        self.temp.cleanup()

    def fake_launchctl(self):
        def run(command, **kwargs):
            if command[:2] == ['/bin/launchctl', 'getenv']:
                return types.SimpleNamespace(returncode=0, stdout=self.launchd.get(command[2], '')+'\n')
            if command[:2] == ['/bin/launchctl', 'setenv']:
                self.launchd[command[2]] = command[3]
            elif command[:2] == ['/bin/launchctl', 'unsetenv']:
                self.launchd.pop(command[2], None)
            else:
                raise AssertionError('Unexpected command')
            return types.SimpleNamespace(returncode=0, stdout='')
        return patch.object(setup.subprocess, 'run', side_effect=run)

    def test_install_writes_agent_and_sets_launchd_now(self):
        with self.fake_launchctl():
            self.assertEqual(setup.login_environment_status(self.home, self.environment), 'missing')
            self.assertEqual(setup.install_login_environment(self.home, self.environment), 'ready')
            self.assertEqual(setup.login_environment_status(self.home, self.environment), 'ready')
        launcher = str(self.home/'.local/share/codex-cua/start-desktop-cli.sh')
        self.assertEqual(self.launchd, {'CODEX_CLI_PATH': launcher,
                                        'CODEX_HOST_CUA_STATE_DIR': str(self.home/'state')})
        agent = plistlib.loads(setup.login_agent_path(self.home).read_bytes())
        self.assertEqual(agent['Label'], setup.LOGIN_LABEL)
        self.assertTrue(agent['RunAtLoad'])
        self.assertIn('/bin/launchctl setenv CODEX_CLI_PATH '+launcher, agent['ProgramArguments'][2])
        # Updated apps keep working: the native CLI is discovered at launch.
        self.assertNotIn('CODEX_HOST_CUA_NATIVE_CLI', agent['ProgramArguments'][2])

    def test_foreign_launchd_value_is_preserved(self):
        self.launchd['CODEX_CLI_PATH'] = '/somebody/else'
        with self.fake_launchctl():
            self.assertEqual(setup.install_login_environment(self.home, self.environment), 'conflict')
        self.assertFalse(setup.login_agent_path(self.home).exists())
        self.assertEqual(self.launchd, {'CODEX_CLI_PATH': '/somebody/else'})

    def test_remove_clears_only_owned_values(self):
        with self.fake_launchctl():
            setup.install_login_environment(self.home, self.environment)
            self.launchd['CODEX_HOST_CUA_STATE_DIR'] = '/changed/by/user'
            setup.remove_login_environment(self.home, self.environment)
        self.assertFalse(setup.login_agent_path(self.home).exists())
        self.assertEqual(self.launchd, {'CODEX_HOST_CUA_STATE_DIR': '/changed/by/user'})

    def test_unrelated_agent_with_same_path_is_preserved(self):
        path = setup.login_agent_path(self.home)
        path.parent.mkdir(parents=True)
        path.write_bytes(plistlib.dumps({'Label': 'other'}))
        with self.fake_launchctl(), self.assertRaises(RuntimeError):
            setup.remove_login_environment(self.home, self.environment)
        self.assertTrue(path.exists())


class LauncherFallbackTests(unittest.TestCase):
    def test_broken_plugin_install_execs_the_original_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            native = Path(directory)/'codex'
            native.write_text('fixture')
            native.chmod(0o700)
            with patch.dict(os.environ, {setup.FALLBACK_ENV: str(native)}), \
                 patch.object(setup, 'resolve_plugin_root', side_effect=RuntimeError('gone')), \
                 patch.object(setup.os, 'execve', side_effect=SystemExit(0)) as execute:
                with self.assertRaises(SystemExit):
                    setup.main(['--control', 'ensure', '--exec-wrapper', '--', 'app-server', '-x'])
            self.assertEqual(execute.call_args.args[:2], (str(native), [str(native), 'app-server', '-x']))

    def test_without_fallback_the_failure_is_still_reported(self):
        with patch.dict(os.environ, {setup.FALLBACK_ENV: ''}), \
             patch.object(setup, 'resolve_plugin_root', side_effect=RuntimeError('gone')), \
             patch.object(setup.os, 'execve', side_effect=AssertionError('No exec')):
            with self.assertRaises(RuntimeError):
                setup.main(['--control', 'ensure', '--exec-wrapper', '--', 'app-server'])


if __name__ == '__main__':
    unittest.main()
