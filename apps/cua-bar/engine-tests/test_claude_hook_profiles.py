"""Explicit profile ownership survives GUI/default-environment uninstall; no other profiles are discovered."""
import fcntl
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import claude_hook_profiles as profiles
import claude_hook_setup as hooks


class ProfileLedgerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cuabar-profiles-')
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name).resolve()
        self.root = self.home/'.local/share/codex-cua'
        self.ledger = self.root/profiles.LEDGER_NAME
        self.environment = {'PATH': '/fixture/no-claude'}

    def configure(self, directory=None):
        environment = dict(self.environment)
        if directory is not None:
            environment['CLAUDE_CONFIG_DIR'] = str(directory)
        return profiles.configure_profile(self.home, environment)

    def remove(self, directory=None):
        environment = dict(self.environment)
        if directory is not None:
            environment['CLAUDE_CONFIG_DIR'] = str(directory)
        return profiles.remove_profiles(self.home, environment)

    def registered(self):
        return json.loads(self.ledger.read_text())['profiles']

    def settings(self, directory):
        path = directory/'settings.json'
        return json.loads(path.read_text()) if path.exists() else {}

    def write_settings(self, directory, value):
        directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        path = directory/'settings.json'
        path.write_text(json.dumps(value)+'\n')
        path.chmod(0o600)

    def test_default_registration_is_private_recorded_and_idempotent(self):
        first = self.configure()
        self.assertEqual((first['state'], first['changed']), ('ready', True))
        self.assertEqual(self.registered(), [str(self.home/'.claude')])
        self.assertEqual(stat.S_IMODE(self.ledger.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        before = self.ledger.stat()
        self.assertFalse(self.configure()['changed'])
        self.assertEqual(self.ledger.stat().st_ino, before.st_ino)

    def test_gui_uninstall_cleans_previously_explicit_profile_without_rediscovering_it(self):
        custom = self.home/'explicit-profile'
        self.assertEqual(self.configure(custom)['state'], 'ready')
        self.assertFalse((self.home/'.claude').exists())
        self.assertEqual(self.remove()['state'], 'removed')
        self.assertNotIn('hooks', self.settings(custom))
        self.assertFalse((self.home/'.claude').exists())
        self.assertEqual(self.registered(), [])

    def test_multiple_recorded_profiles_preserve_other_settings_and_hooks(self):
        first, second = self.home/'first', self.home/'second'
        initial = {'permissions': {'allow': ['Read']}, 'hooks': {'Stop': [{'hooks': [
            {'type': 'command', 'command': '/unrelated/hook', 'args': []}]}]}}
        self.write_settings(first, initial)
        self.configure(first)
        self.configure(second)
        self.assertEqual(self.registered(), [str(first), str(second)])
        self.assertEqual(self.remove()['state'], 'removed')
        self.assertEqual(self.settings(first), initial)
        self.assertEqual(self.settings(second), {})

    def test_company_profile_is_never_scanned_unless_explicitly_configured(self):
        company = self.home/'.claude-ubion'
        hooks.configure_hooks(self.home, company)  # A separately configured profile does not prove app ownership.
        before = (company/'settings.json').read_bytes()
        self.configure()
        self.assertEqual(self.registered(), [str(self.home/'.claude')])
        self.assertEqual(self.remove()['state'], 'removed')
        self.assertEqual((company/'settings.json').read_bytes(), before)

    def test_disabled_hooks_are_preserved_during_registration_and_removal(self):
        directory = self.home/'disabled'
        self.write_settings(directory, {'disableAllHooks': True, 'allowManagedHooksOnly': True})
        self.assertTrue(self.configure(directory)['hooks_disabled'])
        self.assertEqual(self.remove()['state'], 'removed')
        self.assertEqual(self.settings(directory), {'disableAllHooks': True, 'allowManagedHooksOnly': True})

    def test_ledger_is_prepared_before_hooks_can_be_written(self):
        selected = self.home/'selected'
        def configure(home, directory):
            self.assertEqual(self.registered(), [str(selected)])
            return {'state': 'ready', 'changed': True, 'settings_file': str(selected/'settings.json')}
        with patch.object(profiles, 'configure_hooks', side_effect=configure):
            self.assertEqual(self.configure(selected)['state'], 'ready')

    def test_failed_unchanged_configuration_rolls_back_a_new_or_existing_ledger(self):
        rejected = self.home/'rejected'
        failure = {'state': 'conflict', 'changed': False, 'error': 'unsafe_settings'}
        with patch.object(profiles, 'configure_hooks', return_value=failure):
            self.assertEqual(self.configure(rejected)['state'], 'conflict')
        self.assertFalse(self.ledger.exists())
        self.configure()
        before = self.ledger.read_bytes()
        with patch.object(profiles, 'configure_hooks', return_value=failure):
            self.assertEqual(self.configure(rejected)['state'], 'conflict')
        self.assertEqual(self.ledger.read_bytes(), before)

    def test_uncertain_configuration_keeps_ledger_so_uninstall_can_reconcile_it(self):
        selected = self.home/'selected'
        with patch.object(profiles, 'configure_hooks', side_effect=OSError('stand-in write outcome unknown')):
            answer = self.configure(selected)
        self.assertEqual(answer['state'], 'failed')
        self.assertEqual(answer['error'], 'profile_configuration_unconfirmed')
        self.assertEqual(self.registered(), [str(selected)])

    def test_invalid_unsafe_or_symlink_ledger_prevents_any_hook_change(self):
        self.root.mkdir(parents=True, mode=0o700)
        for raw in ('invalid', '[]', '{"schema_version":true,"profiles":[]}',
                    '{"schema_version":1,"profiles":["relative"]}', '{"schema_version":1,"profiles":{}}'):
            with self.subTest(raw=raw):
                self.ledger.write_text(raw)
                self.ledger.chmod(0o600)
                with patch.object(profiles, 'configure_hooks') as configure:
                    self.assertEqual(self.configure()['state'], 'conflict')
                    self.assertEqual(self.remove()['state'], 'conflict')
                configure.assert_not_called()
                self.assertEqual(self.ledger.read_text(), raw)
        self.ledger.write_text('{"schema_version":1,"profiles":[]}')
        self.ledger.chmod(0o644)
        self.assertEqual(self.remove()['state'], 'conflict')
        self.ledger.unlink()
        target = self.home/'elsewhere.json'
        target.write_text('{"schema_version":1,"profiles":[]}')
        target.chmod(0o600)
        self.ledger.symlink_to(target)
        self.assertEqual(self.configure()['state'], 'conflict')
        self.assertTrue(self.ledger.is_symlink())

    def test_ledger_write_failure_happens_before_hook_configuration(self):
        with patch.object(profiles, '_save', side_effect=OSError('stand-in disk error')), \
                patch.object(profiles, 'configure_hooks') as configure:
            answer = self.configure()
        self.assertEqual(answer['state'], 'failed')
        configure.assert_not_called()
        self.assertFalse((self.home/'.claude').exists())

    def test_all_profiles_are_preflighted_before_any_hook_removal(self):
        good, broken = self.home/'good', self.home/'broken'
        self.configure(good)
        self.configure(broken)
        good_before = (good/'settings.json').read_bytes()
        ledger_before = self.ledger.read_bytes()
        (broken/'settings.json').write_text('{invalid')
        answer = self.remove()
        self.assertEqual(answer['state'], 'conflict')
        self.assertEqual((good/'settings.json').read_bytes(), good_before)
        self.assertEqual(self.ledger.read_bytes(), ledger_before)

    def test_a_late_removal_failure_keeps_the_ledger_for_retry(self):
        first, second = self.home/'first', self.home/'second'
        self.configure(first)
        self.configure(second)
        before = self.ledger.read_bytes()
        configure = profiles.configure_hooks
        def fail_second(home, directory, remove=False):
            if str(directory) == str(second):
                return {'state': 'failed', 'changed': False}
            return configure(home, directory, remove=remove)
        with patch.object(profiles, 'configure_hooks', side_effect=fail_second):
            answer = self.remove()
        self.assertEqual(answer['state'], 'failed')
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertEqual(self.remove()['state'], 'removed')

    def test_missing_ledger_still_removes_owned_hooks_in_the_current_legacy_profile(self):
        hooks.configure_hooks(self.home)
        self.assertFalse(self.root.exists())
        self.assertEqual(self.remove()['state'], 'removed')
        self.assertEqual(self.settings(self.home/'.claude'), {})
        self.assertFalse(self.root.exists())

    def test_missing_profiles_are_not_created_during_removal(self):
        self.assertEqual(self.remove()['state'], 'removed')
        self.assertEqual(list(self.home.iterdir()), [])

    def test_another_profile_operation_or_unsafe_lock_prevents_changes(self):
        self.root.mkdir(parents=True, mode=0o700)
        lock = self.root/profiles.LOCK_NAME
        descriptor = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, descriptor)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        self.assertEqual(self.configure()['error'], 'profile_setup_busy')
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        lock.chmod(0o644)
        self.assertEqual(self.configure()['error'], 'unsafe_profile_lock')
        self.assertFalse((self.home/'.claude').exists())

    def test_concurrent_ledger_replacement_is_preserved_before_hooks_change(self):
        self.configure()
        replacement = {'schema_version': 1, 'profiles': [str(self.home/'concurrent-profile')]}
        original_same = profiles._same
        def changed(path, expected):
            path.write_text(json.dumps(replacement))
            return original_same(path, expected)
        with patch.object(profiles, '_same', side_effect=changed), patch.object(profiles, 'configure_hooks') as configure:
            answer = self.configure(self.home/'selected')
        self.assertEqual(answer['error'], 'profile_ledger_changed')
        configure.assert_not_called()
        self.assertEqual(json.loads(self.ledger.read_text()), replacement)

    def test_invalid_or_oversized_selected_profile_does_not_replace_the_existing_ledger(self):
        self.configure()
        before = self.ledger.read_bytes()
        for directory in ('relative-profile', '/invalid\0path', '/'+'x'*profiles.MAX_BYTES):
            with self.subTest(directory=directory[:40]), patch.object(profiles, 'configure_hooks') as configure:
                answer = self.configure(directory)
                self.assertEqual(answer['state'], 'conflict')
                configure.assert_not_called()
                self.assertEqual(self.ledger.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
