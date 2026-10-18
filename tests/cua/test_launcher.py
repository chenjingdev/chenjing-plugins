"""The Desktop launch path, script and plugin side, against fake programs; never Codex or a GUI."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import setup
from test_runtime_paths import fake_app

# Both fakes print their argument vector as |-separated fields, plus who started them.
REPORT = '''printf '%s' "$ROLE"; printf '|%s' "$@"; printf '\\nppid=%s\\nfallback=%s\\n' "$PPID" "$CODEX_CUA_FALLBACK_NATIVE"'''
FAKE_NATIVE = '#!/bin/sh\nROLE=native\n' + REPORT + '\nexit 7\n'
FAKE_PYTHON = '#!/bin/sh\nROLE=python\n' + REPORT + '\nexit 5\n'


class LauncherTests(unittest.TestCase):
    def setUp(self):
        # The odd characters check that every path in the script is shell-quoted.
        self.temp = tempfile.TemporaryDirectory(prefix="cua launcher it's ")
        self.home = Path(self.temp.name).resolve()
        self.root = setup.support_root(self.home)
        self.root.mkdir(parents=True, mode=0o700)
        self.app, self.native, _ = fake_app(self.home/'Applications')
        self.native.write_text(FAKE_NATIVE)
        self.native.chmod(0o700)
        self.python = self.root/'venv/bin/python3'
        self.python.parent.mkdir(parents=True)
        self.python.write_text(FAKE_PYTHON)
        self.python.chmod(0o700)
        self.plugin = self.home/'plugin'
        (self.plugin/'.claude-plugin').mkdir(parents=True)
        (self.plugin/'.claude-plugin/plugin.json').write_text(json.dumps({'name': 'cua', 'version': '0.7.0'}))
        for name in ('setup.py', 'runtime_paths.py', 'start-mcp.sh'):
            (self.plugin/name).write_text('fixture')
        self.environment = {'CODEX_CUA_APP_PATH': str(self.app)}

    def tearDown(self):
        self.temp.cleanup()

    def install(self, environment=None):
        with patch.object(setup, 'ensure_dependencies', return_value=self.python):
            setup.install_command(self.plugin, self.home, self.environment if environment is None else environment)
        return self.root/'start-desktop-cli.sh'

    def run_launcher(self, launcher, *arguments, environment=None):
        result = subprocess.run(['/bin/sh', str(launcher), *arguments], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, timeout=10,
                                env={'PATH': '/usr/bin:/bin', **(environment or {})})
        lines = result.stdout.splitlines()
        report = {'returncode': result.returncode, 'stderr': result.stderr}
        if lines:
            role, *fields = lines[0].split('|')
            report.update(role=role, arguments=fields, **dict(line.split('=', 1) for line in lines[1:]))
        return report

    def test_plugin_runtime_runs_when_interpreter_and_command_copy_exist(self):
        launcher = self.install()
        self.assertIn(setup.MARKER, launcher.read_text().splitlines()[:3])
        self.assertEqual(launcher.stat().st_mode & 0o777, 0o700)
        report = self.run_launcher(launcher, 'app-server', 'two words', '')
        self.assertEqual((report['role'], report['returncode']), ('python', 5))
        self.assertEqual(report['arguments'], [str(self.root/'command.py'), '--control', 'ensure',
                                               '--exec-wrapper', '--', 'app-server', 'two words', ''])
        # The plugin side keeps the recorded CLI for its own fallback, and nothing stays between.
        self.assertEqual(report['fallback'], str(self.native))
        self.assertEqual(report['ppid'], str(os.getpid()))

    def test_missing_unusable_or_dangling_interpreter_starts_the_original_cli_instead(self):
        launcher = self.install()
        arguments = ('-c', 'features.x=true', 'app-server', 'two words', '')
        def restore():
            if self.python.is_symlink() or self.python.exists():
                self.python.unlink()
            self.python.write_text(FAKE_PYTHON)
            self.python.chmod(0o700)
        def dangle():
            self.python.unlink()
            self.python.symlink_to(self.root/'venv/gone')
        breakages = {'missing': self.python.unlink, 'not executable': lambda: self.python.chmod(0o600),
                     'dangling symlink': dangle}
        for name, break_interpreter in breakages.items():
            with self.subTest(name):
                restore()
                break_interpreter()
                report = self.run_launcher(launcher, *arguments,
                                           environment={setup.FALLBACK_ENV: '/stale/value'})
                self.assertEqual((report['role'], report['returncode']), ('native', 7))
                self.assertEqual(report['arguments'], list(arguments))
                self.assertEqual(report['fallback'], str(self.native))
                self.assertEqual(report['stderr'], '')
                self.assertEqual(report['ppid'], str(os.getpid()))

    def test_missing_command_copy_starts_the_original_cli_instead(self):
        launcher = self.install()
        (self.root/'command.py').unlink()
        report = self.run_launcher(launcher, 'app-server', '--analytics-default-enabled')
        self.assertEqual((report['role'], report['returncode']), ('native', 7))
        self.assertEqual(report['arguments'], ['app-server', '--analytics-default-enabled'])
        self.assertEqual(report['fallback'], str(self.native))

    def test_without_a_known_original_cli_the_launcher_stays_a_plain_exec(self):
        launcher = self.install({'CODEX_CUA_APP_PATH': str(self.home/'no-such.app')})
        text = launcher.read_text()
        self.assertEqual(text.splitlines()[:2], ['#!/bin/sh', setup.MARKER])
        self.assertEqual(len(text.splitlines()), 3)
        self.assertNotIn(setup.FALLBACK_ENV, text)
        self.assertTrue(text.splitlines()[2].startswith('exec '))
        self.assertTrue(text.endswith('--control ensure --exec-wrapper -- "$@"\n'))
        self.python.unlink()
        report = self.run_launcher(launcher, 'app-server')
        self.assertNotIn('role', report)
        self.assertNotEqual(report['returncode'], 0)


class LaunchPathGuardTests(unittest.TestCase):
    """setup.py ensure --exec-wrapper checks the files Codex starts through before it execs them."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.plugin = self.root/'plugin'
        self.plugin.mkdir()
        for name in ('desktop_cli_wrapper.py', 'unix_ws_stdio.py', 'mcp_stdio.py'):
            (self.plugin/name).write_text('pass\n')
        (self.plugin/'setup.py').write_text(Path(setup.__file__).read_text())
        spec = importlib.util.spec_from_file_location('setup_in_temporary_plugin', self.plugin/'setup.py')
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        # main() puts the plugin directory on sys.path; do not leave a fake one behind.
        self.addCleanup(lambda: [sys.path.remove(entry) for entry in list(sys.path) if entry == str(self.plugin)])
        self.native = self.root/'codex'
        self.native.write_text('#!/bin/sh\n')
        self.native.chmod(0o700)

    def run_main(self, *arguments):
        with patch.dict(os.environ, {setup.FALLBACK_ENV: str(self.native)}), \
             patch.object(self.module, 'ensure_dependencies', return_value=Path('/fixture/python')), \
             patch.object(self.module.os, 'execve', side_effect=SystemExit(0)) as execute:
            with self.assertRaises(SystemExit):
                self.module.main(list(arguments))
        self.assertEqual(execute.call_count, 1)
        return execute.call_args.args[:2]

    def test_intact_files_start_the_wrapper(self):
        self.assertEqual(self.run_main('ensure', '--exec-wrapper', '--', 'app-server'),
                         ('/fixture/python', ['/fixture/python', str(self.plugin/'desktop_cli_wrapper.py'), 'app-server']))

    def test_missing_or_damaged_files_start_the_original_cli_instead(self):
        original = (str(self.native), [str(self.native), 'app-server', '-c', 'x=1'])
        for name in ('desktop_cli_wrapper.py', 'unix_ws_stdio.py'):
            for label, damage in (('missing', lambda path: path.unlink()),
                                  ('truncated', lambda path: path.write_text('def run(:\n'))):
                with self.subTest(name=name, damage=label):
                    damage(self.plugin/name)
                    self.assertEqual(self.run_main('ensure', '--exec-wrapper', '--', 'app-server', '-c', 'x=1'), original)
                    (self.plugin/name).write_text('pass\n')

    def test_the_mcp_entry_point_does_not_depend_on_the_launch_path_files(self):
        (self.plugin/'desktop_cli_wrapper.py').write_text('def run(:\n')
        (self.plugin/'unix_ws_stdio.py').unlink()
        self.assertEqual(self.run_main('ensure', '--exec-mcp', '--'),
                         ('/fixture/python', ['/fixture/python', str(self.plugin/'mcp_stdio.py')]))


if __name__ == '__main__':
    unittest.main()
