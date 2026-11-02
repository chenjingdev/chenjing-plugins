"""Only CUA Bar's managed hooks are changed, in one explicitly chosen Claude profile."""
import copy
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import claude_hook_setup as setup


class HookProfileCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cuabar-hook-setup-')
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.directory = self.home / '.claude'
        self.path = self.directory / 'settings.json'
        self.environment = patch.dict(os.environ)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        os.environ.pop('CLAUDE_CONFIG_DIR', None)

    def write(self, settings):
        self.directory.mkdir(mode=0o700, exist_ok=True)
        self.path.write_text(json.dumps(settings, ensure_ascii=False) + '\n')
        self.path.chmod(0o600)

    def read(self):
        return json.loads(self.path.read_text())

    def configure(self, **kwargs):
        return setup.configure_hooks(home=self.home, **kwargs)


class HookSetupTests(HookProfileCase):
    def test_new_settings_install_six_hooks_with_a_stable_command(self):
        answer = self.configure()
        self.assertEqual((answer['state'], answer['changed']), ('ready', True))
        hooks = self.read()['hooks']
        self.assertEqual(set(hooks), set(setup.EVENTS))
        command = str(self.home / '.local/share/codex-cua/engine/current/claude-hook.sh')
        for event, groups in hooks.items():
            self.assertEqual(groups[0]['hooks'], [{'type': 'command', 'command': command, 'args': [], 'timeout': 10}])
            self.assertEqual(groups[0].get('matcher'), setup.TOOL_MATCHER if event == 'PreToolUse' else None)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_install_is_idempotent_and_keeps_other_settings_and_hooks(self):
        other = {'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': '/my/stop-script', 'args': ['keep']}]}
        initial = {'permissions': {'allow': ['Read']}, 'model': 'custom',
                   'hooks': {'Stop': [other], 'Notification': [{'hooks': [{'type': 'http', 'url': 'http://localhost'}]}]}}
        self.write(initial)
        self.assertTrue(self.configure()['changed'])
        installed = self.read()
        self.assertEqual(installed['permissions'], initial['permissions'])
        self.assertEqual(installed['model'], 'custom')
        self.assertEqual(installed['hooks']['Stop'][0], other)
        self.assertEqual(installed['hooks']['Notification'], initial['hooks']['Notification'])
        before = self.path.stat()
        self.assertEqual(self.configure()['changed'], False)
        after = self.path.stat()
        self.assertEqual((before.st_ino, before.st_mtime_ns), (after.st_ino, after.st_mtime_ns))

    def test_remove_only_our_exact_command_and_empty_args(self):
        self.configure()
        installed = self.read()
        command = installed['hooks']['Stop'][0]['hooks'][0]['command']
        other = [{'type': 'command', 'command': command, 'args': ['user-customized']},
                 {'type': 'command', 'command': '/my/hook', 'args': []}]
        installed['hooks']['Stop'][0]['hooks'].extend(copy.deepcopy(other))
        installed['unrelated'] = {'keep': True}
        self.write(installed)
        answer = self.configure(remove=True)
        self.assertEqual((answer['state'], answer['changed']), ('removed', True))
        self.assertEqual(self.read(), {'hooks': {'Stop': [{'hooks': other}]}, 'unrelated': {'keep': True}})
        self.assertFalse(self.configure(remove=True)['changed'])

    def test_removing_a_missing_profile_creates_nothing(self):
        self.assertEqual(self.configure(remove=True)['state'], 'removed')
        self.assertEqual(list(self.home.iterdir()), [])

    def test_remove_preserves_empty_existing_hook_entries_it_does_not_own(self):
        for settings in ({'hooks': {}}, {'hooks': {'Stop': []}}, {'hooks': {'Stop': [{'hooks': []}]}}):
            with self.subTest(settings=settings):
                self.write(settings)
                self.assertFalse(self.configure(remove=True)['changed'])
                self.assertEqual(self.read(), settings)

    def test_does_not_discover_or_install_into_company_profiles(self):
        company = self.home / '.claude-ubion'
        company.mkdir(mode=0o700)
        company_settings = company / 'settings.json'
        company_settings.write_text('{"keep":"company"}\n')
        self.configure()
        self.assertEqual(company_settings.read_text(), '{"keep":"company"}\n')

    def test_explicit_profile_argument_wins_over_environment(self):
        os.environ['CLAUDE_CONFIG_DIR'] = str(self.home / 'environment-profile')
        selected = self.home / 'selected-profile'
        answer = self.configure(config_dir=selected)
        self.assertEqual(answer['settings_file'], str(selected / 'settings.json'))
        self.assertTrue((selected / 'settings.json').is_file())
        self.assertFalse(self.directory.exists())
        self.assertFalse((self.home / 'environment-profile').exists())

    def test_explicit_environment_profile_is_used_without_scanning(self):
        os.environ['CLAUDE_CONFIG_DIR'] = '~/chosen-profile'
        answer = self.configure()
        self.assertEqual(answer['settings_file'], str(self.home / 'chosen-profile/settings.json'))
        self.assertFalse(self.directory.exists())

    def test_invalid_json_or_shapes_are_not_overwritten(self):
        for raw in ('{broken', '[]', '{"hooks":[]}', '{"hooks":{"Stop":{}}}',
                    '{"hooks":{"Stop":[{"hooks":{}}]}}'):
            with self.subTest(raw=raw):
                self.directory.mkdir(mode=0o700, exist_ok=True)
                self.path.write_text(raw)
                self.path.chmod(0o600)
                self.assertEqual(self.configure()['state'], 'conflict')
                self.assertEqual(self.path.read_text(), raw)

    def test_symlink_settings_and_profile_are_not_followed(self):
        elsewhere = self.home / 'elsewhere.json'
        elsewhere.write_text('{}\n')
        self.directory.mkdir(mode=0o700)
        self.path.symlink_to(elsewhere)
        self.assertEqual(self.configure()['error'], 'unsafe_settings')
        self.assertTrue(self.path.is_symlink())
        self.assertEqual(elsewhere.read_text(), '{}\n')
        self.path.unlink()
        self.directory.rmdir()
        actual = self.home / 'actual'
        actual.mkdir(mode=0o700)
        self.directory.symlink_to(actual, target_is_directory=True)
        self.assertEqual(self.configure()['error'], 'unsafe_config_dir')
        self.assertEqual(list(actual.iterdir()), [])

    def test_permissions_and_disabled_hooks_are_not_changed(self):
        self.write({'disableAllHooks': True, 'allowManagedHooksOnly': True})
        self.assertTrue(self.configure()['hooks_disabled'])
        self.assertTrue(self.read()['disableAllHooks'])
        self.assertTrue(self.read()['allowManagedHooksOnly'])
        self.path.chmod(0o640)
        self.assertTrue(self.configure(remove=True)['changed'])
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o640)

    def test_writable_by_other_users_is_reported_without_change(self):
        self.write({'model': 'keep'})
        self.path.chmod(0o666)
        before = self.path.read_bytes()
        self.assertEqual(self.configure()['error'], 'unsafe_settings')
        self.assertEqual(self.path.read_bytes(), before)

    def test_concurrent_settings_write_is_detected_and_temp_file_removed(self):
        self.write({'model': 'original'})
        unchanged = setup._unchanged
        def concurrent(path, original):
            path.write_text('{"model":"newer-user-value"}\n')
            return unchanged(path, original)
        with patch.object(setup, '_unchanged', concurrent):
            answer = self.configure()
        self.assertEqual((answer['state'], answer['changed'], answer['error']), ('conflict', False, 'settings_changed'))
        self.assertEqual(self.read(), {'model': 'newer-user-value'})
        self.assertEqual([path.name for path in self.directory.iterdir()], ['settings.json'])

    def test_relative_profile_path_is_rejected(self):
        answer = self.configure(config_dir='relative-profile')
        self.assertEqual((answer['state'], answer['error']), ('conflict', 'invalid_config_dir'))
        self.assertEqual(list(self.home.iterdir()), [])


class HookInspectionTests(HookProfileCase):
    """Readiness reports actual registration or a precise reason it is ineffective, without doing setup."""
    def inspect(self, **kwargs):
        return setup.inspect_hooks(home=self.home, **kwargs)

    def fake_claude(self):
        path = self.home/'.local/bin/claude'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('#!/bin/sh\nexit 0\n')
        path.chmod(0o700)
        return path

    def test_missing_profile_or_settings_is_read_only_and_does_not_install(self):
        self.assertEqual(self.inspect(), 'missing')
        self.assertEqual(list(self.home.iterdir()), [])
        self.directory.mkdir(mode=0o700)
        self.assertEqual(self.inspect(), 'missing')
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_ready_requires_all_managed_events_and_reports_without_rewriting(self):
        self.configure()
        before, info = self.path.read_bytes(), self.path.stat()
        with patch.object(setup, '_write', side_effect=AssertionError('inspection must not write')):
            self.assertEqual(self.inspect(), 'ready')
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual((self.path.stat().st_ino, self.path.stat().st_mtime_ns), (info.st_ino, info.st_mtime_ns))
        complete = self.read()
        for event in setup.EVENTS:
            settings = copy.deepcopy(complete)
            del settings['hooks'][event]
            self.write(settings)
            self.assertEqual(self.inspect(), 'missing', event)

    def test_disabled_settings_are_reported_without_being_overridden(self):
        self.configure()
        complete = self.read()
        for key in ('disableAllHooks', 'allowManagedHooksOnly'):
            settings = {**complete, key: True}
            self.write(settings)
            before = self.path.read_bytes()
            self.assertEqual(self.inspect(), 'disabled')
            self.assertEqual(self.path.read_bytes(), before)

    def test_invalid_or_unsafe_settings_report_conflict_without_modifying_them(self):
        for raw in ('{invalid', '[]', '{"hooks":[]}', '{"hooks":{"Stop":{}}}'):
            self.directory.mkdir(mode=0o700, exist_ok=True)
            self.path.write_text(raw)
            self.path.chmod(0o600)
            self.assertEqual(self.inspect(), 'conflict')
            self.assertEqual(self.path.read_text(), raw)
        self.path.write_text('{}')
        self.path.chmod(0o666)
        self.assertEqual(self.inspect(), 'conflict')
        self.assertEqual(self.path.read_text(), '{}')

    def test_inspection_of_an_io_failure_reports_failed_instead_of_running_setup(self):
        self.directory.mkdir(mode=0o700)
        with patch.object(setup, '_read', side_effect=PermissionError('stand-in error')), \
                patch.object(setup, 'configure_hooks', side_effect=AssertionError('not a setup call')):
            self.assertEqual(self.inspect(), 'failed')

    def test_uninstalled_claude_is_reported_even_if_stale_hook_settings_exist(self):
        self.configure()
        with patch.object(setup, 'inspect_hooks', side_effect=AssertionError('no Claude, no hook inspection')):
            self.assertEqual(setup.lifecycle_hooks_state(self.home, {'PATH': '/fixture/no-claude'}), 'not_installed')

    def test_detected_local_cli_reports_ready_missing_or_disabled_registration(self):
        self.fake_claude()
        environment = {'PATH': '/fixture/no-claude'}
        self.assertEqual(setup.lifecycle_hooks_state(self.home, environment), 'missing')
        self.configure()
        self.assertEqual(setup.lifecycle_hooks_state(self.home, environment), 'ready')
        settings = self.read()
        settings['disableAllHooks'] = True
        self.write(settings)
        self.assertEqual(setup.lifecycle_hooks_state(self.home, environment), 'disabled')

    def test_explicit_environment_profile_is_inspected_without_company_profile_discovery(self):
        self.fake_claude()
        company = self.home/'.claude-ubion'
        self.configure(config_dir=company)
        environment = {'PATH': '/fixture/no-claude'}
        self.assertEqual(setup.lifecycle_hooks_state(self.home, environment), 'missing')
        self.assertEqual(setup.lifecycle_hooks_state(self.home, {**environment, 'CLAUDE_CONFIG_DIR': str(company)}), 'ready')
        self.assertFalse(self.directory.exists())


if __name__ == '__main__':
    unittest.main()
