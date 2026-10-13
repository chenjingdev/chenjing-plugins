"""Portable discovery tests use fake app bundles and never launch a GUI."""
import os
from pathlib import Path
import plistlib
import tempfile
import unittest
from runtime_paths import discover_installation, installation_from_native_cli, InstallationError, default_state


def fake_app(root, name='Codex.app', preferred=True, bundle_id='com.openai.codex'):
    app = root/name
    contents = app/'Contents'
    contents.mkdir(parents=True)
    with (contents/'Info.plist').open('wb') as output:
        plistlib.dump({'CFBundleIdentifier': bundle_id, 'CFBundleExecutable': 'ChatGPT',
                      'CFBundleShortVersionString': 'fixture'}, output)
    native = contents/('Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex' if preferred else 'Resources/codex-cli/bin/codex')
    cua = contents/'Resources/cua_node'
    for path in (native, contents/'MacOS/ChatGPT', cua/'bin/node', cua/'bin/node_repl',
                 cua/'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs'):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('fixture')
        path.chmod(0o700)
    return app, native, cua


class RuntimePathsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def test_home_app_discovery_and_preferred_cli(self):
        app, native, cua = fake_app(self.home/'Applications')
        result = discover_installation({}, self.home, [self.home/'Applications'])
        self.assertEqual((result.app_path, result.native_cli, result.cua_root), (app, native, cua))
        self.assertEqual(default_state(self.home), self.home/'Library/Caches/codex-host-cua')
        self.assertEqual(installation_from_native_cli(native), result)

    def test_fallback_chatgpt_and_explicit_override(self):
        app, native, _ = fake_app(self.home/'Other Apps', 'ChatGPT.app', preferred=False)
        result = discover_installation({'CODEX_CUA_APP_PATH': str(app)}, self.home, [])
        self.assertEqual(result.native_cli, native)
        self.assertEqual(installation_from_native_cli(native).app_path, app)

    def test_invalid_explicit_override_never_silently_falls_back(self):
        fake_app(self.home/'Applications')
        with self.assertRaises(InstallationError):
            discover_installation({'CODEX_CUA_APP_PATH': str(self.home/'missing.app')}, self.home, [self.home/'Applications'])
        with self.assertRaises(InstallationError):
            discover_installation({'CODEX_CUA_APP_PATH': 'relative.app'}, self.home)

    def test_wrong_bundle_missing_cua_and_arbitrary_cli_fail_closed(self):
        wrong, native, _ = fake_app(self.home/'wrong', bundle_id='fixture.untrusted')
        with self.assertRaises(InstallationError):
            discover_installation({'CODEX_CUA_APP_PATH': str(wrong)})
        with self.assertRaises(InstallationError):
            installation_from_native_cli(native)
        app, native, cua = fake_app(self.home/'valid')
        (cua/'bin/node_repl').unlink()
        with self.assertRaises(InstallationError):
            installation_from_native_cli(native)
        with self.assertRaises(InstallationError):
            installation_from_native_cli(self.home/'unrelated/codex')


if __name__ == '__main__':
    unittest.main()
