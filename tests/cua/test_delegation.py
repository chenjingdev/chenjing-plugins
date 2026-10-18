"""The stable command runs the registered plugin's setup.py; fakes only, in a temporary HOME."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import setup
from test_runtime_paths import fake_app

REAL_SETUP = Path(setup.__file__).read_text()
# What a newer plugin version's setup.py would be: here, it only reports that it ran.
REPORTING_SETUP = "import json, sys\nprint(json.dumps({'file': __file__, 'argv': sys.argv[1:]}))\n"
FAKE_NATIVE = '#!/bin/sh\nprintf \'native\'; printf \'|%s\' "$@"; printf \'\\n\'\nexit 7\n'


class DelegationBase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)

    def make_plugin(self, name, source, version='0.9.0'):
        path = self.home/'cache'/name
        (path/'.claude-plugin').mkdir(parents=True)
        (path/'.claude-plugin/plugin.json').write_text(json.dumps({'name': 'cua', 'version': version}))
        for filename in ('runtime_paths.py', 'start-mcp.sh'):
            (path/filename).write_text('fixture')
        (path/'setup.py').write_text(source)
        return path

    def register(self, path, version='0.9.0'):
        registry = self.home/'.claude/plugins/installed_plugins.json'
        registry.parent.mkdir(parents=True, exist_ok=True)
        registry.write_text(json.dumps({'version': 2, 'plugins': {setup.PLUGIN_ID: [
            {'scope': 'user', 'installPath': str(path), 'version': version}]}}))


class HandOverTests(DelegationBase):
    def run_main(self, arguments, **environment):
        """Run main() in this process with HOME redirected and exec replaced; return the exec call."""
        with patch.dict(os.environ, {'HOME': str(self.home), **environment}), \
             patch.object(setup.os, 'execve', side_effect=SystemExit(0)) as execute:
            with self.assertRaises(SystemExit):
                setup.main(arguments)
        return execute

    def test_a_stale_copy_runs_the_registered_setup_with_the_original_arguments(self):
        registered = self.make_plugin('0.9.0', 'fixture')
        self.register(registered)
        execute = self.run_main(['--control', 'doctor', '--probe', '--json'])
        interpreter, argv, environment = execute.call_args.args
        self.assertEqual(interpreter, sys.executable)
        self.assertEqual(argv, [sys.executable, str(registered/'setup.py'),
                                '--control', '--root-resolved', 'doctor', '--probe', '--json'])
        self.assertEqual(environment['PYTHONDONTWRITEBYTECODE'], '1')
        self.assertEqual(environment['HOME'], str(self.home))
        for key, value in os.environ.items():
            if key not in ('HOME', 'PYTHONDONTWRITEBYTECODE'):
                self.assertEqual(environment[key], value)

    def test_commands_this_copy_does_not_know_are_handed_over_before_argument_parsing(self):
        registered = self.make_plugin('0.9.0', 'fixture')
        self.register(registered)
        execute = self.run_main(['--control', 'status', '--json'])
        self.assertEqual(execute.call_args.args[1][1:], [str(registered/'setup.py'),
                                                         '--control', '--root-resolved', 'status', '--json'])

    def test_arguments_for_the_original_cli_are_forwarded_untouched(self):
        registered = self.make_plugin('0.9.0', 'fixture')
        self.register(registered)
        forwarded = ['app-server', '--control', '--root-resolved', '-c', 'features.x=true', '']
        execute = self.run_main(['--control', 'ensure', '--exec-wrapper', '--', *forwarded])
        self.assertEqual(execute.call_args.args[1][2:], ['--control', '--root-resolved', 'ensure',
                                                         '--exec-wrapper', '--', *forwarded])

    def test_the_registered_file_itself_runs_here_without_another_exec(self):
        repository_plugin = Path(setup.__file__).resolve().parent
        version = json.loads((repository_plugin/'.claude-plugin/plugin.json').read_text())['version']
        self.register(repository_plugin, version)
        output = io.StringIO()
        with patch.dict(os.environ, {'HOME': str(self.home)}), \
             patch.object(setup.os, 'execve', side_effect=AssertionError('No hand-over to itself')), \
             patch.object(setup, 'doctor', return_value={'status': 'checked'}) as doctor, \
             contextlib.redirect_stdout(output):
            self.assertEqual(setup.main(['--control', 'doctor', '--json']), 0)
        self.assertEqual(doctor.call_args.args[0], repository_plugin)
        self.assertEqual(json.loads(output.getvalue()), {'status': 'checked'})

    def test_a_handed_over_run_never_resolves_or_hands_over_again(self):
        output = io.StringIO()
        with patch.object(setup, 'resolve_plugin_root', side_effect=AssertionError('Root is already settled')), \
             patch.object(setup.os, 'execve', side_effect=AssertionError('No second hand-over')), \
             patch.object(setup, 'doctor', return_value={'status': 'checked'}) as doctor, \
             contextlib.redirect_stdout(output):
            self.assertEqual(setup.main(['--control', '--root-resolved', 'doctor', '--json']), 0)
        self.assertEqual(doctor.call_args.args[0], Path(setup.__file__).resolve().parent)

    def test_runs_without_control_never_use_the_registry(self):
        with patch.object(setup, 'resolve_plugin_root', side_effect=AssertionError('No registry')), \
             patch.object(setup.os, 'execve', side_effect=AssertionError('No hand-over')), \
             patch.object(setup, 'doctor', return_value={'status': 'checked'}), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(setup.main(['doctor', '--json']), 0)

    def test_failed_hand_over_starts_the_original_cli_for_the_launcher_and_fails_otherwise(self):
        native = self.home/'codex'
        native.write_text(FAKE_NATIVE)
        native.chmod(0o700)
        arguments = ['--control', 'ensure', '--exec-wrapper', '--', 'app-server', '-c', 'x=1']
        expected = (str(native), [str(native), 'app-server', '-c', 'x=1'])
        # Nothing registered at all.
        execute = self.run_main(arguments, **{setup.FALLBACK_ENV: str(native)})
        self.assertEqual(execute.call_args.args[:2], expected)
        # A damaged update is never executed.
        broken = self.make_plugin('broken', 'def (:\n')
        self.register(broken)
        execute = self.run_main(arguments, **{setup.FALLBACK_ENV: str(native)})
        self.assertEqual(execute.call_count, 1)
        self.assertEqual(execute.call_args.args[:2], expected)
        # An exec that fails falls back too, after the failed attempt.
        self.register(self.make_plugin('fine', 'fixture'))
        with patch.dict(os.environ, {'HOME': str(self.home), setup.FALLBACK_ENV: str(native)}), \
             patch.object(setup.os, 'execve', side_effect=[OSError('PRIVATE'), SystemExit(0)]) as execute:
            with self.assertRaises(SystemExit):
                setup.main(arguments)
        self.assertEqual([call.args[0] for call in execute.call_args_list], [sys.executable, str(native)])
        # Other commands report the failure; only the launcher path may start the original CLI.
        for command in (['--control', 'doctor'], ['--control', 'status', '--json']):
            self.register(broken)
            with patch.dict(os.environ, {'HOME': str(self.home), setup.FALLBACK_ENV: str(native)}), \
                 patch.object(setup.os, 'execve', side_effect=AssertionError('No exec')):
                with self.assertRaises(SyntaxError):
                    setup.main(command)


class RealProcessTests(DelegationBase):
    def setUp(self):
        super().setUp()
        self.support = setup.support_root(self.home)
        self.support.mkdir(parents=True, mode=0o700)
        self.command = self.support/'command.py'
        self.command.write_text(REAL_SETUP)
        self.environment = {'HOME': str(self.home), 'PATH': '/usr/bin:/bin'}

    def run_command(self, *arguments):
        result = subprocess.run([sys.executable, str(self.command), *arguments], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, timeout=30, env=self.environment)
        return result

    def test_stale_command_runs_a_newer_registered_setup(self):
        registered = self.make_plugin('0.9.0', REPORTING_SETUP)
        self.register(registered)
        result = self.run_command('--control', 'status', '--json')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            'file': str(registered/'setup.py'),
            'argv': ['--control', '--root-resolved', 'status', '--json']})

    def test_command_follows_a_plugin_update_without_running_setup_again(self):
        first = self.make_plugin('0.9.0', REPORTING_SETUP)
        second = self.make_plugin('0.9.1', REPORTING_SETUP, '0.9.1')
        for path, version in ((first, '0.9.0'), (second, '0.9.1')):
            self.register(path, version)
            self.assertEqual(json.loads(self.run_command('--control', 'status').stdout)['file'],
                             str(path/'setup.py'))

    def install_launcher(self):
        """Run `codex-cua setup` for a fake app with a fake original CLI; return the plugin and launcher."""
        app, native, _ = fake_app(self.home/'Applications')
        native.write_text(FAKE_NATIVE)
        native.chmod(0o700)
        plugin = self.make_plugin('installed', REAL_SETUP, '0.8.0')
        with patch.object(setup, 'ensure_dependencies', return_value=Path(sys.executable)):
            setup.install_command(plugin, self.home, {'CODEX_CUA_APP_PATH': str(app)})
        return plugin, self.support/'start-desktop-cli.sh'

    def run_launcher(self, launcher, *arguments):
        return subprocess.run(['/bin/sh', str(launcher), *arguments], stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, timeout=30, env=self.environment)

    def test_launcher_reaches_a_newer_registered_setup(self):
        plugin, launcher = self.install_launcher()
        newer = self.make_plugin('newer', REPORTING_SETUP, '0.9.0')
        self.register(newer, '0.9.0')
        result = self.run_launcher(launcher, 'app-server', 'two words')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['argv'], ['--control', '--root-resolved', 'ensure',
                                                             '--exec-wrapper', '--', 'app-server', 'two words'])

    def test_launcher_starts_the_original_cli_when_the_registered_plugin_is_gone_or_damaged(self):
        plugin, launcher = self.install_launcher()
        # Updated, but the new version's files are damaged.
        damaged = self.make_plugin('damaged', 'def (:\n', '0.9.0')
        # Removed: only the setup-time source binding is left, and it points nowhere.
        shutil.rmtree(plugin)
        for label, prepare in (('damaged', lambda: self.register(damaged, '0.9.0')),
                               ('removed', lambda: (self.home/'.claude/plugins/installed_plugins.json').unlink())):
            with self.subTest(label):
                prepare()
                result = self.run_launcher(launcher, 'app-server', '-c', 'x=1', 'two words')
                self.assertEqual((result.stdout, result.returncode), ('native|app-server|-c|x=1|two words\n', 7))
                self.assertEqual(result.stderr, '')


if __name__ == '__main__':
    unittest.main()
