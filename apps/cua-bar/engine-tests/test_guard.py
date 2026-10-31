"""The fingerprint that guards the real support folders sees what the old list of names could not, and the runner
says so with an exit code of its own."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import guard

HERE = Path(__file__).resolve().parent
TIME = r'\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4}'
FIXED_NS = 1792332000 * 10**9                   # 2026-10-18 14:00:00 UTC


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/tmp', prefix='grd-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        support = self.home/'.local/share/codex-cua'
        (support/'relay').mkdir(parents=True)
        (support/'relay/relay.mjs').write_text('// one\n')
        (support/'command.py').write_text('x')
        (self.home/'.local/bin').mkdir(parents=True)
        (self.home/'.local/bin/codex-cua').write_text('#!/bin/sh\n')
        (self.home/'Library/LaunchAgents').mkdir(parents=True)
        (self.home/'Library/LaunchAgents/other.plist').write_text('<plist/>')
        (self.home/'Library/LaunchAgents/com.chenjingdev.codex-cua.env.plist').write_text('<plist/>')
        (self.home/'Library/Caches/codex-host-cua').mkdir(parents=True)
        self.before = guard.fingerprint(self.home)

    def moved(self):
        return guard.changes(self.before, guard.fingerprint(self.home))

    def test_nothing_changed_nothing_reported(self):
        self.assertEqual(self.moved(), [])
        self.assertIn('.local/share/codex-cua/relay/relay.mjs', self.before)
        self.assertIsNone(self.before['Library/Caches/codex-cua'], 'an absent folder is part of the picture')

    def test_an_overwrite_inside_an_existing_file_is_seen_although_no_name_changes(self):
        time.sleep(0.01)
        (self.home/'.local/share/codex-cua/relay/relay.mjs').write_text('// two\n')       # same size, same name
        self.assertIn('.local/share/codex-cua/relay/relay.mjs', self.moved())

    def test_an_atomic_replace_is_seen_too(self):
        path = self.home/'.local/share/codex-cua/relay/relay.mjs'
        replacement = path.with_name('.tmp')
        replacement.write_text('// one\n')
        os.replace(replacement, path)
        self.assertIn('.local/share/codex-cua/relay/relay.mjs', self.moved())

    def test_new_removed_and_changed_entries_in_every_watched_place_are_seen(self):
        (self.home/'Library/Caches/codex-cua').mkdir()
        (self.home/'Library/Caches/codex-host-cua/host.json').write_text('{}')
        (self.home/'Library/LaunchAgents/com.chenjingdev.codex-cua.env.plist').unlink()
        (self.home/'.local/bin/codex-cua').chmod(0o755)
        (self.home/'.local/share/codex-cua/command.py').unlink()
        moved = self.moved()
        for name in ('Library/Caches/codex-cua', 'Library/Caches/codex-host-cua/host.json',
                     'Library/LaunchAgents/com.chenjingdev.codex-cua.env.plist',
                     '.local/share/codex-cua/command.py', '.local/share/codex-cua'):
            self.assertIn(name, moved)

    def test_a_login_agent_of_ours_is_watched_and_other_tools_agents_are_not(self):
        agents = self.home/'Library/LaunchAgents'
        (agents/'other.plist').write_text('<plist>changed</plist>')
        (agents/'org.example.new.plist').write_text('<plist/>')
        (agents/'other.plist').unlink()
        self.assertEqual(self.moved(), [], 'what other tools do in the shared folder is not our business')
        (agents/'com.chenjingdev.codex-cua.env.plist').write_text('<plist>rewritten</plist>')
        self.assertIn('Library/LaunchAgents/com.chenjingdev.codex-cua.env.plist', self.moved())
        (agents/'com.chenjingdev.codex-cua.env.plist').unlink()
        (agents/'com.chenjingdev.codex-cua.other.plist').write_text('<plist/>')
        self.assertIn('Library/LaunchAgents/com.chenjingdev.codex-cua.other.plist', self.moved())

    def test_looking_changes_nothing(self):
        guard.fingerprint(self.home)
        guard.fingerprint(self.home)
        self.assertEqual(self.moved(), [])

    def test_a_link_is_described_not_followed(self):
        target = self.home/'elsewhere'
        target.mkdir()
        (target/'file').write_text('x')
        (self.home/'.local/share/codex-cua/link').symlink_to(target)
        after = guard.fingerprint(self.home)
        self.assertIn('.local/share/codex-cua/link', after)
        self.assertNotIn('.local/share/codex-cua/link/file', after)

    def test_the_shell_startup_files_are_watched_and_so_is_the_file_a_link_points_to(self):
        (self.home/'.zshrc').write_text('# mine\n')
        elsewhere = self.home/'dotfiles'
        elsewhere.mkdir()
        (elsewhere/'zshenv').write_text('# one\n')
        (self.home/'.zshenv').symlink_to(elsewhere/'zshenv')
        before = guard.fingerprint(self.home)
        self.assertIsNone(before['.profile'], 'an absent startup file is part of the picture')
        time.sleep(0.01)
        (elsewhere/'zshenv').write_text('# two\n')                  # through the link, which stays as it is
        (self.home/'.zshrc').write_text('# mine, changed\n')
        (self.home/'.bash_profile').write_text('')
        self.assertEqual(guard.changes(before, guard.fingerprint(self.home)),
                         ['.bash_profile', '.bash_profile (target)', '.zshenv (target)', '.zshrc', '.zshrc (target)'])

    def test_the_real_home_comes_from_the_account_database(self):
        with patch.dict(os.environ, {'HOME': '/nonexistent'}):
            self.assertNotEqual(str(guard.real_home()), '/nonexistent')
            self.assertTrue(guard.real_home().is_dir())

    def test_every_change_is_listed_with_what_happened_and_its_new_modification_time(self):
        command = self.home/'.local/share/codex-cua/command.py'
        command.write_text('a longer content')
        os.utime(command, ns=(FIXED_NS, FIXED_NS))
        (self.home/'Library/Caches/codex-cua').mkdir()
        (self.home/'.local/share/codex-cua/relay/relay.mjs').unlink()
        lines = guard.describe(self.before, guard.fingerprint(self.home))
        # The new time of the file, not the old one, and no time for what is gone.
        self.assertIn('.local/share/codex-cua/command.py  changed, modified '+guard.local_time(FIXED_NS), lines)
        self.assertIn('.local/share/codex-cua/relay/relay.mjs  removed', lines)
        new_folder = [line for line in lines if line.startswith('Library/Caches/codex-cua  ')]
        self.assertEqual(len(new_folder), 1)
        self.assertRegex(new_folder[0], r'^Library/Caches/codex-cua  new, modified '+TIME+'$')
        self.assertEqual(len(lines), len(guard.changes(self.before, guard.fingerprint(self.home))), 'one line per path')
        self.assertEqual(guard.describe(self.before, self.before), [])

    def test_a_modification_time_is_shown_in_the_local_time_zone_with_its_offset(self):
        program = 'import guard, sys; print(guard.local_time(int(sys.argv[1])))'
        for zone, shown in (('Asia/Seoul', '2026-10-18 23:00:00 +0900'),
                            ('America/New_York', '2026-10-18 10:00:00 -0400'),
                            ('UTC', '2026-10-18 14:00:00 +0000')):
            with self.subTest(zone=zone):
                found = subprocess.run([sys.executable, '-B', '-c', program, str(FIXED_NS)],
                                       env=dict(os.environ, TZ=zone, PYTHONPATH=str(HERE)),
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
                self.assertEqual((found.returncode, found.stdout.strip()), (0, shown), found.stderr)


STAND_IN_CHANGES_THE_HOME = '''
import os
from pathlib import Path
import unittest


class StandIn(unittest.TestCase):
    def test_something_else_changes_a_watched_file(self):
        Path(os.environ['STAND_IN_HOME'], '.local/share/codex-cua/command.py').write_text('a longer content')
'''
STAND_IN_FAILS = '''
import unittest


class StandIn(unittest.TestCase):
    def test_fails_on_purpose(self):
        self.fail('on purpose')
'''
STAND_IN_PASSES = '''
import unittest


class StandIn(unittest.TestCase):
    def test_passes(self):
        pass
'''
STAND_IN_STRAYS = '''
import os
from pathlib import Path
import unittest


class StandIn(unittest.TestCase):
    def test_writes_into_the_default_home(self):
        Path(os.environ['HOME'], 'stray.txt').write_text('x')
'''


class RunnerTests(unittest.TestCase):
    """run.py as a process, on a stand-in suite and a stand-in home: its exit code says which kind of trouble it is."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/tmp', prefix='grd-run-')
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name).resolve()
        self.home = root/'home'
        (self.home/'.local/share/codex-cua').mkdir(parents=True)
        (self.home/'.local/share/codex-cua/command.py').write_text('x')
        self.suite = root/'suite'
        self.suite.mkdir()

    def run_suite(self, *sources):
        for number, source in enumerate(sources):
            (self.suite/('test_stand_in_%d.py' % number)).write_text(source)
        command = [sys.executable, '-B', str(HERE/'run.py'), '--tests', str(self.suite), '--real-home', str(self.home)]
        return subprocess.run(command, env=dict(os.environ, STAND_IN_HOME=str(self.home), PYTHONDONTWRITEBYTECODE='1'),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)

    def test_a_clean_run_exits_0_and_says_nothing_about_the_guard(self):
        done = self.run_suite(STAND_IN_PASSES)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn('changed while the tests ran', done.stderr)

    def test_a_failing_test_exits_1(self):
        done = self.run_suite(STAND_IN_FAILS)
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertIn('FAILED (failures=1)', done.stderr)
        self.assertNotIn('changed while the tests ran', done.stderr)

    def test_a_change_in_the_real_support_folders_exits_2_although_every_test_passed(self):
        done = self.run_suite(STAND_IN_CHANGES_THE_HOME)
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertIn('Ran 1 test', done.stderr)
        self.assertRegex(done.stderr, r'\nOK\n')
        self.assertIn('The real support folders changed while the tests ran', done.stderr)
        self.assertRegex(done.stderr, r'\n  \.local/share/codex-cua/command\.py  changed, modified '+TIME+r'\n')

    def test_the_guard_wins_over_a_failing_test(self):
        done = self.run_suite(STAND_IN_CHANGES_THE_HOME, STAND_IN_FAILS)
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertIn('FAILED (failures=1)', done.stderr, 'the test results are still printed')
        self.assertIn('command.py  changed, modified ', done.stderr)

    def test_a_stray_in_the_default_home_is_a_failure_of_the_tests_not_a_change_of_the_real_folders(self):
        done = self.run_suite(STAND_IN_STRAYS)
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertIn('Tests wrote into the default home instead of an injected one:\n  stray.txt', done.stderr)
        self.assertNotIn('changed while the tests ran', done.stderr)

    def test_a_usage_error_exits_1_because_2_belongs_to_the_guard(self):
        # The stand-in suite and home come first, so a parser that one day accepts these runs no real suite.
        own = ['--tests', str(self.suite), '--real-home', str(self.home)]
        for arguments, said in (([*own, '--no-such-option'], 'unrecognized arguments: --no-such-option'),
                                ([*own[:3]], 'expected one argument')):
            with self.subTest(arguments=arguments):
                done = subprocess.run([sys.executable, '-B', str(HERE/'run.py'), *arguments], stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True, timeout=60)
                self.assertEqual(done.returncode, 1, done.stderr)
                self.assertIn('usage:', done.stderr)
                self.assertIn(said, done.stderr)


if __name__ == '__main__':
    unittest.main()
