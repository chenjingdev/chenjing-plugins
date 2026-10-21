"""install-engine: the engine this command starts from becomes a private copy in engine/<version>, the usual setup
runs from that copy, and the copies no process runs from are removed. Fakes only, in a temporary HOME."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import engine_install
import setup
from engine_support import EngineCase

ENGINE = Path(setup.__file__).resolve().parent
KEYS = ['version', 'root', 'removed', 'setup']
SETUP_KEYS = ['command', 'login_environment', 'relay']


def copy_engine(destination, version):
    """The engine as a bundle (or a folder of another version) holds it, with `version` in its manifest."""
    shutil.copytree(ENGINE, destination, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store'))
    (destination/'.claude-plugin/plugin.json').write_text(json.dumps({'name': 'cua', 'version': version}))
    return destination


class InstallCase(EngineCase):
    def setUp(self):
        super().setUp()
        self.support = setup.support_root(self.home)
        self.engines = self.support/'engine'
        self.bundle = copy_engine(self.root/'CUABar.app/Contents/Resources/engine', '0.8.0')
        self.copy = self.engines/'0.8.0'
        self.machine.add(5, 1, '/bin/x')                    # the process list is never empty
        # Neither the dependencies nor the login session of the machine running the tests are touched.
        patcher = patch.object(setup, 'ensure_dependencies', return_value=self.support/'venv/bin/python3')
        self.dependencies = patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(setup, 'install_login_environment', return_value='ready')
        self.login = patcher.start()
        self.addCleanup(patcher.stop)

    def install(self, root=None, as_json=True, **context):
        ctx = self.context(environment={'CODEX_CUA_APP_PATH': str(self.app)}, **context)
        out, err = io.StringIO(), io.StringIO()
        status = engine_install.run_install_engine(types.SimpleNamespace(json=as_json), root or self.bundle, setup,
                                                   context=ctx, stdout=out, stderr=err)
        return status, out.getvalue(), err.getvalue()

    def installed(self, **kwargs):
        status, out, err = self.install(**kwargs)
        self.assertEqual((status, err), (0, ''))
        return json.loads(out)

    def old_copy(self, version):
        setup.private_directory(self.support)
        setup.private_directory(self.engines)
        folder = self.engines/version
        folder.mkdir(mode=0o700)
        (folder/'mcp_stdio.py').write_text('# an earlier version\n')
        return folder

    def files(self, root):
        return sorted(str(path.relative_to(root)) for path in root.rglob('*') if path.is_file())

    def assert_copy_of_bundle(self):
        self.assertEqual(self.files(self.copy), self.files(self.bundle))
        for name in self.files(self.bundle):
            self.assertEqual((self.copy/name).read_bytes(), (self.bundle/name).read_bytes(), name)
        for path in [self.engines, self.copy, *self.copy.rglob('*')]:
            self.assertEqual(stat.S_IMODE(path.lstat().st_mode) & 0o077, 0, path)


class UnpackTests(InstallCase):
    def test_the_root_it_starts_from_becomes_a_private_copy_named_by_its_manifest_version(self):
        result = self.installed()
        self.assertEqual((result['version'], result['root']), ('0.8.0', str(self.copy)))
        self.assert_copy_of_bundle()
        self.assertEqual(stat.S_IMODE((self.copy/'setup.sh').stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.copy/'setup.py').stat().st_mode), 0o600)
        self.assertEqual(os.listdir(self.engines), ['0.8.0'])

    def test_the_usual_setup_runs_from_the_copy(self):
        self.installed()
        self.assertEqual(json.loads((self.support/'source.json').read_text()),
                         {'schema_version': 1, 'plugin_id': setup.PLUGIN_ID, 'source_root': str(self.copy)})
        self.assertEqual(setup.resolve_plugin_root(self.home), self.copy)
        self.assertEqual((self.support/'command.py').read_text(), (self.copy/'setup.py').read_text())
        for name in ('relay.mjs', 'node-repl-relay'):
            self.assertEqual((self.support/'relay'/name).read_bytes(), (self.copy/'relay'/name).read_bytes())
        self.assertIn(setup.MARKER, (self.home/'.local/bin/codex-cua').read_text().splitlines()[:3])
        self.assertEqual(self.login.call_args.args[0], self.home)

    def test_a_newer_root_takes_over_the_binding_and_the_command_copy(self):
        self.installed()
        newer = copy_engine(self.root/'newer/engine', '0.8.1')
        (newer/'setup.py').write_text((newer/'setup.py').read_text()+'# 0.8.1\n')
        # A Claude conversation that was opened before the update still runs from the earlier copy.
        self.machine.add(4300, 500, '%s %s/mcp_stdio.py' % (self.support/'venv/bin/python3', self.copy))
        result = self.installed(root=newer)
        self.assertEqual((result['version'], result['removed']), ('0.8.1', []))
        self.assertEqual(setup.resolve_plugin_root(self.home), self.engines/'0.8.1')
        self.assertTrue((self.support/'command.py').read_text().endswith('# 0.8.1\n'))
        self.assert_copy_of_bundle()                                  # the earlier copy is untouched

    def test_the_copy_is_made_beside_its_place_and_moved_in_with_one_rename(self):
        renames = []
        real = os.rename

        def record(source, destination, *args, **kwargs):
            renames.append((Path(source), Path(destination)))
            return real(source, destination, *args, **kwargs)
        with patch.object(engine_install.os, 'rename', side_effect=record):
            self.installed()
        [(source, destination)] = renames
        self.assertEqual((source.parent, destination), (self.engines, self.copy))
        self.assertNotEqual(source.name, destination.name)

    def test_a_copy_that_fails_halfway_leaves_neither_the_folder_nor_a_temporary_one(self):
        real, calls = shutil.copyfile, []

        def fail_on_the_fourth(source, destination, *args, **kwargs):
            calls.append(source)
            if len(calls) == 4:
                raise OSError(28, 'No space left on device')
            return real(source, destination, *args, **kwargs)
        with patch.object(engine_install.shutil, 'copyfile', side_effect=fail_on_the_fourth):
            status, out, err = self.install()
        self.assertEqual((status, out), (1, ''))
        self.assertEqual(os.listdir(self.engines), [])
        self.assertFalse((self.support/'source.json').exists())

    def test_the_root_may_be_the_copy_itself(self):
        self.installed()
        with patch.object(engine_install.shutil, 'copyfile', side_effect=AssertionError('nothing to copy')):
            result = self.installed(root=self.copy)
        self.assertEqual((result['version'], result['root'], result['removed']), ('0.8.0', str(self.copy), []))
        self.assertEqual(os.listdir(self.engines), ['0.8.0'])


class SameVersionTests(InstallCase):
    def test_a_whole_copy_of_the_same_version_is_used_as_it_is(self):
        self.installed()
        notes = self.copy/'notes.txt'
        notes.write_text('an open conversation may be reading here')
        license_file = self.copy/'LICENSE'
        other = license_file.read_bytes()[:-1]+b'#'                     # the same size, other content
        license_file.write_bytes(other)
        inodes = {path: path.lstat().st_ino for path in (self.copy, license_file, self.copy/'setup.py')}
        with patch.object(engine_install.shutil, 'copyfile', side_effect=AssertionError('nothing is copied')):
            result = self.installed()
        self.assertEqual((result['version'], result['root'], result['removed']), ('0.8.0', str(self.copy), []))
        self.assertEqual(license_file.read_bytes(), other)
        self.assertEqual(notes.read_text(), 'an open conversation may be reading here')
        self.assertEqual({path: path.lstat().st_ino for path in inodes}, inodes)
        self.assertEqual(os.listdir(self.engines), ['0.8.0'])
        self.assertEqual(self.login.call_count, 2)                        # the setup itself runs again

    def test_a_copy_of_the_same_version_that_is_not_whole_is_replaced(self):
        damages = {'a file is gone': lambda: (self.copy/'mcp_stdio.py').unlink(),
                   'a file is cut off': lambda: (self.copy/'host_mcp.py').write_bytes(b'cut'),
                   'a folder is gone': lambda: shutil.rmtree(self.copy/'relay'),
                   'others can read it': lambda: self.copy.chmod(0o755),
                   'others can write a file': lambda: (self.copy/'setup.py').chmod(0o666),
                   'the manifest is another version': lambda: (self.copy/'.claude-plugin/plugin.json').write_text(
                       json.dumps({'name': 'cua', 'version': '0.7.0'}))}
        for label, damage in damages.items():
            with self.subTest(label):
                self.installed()
                damage()
                self.assertEqual(self.installed()['root'], str(self.copy))
                self.assert_copy_of_bundle()
                self.assertEqual(os.listdir(self.engines), ['0.8.0'])

    def test_a_link_in_the_place_of_the_copy_is_replaced_not_followed(self):
        elsewhere = self.root/'elsewhere'
        elsewhere.mkdir()
        (elsewhere/'keep.txt').write_text('keep')
        before = self.files(self.bundle)
        setup.private_directory(self.support)
        setup.private_directory(self.engines)
        for target in (elsewhere, self.bundle):                       # the second one is the root it is started from
            with self.subTest(target=target.name):
                self.copy.symlink_to(target)
                self.installed()
                self.assert_copy_of_bundle()
                self.assertFalse(self.copy.is_symlink())
                self.assertEqual(os.listdir(elsewhere), ['keep.txt'])
                self.assertEqual(self.files(self.bundle), before)
                self.assertEqual(os.listdir(self.engines), ['0.8.0'])
                shutil.rmtree(self.copy)


class OldCopyTests(InstallCase):
    def python(self):
        return str(self.support/'venv/bin/python3')

    def test_copies_no_process_runs_from_are_removed_and_the_others_stay(self):
        for version in ('0.7.0', '0.7.4', '0.7.5', '0.7.6', '0.7.7', '0.9.0'):
            self.old_copy(version)
        self.machine.add(4300, 500, '%s %s/0.7.5/mcp_stdio.py' % (self.python(), self.engines))      # a Claude bridge
        self.machine.add(4301, 1000, '%s %s/0.7.6/desktop_cli_wrapper.py app-server' % (self.python(), self.engines))
        self.machine.add(4302, 500, '/bin/sh %s/0.7.7/start-mcp.sh' % self.engines)                  # about to be a bridge
        # Another folder with a longer name is not the one that is named.
        self.machine.add(4303, 1, '%s %s/0.7.0.1/mcp_stdio.py' % (self.python(), self.engines))
        self.machine.add(4304, 1, '%s %s/0.7.4-beta/mcp_stdio.py' % (self.python(), self.engines))
        result = self.installed()
        self.assertEqual(result['removed'], ['0.7.0', '0.7.4', '0.9.0'])
        self.assertEqual(sorted(os.listdir(self.engines)), ['0.7.5', '0.7.6', '0.7.7', '0.8.0'])

    def test_a_process_of_another_user_keeps_its_copy_too(self):
        self.old_copy('0.7.5')
        self.machine.add(4300, 1, '%s %s/0.7.5/mcp_stdio.py' % (self.python(), self.engines), uid=os.getuid() + 1)
        self.assertEqual(self.installed()['removed'], [])
        self.assertTrue((self.engines/'0.7.5').is_dir())

    def test_the_version_just_installed_is_never_removed_whatever_runs(self):
        self.old_copy('0.7.0')
        self.assertEqual(self.installed()['removed'], ['0.7.0'])
        self.assertEqual(self.installed()['removed'], [])
        self.assertTrue(self.copy.is_dir())
        self.assertEqual(self.files(self.copy), self.files(self.bundle))

    def test_only_real_version_folders_are_touched(self):
        self.old_copy('0.7.0')
        (self.engines/'notes.txt').write_text('mine')
        (self.engines/'latest').mkdir()
        (self.engines/'.install-running').mkdir()                         # the temporary folder of another install
        elsewhere = self.root/'elsewhere'
        elsewhere.mkdir()
        (elsewhere/'keep.txt').write_text('keep')
        (self.engines/'0.6.0').symlink_to(elsewhere)
        (self.engines/'0.6.1').write_text('a file')
        self.assertEqual(self.installed()['removed'], ['0.7.0'])
        self.assertEqual(sorted(os.listdir(self.engines)),
                         ['.install-running', '0.6.0', '0.6.1', '0.8.0', 'latest', 'notes.txt'])
        self.assertEqual(os.listdir(elsewhere), ['keep.txt'])

    def test_nothing_is_removed_while_what_runs_is_not_known(self):
        def unreadable(argv, timeout=None, environment=None):
            raise subprocess.TimeoutExpired(argv, timeout)
        folder = self.old_copy('0.7.0')
        for label, context in (('ps does not answer', {'run': unreadable}), ('ps lists nothing', {})):
            with self.subTest(label):
                if not context:
                    self.machine.procs.clear()
                result = self.installed(**context)
                self.assertEqual(result['removed'], [])
                self.assertTrue(folder.is_dir())
                self.assertEqual(result['setup']['command'], 'ready')


class OutputTests(InstallCase):
    def test_json_is_one_object_on_one_line_with_these_keys(self):
        self.old_copy('0.7.0')
        status, out, err = self.install()
        self.assertEqual((status, err), (0, ''))
        self.assertTrue(out.endswith('\n') and out.count('\n') == 1, out)
        result = json.loads(out)
        self.assertEqual(list(result), KEYS)
        self.assertEqual(list(result['setup']), SETUP_KEYS)
        self.assertEqual(result, {'version': '0.8.0', 'root': str(self.copy), 'removed': ['0.7.0'],
                                  'setup': {'command': 'ready', 'login_environment': 'ready', 'relay': 'ready'}})

    def test_without_json_it_says_in_words_what_was_done(self):
        self.old_copy('0.7.0')
        status, out, err = self.install(as_json=False)
        self.assertEqual((status, err), (0, ''))
        self.assertEqual(out.splitlines(), ['Installed engine 0.8.0: %s' % self.copy,
                                            'Removed older engines: 0.7.0',
                                            'Authored command: ready',
                                            'Ordinary app launch as host: ready',
                                            'Relay files: ready'])

    def test_a_login_session_that_cannot_be_set_up_is_reported_and_is_no_failure(self):
        self.login.return_value = 'conflict'
        self.assertEqual(self.installed()['setup']['login_environment'], 'conflict')
        self.login.side_effect = RuntimeError('PRIVATE')
        result = self.installed()
        self.assertEqual(result['setup']['login_environment'], 'failed')
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_the_relay_files_are_reported_as_the_setup_finds_them(self):
        shutil.rmtree(self.bundle/'relay')
        self.assertEqual(self.installed()['setup']['relay'], 'missing')


class FailureTests(InstallCase):
    def fails(self, **kwargs):
        status, out, err = self.install(**kwargs)
        self.assertNotEqual(status, 0)
        self.assertEqual(out, '')
        self.assertEqual(err.count('\n'), 1, err)
        self.assertTrue(err.endswith('\n'))
        return err

    def test_a_root_that_is_no_engine_fails_before_anything_is_written(self):
        (self.bundle/'.claude-plugin/plugin.json').write_text(json.dumps({'name': 'other', 'version': '0.8.0'}))
        self.fails()
        (self.bundle/'.claude-plugin/plugin.json').write_text(json.dumps({'name': 'cua', 'version': '0.8.0'}))
        (self.bundle/'runtime_paths.py').unlink()
        self.fails()
        self.assertFalse(self.support.exists())

    def test_a_version_that_cannot_name_a_folder_fails_before_anything_is_written(self):
        for version in ('../../x', '', '.hidden', '0.8.0/../..', 'v 1', 7, None):
            with self.subTest(version=version):
                (self.bundle/'.claude-plugin/plugin.json').write_text(json.dumps({'name': 'cua', 'version': version}))
                self.fails()
                self.assertFalse(self.support.exists())

    def test_a_link_in_the_root_is_refused(self):
        (self.bundle/'link.py').symlink_to(ENGINE/'setup.py')
        self.assertIn('link', self.fails())
        self.assertFalse(self.engines.exists() and os.listdir(self.engines))

    def test_what_pip_says_stays_out_of_the_one_line(self):
        def noisy(*args, **kwargs):
            print('WARNING: pip is talking at length', file=sys.stderr)
            raise subprocess.CalledProcessError(1, ['pip', 'install', 'PRIVATE'])
        with patch.object(setup, 'ensure_dependencies', side_effect=noisy):
            err = self.fails()
        self.assertNotIn('pip is talking', err)
        self.assertNotIn('PRIVATE', err)
        self.assertIn('CalledProcessError', err)

    def test_the_reason_of_a_refusal_is_the_one_line(self):
        command = self.home/'.local/bin/codex-cua'
        command.parent.mkdir(parents=True)
        command.write_text('unrelated')
        self.assertIn('An unrelated codex-cua command already exists', self.fails())
        self.assertEqual(command.read_text(), 'unrelated')


class CommandLineTests(InstallCase):
    def run_main(self, *arguments):
        ctx = self.context(environment={'CODEX_CUA_APP_PATH': str(self.app)})
        out = io.StringIO()
        with patch.object(engine_install, 'Context', side_effect=lambda *args, **kwargs: ctx), \
             contextlib.redirect_stdout(out):
            status = setup.main(list(arguments))
        return status, out.getvalue()

    def test_install_engine_is_a_command_that_unpacks_the_folder_setup_py_runs_from(self):
        status, out = self.run_main('install-engine', '--json')
        manifest = json.loads((ENGINE/'.claude-plugin/plugin.json').read_text())
        self.assertEqual(status, 0)
        result = json.loads(out)
        self.assertEqual((result['version'], result['root']), (manifest['version'],
                                                               str(self.engines/manifest['version'])))
        self.assertEqual(setup.resolve_plugin_root(self.home), self.engines/manifest['version'])

    def test_it_takes_no_other_option_and_no_argument(self):
        for arguments in (('install-engine', '--connection', 'a'), ('install-engine', '--force'),
                          ('install-engine', '--group', 'all'), ('install-engine', 'extra'),
                          ('install-engine', '--', 'extra')):
            with self.subTest(arguments), contextlib.redirect_stderr(io.StringIO()), \
                 patch.object(engine_install, 'run_install_engine', side_effect=AssertionError('not run')):
                with self.assertRaises(SystemExit) as caught:
                    setup.main(list(arguments))
                self.assertEqual(caught.exception.code, 2)

    def test_the_command_is_in_the_help_and_is_no_engine_json_command(self):
        text = io.StringIO()
        with contextlib.redirect_stdout(text), self.assertRaises(SystemExit):
            setup.main(['--help'])
        self.assertIn('install-engine', text.getvalue())
        self.assertNotIn('install-engine', setup.ENGINE_COMMANDS)


class ScriptTests(unittest.TestCase):
    """setup.sh and start-mcp.sh hand setup.py its folder as the real one, however they were reached."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(os.path.realpath(self.temp.name))
        self.real = self.root/'engine/0.8.0'
        self.real.mkdir(parents=True)
        for name in ('setup.sh', 'start-mcp.sh'):
            shutil.copy(ENGINE/name, self.real/name)
        (self.real/'setup.py').write_text('import sys\nprint(__file__)\nprint(sys.argv[1:])\n')

    def run_script(self, path, *arguments, cwd=None):
        result = subprocess.run(['/bin/sh', str(path), *arguments], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, timeout=30, cwd=str(cwd or self.root),
                                env={'HOME': str(self.root), 'PATH': '/usr/bin:/bin'})
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.splitlines()

    def test_both_scripts_use_the_real_folder_when_reached_through_a_link(self):
        (self.root/'current').symlink_to(self.real)
        (self.root/'chain').symlink_to(self.root/'current')
        for name in ('setup.sh', 'start-mcp.sh'):
            for label, path in (('the folder is a link', self.root/'current'/name),
                                ('a link to a link', self.root/'chain'/name)):
                with self.subTest(name=name, case=label):
                    first, second = self.run_script(path, 'one')
                    self.assertEqual(first, str(self.real/'setup.py'))
                    self.assertIn("'one'", second)

    def test_both_scripts_use_the_real_folder_when_the_script_itself_is_a_link(self):
        for name in ('setup.sh', 'start-mcp.sh'):
            with self.subTest(name=name):
                alias = self.root/('alias-'+name)
                alias.symlink_to(self.real/name)
                relative = self.root/('relative-'+name)
                relative.symlink_to(Path('engine/0.8.0')/name)
                for path in (alias, relative):
                    self.assertEqual(self.run_script(path)[0], str(self.real/'setup.py'))

    def test_a_plain_call_from_inside_the_folder_still_works(self):
        for name in ('setup.sh', 'start-mcp.sh'):
            with self.subTest(name=name):
                self.assertEqual(self.run_script(name, cwd=self.real)[0], str(self.real/'setup.py'))
                self.assertEqual(self.run_script('./'+name, cwd=self.real)[0], str(self.real/'setup.py'))


if __name__ == '__main__':
    unittest.main()
