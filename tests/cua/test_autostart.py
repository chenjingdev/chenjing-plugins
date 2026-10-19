"""Autostart and login-environment tests use fake apps and fake launchd; no GUI opens."""
import contextlib
import ctypes
import json
import os
from pathlib import Path
import plistlib
import stat
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import call, MagicMock, patch
import host_autostart
import setup
from test_runtime_paths import fake_app

CODEX = 'com.openai.codex'
TERMINAL = 'com.cmuxterm.app'
BROWSER = 'com.google.Chrome'


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        if self.now > 600:
            # A wait that never ends fails here instead of hanging the whole run.
            raise AssertionError('Something keeps waiting far beyond every limit it has.')


class Desktop:
    """The front app and the mouse as the fake seconds go by.

    Apps come forward at set seconds, by themselves or by a person's choice; `open -b` brings one forward at once.
    """
    def __init__(self, clock, front):
        self.clock = clock
        self.front = front
        self.later = []                    # (second, bundle) of the apps that are going to come forward
        self.presses = []                  # the seconds at which a person pressed the mouse
        self.readable = True               # False: macOS will not say when the mouse was pressed

    def comes_forward(self, second, bundle):
        self.later = sorted(self.later+[(second, bundle)])

    def front_bundle(self):
        while self.later and self.later[0][0] <= self.clock.now:
            self.front = self.later.pop(0)[1]
        return self.front

    def seconds_since_press(self):
        if not self.readable:
            return None
        past = [second for second in self.presses if second <= self.clock.now]
        return self.clock.now-max(past) if past else 86400.0


def run_inline(work):
    work()


class AutostartTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve()
        self.state = self.home/'state'
        self.app, self.native, _ = fake_app(self.home/'Applications')
        self.environment = {'CODEX_CUA_APP_PATH': str(self.app)}
        self.clock = Clock()
        self.desktop = Desktop(self.clock, TERMINAL)
        self.commands = []
        self.moments = []                  # the second at which each command ran
        self.opened_at = None
        self.ready_at = None

    def tearDown(self):
        self.temp.cleanup()

    def run_command(self, command, **kwargs):
        self.commands.append(command)
        self.moments.append(self.clock.now)
        if command[:2] == ['/usr/bin/open', '-g']:
            self.opened_at = self.clock.now
        elif command[:2] == ['/usr/bin/open', '-b']:
            self.desktop.front = command[2]
        return types.SimpleNamespace(returncode=0, stdout='')

    @contextlib.contextmanager
    def faked(self, processes=(), front=None):
        """Commands are recorded instead of run; the desktop answers for the front app and for the mouse."""
        with patch.object(host_autostart.subprocess, 'run', side_effect=self.run_command), \
             patch.object(host_autostart, 'app_processes', return_value=list(processes)), \
             patch.object(host_autostart, 'front_bundle', side_effect=front or self.desktop.front_bundle), \
             patch.object(host_autostart, 'seconds_since_mouse_press', side_effect=self.desktop.seconds_since_press):
            yield

    def ensure(self, registry, **options):
        return host_autostart.ensure_host(self.state, registry, self.environment, self.home,
                                          sleep=self.clock.sleep, clock=self.clock, **options)

    def run_host(self, registry, processes=(), start=run_inline):
        """Open the app (if closed) and run the watch that follows inline; start=None leaves it to ensure_host."""
        with self.faked(processes):
            return self.ensure(registry, **({} if start is None else {'start': start}))

    def host_after_open(self, seconds=0):
        """A registry that is there `seconds` after the app was opened."""
        def registry(state):
            if self.opened_at is None or self.clock.now < self.opened_at+seconds:
                raise FileNotFoundError
            self.ready_at = self.clock.now
            return {'socket_path': '/ready'}
        return registry

    def opened(self):
        return [command for command in self.commands if command[:2] == ['/usr/bin/open', '-g']]

    def sent_back(self):
        """The apps brought forward again with `open -b`."""
        return [command[2] for command in self.commands if command[:2] == ['/usr/bin/open', '-b']]

    def sent_back_at(self):
        return [moment for command, moment in zip(self.commands, self.moments)
                if command[:2] == ['/usr/bin/open', '-b']]

    def test_ready_host_is_returned_without_opening_anything(self):
        self.assertEqual(self.run_host(lambda state: {'socket_path': '/ready'}), {'socket_path': '/ready'})
        self.assertEqual(self.commands, [])
        self.assertFalse(self.state.exists())

    def test_closed_app_opens_hidden_with_launcher_env_and_focus_returns(self):
        # As in the real run: Codex comes forward by itself the moment the connection is ready.
        self.desktop.comes_forward(0.1, CODEX)
        result = self.run_host(self.host_after_open())
        self.assertEqual(result, {'socket_path': '/ready'})
        [command] = self.opened()
        self.assertEqual(command[:5], ['/usr/bin/open', '-g', '-j', '-a', str(self.app)])
        self.assertIn('CODEX_CLI_PATH='+str(self.home/'.local/share/codex-cua/start-desktop-cli.sh'), command)
        self.assertIn('CODEX_HOST_CUA_STATE_DIR='+str(self.state), command)
        self.assertIn('CODEX_HOST_CUA_NATIVE_CLI='+str(self.native), command)
        self.assertEqual(self.commands[-1], ['/usr/bin/open', '-b', TERMINAL])
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)

    def test_focus_is_left_alone_when_codex_never_takes_front(self):
        self.run_host(self.host_after_open(seconds=0.4))
        self.assertEqual(self.sent_back(), [])
        # The watch looked for its whole time.
        self.assertGreaterEqual(self.clock.now, host_autostart.WATCH_SECONDS)

    def test_codex_coming_forward_twice_within_thirty_seconds_is_sent_back_twice(self):
        self.desktop.comes_forward(2.0, CODEX)
        self.desktop.comes_forward(12.0, CODEX)
        self.run_host(self.host_after_open())
        self.assertEqual(self.sent_back(), [TERMINAL, TERMINAL])
        for moment, expected in zip(self.sent_back_at(), (2.0, 12.0)):
            self.assertAlmostEqual(moment, expected, delta=host_autostart.WATCH_INTERVAL)
        self.assertEqual(self.desktop.front, TERMINAL)

    def test_a_person_who_moved_on_meanwhile_gets_that_app_back(self):
        self.desktop.comes_forward(3.0, BROWSER)
        self.desktop.comes_forward(8.0, CODEX)
        self.run_host(self.host_after_open())
        self.assertEqual(self.sent_back(), [BROWSER])
        self.assertEqual(self.desktop.front, BROWSER)

    def test_codex_chosen_with_the_mouse_stays_and_the_watch_is_over(self):
        # The person clicks Codex in the Dock, goes back to the terminal; much later Codex comes forward by itself.
        self.desktop.presses = [2.0]
        self.desktop.comes_forward(2.1, CODEX)
        self.desktop.comes_forward(4.0, TERMINAL)
        self.desktop.comes_forward(9.0, CODEX)
        self.run_host(self.host_after_open())
        self.assertEqual(self.sent_back(), [])
        self.assertEqual(self.desktop.front, CODEX)
        self.assertLess(self.clock.now, 5)

    def test_a_mouse_press_longer_ago_than_a_second_is_no_choice(self):
        self.desktop.presses = [1.0]
        self.desktop.comes_forward(2.5, CODEX)
        self.run_host(self.host_after_open())
        self.assertEqual(self.sent_back(), [TERMINAL])

    def test_a_mouse_press_macos_will_not_report_is_no_choice(self):
        self.desktop.readable = False
        self.desktop.comes_forward(2.0, CODEX)
        self.run_host(self.host_after_open())
        self.assertEqual(self.sent_back(), [TERMINAL])

    def test_the_watch_ends_thirty_seconds_after_the_connection_was_ready(self):
        # The host is ready 5 seconds after the app was opened, so the watch lasts until about second 35.
        self.desktop.comes_forward(33.0, CODEX)
        self.desktop.comes_forward(36.5, CODEX)
        self.run_host(self.host_after_open(seconds=5))
        self.assertEqual(self.sent_back(), [TERMINAL])
        self.assertAlmostEqual(self.sent_back_at()[0], 33.0, delta=0.5)
        self.assertAlmostEqual(self.clock.now, self.ready_at+host_autostart.WATCH_SECONDS, delta=0.5)

    def test_ensure_host_only_hands_the_watch_over(self):
        self.desktop.comes_forward(2.0, CODEX)
        handed = []
        result = self.run_host(self.host_after_open(), start=handed.append)
        self.assertEqual(result, {'socket_path': '/ready'})
        [watch] = handed
        self.assertEqual(self.sent_back(), [])
        self.assertEqual(self.clock.now, 0.0)
        with self.faked():
            watch()
        self.assertEqual(self.sent_back(), [TERMINAL])

    def test_ensure_host_returns_while_the_watch_is_still_going(self):
        test_thread = threading.current_thread()
        looking, gate, watchers = threading.Event(), threading.Event(), []

        def front():
            # The watch is a thread of its own; its first look is held until the test lets it go.
            if threading.current_thread() is not test_thread and not looking.is_set():
                watchers.append(threading.current_thread())
                looking.set()
                gate.wait(10)
            return self.desktop.front_bundle()
        with self.faked(front=front):
            try:
                result = self.ensure(self.host_after_open())
                self.assertTrue(looking.wait(10))
                [watcher] = watchers
                self.assertEqual(result, {'socket_path': '/ready'})
                self.assertTrue(watcher.is_alive())
                self.assertTrue(watcher.daemon)
            finally:
                gate.set()
                for watcher in watchers:
                    watcher.join(10)
        self.assertFalse(any(watcher.is_alive() for watcher in watchers))

    def handed_over_when_front_is(self, front):
        self.desktop.front = front
        handed = []
        self.run_host(self.host_after_open(), start=handed.append)
        return handed

    def test_no_watch_starts_without_a_front_app_to_return_to(self):
        self.assertEqual(self.handed_over_when_front_is(None), [])

    def test_no_watch_starts_when_the_front_app_was_codex_itself(self):
        self.assertEqual(self.handed_over_when_front_is(CODEX), [])

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


class FrontAppTests(unittest.TestCase):
    """Which app is in front, from what lsappinfo prints."""

    def front(self, printed):
        answers = ['ASN:0x0-0x1001:\n', printed]

        def run(argv, **options):
            return types.SimpleNamespace(returncode=0, stdout=answers.pop(0))
        with patch.object(host_autostart.subprocess, 'run', side_effect=run):
            return host_autostart.front_bundle()

    def test_the_bundle_id_is_read_from_the_output_of_macos_27_and_of_older_versions(self):
        self.assertEqual(self.front('[ NULL ] ASN:0x0-0x1001: (in front) \n    bundleID="com.cmuxterm.app"\n'
                                    '    bundle path="/Applications/cmux.app" \n    executable path=[ NULL ] \n'),
                         'com.cmuxterm.app')
        self.assertEqual(self.front('"CFBundleIdentifier"="com.apple.Terminal"\n'), 'com.apple.Terminal')

    def test_no_bundle_id_is_none(self):
        for printed in ('', '[ NULL ] ASN:0x0-0x1001: (in front) \n    bundleID=[ NULL ]\n', 'bundle path="x"'):
            self.assertIsNone(self.front(printed))


class MousePressTests(unittest.TestCase):
    """How long ago a person pressed the mouse, as CoreGraphics tells it."""

    def library(self, ages):
        library = MagicMock()
        library.CGEventSourceSecondsSinceLastEventType.side_effect = lambda state, event: ages[event]
        return library

    def test_the_more_recent_of_the_left_and_the_right_press_is_the_answer(self):
        library = self.library({1: 30.0, 3: 0.4})
        with patch.object(host_autostart.ctypes, 'CDLL', return_value=library):
            self.assertEqual(host_autostart.seconds_since_mouse_press(), 0.4)
        reader = library.CGEventSourceSecondsSinceLastEventType
        # The hardware state (1), asked for the left button (1) and for the right one (3).
        self.assertEqual(reader.call_args_list, [call(1, 1), call(1, 3)])
        self.assertIs(reader.restype, ctypes.c_double)
        self.assertEqual(reader.argtypes, [ctypes.c_int32, ctypes.c_uint32])

    def test_what_macos_will_not_say_is_none(self):
        with patch.object(host_autostart.ctypes, 'CDLL', side_effect=OSError('no CoreGraphics')):
            self.assertIsNone(host_autostart.seconds_since_mouse_press())
        with patch.object(host_autostart.ctypes, 'CDLL', return_value=MagicMock(spec=[])):
            self.assertIsNone(host_autostart.seconds_since_mouse_press())

    @unittest.skipUnless(sys.platform == 'darwin', 'CoreGraphics is macOS only')
    def test_this_mac_answers_in_seconds(self):
        seconds = host_autostart.seconds_since_mouse_press()
        self.assertIsInstance(seconds, float)
        self.assertGreaterEqual(seconds, 0)


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
        # A script of its own, so Login Items names it instead of saying `sh`.
        script = self.home/'.local/share/codex-cua/codex-cua-login-env'
        self.assertEqual(agent['ProgramArguments'], [str(script)])
        self.assertEqual(stat.S_IMODE(script.stat().st_mode), 0o700)
        text = script.read_text()
        self.assertTrue(text.startswith('#!/bin/sh\n'+setup.MARKER+'\n'))
        self.assertIn('/bin/launchctl setenv CODEX_CLI_PATH '+launcher+'\n', text)
        # Updated apps keep working: the native CLI is discovered at launch.
        self.assertNotIn('CODEX_HOST_CUA_NATIVE_CLI', text)

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
        self.assertFalse(setup.login_script_path(self.home).exists())
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
