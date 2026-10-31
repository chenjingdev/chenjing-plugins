"""The block in the login shell's startup file (shell_startup.py): where it goes, that only the block is ever written,
what setup and status say about it, that removal takes out the block alone, and that a real zsh and bash started the
way Codex starts them hand over the launcher while a terminal's shell does not."""
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import setup
import shell_startup

BEFORE = b'# mine\nexport EDITOR=vi\n'
AFTER = b'alias ll="ls -l"\n'


class ShellCase(unittest.TestCase):
    """A temporary home whose name needs quoting, with zsh as the login shell unless a test says otherwise."""
    shell = '/bin/zsh'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()/"it's home"
        self.home.mkdir()
        self.environment = {'CODEX_HOST_CUA_STATE_DIR': str(self.home/'state dir')}
        self.login_shell = patch.object(shell_startup, 'login_shell', return_value=self.shell)
        self.login_shell.start()
        self.addCleanup(self.login_shell.stop)

    def use_shell(self, shell):
        self.login_shell.stop()
        self.login_shell = patch.object(shell_startup, 'login_shell', return_value=shell)
        self.login_shell.start()

    def values(self):
        return setup.login_values(self.home, self.environment)

    def block(self):
        return shell_startup.block(self.values())

    def install(self):
        return setup.install_shell_environment(self.home, self.environment)

    def status(self):
        return setup.shell_environment_status(self.home, self.environment)

    def old_block(self):
        return self.block().replace(b'export CODEX_HOST', b'export  CODEX_HOST')


class BlockTests(ShellCase):
    def test_the_block_exports_both_values_quoted_only_for_a_shell_codex_starts(self):
        launcher = str(self.home/'.local/share/codex-cua/start-desktop-cli.sh')
        quoted = launcher.replace("'", "'\"'\"'").encode()
        self.assertEqual(self.block(), b'\n'.join([
            b'# >>> codex-cua (CUA Bar) >>>',
            b'# CUA Bar: Codex reads this when it starts, so it attaches even when macOS reopens Codex at login.',
            b'if [ -n "${CODEX_SHELL-}" ] || [ "${__CFBundleIdentifier-}" = com.openai.codex ]; then',
            b"  if [ -x '" + quoted + b"' ]; then",
            b"    export CODEX_CLI_PATH='" + quoted + b"'",
            b"    export CODEX_HOST_CUA_STATE_DIR='" + str(self.home/'state dir').replace("'", "'\"'\"'").encode() + b"'",
            b'  fi', b'fi',
            b'# <<< codex-cua (CUA Bar) <<<', b'']))

    def test_a_missing_file_is_made_with_the_block_alone(self):
        self.assertEqual(self.status(), ('missing', self.home/'.zshenv'))
        self.assertEqual(self.install(), ('ready', self.home/'.zshenv'))
        self.assertEqual((self.home/'.zshenv').read_bytes(), self.block())
        self.assertEqual(stat.S_IMODE((self.home/'.zshenv').stat().st_mode), 0o644)
        self.assertEqual(self.status(), ('ready', self.home/'.zshenv'))
        self.assertEqual([path.name for path in self.home.iterdir()], ['.zshenv'], 'no temporary file is left')

    def test_the_block_goes_after_what_is_there_on_a_line_of_its_own(self):
        path = self.home/'.zshenv'
        for text, joined in ((BEFORE, BEFORE), (b'export A=1', b'export A=1\n')):
            path.write_bytes(text)
            self.assertEqual(self.install(), ('ready', path))
            self.assertEqual(path.read_bytes(), joined+self.block())

    def test_a_file_that_holds_the_same_block_is_not_written(self):
        path = self.home/'.zshenv'
        path.write_bytes(BEFORE+self.block()+AFTER)
        os.utime(path, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
        before = path.stat()
        self.assertEqual(self.install(), ('ready', path))
        after = path.stat()
        self.assertEqual((after.st_ino, after.st_mtime_ns), (before.st_ino, before.st_mtime_ns))

    def test_an_old_block_is_replaced_where_it_is_and_nothing_else_changes(self):
        path = self.home/'.zshenv'
        path.write_bytes(BEFORE+self.old_block()+AFTER)
        self.assertEqual(self.status(), ('outdated', path))
        self.assertEqual(self.install(), ('ready', path))
        self.assertEqual(path.read_bytes(), BEFORE+self.block()+AFTER)

    def test_several_blocks_become_one_where_the_first_was(self):
        path = self.home/'.zshenv'
        path.write_bytes(BEFORE+self.old_block()+b'middle\n'+self.block()+AFTER)
        self.assertEqual(self.status(), ('outdated', path))
        self.install()
        self.assertEqual(path.read_bytes(), BEFORE+self.block()+b'middle\n'+AFTER)

    def test_a_marker_without_its_pair_is_text_like_any_other(self):
        path = self.home/'.zshenv'
        text = BEFORE+shell_startup.END+b'\n'+AFTER+shell_startup.START+b'\n'
        path.write_bytes(text)
        self.assertEqual(self.status(), ('missing', path))
        self.install()
        self.assertEqual(path.read_bytes(), text+self.block())

    def test_the_mode_of_the_file_is_kept(self):
        path = self.home/'.zshenv'
        path.write_bytes(BEFORE)
        path.chmod(0o600)
        self.install()
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_a_link_stays_and_the_file_it_points_to_gets_the_block(self):
        dotfiles = self.home/'dotfiles'
        dotfiles.mkdir()
        (dotfiles/'zshenv').write_bytes(BEFORE)
        (self.home/'.zshenv').symlink_to('dotfiles/zshenv')
        self.assertEqual(self.install(), ('ready', self.home/'.zshenv'))
        self.assertEqual(os.readlink(self.home/'.zshenv'), 'dotfiles/zshenv')
        self.assertEqual((dotfiles/'zshenv').read_bytes(), BEFORE+self.block())
        self.assertEqual(self.status(), ('ready', self.home/'.zshenv'))
        setup.remove_shell_environment(self.home, self.environment)
        self.assertEqual(os.readlink(self.home/'.zshenv'), 'dotfiles/zshenv')
        self.assertEqual((dotfiles/'zshenv').read_bytes(), BEFORE)

    def test_zsh_reads_the_file_in_zdotdir_when_that_is_an_absolute_path(self):
        (self.home/'zdot').mkdir()
        self.environment['ZDOTDIR'] = str(self.home/'zdot')
        self.assertEqual(self.install(), ('ready', self.home/'zdot/.zshenv'))
        self.assertFalse((self.home/'.zshenv').exists())
        self.environment['ZDOTDIR'] = 'zdot'
        self.assertEqual(self.status(), ('missing', self.home/'.zshenv'))

    def test_bash_gets_the_first_of_its_login_files_that_is_there(self):
        self.use_shell('/bin/bash')
        file = lambda: shell_startup.startup_file(self.home, self.environment)
        self.assertEqual(file(), self.home/'.bash_profile', 'none there: the one bash reads first')
        (self.home/'.profile').write_bytes(BEFORE)
        self.assertEqual(file(), self.home/'.profile')
        (self.home/'.bash_login').write_bytes(BEFORE)
        self.assertEqual(file(), self.home/'.bash_login')
        (self.home/'.bash_profile').symlink_to(self.home/'nowhere')
        self.assertEqual(file(), self.home/'.bash_login', 'a link to nothing is not there for bash either')
        (self.home/'nowhere').write_bytes(b'')
        self.assertEqual(file(), self.home/'.bash_profile')
        self.assertEqual(self.install(), ('ready', self.home/'.bash_profile'))
        self.assertEqual((self.home/'.bash_login').read_bytes(), BEFORE)

    def test_another_login_shell_gets_no_block(self):
        for shell in ('/bin/tcsh', '/opt/homebrew/bin/fish', ''):
            self.use_shell(shell)
            self.assertEqual(self.status(), ('unsupported_shell', None))
            self.assertEqual(self.install(), ('unsupported_shell', None))
        self.assertEqual(list(self.home.iterdir()), [])
        self.assertEqual(setup.shell_line('unsupported_shell', None), 'unsupported_shell')

    def test_a_file_that_cannot_be_written_is_reported_and_fails_nothing(self):
        path = self.home/'.zshenv'
        path.write_bytes(BEFORE)
        path.chmod(0o444)
        self.assertEqual(self.status(), ('unwritable', path))
        with patch.object(setup, 'install_login_environment', return_value='ready'):
            self.assertEqual(setup.install_login(self.home, self.environment), ('failed', ('unwritable', path)))
        self.assertEqual(path.read_bytes(), BEFORE)
        path.unlink()
        path.mkdir()
        self.assertEqual(self.install(), ('unwritable', path))
        locked = self.home/'locked'
        locked.mkdir()
        locked.chmod(0o500)
        self.addCleanup(locked.chmod, 0o700)
        self.environment['ZDOTDIR'] = str(locked)
        self.assertEqual(self.status(), ('unwritable', locked/'.zshenv'))
        self.assertEqual(self.install(), ('unwritable', locked/'.zshenv'))
        with patch.object(shell_startup, 'startup_file', side_effect=RuntimeError):
            self.assertEqual(self.install(), ('unwritable', None))
        self.assertEqual(setup.shell_line('unwritable', locked/'.zshenv'), 'unwritable (%s)' % (locked/'.zshenv'))

    def test_a_login_value_of_somebody_else_leaves_the_file_alone(self):
        with patch.object(setup, 'install_login_environment', return_value='conflict'):
            self.assertEqual(setup.install_login(self.home, self.environment),
                             ('conflict', ('missing', self.home/'.zshenv')))
        self.assertFalse((self.home/'.zshenv').exists())

    def test_removal_takes_out_the_block_alone_from_every_file_it_may_be_in(self):
        (self.home/'.zshenv').write_bytes(BEFORE+self.block()+AFTER)
        (self.home/'.bash_profile').write_bytes(self.old_block()+b'\n \n')
        (self.home/'.profile').write_bytes(BEFORE)
        untouched = (self.home/'.profile').stat()
        self.use_shell('/bin/tcsh')                         # whatever the login shell is now
        setup.remove_shell_environment(self.home, self.environment)
        self.assertEqual((self.home/'.zshenv').read_bytes(), BEFORE+AFTER)
        self.assertFalse((self.home/'.bash_profile').exists(), 'a file left with blanks only goes')
        self.assertEqual((self.home/'.profile').stat().st_mtime_ns, untouched.st_mtime_ns)

    def test_a_file_that_cannot_be_changed_keeps_its_block_and_removal_goes_on(self):
        (self.home/'.zshenv').write_bytes(BEFORE+self.block())
        (self.home/'.zshenv').chmod(0o444)
        (self.home/'.bash_profile').write_bytes(self.block())
        setup.remove_shell_environment(self.home, self.environment)
        self.assertEqual((self.home/'.zshenv').read_bytes(), BEFORE+self.block())
        self.assertFalse((self.home/'.bash_profile').exists())


DELIMITER = '_SHELL_ENV_DELIMITER_'
# What Codex runs in the login shell to take over its environment.
CODEX_COMMAND = "printf '\\0%s\\0' '_SHELL_ENV_DELIMITER_'; command env -0 || exit; printf '\\0%s\\0' '_SHELL_ENV_DELIMITER_'"


class RealShellTests(ShellCase):
    """A real zsh and bash in the temporary home, started like Codex starts the login shell: `-ilc` with the
    environment given from scratch, so that nothing of this account's own shell files is read."""

    def prepare(self, shell):
        self.use_shell(shell)
        self.launcher = Path(self.values()['CODEX_CLI_PATH'])
        self.launcher.parent.mkdir(parents=True)
        self.launcher.write_text('#!/bin/sh\n')
        self.launcher.chmod(0o700)
        self.assertEqual(self.install()[0], 'ready')

    def exported(self, shell, **condition):
        environment = {'HOME': str(self.home), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'USER': 'tester',
                       'SHELL': shell, 'TERM': 'dumb'}
        environment.update(condition)
        done = subprocess.run([shell, '-ilc', CODEX_COMMAND], env=environment, cwd=str(self.home),
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              timeout=30, start_new_session=True)
        parts = done.stdout.decode().split('\0'+DELIMITER+'\0')
        self.assertEqual(len(parts), 3, done.stdout)
        found = dict(item.split('=', 1) for item in parts[1].split('\0') if '=' in item)
        return {key: found.get(key) for key in ('CODEX_CLI_PATH', 'CODEX_HOST_CUA_STATE_DIR')}

    def check(self, shell):
        self.prepare(shell)
        wanted = self.values()
        self.assertEqual(self.exported(shell, CODEX_SHELL='1'), wanted)
        self.assertEqual(self.exported(shell, __CFBundleIdentifier='com.openai.codex'), wanted)
        nothing = {'CODEX_CLI_PATH': None, 'CODEX_HOST_CUA_STATE_DIR': None}
        self.assertEqual(self.exported(shell), nothing, 'a terminal shell gets nothing')
        self.assertEqual(self.exported(shell, __CFBundleIdentifier='com.apple.Terminal'), nothing)
        self.launcher.chmod(0o600)
        self.assertEqual(self.exported(shell, CODEX_SHELL='1'), nothing, 'no launcher to run, nothing handed over')
        self.launcher.unlink()
        self.assertEqual(self.exported(shell, CODEX_SHELL='1'), nothing)

    @unittest.skipUnless(os.access('/bin/zsh', os.X_OK), 'no /bin/zsh')
    def test_zsh(self):
        self.check('/bin/zsh')
        self.assertTrue((self.home/'.zshenv').is_file())

    @unittest.skipUnless(os.access('/bin/bash', os.X_OK), 'no /bin/bash')
    def test_bash(self):
        self.check('/bin/bash')
        self.assertTrue((self.home/'.bash_profile').is_file())


if __name__ == '__main__':
    unittest.main()
