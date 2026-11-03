"""Loaded-versus-installed code checks use small owned engine trees, never the real installation."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

import runtime_identity


def write_engine(root, version='0.8.17'):
    root = Path(root)
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    root.chmod(0o700)
    manifest = root/'.claude-plugin/plugin.json'
    manifest.parent.mkdir(mode=0o700)
    manifest.write_text(json.dumps({'name': 'cuabar', 'version': version}))
    manifest.chmod(0o600)
    for name, content in (('host_mcp.py', 'HOST = 1\n'), ('mcp_stdio.py', 'MCP = 1\n')):
        path = root/name
        path.write_text(content)
        path.chmod(0o600)
    return root


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cua-identity-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.engines = self.home/'.local/share/codex-cua/engine'
        self.engines.mkdir(parents=True, mode=0o700)
        self.current = write_engine(self.engines/'0.8.17')
        (self.engines/'current').symlink_to(self.current.name)

    def test_installed_identity_follows_only_the_owned_versioned_current_target(self):
        installed = runtime_identity.installed_identity(self.home)
        self.assertEqual(installed['version'], '0.8.17')
        self.assertRegex(installed['revision'], r'^[a-f0-9]{64}$')
        self.assertEqual(runtime_identity.installed_root(self.home), self.current)
        self.assertEqual(installed, runtime_identity.engine_identity(self.current))

    def test_same_sized_content_change_is_detected_while_paths_and_mtimes_stay_the_same(self):
        before = runtime_identity.installed_identity(self.home)
        source = self.current/'host_mcp.py'
        info = source.stat()
        source.write_text('HOST = 2\n')
        os.utime(source, ns=(info.st_atime_ns, info.st_mtime_ns))
        after = runtime_identity.installed_identity(self.home)
        self.assertEqual(source.stat().st_size, info.st_size)
        self.assertEqual(source.stat().st_mtime_ns, info.st_mtime_ns)
        self.assertEqual(after['version'], before['version'])
        self.assertNotEqual(after['revision'], before['revision'])

    def test_a_snapshot_captured_at_import_does_not_follow_an_in_place_repair(self):
        module_path = self.current/'runtime_identity.py'
        shutil.copyfile(runtime_identity.__file__, module_path)
        module_path.chmod(0o600)
        spec = importlib.util.spec_from_file_location('fixture_loaded_identity', module_path)
        loaded = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(loaded)
        frozen = dict(loaded.RUNNING_IDENTITY)
        self.assertEqual(frozen, loaded.engine_identity(self.current))
        (self.current/'mcp_stdio.py').write_text('MCP = 2\n')
        self.assertNotEqual(loaded.engine_identity(self.current)['revision'], frozen['revision'])
        self.assertEqual(loaded.RUNNING_IDENTITY, frozen, 'an old process must keep reporting its loaded code')

    def test_missing_invalid_or_external_installations_cannot_claim_an_update(self):
        link = self.engines/'current'
        external = write_engine(self.home/'external-engine')
        for target in ('missing', external):
            with self.subTest(target=str(target)):
                link.unlink()
                link.symlink_to(target)
                self.assertIsNone(runtime_identity.installed_root(self.home))
                self.assertEqual(runtime_identity.installed_identity(self.home), runtime_identity.UNKNOWN)
        link.unlink()
        link.symlink_to(self.current.name)
        manifest = self.current/'.claude-plugin/plugin.json'
        for value in ({'version': '../other'}, {'version': 17}, [], {'version': '0.8.17\n'}):
            with self.subTest(manifest=value):
                manifest.write_text(json.dumps(value))
                self.assertEqual(runtime_identity.installed_identity(self.home), runtime_identity.UNKNOWN)

    def test_world_writable_or_symlinked_runtime_files_are_unverifiable(self):
        source = self.current/'mcp_stdio.py'
        source.chmod(0o666)
        self.assertEqual(runtime_identity.engine_identity(self.current), runtime_identity.UNKNOWN)
        source.chmod(0o600)
        source.unlink()
        external = self.home/'external.py'
        external.write_text('MCP = 1\n')
        source.symlink_to(external)
        self.assertEqual(runtime_identity.engine_identity(self.current), runtime_identity.UNKNOWN)

    def test_symlinked_or_writable_manifest_directory_is_unverifiable(self):
        manifest = self.current/'.claude-plugin'
        manifest.chmod(0o777)
        self.assertEqual(runtime_identity.engine_identity(self.current), runtime_identity.UNKNOWN)
        manifest.chmod(0o700)
        external = self.home/'external-manifest'
        manifest.rename(external)
        manifest.symlink_to(external, target_is_directory=True)
        self.assertEqual(runtime_identity.engine_identity(self.current), runtime_identity.UNKNOWN)

    def test_adding_a_runtime_file_changes_the_revision_but_bytecode_and_notes_do_not(self):
        before = runtime_identity.engine_identity(self.current)
        (self.current/'notes.txt').write_text('not executable code')
        cache = self.current/'__pycache__'
        cache.mkdir()
        (cache/'host_mcp.pyc').write_bytes(b'fixture cache')
        self.assertEqual(runtime_identity.engine_identity(self.current), before)
        nested = self.current/'relay'
        nested.mkdir(mode=0o700)
        (nested/'relay.mjs').write_text('// runtime change\n')
        self.assertNotEqual(runtime_identity.engine_identity(self.current)['revision'], before['revision'])


class RuntimeStatusTests(unittest.TestCase):
    def setUp(self):
        self.installed = {'version': '0.8.17', 'revision': 'a'*64}

    def test_old_version_and_same_version_changed_code_both_need_reconnect(self):
        for record in ({'version': '0.8.16', 'runtime_revision': 'a'*64},
                       {'version': '0.8.17', 'runtime_revision': 'b'*64}):
            with self.subTest(record=record):
                result = runtime_identity.runtime_status(record, self.installed)
                self.assertEqual(result['state'], 'reconnect_required')
                self.assertTrue(result['reconnect_required'])
                self.assertEqual(result['running_version'], record['version'])
                self.assertEqual(result['installed_version'], '0.8.17')

    def test_reconnected_matching_version_and_content_are_current(self):
        result = runtime_identity.runtime_status(
            {'version': '0.8.17', 'runtime_revision': 'a'*64}, self.installed)
        self.assertEqual(result['state'], 'current')
        self.assertFalse(result['reconnect_required'])

    def test_unknown_legacy_identity_recommends_one_reconnect_then_a_new_record_clears_it(self):
        for record in ({}, {'version': '0.8.17'}, {'version': '0.8.17', 'runtime_revision': 'not-a-digest'}):
            with self.subTest(record=record):
                result = runtime_identity.runtime_status(record, self.installed)
                self.assertTrue(result['reconnect_required'])
                self.assertEqual(result['state'], 'unknown')
        fresh = {'version': '0.8.17', 'runtime_revision': self.installed['revision']}
        self.assertFalse(runtime_identity.runtime_status(fresh, self.installed)['reconnect_required'])

    def test_missing_installation_reports_unknown_without_a_reconnect_alarm(self):
        for installed in ({}, runtime_identity.UNKNOWN, {'version': '../invalid', 'revision': 'a'*64}):
            with self.subTest(installed=installed):
                result = runtime_identity.runtime_status({'version': '0.8.16'}, installed)
                self.assertFalse(result['reconnect_required'])
                self.assertEqual(result['state'], 'unknown')
                self.assertIsNone(result['installed_version'])

    def test_real_legacy_command_path_supplies_a_safe_version_without_executing_it(self):
        command = ('/Users/fixture/.local/share/codex-cua/venv/bin/python3 '
                   '/Users/fixture/.local/share/codex-cua/engine/0.8.16/mcp_stdio.py')
        result = runtime_identity.runtime_status({}, self.installed, command)
        self.assertEqual(result['running_version'], '0.8.16')
        self.assertTrue(result['reconnect_required'])
        self.assertIsNone(runtime_identity.runtime_status({}, self.installed, command+'-fake')['running_version'])
        self.assertIsNone(runtime_identity.runtime_status({}, self.installed, command.replace('0.8.16', '../bad'))['running_version'])
