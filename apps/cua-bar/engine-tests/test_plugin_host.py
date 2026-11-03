"""The cuabar Claude Code plugin (0.9.0): its manifest, standing by for CUA Bar, the engine copy it runs, its wording,
its hooks and the unlock recovery its bridge asks for, without a real Claude, Codex or app."""
import asyncio
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import bridge_control
import claude_hook_setup
import claude_lifecycle as lifecycle
import cuabar_host
import host_mcp
import mcp_health
import plugin_host
import plugin_standby
import setup

ENGINE = Path(__file__).resolve().parents[1]/'engine'
PLUGIN = {cuabar_host.HOST_ENV: cuabar_host.PLUGIN}


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((ENGINE/'.claude-plugin/plugin.json').read_text())

    def test_the_plugin_is_cuabar_at_the_version_of_its_bridge(self):
        self.assertEqual(self.manifest['name'], 'cuabar')
        self.assertEqual(self.manifest['version'], host_mcp.VERSION)
        self.assertEqual(self.manifest['version'], plugin_standby.VERSION)

    def test_its_mcp_starts_the_plugin_entry_point_of_this_folder(self):
        server = self.manifest['mcpServers']['cuabar']
        self.assertEqual(server['command'], '${CLAUDE_PLUGIN_ROOT}/plugin-mcp.sh')
        self.assertTrue(os.access(ENGINE/'plugin-mcp.sh', os.X_OK))
        self.assertIn('setup.py" plugin-mcp', (ENGINE/'plugin-mcp.sh').read_text())

    def test_its_hooks_are_the_events_the_app_manages_with_the_plugin_argument(self):
        hooks = self.manifest['hooks']
        self.assertEqual(set(hooks), set(claude_hook_setup.EVENTS))
        for event, groups in hooks.items():
            handlers = [handler for group in groups for handler in group['hooks']]
            self.assertEqual([handler['command'] for handler in handlers],
                             ['"${CLAUDE_PLUGIN_ROOT}/claude-hook.sh" plugin'])
        self.assertEqual(hooks['PreToolUse'][0]['matcher'], '^mcp__plugin_cuabar_cuabar__.*$')

    def test_the_skill_is_in_the_folder(self):
        self.assertIn('name: cuabar', (ENGINE/'skills/cuabar/SKILL.md').read_text())


class NameTests(unittest.TestCase):
    def test_both_hosts_tool_names_give_the_tool(self):
        self.assertEqual(cuabar_host.tool_name('mcp__cuabar__js'), 'js')
        self.assertEqual(cuabar_host.tool_name('mcp__plugin_cuabar_cuabar__turn_ended'), 'turn_ended')
        for name in ('mcp__cuabar__', 'mcp__plugin_cua_cua__js', 'mcp__cuabarx__js', None, 3):
            self.assertIsNone(cuabar_host.tool_name(name))

    def test_the_reconnect_command_names_the_server_of_the_host(self):
        self.assertEqual(cuabar_host.reconnect_command({}), '/mcp reconnect cuabar')
        self.assertEqual(cuabar_host.reconnect_command(PLUGIN), '/mcp reconnect plugin:cuabar:cuabar')

    def test_every_plugin_wording_still_finds_its_app_text(self):
        app = ' '.join(host_mcp.host_text(text, plugin=False)
                       for text in (host_mcp.INSTRUCTIONS, host_mcp.HOST_NOTE, host_mcp.UPDATE_CLOSING))
        for old, _ in host_mcp.PLUGIN_WORDING:
            self.assertIn(old, app)
        plugin = host_mcp.host_text(app, plugin=True)
        self.assertNotIn('/mcp reconnect cuabar', plugin)
        self.assertNotIn('`repair`', plugin)
        self.assertNotIn('through CUA Bar.', plugin)
        self.assertIn('/mcp reconnect plugin:cuabar:cuabar', plugin)


class StandbyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.ps = SimpleNamespace(stdout='/usr/sbin/cfprefsd\n/Applications/Other.app/Contents/MacOS/other\n')

    def reason(self, environment=None):
        return plugin_host.standby_reason(self.home, environment or {}, run=self.run_ps)

    def run_ps(self, *arguments, **options):
        return self.ps

    def test_nothing_of_the_app_means_the_plugin_serves(self):
        self.assertIsNone(self.reason())
        (self.home/'.claude.json').write_text(json.dumps({'mcpServers': {'other': {}}}))
        self.assertIsNone(self.reason())

    def test_the_apps_user_mcp_makes_the_plugin_stand_by(self):
        (self.home/'.claude.json').write_text(json.dumps({'mcpServers': {'cuabar': {'command': 'x'}}}))
        self.assertEqual(self.reason(), 'app_mcp')

    def test_the_claude_config_dir_holds_the_claude_json_it_reads(self):
        profile = self.home/'profile'
        profile.mkdir()
        (profile/'.claude.json').write_text(json.dumps({'mcpServers': {'cuabar': {}}}))
        self.assertIsNone(self.reason())
        self.assertEqual(self.reason({'CLAUDE_CONFIG_DIR': str(profile)}), 'app_mcp')

    def test_a_running_app_makes_the_plugin_stand_by(self):
        self.ps = SimpleNamespace(stdout='/Users/x/Applications/CUABar.app/Contents/MacOS/cua-bar\n')
        self.assertEqual(self.reason(), 'app_running')

    def test_an_unreadable_claude_json_or_process_list_is_no_reason(self):
        (self.home/'.claude.json').write_text('{broken')
        def refuse(*arguments, **options):
            raise OSError
        self.assertIsNone(plugin_host.standby_reason(self.home, {}, run=refuse))

    def test_the_standby_server_has_no_tools_and_says_why(self):
        text = plugin_standby.instructions('app_mcp')
        reply = plugin_standby.answer({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
                                       'params': {'protocolVersion': '2025-11-25'}}, text)
        self.assertEqual(reply['result']['protocolVersion'], '2025-11-25')
        self.assertIn('claude mcp remove -s user cuabar', reply['result']['instructions'])
        self.assertEqual(plugin_standby.answer({'id': 2, 'method': 'tools/list'}, text)['result'], {'tools': []})
        self.assertEqual(plugin_standby.answer({'id': 3, 'method': 'ping'}, text)['result'], {})
        self.assertIsNone(plugin_standby.answer({'method': 'notifications/initialized'}, text))
        self.assertEqual(plugin_standby.answer({'id': 4, 'method': 'tools/call'}, text)['error']['code'], -32601)
        self.assertIn('Reason: no venv', plugin_standby.instructions('setup_failed', 'no venv'))

    def test_the_standby_process_answers_on_stdout_until_stdin_closes(self):
        lines = '\n'.join(json.dumps(message) for message in (
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}},
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'})) + '\n'
        result = subprocess.run(['/usr/bin/python3', '-B', str(ENGINE/'plugin_standby.py'), 'app_running'],
                                input=lines, capture_output=True, text=True, timeout=10)
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([reply['id'] for reply in replies], [1, 2])
        self.assertEqual(replies[1]['result'], {'tools': []})


class EngineRootTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.engines = self.home/'.local/share/codex-cua/engine'
        self.engines.mkdir(parents=True)
        self.plugin = self.engine(self.home/'cache/cuabar/0.9.0', '0.9.0')
        self.ctx = SimpleNamespace(setup=setup, home=self.home)

    def engine(self, folder, version):
        (folder/'.claude-plugin').mkdir(parents=True)
        (folder/'.claude-plugin/plugin.json').write_text(json.dumps({'name': 'cuabar', 'version': version}))
        for name in ('setup.py', 'runtime_paths.py', 'start-mcp.sh'):
            (folder/name).write_text('')
        return folder

    def root(self):
        with patch('engine_install.install_engine', return_value={'root': '/installed'}) as install:
            root = plugin_host.engine_root(self.ctx, self.plugin)
        return root, install

    def test_this_version_is_installed_without_the_apps_hooks(self):
        root, install = self.root()
        self.assertEqual(root, Path('/installed'))
        install.assert_called_once_with(self.ctx, self.plugin, claude_hooks=False)

    def test_an_older_or_equal_current_is_installed_over(self):
        for version in ('0.8.18', '0.9.0'):
            with self.subTest(version=version):
                self.engine(self.engines/version, version)
                (self.engines/'current').unlink(missing_ok=True)
                (self.engines/'current').symlink_to(version)
                self.assertEqual(self.root()[0], Path('/installed'))

    def test_a_newer_current_runs_instead_and_is_never_moved_back(self):
        newer = self.engine(self.engines/'0.9.1', '0.9.1')
        (self.engines/'current').symlink_to('0.9.1')
        root, install = self.root()
        self.assertEqual(root, newer.resolve())
        install.assert_not_called()

    def test_a_broken_newer_current_is_installed_over(self):
        (self.engines/'0.9.1').mkdir()
        (self.engines/'current').symlink_to('0.9.1')
        self.assertEqual(self.root()[0], Path('/installed'))

    def test_setup_leaves_the_apps_hooks_out_when_asked(self):
        with patch.object(setup, 'install_command', return_value='cmd'), \
                patch.object(setup, 'install_login', return_value=('ready', ('ready', None))), \
                patch.object(setup, 'relay_status', return_value='ready'), \
                patch('claude_hook_setup.claude_available', return_value=True), \
                patch('claude_hook_profiles.configure_profile') as configure:
            setup.run_setup(self.plugin, self.home, {}, claude_hooks=False)
            configure.assert_not_called()
            setup.run_setup(self.plugin, self.home, {})
            configure.assert_called_once()


class HealthTests(unittest.TestCase):
    def test_the_plugin_has_no_repair_tool(self):
        self.assertEqual([spec['name'] for spec in mcp_health.tool_specs({})], ['status', 'repair'])
        self.assertEqual([spec['name'] for spec in mcp_health.tool_specs(PLUGIN)], ['status'])

    def test_the_plugins_hooks_count_as_ready_unless_hooks_are_off(self):
        for state, expected in (('ready', 'plugin'), ('missing', 'plugin'), ('disabled', 'disabled'),
                                ('conflict', 'conflict')):
            with self.subTest(state=state), patch.object(mcp_health, 'inspect_hooks', return_value=state):
                self.assertEqual(mcp_health._hooks(Path('/h'), PLUGIN), expected)
                self.assertEqual(mcp_health._hooks(Path('/h'), {}), state)


class UnlockTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory(dir='/tmp', prefix='pu')
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name).resolve()/'state'
        self.control = bridge_control.BridgeControl(SimpleNamespace(), state=self.state)
        self.control.UNLOCK_RESET_DELAY = 0
        self.control.writer_id = 'bridge-1-2'

    async def calls(self, environment, error):
        with patch.dict(os.environ, environment), patch.object(bridge_control.subprocess, 'Popen') as popen:
            self.control.record_call('js', False, 5, 'session', True, error)
            await asyncio.sleep(0.05)
        return popen.call_args_list

    async def test_the_plugins_bridge_asks_unlock_reset_after_an_unlock_failure(self):
        calls = await self.calls(PLUGIN, 'unlock_failed')
        self.assertEqual(len(calls), 1)
        command = calls[0].args[0]
        self.assertEqual(command[1:], [str(ENGINE/'setup.py'), 'unlock-reset', '--json'])
        self.assertTrue(calls[0].kwargs['start_new_session'])

    async def test_nothing_else_and_no_app_bridge_asks(self):
        self.assertEqual(await self.calls(PLUGIN, 'screen_locked'), [])
        self.assertEqual(await self.calls({cuabar_host.HOST_ENV: ''}, 'unlock_failed'), [])


class HookTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir='/tmp', prefix='ph')
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name).resolve()
        self.state.chmod(0o700)

    def test_the_plugins_tool_names_bind_like_the_apps(self):
        payload = {'hook_event_name': 'PreToolUse', 'session_id': 'claude-one', 'prompt_id': 'p',
                   'tool_use_id': 'toolu_one'}
        for name in ('mcp__plugin_cuabar_cuabar__js', 'mcp__cuabar__js_reset', 'mcp__plugin_cuabar_cuabar__turn_ended'):
            self.assertTrue(lifecycle.bind_call(self.state, (42, 7), dict(payload, tool_name=name)))
        self.assertFalse(lifecycle.bind_call(self.state, (42, 7), dict(payload, tool_name='mcp__plugin_cuabar_cuabar__status')))

    def run_hook(self, event, app_hooks):
        stdin = SimpleNamespace(buffer=io.BytesIO(json.dumps({'hook_event_name': event, 'session_id': 's'}).encode()))
        with patch.object(lifecycle.sys, 'stdin', stdin), patch.dict(os.environ, {cuabar_host.HOST_ENV: ''}), \
                patch.object(lifecycle, 'app_hooks_present', return_value=app_hooks), \
                patch.object(lifecycle, 'hook_owner', return_value=None) as owner:
            self.assertEqual(lifecycle.main(['plugin']), 0)
            return owner.called, os.environ.get(cuabar_host.HOST_ENV)

    def test_the_plugins_end_hooks_stay_quiet_while_the_apps_hooks_are_there(self):
        self.assertEqual(self.run_hook('Stop', app_hooks=True), (False, ''))
        self.assertEqual(self.run_hook('Stop', app_hooks=False), (True, 'plugin'))

    def test_the_plugins_pretooluse_binds_even_beside_the_apps_hooks(self):
        # The app's PreToolUse matcher names only mcp__cuabar__ tools.
        self.assertEqual(self.run_hook('PreToolUse', app_hooks=True), (True, 'plugin'))


if __name__ == '__main__':
    unittest.main()
