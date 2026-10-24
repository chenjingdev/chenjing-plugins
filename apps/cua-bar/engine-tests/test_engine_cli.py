"""The command line of the engine: arguments, the one JSON object on stdout, diagnose text and a real-process smoke test."""
import contextlib
import io
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

import engine_cli
import engine_diagnose
import setup
from engine_core import iso
from engine_support import (APP_VERSION, DECOY, NOW, SESSION_A, SESSION_C, SESSION_D, EngineCase, FakeHost, State, at)
from test_runtime_paths import fake_app

PLUGIN = Path(setup.__file__).resolve().parent
BRIDGE_ID = 'claude-4242-%d' % (NOW-900)


class CliCase(EngineCase):
    def run_cli(self, *arguments, **context):
        """setup.main(arguments) with the engine working on the fake Mac; returns (exit status, stdout)."""
        ctx = self.context(**context)
        out = io.StringIO()
        with patch.object(engine_cli, 'Context', side_effect=lambda *args, **kwargs: ctx), contextlib.redirect_stdout(out):
            status = setup.main(list(arguments))
        return status, out.getvalue()

    def run_json(self, *arguments, **context):
        status, text = self.run_cli(*arguments, **context)
        self.assertEqual(status, 0)
        self.assertTrue(text.endswith('\n') and text.count('\n') == 1, text)       # exactly one line
        return json.loads(text)


class ArgumentTests(CliCase):
    def rejected(self, *arguments):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            setup.main(list(arguments))
        self.assertEqual(caught.exception.code, 2, arguments)

    def test_the_engine_commands_are_registered_with_their_options(self):
        parser_text = io.StringIO()
        with contextlib.redirect_stdout(parser_text), self.assertRaises(SystemExit):
            setup.main(['--help'])
        for name in ('status', 'release', 'release-session', 'stop', 'restart-codex', 'diagnose', '--connection',
                     '--ended', '--session', '--user', '--group', '--force'):
            self.assertIn(name, parser_text.getvalue())
        self.assertEqual(setup.ENGINE_COMMANDS, engine_cli.COMMANDS)

    def test_a_command_needs_exactly_the_arguments_it_is_for(self):
        for arguments in (('release',), ('release', '--connection', 'a', '--ended'), ('release-session',),
                          ('stop',), ('stop', '--connection', 'a', '--group', 'all'), ('stop', '--group', 'nobody'),
                          ('status', '--force'), ('release', '--connection', 'a', '--force'),
                          ('release', '--ended', '--user'), ('stop', '--connection', 'a', '--user'),
                          ('release-session', '--session', 'a', '--force'), ('restart-codex', '--ended'),
                          ('diagnose', '--session', 'a')):
            self.rejected(*arguments)

    def test_the_options_of_the_engine_do_not_leak_into_the_older_commands(self):
        for command in ('doctor', 'start', 'setup', 'uninstall', 'install'):
            for option in (['--force'], ['--user'], ['--ended'], ['--group', 'all'], ['--session', 'x'], ['--connection', 'x']):
                self.rejected(command, *option)


class JsonCommandTests(CliCase):
    def test_status_prints_one_json_object_and_exits_zero(self):
        self.machine.add(5, 1, '/bin/x')
        status = self.run_json('status', '--json')
        self.assertEqual(status['schema_version'], 1)
        self.assertEqual(self.run_json('status')['schema_version'], 1)       # --json is not needed

    def test_work_folders_with_any_characters_survive_as_plain_ascii_json(self):
        self.start_world()
        self.bridge_with_runtime(cwd='/work/프로젝트 "x"\\y')
        status, text = self.run_cli('status', '--json')
        self.assertEqual(status, 0)
        text.encode('ascii')                                     # escaped, so no console encoding can break it
        [connection] = json.loads(text)['connections']
        self.assertEqual(connection['cwd'], '/work/프로젝트 "x"\\y')

    def test_a_failed_action_still_exits_zero_with_ok_false(self):
        self.machine.add(5, 1, '/bin/x')
        self.assertEqual(self.run_json('release', '--connection', 'claude-1-2', '--json'),
                         {'ok': False, 'released': False, 'reason': 'not_found', 'scope_count': 0})
        self.assertEqual(self.run_json('stop', '--connection', 'claude-1-2', '--json'),
                         {'ok': False, 'stopped': False, 'released': False, 'reason': 'not_found'})
        self.assertEqual(self.run_json('release-session', '--session', SESSION_A, '--json'),
                         {'ok': False, 'released': False, 'reason': 'not_found', 'tab_count': None})
        self.assertEqual(self.run_json('release', '--ended', '--json'), {'ok': True, 'results': []})
        self.assertEqual(self.run_json('stop', '--group', 'all', '--json'),
                         {'ok': True, 'stopped': 0, 'failed': 0, 'results': []})

    def test_release_and_stop_arrive_at_the_connection(self):
        self.start_world()
        directory, _ = self.bridge_with_runtime()
        server = self.serve(directory, 4242, NOW-900, lambda request: {'released': True, 'reason': None, 'scope_count': 4})
        self.assertEqual(self.run_json('release', '--connection', BRIDGE_ID, '--json'),
                         {'ok': True, 'released': True, 'reason': None, 'scope_count': 4})
        self.assertEqual(self.run_json('stop', '--connection', BRIDGE_ID, '--force', '--json'),
                         {'ok': True, 'stopped': True, 'released': True, 'reason': None})
        self.assertEqual(len(server.requests), 2)
        self.assertEqual(self.machine.signals, [(4242, signal.SIGTERM)])

    def test_group_stop_and_the_group_name(self):
        self.start_world()
        self.bridge_with_runtime()
        result = self.run_json('stop', '--group', 'codex', '--json')
        self.assertEqual(result, {'ok': True, 'stopped': 0, 'failed': 0, 'results': []})
        result = self.run_json('stop', '--group', 'claude', '--json')
        self.assertEqual((result['stopped'], [item['connection_id'] for item in result['results']]), (1, [BRIDGE_ID]))

    def test_a_cmux_cua_connection_is_stopped_by_the_id_status_shows_and_is_never_released_or_grouped(self):
        self.add_claude(500)
        self.machine.add(3500, 1, self.commands.cmux_serve)
        self.machine.add(3501, 500, self.commands.cmux_mcp, start=NOW-600)
        [client] = self.run_json('status', '--json')['other_tools'][0]['clients']
        self.assertEqual((client['id'], client['pid'], client['mcp_pid'], client['can_stop']),
                         ('cmux-3501-%d' % (NOW-600), 500, 3501, True))
        self.assertEqual(self.run_json('release', '--connection', client['id'], '--json'),
                         {'ok': False, 'released': False, 'reason': 'unsupported', 'scope_count': 0})
        self.assertEqual(self.run_json('stop', '--group', 'all', '--json'), {'ok': True, 'stopped': 0, 'failed': 0, 'results': []})
        self.assertEqual(self.machine.signals, [])
        self.assertEqual(self.run_json('stop', '--connection', client['id'], '--force', '--json'),
                         {'ok': True, 'stopped': True, 'released': False, 'reason': None})
        self.assertEqual(self.machine.signals, [(3501, signal.SIGTERM)])
        self.assertEqual(self.run_json('stop', '--connection', client['id'], '--json')['reason'], 'not_found')

    def test_release_session_passes_the_users_click_on(self):
        import host_mcp
        self.start_world()
        self.host_socket()
        self.chrome_plugin()
        hosts = []

        async def js(params):
            return {'content': [{'type': 'text', 'text': DECOY+'\n@@count 5'}]}

        async def connect(**kwargs):
            hosts.append(FakeHost({'js': js}))
            return hosts[-1]
        self.state.relay('d2', 7101, NOW-5000, scopes=[State.scope(SESSION_C, last=at(1000))], cleanup='open')
        with patch.object(host_mcp, 'unix_connect', AsyncMock(side_effect=connect)):
            self.assertEqual(self.run_json('release-session', '--session', SESSION_C, '--json')['reason'], 'needs_user')
            self.assertEqual(hosts, [])
            result = self.run_json('release-session', '--session', SESSION_C, '--user', '--json')
        self.assertEqual(result, {'ok': True, 'released': True, 'reason': None, 'tab_count': 5})
        self.assertNotIn('TITLE_SENTINEL', json.dumps(result))

    def test_restart_codex_runs_only_the_restart(self):
        self.machine.add(5, 1, '/bin/x')
        self.machine.add(1000, 1, self.commands.app_main)
        self.assertEqual(self.run_json('restart-codex', '--json'), {'ok': True, 'reason': None})
        self.assertEqual(self.machine.signals, [])

    def test_status_does_not_run_the_older_commands_machinery(self):
        self.machine.add(5, 1, '/bin/x')
        with patch.object(setup, 'doctor', side_effect=AssertionError('not doctor')), \
             patch.object(setup, 'start_host', side_effect=AssertionError('not start')):
            self.run_json('status', '--json')


class DiagnoseTests(CliCase):
    def world(self):
        self.start_world()
        self.write_host(relay=False, relay_reason='unknown_field')
        self.bridge_with_runtime(last_call=3000, relay_last_call=3000)
        self.add_runtime(3000, NOW-2000)
        self.state.relay('r2', 3001, NOW-2000, root_pid=3000, runtime_pid=3002, scopes=[State.scope(SESSION_C)])
        self.state.bridge('d1', 7001, NOW-5000, scopes=[State.scope(SESSION_D, last=at(1000))], cleanup='open')
        self.add_claude(501)
        self.machine.add(3500, 1, self.commands.cmux_serve)
        self.machine.add(3501, 501, self.commands.cmux_mcp)
        self.machine.add(3502, 501, self.commands.cmux_mcp)          # a second connection of the same AI client
        self.machine.cwds[501] = str(self.home/'secret-project')
        self.state.activity([State.line('bridge-8001-%d' % (NOW-8000), 400-index, SESSION_A, tool='js', ms=100+index,
                                        ok=index % 2 == 1) for index in range(30)])

    def text(self):
        status, text = self.run_cli('diagnose')
        self.assertEqual(status, 0)
        return text

    def test_a_host_that_a_launcher_older_than_this_setup_started_says_so_on_its_line(self):
        self.world()
        self.write_host(relay=False, older_launcher=True)
        self.assertIn('host: ready since %s, started before this setup' % iso(NOW-300), self.text().splitlines())

    def test_it_reports_versions_states_counts_other_tools_and_the_latest_operations(self):
        self.world()
        text = self.text()
        lines = text.splitlines()
        self.assertEqual(lines[0], 'codex-cua diagnose')
        self.assertIn('plugin: '+self.context().plugin_version(), lines)
        self.assertIn('generated: '+iso(NOW), lines)
        self.assertTrue(any(line.startswith('python: 3.') for line in lines))
        self.assertTrue(any(line.startswith('macos: ') for line in lines))
        self.assertIn('codex app: ~/Applications/Codex.app %s, running (1 process)' % APP_VERSION, lines)
        self.assertIn('host: ready since '+iso(NOW-300), lines)
        self.assertIn('setup: command=ready, dependencies=ready, login_environment=ready, wrapper=ready, relay=inactive', lines)
        self.assertIn('relay left out at the last Codex start: unknown_field', lines)
        self.assertIn('connections: 2 (claude 1, codex 1); active 1, idle 1, ended 0', lines)
        self.assertIn('leases: the list cannot be read; may be left behind: 1 (releasable now: 1)', lines)
        self.assertIn('other tool: cmux-cua running, 1 process, 2 connections (claude 2)', lines)
        operations = lines[lines.index('latest operations (newest first, 20 of 30):')+1:]
        self.assertEqual(len(operations), 20)
        self.assertTrue(all(re.match(r'^  \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ claude js (ok|failed) \d+ ms$', line) for line in operations))
        self.assertTrue(operations[0].endswith('ok 129 ms'))

    def revived(self, repl, relay, bridge_started, rss, **fields):
        """A runtime Codex started again by itself for the thread of a bridge that is long gone."""
        self.add_runtime(repl, NOW-600, rss=rss)
        self.state.relay('r%d' % relay, relay, NOW-600, root_pid=repl, runtime_pid=relay+1, cwd='/work/c22',
                         owner='bridge-%d-%d' % (relay+5000, bridge_started), **fields)

    def test_runtimes_codex_started_again_are_counted_in_plain_words_and_are_no_connection(self):
        self.start_world()
        self.revived(2000, 2001, NOW-5000, (70_000, 20_000, 17_520))
        self.revived(3000, 3001, NOW-9000, (70_000, 20_000, 17_520))
        lines = self.text().splitlines()
        self.assertIn('Codex가 다시 켠 빈 런타임 2개 · 210 MB — 대화가 끝난 것이라 Codex가 곧 내려요', lines)
        self.assertIn('connections: 0 (claude 0, codex 0); active 0, idle 0, ended 0', lines)
        self.assertEqual(lines[lines.index('connections: 0 (claude 0, codex 0); active 0, idle 0, ended 0')+1].split(' ')[0],
                         'Codex가')

    def test_one_such_runtime_is_said_just_as_plainly_and_says_nothing_of_where_it_works(self):
        self.start_world()
        self.revived(2000, 2001, NOW-5000, (100_000, 30_000, 10_000))
        text = self.text()
        self.assertIn('Codex가 다시 켠 빈 런타임 1개 · 137 MB — 대화가 끝난 것이라 Codex가 곧 내려요', text.splitlines())
        self.assertNotIn('/work/c22', text)

    def test_one_that_found_its_bridge_gone_as_it_came_up_is_counted_however_soon_after_the_bridge(self):
        self.start_world()
        self.revived(2000, 2001, NOW-618, (100_000, 30_000, 10_000), owner_running=False)      # 18 s after the bridge
        lines = self.text().splitlines()
        self.assertIn('Codex가 다시 켠 빈 런타임 1개 · 137 MB — 대화가 끝난 것이라 Codex가 곧 내려요', lines)
        self.assertIn('connections: 0 (claude 0, codex 0); active 0, idle 0, ended 0', lines)

    def test_the_same_one_that_found_its_bridge_running_is_an_ended_connection_in_the_counts(self):
        self.start_world()
        self.revived(2000, 2001, NOW-618, (100_000, 30_000, 10_000), owner_running=True)
        lines = self.text().splitlines()
        self.assertIn('connections: 1 (claude 1, codex 0); active 0, idle 0, ended 1', lines)
        self.assertFalse([line for line in lines if '빈 런타임' in line])

    def test_without_one_the_report_has_no_such_line(self):
        self.world()
        self.assertFalse([line for line in self.text().splitlines() if '빈 런타임' in line])

    def test_a_runtime_that_was_used_is_an_ended_connection_in_the_counts_and_not_in_that_line(self):
        self.start_world()
        self.add_runtime(2000, NOW-600)
        self.state.relay('r1', 2001, NOW-600, root_pid=2000, runtime_pid=2002, owner='bridge-7001-%d' % (NOW-5000),
                         last_call_at=iso(at(100)))
        lines = self.text().splitlines()
        self.assertIn('connections: 1 (claude 1, codex 0); active 0, idle 0, ended 1', lines)
        self.assertFalse([line for line in lines if '빈 런타임' in line])

    def test_memory_is_said_in_binary_megabytes_like_the_apps_rows(self):
        self.assertEqual([engine_diagnose._memory(size) for size in (0, 1_048_575, 1_048_576, 215_040*1024, 1023*1_048_576+400_000,
                                                                       1024*1_048_576, 1_700_000*1024)],
                         ['1 MB 미만', '1 MB 미만', '1 MB', '210 MB', '1023 MB', '1.0 GB', '1.6 GB'])

    def test_no_home_folder_url_environment_value_or_private_name_appears(self):
        self.world()
        secrets = {'SECRET_SENTINEL_TOKEN': 'sk-live-12345', 'CODEX_HOST_CUA_NATIVE_CLI': 'ENV_VALUE_SENTINEL'}
        with patch.dict(os.environ, secrets):
            text = self.text()
        for forbidden in (str(self.home), str(self.home.parent), 'secret-project', 'sk-live-12345', 'ENV_VALUE_SENTINEL',
                          'SECRET_SENTINEL_TOKEN', '://', 'TITLE_SENTINEL', os.path.expanduser('~')):
            self.assertNotIn(forbidden, text)
        self.assertNotRegex(text, r'/Users/|/home/|/private/var')
        # Not even the work folders of the connections, which only the app's own list shows.
        folders = {item['cwd'] for item in json.loads(self.run_cli('status')[1])['connections'] if item['cwd']}
        self.assertTrue(folders)
        for folder in folders:
            self.assertNotIn(folder, text)
        self.assertIn('~/Applications/Codex.app', text)     # the app that lives in the home folder is written with ~

    def test_the_home_folder_is_written_as_a_tilde_in_every_spelling(self):
        home = Path('/Users/someone')
        self.assertEqual(engine_diagnose.redact('app /Users/someone/Applications/Codex.app', home), 'app ~/Applications/Codex.app')
        self.assertEqual(engine_diagnose.redact('see https://example.com/a?b=c and unix:///tmp/x.sock!', home),
                         'see [url] and [url]')
        self.assertEqual(engine_diagnose.redact('/Users/someonelse/x and /Users/someone', home), '/Users/someonelse/x and ~')
        self.assertEqual(engine_diagnose.redact('unchanged text', Path('/')), 'unchanged text')

    def test_an_empty_mac_still_gives_a_complete_report(self):
        self.machine.add(5, 1, '/bin/x')
        text = self.text()
        self.assertIn('connections: 0 (claude 0, codex 0); active 0, idle 0, ended 0', text)
        self.assertIn('other tools: none', text)
        self.assertIn('latest operations (newest first, 0 of 0):', text)
        self.assertIn('screen: no call in the last 10 s', text)
        self.assertIn('host: missing', text)

    def test_diagnose_says_how_the_screen_is_used_without_naming_anything(self):
        self.start_world()
        self.bridge_with_runtime(last_call=3, relay_last_call=3)
        self.assertIn('screen: in use by a claude connection', self.text())

    def test_diagnose_reads_what_it_reports_and_changes_nothing(self):
        self.world()
        before = sorted(str(item) for item in self.root.rglob('*'))
        self.text()
        self.assertEqual(sorted(str(item) for item in self.root.rglob('*')), before)


class RealProcessTests(unittest.TestCase):
    """The command as a user runs it, in a real Python process. It reads the real process list (read-only) but every
    folder it may write to or read settings from is temporary."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/tmp', prefix='cx-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root/'home'
        self.home.mkdir()
        self.app, _, _ = fake_app(self.home/'Applications')
        state = self.root/'state'
        state.mkdir(mode=0o700)
        host = self.root/'host'
        host.mkdir(mode=0o700)
        self.environment = {'HOME': str(self.home), 'PATH': '/usr/bin:/bin:/usr/sbin', 'PYTHONDONTWRITEBYTECODE': '1',
                            'CODEX_CUA_STATE_DIR': str(state), 'CODEX_HOST_CUA_STATE_DIR': str(host),
                            'CODEX_CUA_APP_PATH': str(self.app), 'SECRET_SENTINEL': 'ENV_VALUE_SENTINEL'}

    def command(self, *arguments):
        began = time.monotonic()
        result = subprocess.run([sys.executable, str(PLUGIN/'setup.py'), *arguments], env=self.environment,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60, cwd=str(self.root))
        return result, time.monotonic()-began

    def test_status_json_is_valid_contract_json_and_fast(self):
        result, seconds = self.command('status', '--json')
        self.assertEqual((result.returncode, result.stderr), (0, ''))
        status = json.loads(result.stdout)
        self.assertEqual(list(status), ['schema_version', 'generated_at', 'plugin', 'engine', 'codex', 'host', 'setup',
                                        'connections', 'leases', 'other_tools', 'screen', 'activity'])
        self.assertEqual(status['engine'], {'version': status['plugin']['version'], 'root': str(PLUGIN),
                                            'launcher': str(self.home/'.local/share/codex-cua/engine/current/start-mcp.sh')})
        self.assertEqual(status['codex']['app_path'], str(self.app))
        self.assertEqual(status['host'], {'state': 'missing', 'since': None, 'started_before_setup': False,
                                          'engine_version': None, 'relay_reason': None, 'restart_adds_relay': False})
        self.assertEqual(status['leases'], {'readable': False, 'items': [], 'maybe_left': []})
        self.assertEqual(status['setup']['command'], 'missing')         # nothing is installed in the temporary home
        for connection in status['connections']:
            self.assertEqual(sorted(connection), sorted(['id', 'agent', 'state', 'pid', 'owner_pid', 'owner_alive', 'cwd',
                'started_at', 'memory_bytes', 'last_call_at', 'idle_seconds', 'session_id', 'busy', 'can_release', 'can_stop',
                'holds']))
        self.assertLess(seconds, 5)
        self.assertEqual(sorted(item.name for item in self.home.rglob('*') if item.name != 'Applications'
                                and 'Applications' not in item.parts), [])      # nothing was written into the home

    def test_diagnose_is_safe_to_paste(self):
        result, _ = self.command('diagnose')
        self.assertEqual((result.returncode, result.stderr), (0, ''))
        self.assertTrue(result.stdout.startswith('codex-cua diagnose\n'))
        for forbidden in (str(self.home), str(self.root), 'ENV_VALUE_SENTINEL', '://'):
            self.assertNotIn(forbidden, result.stdout)
        self.assertIn('codex app: ~/Applications/Codex.app fixture, not running', result.stdout)

    def test_a_missing_argument_is_an_error_that_does_not_run_anything(self):
        result, _ = self.command('release', '--json')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, '')

    def test_the_older_commands_still_run(self):
        result, _ = self.command('doctor', '--json')
        report = json.loads(result.stdout)
        self.assertEqual((report['plugin_id'], report['installation']), (setup.PLUGIN_ID, 'verified_assets'))

    def test_a_connection_test_without_a_host_ends_at_once_and_starts_and_writes_nothing(self):
        result, seconds = self.command('doctor', '--probe', '--json')
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 1)
        self.assertEqual((report['probe'], report['status']), ({'status': 'host_unavailable'}, 'host_unavailable'))
        self.assertLess(seconds, 10)
        self.assertEqual(sorted(item.name for item in self.home.rglob('*') if item.name != 'Applications'
                                and 'Applications' not in item.parts), [])      # nothing was written into the home
        self.assertEqual(sorted(item.name for item in (self.root/'state').iterdir()), [])
        self.assertEqual(sorted(item.name for item in (self.root/'host').iterdir()), [])


if __name__ == '__main__':
    unittest.main()
