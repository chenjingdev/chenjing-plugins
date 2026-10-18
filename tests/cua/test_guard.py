"""The fingerprint that guards the real support folders sees what the old list of names could not."""
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import guard


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
        (self.home/'Library/LaunchAgents/other.plist').unlink()
        (self.home/'.local/bin/codex-cua').chmod(0o755)
        (self.home/'.local/share/codex-cua/command.py').unlink()
        moved = self.moved()
        for name in ('Library/Caches/codex-cua', 'Library/Caches/codex-host-cua/host.json', 'Library/LaunchAgents/other.plist',
                     'Library/LaunchAgents', '.local/share/codex-cua/command.py', '.local/share/codex-cua'):
            self.assertIn(name, moved)

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

    def test_the_real_home_comes_from_the_account_database(self):
        with patch.dict(os.environ, {'HOME': '/nonexistent'}):
            self.assertNotEqual(str(guard.real_home()), '/nonexistent')
            self.assertTrue(guard.real_home().is_dir())


if __name__ == '__main__':
    unittest.main()
