"""The status the menu bar app reads: every contract field, attribution of runtimes, states, leases and activity."""
import json
import os
import re
import shutil
import unittest

import engine_records
import engine_status
from engine_core import iso
from engine_support import (ABSENT, APP_VERSION, ENGINE_PID, NOW, SESSION_A, SESSION_B, SESSION_C, SESSION_D, UID,
                            EngineCase, State, at)

TOP_KEYS = ['schema_version', 'generated_at', 'plugin', 'engine', 'codex', 'host', 'setup', 'connections', 'leases',
            'other_tools', 'screen', 'settings', 'activity']
CONNECTION_KEYS = ['id', 'agent', 'state', 'pid', 'owner_pid', 'owner_alive', 'cwd', 'started_at', 'memory_bytes',
                   'last_call_at', 'idle_seconds', 'session_id', 'busy', 'can_release', 'can_stop', 'holds']
CMUX_CLIENT_KEYS = ['id', 'pid', 'mcp_pid', 'agent', 'cwd', 'started_at', 'can_stop']
TIME = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')


class StatusCase(EngineCase):
    def status(self, **settings):
        return engine_status.status(self.context(**settings))

    @staticmethod
    def find(status, connection_id):
        return next(item for item in status['connections'] if item['id'] == connection_id)


class ShapeTests(StatusCase):
    def test_an_empty_mac_has_exactly_the_contract_keys_and_nulls(self):
        self.machine.add(5, 1, '/bin/x')
        status = self.status(application_roots=[self.home/'Nowhere'])
        self.assertEqual(list(status), TOP_KEYS)
        self.assertEqual(status['schema_version'], 1)
        self.assertEqual(status['generated_at'], iso(NOW))
        self.assertEqual(status['plugin'], {'version': json.loads(
            (self.context().plugin_root/'.claude-plugin/plugin.json').read_text())['version']})
        manifest = json.loads((self.context().plugin_root/'.claude-plugin/plugin.json').read_text())
        self.assertEqual(status['engine'], {'version': manifest['version'], 'root': str(self.context().plugin_root),
                                            'launcher': str(self.home/'.local/share/codex-cua/engine/current/start-mcp.sh')})
        self.assertEqual(status['engine']['version'], status['plugin']['version'])
        self.assertEqual(status['codex'], {'installed': False, 'app_path': None, 'app_version': None, 'running': False,
                                           'pids': []})
        self.assertEqual(status['host'], {'state': 'missing', 'since': None, 'started_before_setup': False,
                                          'engine_version': None, 'relay_reason': None, 'restart_adds_relay': False})
        self.assertEqual(list(status['setup']), ['command', 'dependencies', 'login_environment', 'shell_environment',
                                                 'shell_file', 'wrapper', 'relay'])
        self.assertEqual(status['connections'], [])
        self.assertEqual(status['leases'], {'readable': False, 'items': [], 'maybe_left': [], 'release_blocked': False})
        self.assertEqual(status['other_tools'], [])
        self.assertEqual(status['screen'], {'active_connection_id': None, 'last_call_at': None})
        self.assertEqual(status['settings'], {'error_text': False})
        self.assertEqual(status['activity'], [])
        json.dumps(status)

    def test_a_full_world_fills_every_field_with_the_right_type(self):
        self.start_world()
        bridge_dir, relay_dir = self.bridge_with_runtime()
        self.serve(bridge_dir, 4242, NOW-900, lambda request: {'released': True})
        self.add_runtime(3000, NOW-2000)
        self.state.relay('r2', 3001, NOW-2000, root_pid=3000, runtime_pid=3002, scopes=[State.scope(SESSION_B)])
        self.add_runtime(4000, NOW-5000, relay=False)
        self.machine.cwds[4000] = '/work/unrecorded'
        status = self.status()
        self.assertEqual(status['codex'], {'installed': True, 'app_path': str(self.app), 'app_version': APP_VERSION,
                                           'running': True, 'pids': [1000]})
        self.assertEqual(status['host'], {'state': 'ready', 'since': iso(NOW-300), 'started_before_setup': False,
                                          'engine_version': self.engine_version(), 'relay_reason': None, 'restart_adds_relay': False})
        self.assertEqual(status['setup'], {'command': 'ready', 'dependencies': 'ready', 'login_environment': 'ready',
                                           'shell_environment': 'ready', 'shell_file': str(self.home/'.zshenv'),
                                           'wrapper': 'ready', 'relay': 'active'})
        for connection in status['connections']:
            self.assertEqual(list(connection), CONNECTION_KEYS)
            self.assertIn(connection['agent'], ('claude', 'codex'))
            self.assertIn(connection['state'], ('active', 'idle', 'ended'))
            self.assertTrue(re.match(r'^(claude|codex)-\d+-\d+$', connection['id']))
            self.assertTrue(TIME.match(connection['started_at']))
            for key in ('pid', 'memory_bytes'):
                self.assertIsInstance(connection[key], int)
            for key in ('owner_alive', 'busy', 'can_release', 'can_stop'):
                self.assertIsInstance(connection[key], bool)
            self.assertTrue(connection['last_call_at'] is None or TIME.match(connection['last_call_at']))
        self.assertEqual([item['agent'] for item in status['connections']], ['claude', 'codex', 'codex'])
        json.dumps(status)

    def test_status_reads_and_writes_nothing_when_there_is_nothing_to_clean_up(self):
        self.start_world()
        self.bridge_with_runtime()
        self.machine.cwds[4242] = '/work/x'
        before = sorted(str(item) for item in self.root.rglob('*'))
        self.status()
        self.assertEqual(sorted(str(item) for item in self.root.rglob('*')), before)

    def test_a_setup_check_that_fails_does_not_fail_the_status(self):
        def broken(ctx):
            raise OSError('launchctl is not there')
        self.machine.add(5, 1, '/bin/x')
        setup_section = self.status(checks=broken)['setup']
        self.assertEqual(setup_section, {'command': 'missing', 'dependencies': 'missing', 'login_environment': 'unknown',
                                         'shell_environment': 'unknown', 'shell_file': None, 'wrapper': 'broken',
                                         'relay': 'unavailable'})

    def test_the_actions_do_not_run_the_setup_checks(self):
        import engine_actions
        self.machine.add(5, 1, '/bin/x')

        def never(ctx):
            raise AssertionError('the setup checks are for the status only')
        engine_actions.release_connection(self.context(checks=never), 'claude-1-2')
        engine_actions.stop_group(self.context(checks=never), 'all')
        engine_actions.release_ended(self.context(checks=never))

    def test_host_codex_and_setup_sections(self):
        self.machine.add(5, 1, '/bin/x')
        status = self.status()
        self.assertEqual((status['codex']['installed'], status['codex']['running'], status['codex']['pids']),
                         (True, False, []))
        self.assertEqual(status['host']['state'], 'missing')
        self.start_world(relay=False)
        self.assertEqual(self.status()['setup']['relay'], 'inactive')
        self.machine.remove(1000)               # the host's wrapper (here also the app) is gone
        self.assertEqual(self.status()['host']['state'], 'closed')


class HostStartTests(StatusCase):
    def test_a_codex_that_opened_moments_ago_is_still_starting_its_host(self):
        self.machine.add(1000, 1, self.commands.app_main, start=NOW-10)
        self.write_host(status='closed')
        self.assertEqual(self.status()['host']['state'], 'starting')
        self.machine.procs[1000]['start'] = NOW-31
        self.assertEqual(self.status()['host']['state'], 'closed')

    def test_without_a_codex_or_with_a_ready_host_nothing_changes(self):
        self.machine.add(5, 1, '/bin/x')
        self.write_host(status='closed')
        self.assertEqual(self.status()['host']['state'], 'closed')
        self.machine.add(1000, 1, self.commands.app_main, start=NOW-5)
        self.machine.add(1100, 1000, self.commands.app_server, start=NOW-4)
        self.machine.add(1200, 1000, '/usr/bin/python3 unix_ws_stdio.py --socket x', start=NOW-4)
        self.write_host(status='ready')
        self.assertEqual(self.status()['host']['state'], 'ready')


class HostStopTests(StatusCase):
    def test_a_codex_whose_host_closed_moments_ago_is_still_quitting(self):
        self.machine.add(1000, 1, self.commands.app_main, start=NOW-7200)
        self.write_host(status='closed', age=5)
        self.assertEqual(self.status()['host']['state'], 'stopping')
        self.write_host(status='closed', age=31)
        self.assertEqual(self.status()['host']['state'], 'closed')

    def test_a_gone_codex_or_a_host_that_never_was_is_not_quitting(self):
        self.machine.add(5, 1, '/bin/x')
        self.write_host(status='closed', age=5)
        self.assertEqual(self.status()['host']['state'], 'closed')
        (self.host_dir/'host.json').unlink()
        self.machine.add(1000, 1, self.commands.app_main, start=NOW-7200)
        self.assertEqual(self.status()['host']['state'], 'missing')

    def long_connected_codex(self):
        """Codex 1000 with its wrapper 1001, app-server 1100 and proxy 1200, all started 7 hours ago; the wrapper wrote
        `ready` then and has written nothing since."""
        self.machine.add(1000, 1, self.commands.app_main, start=NOW-7*3600)
        self.machine.add(1001, 1000, '/usr/bin/python3 desktop_cli_wrapper.py', start=NOW-7*3600)
        self.machine.add(1100, 1001, self.commands.app_server, start=NOW-7*3600)
        self.machine.add(1200, 1001, self.commands.host_proxy, start=NOW-7*3600)
        self.write_host(owner=1001, age=7*3600)

    def test_a_codex_that_was_connected_for_hours_is_quitting_all_the_way_down(self):
        # S2, the fourth round: the wrapper ends the app-server and the proxy before it writes `closed`, and the file
        # of a host that has been ready for hours gives no grace.
        self.long_connected_codex()
        self.assertEqual(self.status()['host']['state'], 'ready')
        self.machine.remove(1200)                       # the app let go of its proxy: Codex is quitting
        self.assertEqual(self.status()['host'], {'state': 'stopping', 'since': None, 'started_before_setup': False,
                                                 'engine_version': self.engine_version(), 'relay_reason': None, 'restart_adds_relay': False})
        self.machine.remove(1100)                       # the wrapper ended the app-server
        self.assertEqual(self.status()['host']['state'], 'stopping')
        self.machine.remove(1001)                       # the wrapper wrote `closed` and ended; Codex is still quitting
        self.write_host(status='closed', owner=1001, age=2)
        self.assertEqual(self.status()['host']['state'], 'stopping')
        self.machine.now = NOW+40                       # and a Codex that is still here much later has no host
        self.assertEqual(self.status()['host']['state'], 'closed')

    def test_a_wrapper_that_wrote_stopping_keeps_the_host_quitting_until_the_grace_is_over(self):
        self.long_connected_codex()
        for pid in (1100, 1200):
            self.machine.remove(pid)
        self.write_host(status='stopping', owner=1001, stopping_at=iso(NOW-5), age=5)
        self.assertEqual(self.status()['host'], {'state': 'stopping', 'since': iso(NOW-5), 'started_before_setup': False,
                                                 'engine_version': self.engine_version(), 'relay_reason': None, 'restart_adds_relay': False})
        self.machine.now = NOW+30                       # 35 s after it began, and the wrapper is still there
        self.assertEqual(self.status()['host']['state'], 'closed')

    def test_a_codex_whose_wrapper_ended_without_a_word_has_no_host(self):
        self.long_connected_codex()
        self.machine.remove(1001)                       # `ready` is all the file says, and nothing will say more
        self.assertEqual(self.status()['host']['state'], 'closed')
        for pid in (1100, 1200):
            self.machine.remove(pid)
        self.assertEqual(self.status()['host']['state'], 'closed')


class StartedBeforeSetupTests(StatusCase):
    def test_a_host_from_an_older_launcher_says_a_restart_applies_the_setup(self):
        self.machine.add(5, 1, '/bin/x')
        self.start_world()
        self.write_host(relay=True, older_launcher=True)
        self.assertIs(self.status()['host']['started_before_setup'], True)
        # Without its relay too (S8: the Codex from before the relay).
        self.write_host(relay=False, older_launcher=True)
        self.assertIs(self.status()['host']['started_before_setup'], True)

    def test_a_host_from_this_launcher_or_no_ready_host_says_nothing(self):
        self.machine.add(5, 1, '/bin/x')
        self.start_world()
        self.assertIs(self.status()['host']['started_before_setup'], False)
        self.write_host(relay=False, relay_reason='stable_copy')
        self.assertIs(self.status()['host']['started_before_setup'], False, 'a restart would not change it')
        self.write_host(status='closed', older_launcher=True)
        self.assertIs(self.status()['host']['started_before_setup'], False)
        self.write_host(status='closed', engine_version='0.0.1')
        self.assertIs(self.status()['host']['started_before_setup'], False, 'only a ready host is running anything')

    def test_a_host_whose_launcher_did_not_write_its_engine_version_says_a_restart_applies_the_setup(self):
        # The launcher of 0.7.0 already wrote the relay table (relay_config) but not the version of its engine.
        self.machine.add(5, 1, '/bin/x')
        self.start_world()
        for label, version in (('no such key', ABSENT), ('null: the launcher could not read its manifest', None),
                               ('empty', ''), ('not a version', 7), ('not text either', ['0.8.0'])):
            with self.subTest(label):
                self.write_host(relay=True, engine_version=version)
                host = self.status()['host']
                self.assertIs(host['started_before_setup'], True)
                self.assertIsNone(host['engine_version'], 'a value that is no version is not passed on')

    def test_a_host_started_by_another_version_of_the_engine_says_a_restart_applies_the_setup(self):
        # Versions of one line (0.8.x) differ in what the launcher does, so the version is compared as a whole.
        engine = self.root/'engine-0.8.1'
        (engine/'.claude-plugin').mkdir(parents=True)
        (engine/'.claude-plugin/plugin.json').write_text(json.dumps({'name': 'cua', 'version': '0.8.1'}))
        self.machine.add(5, 1, '/bin/x')
        self.start_world()
        for version, expected in (('0.8.0', True), ('0.8.1', False), ('0.8.10', True), ('0.8.1-beta', True),
                                  ('0.9.0', True), ('0.7.0', True), ('0.8.1 ', True)):
            with self.subTest(version):
                self.write_host(relay=True, engine_version=version)
                host = self.status(plugin_root=engine)['host']
                self.assertIs(host['started_before_setup'], expected)
                self.assertEqual(host['engine_version'], version)

    def test_a_relay_less_host_of_this_engine_says_nothing_and_a_missing_table_still_says_it(self):
        # The table and the version are two reasons; each alone is enough, and neither is when both are in order.
        self.machine.add(5, 1, '/bin/x')
        self.start_world()
        self.write_host(relay=False)
        self.assertIs(self.status()['host']['started_before_setup'], False)
        self.write_host(relay=False, relay_config=ABSENT)
        self.assertIs(self.status()['host']['started_before_setup'], True)
        self.write_host(relay=False, relay_config=ABSENT, engine_version='0.0.1')
        self.assertIs(self.status()['host']['started_before_setup'], True)

    def test_the_engine_version_of_the_host_is_told_only_while_a_host_runs(self):
        self.machine.add(5, 1, '/bin/x')
        self.assertIsNone(self.status()['host']['engine_version'], 'no host record at all')
        self.start_world()
        for state in ('ready', 'starting'):
            with self.subTest(state):
                self.write_host(status=state, engine_version='0.8.0')
                self.assertEqual(self.status()['host']['engine_version'], '0.8.0')
        self.write_host(status='closed', engine_version='0.8.0')
        self.assertIsNone(self.status()['host']['engine_version'], 'a host that is gone has no version to tell')
        (self.host_dir/'host.json').write_text('{"schema_version": 1}')
        self.assertIsNone(self.status()['host']['engine_version'])


class RelaySetupTests(StatusCase):
    def relay_state(self, host_ready, relay, files):
        self.machine.add(5, 1, '/bin/x')
        if host_ready:
            self.start_world(relay=relay)
        elif relay is not None:
            self.write_host(status='closed', relay=relay)
        return self.status(checks=lambda ctx: {**self.default_checks(ctx), 'relay_files': files})['setup']['relay']

    def test_active_when_the_running_host_started_the_relay_even_if_the_copy_is_gone_since(self):
        self.assertEqual(self.relay_state(True, True, 'ready'), 'active')
        self.assertEqual(self.relay_state(True, True, 'missing'), 'active')

    def test_unavailable_when_the_stable_copy_is_missing_or_invalid_and_the_host_does_not_use_it(self):
        for files in ('missing', 'invalid'):
            self.assertEqual(self.relay_state(True, False, files), 'unavailable')
            self.assertEqual(self.relay_state(False, None, files), 'unavailable')

    def test_inactive_when_the_host_runs_without_the_relay_or_there_is_no_host(self):
        self.assertEqual(self.relay_state(True, False, 'ready'), 'inactive')
        self.assertEqual(self.relay_state(False, None, 'ready'), 'inactive')

    def test_a_relay_flag_of_a_closed_host_is_not_active(self):
        self.assertEqual(self.relay_state(False, True, 'ready'), 'inactive')

    def test_a_host_that_went_without_the_relay_says_why_and_whether_a_restart_brings_it(self):
        """The first start after a Codex update: Codex writes its copy of the computer-use plugin a few seconds after the
        launcher looked for it (plugin_entry). Once the copy is there, the next start has the relay."""
        self.machine.add(5, 1, '/bin/x')
        self.start_world(relay=False)
        self.write_host(relay=False, relay_reason='plugin_entry')
        host = lambda: {key: self.status()['host'][key] for key in ('relay_reason', 'restart_adds_relay')}
        self.assertEqual(host(), {'relay_reason': 'plugin_entry', 'restart_adds_relay': False})
        plugin = self.home/'.codex/plugins/cache/openai-bundled/unified-computer-use'/APP_VERSION
        (plugin/'.codex-plugin').mkdir(parents=True)
        (plugin/'.codex-plugin/plugin.json').write_text(json.dumps({'name': 'computer-use', 'version': APP_VERSION}))
        self.assertEqual(host()['restart_adds_relay'], False, 'half written')
        (plugin/'.mcp.json').write_text('{}')
        self.assertEqual(host(), {'relay_reason': 'plugin_entry', 'restart_adds_relay': True})
        # A copy the launcher (pid 1000 here) refused for a lasting cause brings nothing: one that was there before it
        # started, one others may write, one of another version. The hint would stay through every restart.
        launched = NOW-7200
        for name in ('.codex-plugin/plugin.json', '.mcp.json'):
            os.utime(plugin/name, (launched-60, launched-60))
        self.assertEqual(host()['restart_adds_relay'], False, 'there before the launcher looked')
        os.utime(plugin/'.mcp.json', (launched+12, launched+12))
        self.assertEqual(host()['restart_adds_relay'], True, 'written since, even if only in part')
        (plugin/'.mcp.json').chmod(0o664)
        self.assertEqual(host()['restart_adds_relay'], False, 'others may write it')
        (plugin/'.mcp.json').chmod(0o644)
        (plugin/'.codex-plugin/plugin.json').write_text(json.dumps({'name': 'computer-use', 'version': '1.0'}))
        self.assertEqual(host()['restart_adds_relay'], False, 'of another version')
        (plugin/'.codex-plugin/plugin.json').write_text(json.dumps({'name': 'computer-use', 'version': APP_VERSION}))
        self.assertEqual(host()['restart_adds_relay'], True)
        self.write_host(relay=False, relay_reason='plugin_entry', owner=4999)
        self.assertEqual(host()['restart_adds_relay'], False, 'a launcher that is gone cannot be compared')
        self.write_host(relay=False, relay_reason='not_bundled')       # a copy that says no bundled server: a restart changes nothing
        self.assertEqual(host(), {'relay_reason': 'not_bundled', 'restart_adds_relay': False})
        self.write_host(relay=True)
        self.assertEqual(host(), {'relay_reason': None, 'restart_adds_relay': False})

    def test_a_host_of_an_older_launcher_that_did_not_know_the_preloading_bundled_server_gets_the_relay_by_a_restart(self):
        """Codex 26.1023 starts the bundled runtime as `node --import …/require-browser-access.mjs …/cua-repl.mjs`. A
        launcher from before 0.8.7 took that for another server (not_bundled); this engine's launcher takes it."""
        self.machine.add(5, 1, '/bin/x')
        self.start_world(relay=False)
        cua = self.app/'Contents/Resources/cua_node'
        plugin = self.home/'.codex/plugins/cache/openai-bundled/unified-computer-use'/APP_VERSION
        module = (plugin/'require-browser-access.mjs').as_uri()
        script = str(cua/'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')
        host = lambda: {key: self.status()['host'][key] for key in ('relay_reason', 'restart_adds_relay')}

        def old_launcher_host():
            self.write_host(relay=False, relay_reason='not_bundled', engine_version='0.8.6')

        def copy(args=None, **changes):
            entry = {'command': str(cua/'bin/node'), 'args': [ '--import', module, script] if args is None else args,
                     'env': {'CUA_REPL_NODE_REPL_PATH': str(cua/'bin/node_repl')}}
            entry.update(changes)
            (plugin/'.codex-plugin').mkdir(parents=True, exist_ok=True)
            (plugin/'.codex-plugin/plugin.json').write_text(json.dumps({'name': 'unified-computer-use', 'version': APP_VERSION}))
            (plugin/'.mcp.json').write_text(json.dumps({'mcpServers': {'cua_repl': entry}}))
            os.chmod(plugin/'.mcp.json', 0o644)
        old_launcher_host()
        self.assertEqual(host(), {'relay_reason': 'not_bundled', 'restart_adds_relay': False}, 'no copy of the plugin to go by')
        copy()
        self.assertEqual(host(), {'relay_reason': 'not_bundled', 'restart_adds_relay': True})
        copy(args=['--import=' + module, script])
        self.assertEqual(host()['restart_adds_relay'], True)
        # Only the new form: the old one was taken by the old launcher too, so a restart would refuse it for the same cause.
        copy(args=[script])
        self.assertEqual(host()['restart_adds_relay'], False)
        for label, args in (('another module', ['--import', 'file:///tmp/require-browser-access.mjs', script]),
                            ('another option', ['--inspect', '--import', module, script]),
                            ('two modules', ['--import', module, '--import', module, script]),
                            ('another script', ['--import', module, '/elsewhere/cua-repl.mjs'])):
            copy(args=args)
            self.assertEqual(host()['restart_adds_relay'], False, label)
        copy(command='/usr/bin/node')
        self.assertEqual(host()['restart_adds_relay'], False, 'another node')
        copy(env={'CUA_REPL_NODE_REPL_PATH': '/elsewhere/node_repl'})
        self.assertEqual(host()['restart_adds_relay'], False, 'another runtime')
        copy()
        os.chmod(plugin/'.mcp.json', 0o666)
        self.assertEqual(host()['restart_adds_relay'], False, 'others may write the file')
        os.chmod(plugin/'.mcp.json', 0o644)
        self.assertEqual(host()['restart_adds_relay'], True)
        # A host that the launcher of this engine started, with a copy that was there before the launcher looked, is
        # refused for a cause a restart does not change (a copy written since is the next test).
        launched = NOW-7200
        os.utime(plugin/'.mcp.json', (launched-60, launched-60))
        self.write_host(relay=False, relay_reason='not_bundled')
        self.assertEqual(host()['restart_adds_relay'], False)
        # A host without the version, or with the relay, or with another reason, is not this case.
        self.write_host(relay=False, relay_reason='not_bundled', older_launcher=True)
        self.assertEqual(host()['restart_adds_relay'], True)
        self.write_host(relay=False, relay_reason='unknown_field', engine_version='0.8.6')
        self.assertEqual(host()['restart_adds_relay'], False)
        self.write_host(relay=True, engine_version='0.8.6')
        self.assertEqual(host(), {'relay_reason': None, 'restart_adds_relay': False})

    def test_a_host_that_read_the_definition_before_codex_wrote_its_copy_for_the_new_version_gets_the_relay_by_a_restart(self):
        """The first start after a Codex update (0.8.9): the launcher of this engine read Codex's definition of the server
        while it still named the module of the version before (`plugin_updating`; `not_bundled` from a launcher that
        had no word for it). Codex wrote its copy for the new version seconds later; the next start reads that."""
        self.machine.add(5, 1, '/bin/x')
        self.start_world(relay=False)
        cua = self.app/'Contents/Resources/cua_node'
        plugin = self.home/'.codex/plugins/cache/openai-bundled/unified-computer-use'/APP_VERSION
        module = (plugin/'require-browser-access.mjs').as_uri()
        script = str(cua/'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')
        host = lambda: {key: self.status()['host'][key] for key in ('relay_reason', 'restart_adds_relay')}
        launched = NOW-7200            # the launcher is the app's pid 1000 here

        def copy(args=None, written=None, **changes):
            entry = {'command': str(cua/'bin/node'), 'args': ['--import', module, script] if args is None else args,
                     'env': {'CUA_REPL_NODE_REPL_PATH': str(cua/'bin/node_repl')}}
            entry.update(changes)
            (plugin/'.codex-plugin').mkdir(parents=True, exist_ok=True)
            (plugin/'.codex-plugin/plugin.json').write_text(json.dumps({'name': 'unified-computer-use', 'version': APP_VERSION}))
            (plugin/'.mcp.json').write_text(json.dumps({'mcpServers': {'cua_repl': entry}}))
            os.chmod(plugin/'.mcp.json', 0o644)
            if written is not None:
                os.utime(plugin/'.mcp.json', (written, written))
        for reason in ('plugin_updating', 'not_bundled'):
            with self.subTest(reason):
                self.write_host(relay=False, relay_reason=reason)      # started by this engine's launcher
                shutil.rmtree(plugin, ignore_errors=True)
                self.assertEqual(host(), {'relay_reason': reason, 'restart_adds_relay': False}, 'no copy of this version yet')
                # A copy that was there before the launcher looked was refused for a lasting cause (or is not what the
                # launcher saw): a restart would refuse it again.
                copy(written=launched-60)
                self.assertEqual(host()['restart_adds_relay'], False, 'there before the launcher looked')
                copy(written=launched+10)
                self.assertEqual(host(), {'relay_reason': reason, 'restart_adds_relay': True}, 'written since')
                copy(args=['--import=' + module, script], written=launched+10)
                self.assertEqual(host()['restart_adds_relay'], True, 'the joined form')
                # The file that decides is the .mcp.json: an old manifest next to a new one changes nothing.
                os.utime(plugin/'.codex-plugin/plugin.json', (launched-60, launched-60))
                self.assertEqual(host()['restart_adds_relay'], True)
                # A launcher that is gone cannot be compared with.
                self.write_host(relay=False, relay_reason=reason, owner=4999)
                self.assertEqual(host()['restart_adds_relay'], False, 'a launcher that is gone')
                self.write_host(relay=False, relay_reason=reason)
                # Not the bundled server, whatever the time: nothing a restart brings.
                for label, args in (('the old form', [script]),
                                    ('another module', ['--import', 'file:///tmp/require-browser-access.mjs', script]),
                                    ('the module of the version before', ['--import', module.replace(APP_VERSION, '1.2.2'), script]),
                                    ('another option', ['--inspect', '--import', module, script]),
                                    ('two modules', ['--import', module, '--import', module, script]),
                                    ('another script', ['--import', module, '/elsewhere/cua-repl.mjs'])):
                    copy(args=args, written=launched+10)
                    self.assertEqual(host()['restart_adds_relay'], False, label)
                copy(command='/usr/bin/node', written=launched+10)
                self.assertEqual(host()['restart_adds_relay'], False, 'another node')
                copy(env={'CUA_REPL_NODE_REPL_PATH': '/elsewhere/node_repl'}, written=launched+10)
                self.assertEqual(host()['restart_adds_relay'], False, 'another runtime')
                copy(written=launched+10)
                os.chmod(plugin/'.mcp.json', 0o666)
                self.assertEqual(host()['restart_adds_relay'], False, 'others may write the file')
                os.chmod(plugin/'.mcp.json', 0o644)
                self.assertEqual(host()['restart_adds_relay'], True)
        # Another reason, or the relay itself, is not this case.
        self.write_host(relay=False, relay_reason='unknown_field')
        self.assertEqual(host()['restart_adds_relay'], False)
        self.write_host(relay=True)
        self.assertEqual(host(), {'relay_reason': None, 'restart_adds_relay': False})

    def test_the_host_must_name_this_plugins_launcher_to_count_as_having_the_relay(self):
        self.machine.add(5, 1, '/bin/x')
        self.start_world(relay=True)
        self.assertEqual(self.status()['setup']['relay'], 'active')
        missing = lambda ctx: {**self.default_checks(ctx), 'relay_files': 'missing'}
        for launcher in (None, '/somewhere/else/node-repl-relay', self.stable_launcher()+'x', ''):
            self.write_host(relay=True, relay_launcher=launcher)
            self.assertEqual(self.status()['setup']['relay'], 'inactive', launcher)
            self.assertEqual(self.status(checks=missing)['setup']['relay'], 'unavailable', launcher)


class AttributionTests(StatusCase):
    def test_a_runtime_that_shares_a_session_with_a_bridge_belongs_to_the_claude_connection(self):
        self.start_world()
        bridge_dir, _ = self.bridge_with_runtime()
        self.serve(bridge_dir, 4242, NOW-900, lambda request: {'released': True})
        status = self.status()
        [connection] = status['connections']
        self.assertEqual(connection['id'], 'claude-4242-%d' % (NOW-900))
        # the bridge process plus cua-repl, relay and the runtime
        self.assertEqual(connection['memory_bytes'], (30_000+1000+400+2000)*1024)
        self.assertEqual((connection['agent'], connection['pid'], connection['owner_pid'], connection['owner_alive']),
                         ('claude', 4242, 500, True))
        self.assertEqual((connection['cwd'], connection['started_at'], connection['session_id']),
                         ('/work/x', iso(NOW-900), SESSION_A))
        self.assertEqual((connection['last_call_at'], connection['idle_seconds']), (iso(at(20)), 20))
        self.assertEqual((connection['state'], connection['busy'], connection['can_release'], connection['can_stop']),
                         ('active', False, True, True))

    def test_a_relay_whose_session_belongs_to_no_bridge_is_a_codex_connection(self):
        self.start_world()
        self.add_runtime(3000, NOW-2000)
        directory = self.state.relay('r2', 3001, NOW-2000, root_pid=3000, runtime_pid=3002, cwd='/work/codex',
                                     last_call_at=iso(at(40)), scopes=[State.scope(SESSION_B, subagent=True),
                                                                       State.scope(SESSION_C, subagent=False)])
        self.serve(directory, 3001, NOW-2000, lambda request: {'released': True})
        [connection] = self.status()['connections']
        self.assertEqual(connection['id'], 'codex-3001-%d' % (NOW-2000))
        self.assertEqual((connection['agent'], connection['pid'], connection['owner_pid'], connection['owner_alive']),
                         ('codex', 3001, 1100, True))
        self.assertEqual(connection['memory_bytes'], (1000+400+2000)*1024)
        self.assertEqual((connection['cwd'], connection['session_id'], connection['can_release']),
                         ('/work/codex', SESSION_C, True))     # the main thread's session wins over a sub-agent's

    def test_a_runtime_without_any_record_is_listed_with_nulls_and_cannot_be_released(self):
        self.start_world()
        self.add_runtime(4000, NOW-5000, relay=False)
        self.machine.cwds[4000] = '/work/unrecorded'
        [connection] = self.status()['connections']
        self.assertEqual(connection, {
            'id': 'codex-4000-%d' % (NOW-5000), 'agent': 'codex', 'state': 'active', 'pid': 4000, 'owner_pid': 1100,
            'owner_alive': True, 'cwd': '/work/unrecorded', 'started_at': iso(NOW-5000),
            'memory_bytes': (1000+2000)*1024, 'last_call_at': None, 'idle_seconds': None, 'session_id': None,
            'busy': False, 'can_release': False, 'can_stop': True, 'holds': None})

    def test_what_a_connection_holds_is_a_scope_it_still_serves_or_a_session_left_with_it(self):
        """holds: an AI that called and has not ended its turn holds its scope; once the turn ended (or was released) it
        holds nothing, however recently it called; a bridge whose host is gone still holds what may be left in Chrome."""
        self.start_world()
        directory, relay_directory = self.bridge_with_runtime(last_call=20)
        bridge = 'claude-4242-%d' % (NOW-900)
        holds = lambda: next(item['holds'] for item in self.status()['connections'] if item['id'] == bridge)
        self.assertIs(holds(), True)
        self.update(directory, 'bridge', scopes=[], cleanup='none')
        self.update(relay_directory, 'relay', scopes=[])
        self.assertIs(holds(), False, 'the turn ended a moment ago: nothing is held')
        self.update(directory, 'bridge', host=None, scopes=[State.scope(SESSION_A, last=at(300))])
        self.assertIs(holds(), True, 'its host is gone, and what it holds may still be left in Chrome')
        self.machine.add(5000, 1, self.commands.chrome, start=NOW-100)
        self.assertIs(holds(), False, 'Chrome restarted since: it forgot that lease')

    def test_what_the_engine_must_never_signal_is_not_offered_for_stopping(self):
        from engine_support import ENGINE_PID
        self.start_world()
        self.add_runtime(4000, NOW-5000, relay=False)
        self.add_runtime(4100, NOW-5000, relay=False)
        self.machine.add(ENGINE_PID, 4100, '/usr/bin/python3 setup.py status')     # the engine runs below this runtime
        connections = {item['pid']: item['can_stop'] for item in self.status()['connections']}
        self.assertEqual(connections, {4000: True, 4100: False})

    def test_a_bridge_without_a_record_is_listed_too(self):
        self.start_world()
        self.add_claude(501)
        self.add_bridge(4300, 501, NOW-700, command=self.commands.old_bridge)
        self.machine.cwds[4300] = '/work/old'
        [connection] = self.status()['connections']
        self.assertEqual((connection['id'], connection['agent'], connection['owner_pid'], connection['owner_alive'],
                          connection['cwd'], connection['session_id'], connection['last_call_at'],
                          connection['can_release'], connection['can_stop'], connection['memory_bytes']),
                         ('claude-4300-%d' % (NOW-700), 'claude', 501, True, '/work/old', None, None, False, True,
                          30_000*1024))

    def test_a_bridge_that_runs_from_an_engine_copy_of_any_version_is_a_connection(self):
        self.start_world()
        self.add_claude(501)
        self.add_bridge(4300, 501, NOW-700, command=self.commands.old_engine_bridge)
        self.add_bridge(4301, 501, NOW-600, command=self.commands.engine_bridge)
        self.assertEqual({item['pid']: (item['agent'], item['state']) for item in self.status()['connections']},
                         {4300: ('claude', 'active'), 4301: ('claude', 'active')})

    def test_the_engine_says_which_folder_it_runs_from(self):
        root = self.home/'.local/share/codex-cua/engine/0.8.0'
        (root/'.claude-plugin').mkdir(parents=True)
        (root/'.claude-plugin/plugin.json').write_text(json.dumps({'name': 'cua', 'version': '0.8.0'}))
        self.machine.add(5, 1, '/bin/x')
        status = self.status(plugin_root=root)
        launcher = str(self.home/'.local/share/codex-cua/engine/current/start-mcp.sh')
        self.assertEqual(status['engine'], {'version': '0.8.0', 'root': str(root), 'launcher': launcher})
        self.assertEqual(status['plugin'], {'version': '0.8.0'})
        (root/'.claude-plugin/plugin.json').unlink()
        status = self.status(plugin_root=root)
        self.assertEqual((status['engine'], status['plugin']),
                         ({'version': None, 'root': str(root), 'launcher': launcher}, {'version': None}))

    def test_nodes_directly_under_the_app_server_are_not_cua_runtimes(self):
        self.start_world()
        self.machine.add(2100, 1100, self.commands.node_repl)
        self.assertEqual(self.status()['connections'], [])

    def test_cmux_cua_is_never_a_connection_only_a_tool_with_one_client_entry_per_mcp_process(self):
        self.start_world()
        self.add_claude(500)
        self.machine.add(3000, 1, self.commands.cmux_serve)
        self.machine.add(3001, 1, self.commands.cmux_serve)
        self.machine.add(3002, 500, self.commands.cmux_mcp, start=NOW-900)
        self.machine.add(3003, 500, self.commands.cmux_mcp, start=NOW-300)
        self.machine.add(3004, 1100, self.commands.cmux_mcp, start=NOW-60)
        self.machine.cwds.update({500: '/work/claude-project', 1100: '/work/codex-project'})
        status = self.status()
        self.assertEqual(status['connections'], [])
        self.assertEqual(status['other_tools'], [{'name': 'cmux-cua', 'running': True, 'pids': [3000, 3001], 'clients': [
            {'id': 'cmux-3002-%d' % (NOW-900), 'pid': 500, 'mcp_pid': 3002, 'agent': 'claude',
             'cwd': '/work/claude-project', 'started_at': iso(NOW-900), 'can_stop': True},
            {'id': 'cmux-3003-%d' % (NOW-300), 'pid': 500, 'mcp_pid': 3003, 'agent': 'claude',
             'cwd': '/work/claude-project', 'started_at': iso(NOW-300), 'can_stop': True},
            {'id': 'cmux-3004-%d' % (NOW-60), 'pid': 1100, 'mcp_pid': 3004, 'agent': 'codex',
             'cwd': '/work/codex-project', 'started_at': iso(NOW-60), 'can_stop': True}]}])

    def test_a_client_entry_has_exactly_the_contract_keys_and_types(self):
        self.add_claude(500)
        self.machine.add(3001, 500, self.commands.cmux_mcp)
        [tool] = self.status()['other_tools']
        [client] = tool['clients']
        self.assertEqual(list(client), CMUX_CLIENT_KEYS)
        self.assertTrue(re.match(r'^cmux-\d+-\d+$', client['id']))
        self.assertTrue(TIME.match(client['started_at']))
        for key in ('pid', 'mcp_pid'):
            self.assertIsInstance(client[key], int)
        self.assertIsInstance(client['can_stop'], bool)
        json.dumps(tool)

    def test_cmux_cua_that_is_installed_but_not_running_is_listed_as_stopped_and_unknown_clients_have_null_fields(self):
        self.machine.add(5, 1, '/bin/x')
        self.assertEqual(self.status()['other_tools'], [])
        (self.home/'Library/Application Support/cmux/cmux-cua').mkdir(parents=True)
        self.assertEqual(self.status()['other_tools'], [{'name': 'cmux-cua', 'running': False, 'pids': [], 'clients': []}])
        self.machine.add(3002, 77, self.commands.cmux_mcp)
        self.machine.add(77, 1, '/bin/sh -c something')
        self.assertEqual(self.status()['other_tools'], [{'name': 'cmux-cua', 'running': True, 'pids': [], 'clients': [
            {'id': 'cmux-3002-%d' % (NOW-3600), 'pid': 77, 'mcp_pid': 3002, 'agent': None, 'cwd': None,
             'started_at': iso(NOW-3600), 'can_stop': True}]}])

    def test_an_mcp_process_whose_ai_client_is_gone_is_still_listed_without_a_client_and_can_be_stopped(self):
        self.machine.add(3002, 1, self.commands.cmux_mcp, start=NOW-500)          # its parent is launchd now
        self.machine.add(3003, 4444, self.commands.cmux_mcp, start=NOW-400)       # its parent vanished from the list
        self.machine.cwds[4444] = '/work/whoever-has-that-pid-now'                # nothing of that is taken for its client
        clients = self.status()['other_tools'][0]['clients']
        self.assertEqual([(item['mcp_pid'], item['pid'], item['agent'], item['cwd'], item['can_stop']) for item in clients],
                         [(3002, None, None, None, True), (3003, None, None, None, True)])
        self.assertEqual(self.status()['other_tools'][0]['running'], True)

    def test_connections_are_ordered_by_client_with_the_ones_without_a_client_last(self):
        self.add_claude(500)
        self.machine.add(3001, 1, self.commands.cmux_mcp, start=NOW-900)          # no client
        self.machine.add(3002, 500, self.commands.cmux_mcp, start=NOW-800)
        self.machine.add(3003, 1100, self.commands.cmux_mcp, start=NOW-700)
        self.machine.add(3004, 4444, self.commands.cmux_mcp, start=NOW-600)       # no client
        self.machine.add(3005, 500, self.commands.cmux_mcp, start=NOW-100)
        self.machine.add(1100, 1, self.commands.app_server)
        clients = self.status()['other_tools'][0]['clients']
        self.assertEqual([(item['mcp_pid'], item['pid']) for item in clients],
                         [(3002, 500), (3005, 500), (3003, 1100), (3001, None), (3004, None)])

    def test_can_stop_is_false_where_stop_would_refuse(self):
        self.add_claude(500)
        self.machine.add(3001, 500, self.commands.cmux_mcp, start=NOW-900)
        self.machine.add(3002, 500, self.commands.cmux_mcp, start=NOW-800)       # the engine runs below this one
        self.machine.add(3003, 500, self.commands.cmux_mcp, start=NOW-700)       # an mcp process that is itself a client
        self.machine.add(3004, 3003, self.commands.cmux_mcp, start=NOW-600)
        self.machine.add(ENGINE_PID, 3002, '/usr/bin/python3 setup.py status')
        clients = {item['mcp_pid']: item['can_stop'] for item in self.status()['other_tools'][0]['clients']}
        self.assertEqual(clients, {3001: True, 3002: False, 3003: False, 3004: True})

    def test_other_users_mcp_processes_are_not_listed(self):
        self.add_claude(500)
        self.machine.add(3001, 500, self.commands.cmux_mcp)
        self.machine.add(3002, 500, self.commands.cmux_mcp, uid=UID+1)
        self.machine.add(3003, 1, self.commands.cmux_serve, uid=UID+1)
        [tool] = self.status()['other_tools']
        self.assertEqual(([item['mcp_pid'] for item in tool['clients']], tool['pids']), ([3001], []))

    def test_a_session_less_relay_is_paired_with_the_bridge_that_connected_right_after_it_started(self):
        self.start_world()
        self.add_claude(500)
        self.add_bridge(4242, 500, NOW-900)
        self.state.bridge('a1', 4242, NOW-900, owner_pid=500, cwd='/work/x', session_id=SESSION_A,
                          connected_at=iso(NOW-880), host={'pid': 1100, 'relay': True})
        self.add_runtime(2000, NOW-885)
        self.state.relay('r1', 2001, NOW-885, root_pid=2000, runtime_pid=2002, cwd='/work/x', app_server_pid=1100)
        connections = self.status()['connections']
        self.assertEqual([item['id'] for item in connections], ['claude-4242-%d' % (NOW-900)])
        self.assertEqual(connections[0]['memory_bytes'], (30_000+1000+400+2000)*1024)

    def test_the_pairing_is_refused_when_it_is_not_clearly_one_to_one(self):
        self.start_world()
        self.add_claude(500)
        for name, pid in (('a1', 4242), ('a2', 4243)):
            self.add_bridge(pid, 500, NOW-900)
            self.state.bridge(name, pid, NOW-900, owner_pid=500, cwd='/work/x', session_id=SESSION_A,
                              connected_at=iso(NOW-880), host={'pid': 1100, 'relay': True})
        self.add_runtime(2000, NOW-885)
        self.state.relay('r1', 2001, NOW-885, root_pid=2000, runtime_pid=2002, cwd='/work/x', app_server_pid=1100)
        agents = sorted((item['agent'], item['pid']) for item in self.status()['connections'])
        self.assertEqual(agents, [('claude', 4242), ('claude', 4243), ('codex', 2001)])

    def pair(self, **changes):
        """Agents of the connections when a session-less relay (with `changes`) runs next to a connected bridge."""
        self.start_world()
        self.add_claude(500)
        self.add_bridge(4242, 500, NOW-900)
        self.state.bridge('a1', 4242, NOW-900, owner_pid=500, cwd='/work/x', session_id=SESSION_A,
                          connected_at=iso(NOW-880), host={'pid': 1100, 'relay': True})
        started = changes.pop('started_at', NOW-885)
        self.add_runtime(2000, started)
        self.state.relay('r1', 2001, started, root_pid=2000, runtime_pid=2002,
                         **{'cwd': '/work/x', 'app_server_pid': 1100, **changes})
        return sorted(item['agent'] for item in self.status()['connections'])

    def test_the_pairing_needs_the_same_folder(self):
        self.assertEqual(self.pair(cwd='/work/other'), ['claude', 'codex'])

    def test_the_pairing_needs_the_same_host(self):
        self.assertEqual(self.pair(app_server_pid=1999), ['claude', 'codex'])

    def test_the_pairing_needs_a_relay_that_started_just_before_the_connection(self):
        self.assertEqual(self.pair(started_at=NOW-300), ['claude', 'codex'])       # after the bridge connected
        self.assertEqual(self.pair(started_at=NOW-2000), ['claude', 'codex'])      # long before it
        self.assertEqual(self.pair(), ['claude'])

    def test_the_activity_log_links_a_runtime_that_has_no_open_scope_to_its_bridge(self):
        self.start_world()
        self.bridge_with_runtime(scopes=False)
        self.state.activity([State.line('relay-2001-%d' % (NOW-890), 40, SESSION_A)])
        connections = self.status()['connections']
        self.assertEqual([item['id'] for item in connections], ['claude-4242-%d' % (NOW-900)])
        self.assertEqual(connections[0]['memory_bytes'], (30_000+1000+400+2000)*1024)

    def test_a_runtime_that_still_serves_a_dead_bridges_thread_is_an_ended_claude_connection(self):
        self.start_world()
        self.add_runtime(2000, NOW-890)
        directory = self.state.relay('r1', 2001, NOW-890, root_pid=2000, runtime_pid=2002, cwd='/work/x',
                                     scopes=[State.scope(SESSION_A)])
        self.serve(directory, 2001, NOW-890, lambda request: {'released': True})
        self.state.bridge('d1', 7001, NOW-5000, owner_pid=501, session_id=SESSION_A, cwd='/work/x',
                          scopes=[State.scope(SESSION_A)], cleanup='open')
        [connection] = self.status()['connections']
        self.assertEqual((connection['id'], connection['agent'], connection['state'], connection['owner_alive'],
                          connection['owner_pid'], connection['can_release']),
                         ('claude-2001-%d' % (NOW-890), 'claude', 'ended', False, 501, True))


    def test_the_runtime_of_a_dead_bridge_has_ended_even_while_the_claude_process_that_owned_it_lives(self):
        self.start_world()
        self.add_claude(500)
        self.add_runtime(2000, NOW-890)
        self.state.relay('r1', 2001, NOW-890, root_pid=2000, runtime_pid=2002, scopes=[State.scope(SESSION_A)])
        self.state.bridge('d1', 7001, NOW-5000, owner_pid=500, session_id=SESSION_A, scopes=[State.scope(SESSION_A)],
                          cleanup='open')                      # the bridge crashed; Claude Code itself still runs
        [connection] = self.status()['connections']
        self.assertEqual((connection['agent'], connection['state'], connection['owner_pid'], connection['owner_alive']),
                         ('claude', 'ended', 500, False))


class OwnerNameTests(StatusCase):
    """A relay that a bridge started carries the bridge's name (`owner`); that decides whose runtime it is."""

    def named_runtime(self, owner, start=NOW-600, cwd='/work/other', scopes=(), **fields):
        self.add_runtime(2000, start)
        return self.state.relay('r1', 2001, start, root_pid=2000, runtime_pid=2002, cwd=cwd, owner=owner,
                                scopes=list(scopes), **fields)

    def test_a_runtime_that_names_its_bridge_belongs_to_it_without_a_shared_session_folder_or_start(self):
        self.start_world()
        self.add_claude(500)
        self.add_bridge(4242, 500, NOW-900)
        self.state.bridge('a1', 4242, NOW-900, owner_pid=500, cwd='/work/x', session_id=SESSION_A)
        self.named_runtime('bridge-4242-%d' % (NOW-900))
        [connection] = self.status()['connections']
        self.assertEqual((connection['id'], connection['agent'], connection['state']),
                         ('claude-4242-%d' % (NOW-900), 'claude', 'active'))
        self.assertEqual(connection['memory_bytes'], (30_000+1000+400+2000)*1024)

    def test_a_runtime_that_names_a_bridge_that_is_gone_is_an_ended_claude_connection(self):
        self.start_world()
        directory = self.named_runtime('bridge-7001-%d' % (NOW-5000), last_call_at=iso(at(500)))      # it was called once
        self.serve(directory, 2001, NOW-600, lambda request: {'released': True})
        [connection] = self.status()['connections']
        self.assertEqual((connection['id'], connection['agent'], connection['state'], connection['owner_alive'],
                          connection['owner_pid'], connection['can_release']),
                         ('claude-2001-%d' % (NOW-600), 'claude', 'ended', False, 1100, True))
        self.state.bridge('d1', 7001, NOW-5000, owner_pid=501)       # its record, when there still is one, names the owner
        [connection] = self.status()['connections']
        self.assertEqual((connection['state'], connection['owner_pid']), ('ended', 501))

    def test_a_runtime_that_names_a_gone_bridge_is_not_given_to_a_live_bridge_that_shares_its_session(self):
        self.start_world()
        self.add_claude(500)
        self.add_bridge(4242, 500, NOW-900)
        self.state.bridge('a1', 4242, NOW-900, owner_pid=500, cwd='/work/x', session_id=SESSION_A,
                          scopes=[State.scope(SESSION_A)])
        self.named_runtime('bridge-7001-%d' % (NOW-5000), scopes=[State.scope(SESSION_A)])
        found = sorted((item['agent'], item['state'], item['pid']) for item in self.status()['connections'])
        self.assertEqual(found, [('claude', 'active', 4242), ('claude', 'ended', 2001)])

    def test_a_runtime_that_names_a_bridge_running_without_a_record_is_part_of_that_bridges_connection(self):
        self.start_world()
        self.add_claude(501)
        self.add_bridge(4300, 501, NOW-700)
        self.named_runtime('bridge-4300-%d' % (NOW-700))
        [connection] = self.status()['connections']
        self.assertEqual((connection['id'], connection['state'], connection['memory_bytes']),
                         ('claude-4300-%d' % (NOW-700), 'active', (30_000+1000+400+2000)*1024))

    def test_a_runtime_whose_bridge_still_runs_is_never_ended_even_when_nothing_else_knows_the_bridge(self):
        self.start_world()
        self.add_claude(501)
        self.machine.add(4300, 501, '/usr/bin/python3 /somewhere/else/server.py', start=NOW-700)
        self.named_runtime('bridge-4300-%d' % (NOW-700))
        [connection] = self.status()['connections']
        self.assertEqual((connection['agent'], connection['state'], connection['owner_pid'], connection['owner_alive']),
                         ('claude', 'active', 501, True))

    def test_a_name_that_is_not_a_bridges_or_whose_start_does_not_match_counts_as_no_name_or_a_gone_bridge(self):
        self.start_world()
        self.named_runtime('relay-4242-%d' % (NOW-900), scopes=[State.scope(SESSION_B)])
        [connection] = self.status()['connections']
        self.assertEqual((connection['agent'], connection['state']), ('codex', 'active'))
        self.add_claude(500)
        self.add_bridge(4242, 500, NOW-900)
        self.update(self.state.root/'relays/relay-r1', 'relay', owner='bridge-4242-%d' % (NOW-1900))
        [connection] = [item for item in self.status()['connections'] if item['pid'] == 2001]
        self.assertEqual((connection['agent'], connection['state']), ('claude', 'ended'))     # a reused pid


class LineOwnerTests(StatusCase):
    """A relay that a bridge started writes the bridge's name (`owner`) into every activity line. The line says Claude for
    as long as it is in the log, when the connection, the runtime and the bridge's record are long gone (S23)."""
    BRIDGE = 'bridge-4242-%d' % (NOW-900)
    CLAUDE = 'claude-4242-%d' % (NOW-900)

    def lines(self, status=None):
        """(ms, agent, connection id) of every activity entry, newest first."""
        status = self.status() if status is None else status
        return [(item['ms'], item['agent'], item['connection_id']) for item in status['activity']]

    def test_a_claude_conversation_whose_connection_and_bridge_record_are_gone_keeps_its_lines_claude(self):
        self.start_world()
        self.state.activity([State.line('relay-2001-%d' % (NOW-890), 100, SESSION_A, ms=11, owner=self.BRIDGE),
                             State.line('relay-2001-%d' % (NOW-890), 80, SESSION_A, tool='turn_ended', ms=22,
                                        owner=self.BRIDGE)])
        self.assertEqual((self.state.names('bridge'), self.state.names('relay')), ([], []))
        status = self.status()
        # Nothing of that conversation is left to ask: no connection, no lease, no record.
        self.assertEqual((status['connections'], status['leases']['maybe_left']), ([], []))
        self.assertEqual(self.lines(status), [(22, 'claude', self.CLAUDE), (11, 'claude', self.CLAUDE)])

    def test_a_codex_conversations_lines_stay_codex_whether_its_runtime_runs_or_not(self):
        self.start_world()
        self.add_runtime(3000, NOW-2000)
        self.state.relay('r2', 3001, NOW-2000, root_pid=3000, runtime_pid=3002, scopes=[State.scope(SESSION_B)])
        self.state.activity([
            State.line('relay-3001-%d' % (NOW-2000), 100, SESSION_B, ms=1),       # a Codex runtime that runs
            State.line('relay-9001-%d' % (NOW-9000), 90, SESSION_C, ms=2),        # one that is gone
            State.line('relay-9002-%d' % (NOW-9000), 80, None, ms=3),             # ... that named no session
            State.line('relay-2001-%d' % (NOW-890), 70, SESSION_A, ms=4, owner=self.BRIDGE)])      # next to a Claude one
        status = self.status()
        self.assertEqual([(item['agent'], item['state']) for item in status['connections']], [('codex', 'active')])
        self.assertEqual(self.lines(status), [
            (4, 'claude', self.CLAUDE), (3, 'codex', 'codex-9002-%d' % (NOW-9000)),
            (2, 'codex', 'codex-9001-%d' % (NOW-9000)), (1, 'codex', 'codex-3001-%d' % (NOW-2000))])

    def test_lines_without_the_name_are_read_as_before(self):
        self.start_world()
        # A dead bridge's record that still lists a session, as the bridge's records do until a release is confirmed.
        self.state.bridge('d1', 7001, NOW-5000, owner_pid=501, session_id=SESSION_C, scopes=[State.scope(SESSION_C)],
                          cleanup='open')
        self.state.activity([
            State.line('relay-9001-%d' % (NOW-9000), 90, SESSION_C, ms=1),        # a relay that is gone, a listed session
            State.line('relay-9002-%d' % (NOW-9000), 80, SESSION_D, ms=2),        # ... a session nobody lists
            State.line('bridge-8001-%d' % (NOW-8000), 70, SESSION_D, ms=3)])      # a bridge's own line
        self.assertEqual(self.lines(), [(3, 'claude', 'claude-8001-%d' % (NOW-8000)),
                                        (2, 'codex', 'codex-9002-%d' % (NOW-9000)),
                                        (1, 'claude', 'claude-7001-%d' % (NOW-5000))])

    def test_a_name_that_is_not_a_bridges_changes_nothing(self):
        self.start_world()
        self.state.activity([State.line('relay-9001-%d' % (NOW-9000), 90, SESSION_C, ms=1,
                                        owner='relay-4242-%d' % (NOW-900)),
                             State.line('relay-9002-%d' % (NOW-9000), 80, SESSION_D, ms=2, owner='bridge-4242-x')])
        self.assertEqual(self.lines(), [(2, 'codex', 'codex-9002-%d' % (NOW-9000)),
                                        (1, 'codex', 'codex-9001-%d' % (NOW-9000))])

    def test_the_name_in_a_line_is_trusted_before_what_its_session_suggests(self):
        self.start_world()
        self.state.bridge('d1', 7001, NOW-5000, owner_pid=501, session_id=SESSION_C, scopes=[State.scope(SESSION_C)],
                          cleanup='open')
        self.state.activity([State.line('relay-2001-%d' % (NOW-890), 60, SESSION_C, ms=1, owner=self.BRIDGE)])
        self.assertEqual(self.lines(), [(1, 'claude', self.CLAUDE)])      # not the dead bridge whose record lists SESSION_C

    def test_a_line_of_a_runtime_that_runs_keeps_the_id_of_the_connection_it_is_listed_under(self):
        """The app finds a line's folder through the id of a listed connection, so a runtime that is listed keeps its own."""
        self.start_world()
        self.add_runtime(2000, NOW-600)
        self.state.relay('r1', 2001, NOW-600, root_pid=2000, runtime_pid=2002, cwd='/work/y', owner=self.BRIDGE,
                         last_call_at=iso(at(100)))
        self.state.activity([State.line('relay-2001-%d' % (NOW-600), 100, SESSION_A, ms=1, owner=self.BRIDGE)])
        status = self.status()
        self.assertEqual([(item['id'], item['agent'], item['state']) for item in status['connections']],
                         [('claude-2001-%d' % (NOW-600), 'claude', 'ended')])
        self.assertEqual(self.lines(status), [(1, 'claude', 'claude-2001-%d' % (NOW-600))])

    def test_a_line_of_a_runtime_that_is_gone_belongs_to_its_bridge_while_that_runs(self):
        self.start_world()
        self.bridge_with_runtime()
        # An earlier runtime of the same bridge (Codex had started again), for a session the bridge no longer lists.
        self.state.activity([State.line('relay-1777-%d' % (NOW-4000), 300, SESSION_B, ms=1, owner=self.BRIDGE)])
        status = self.status()
        self.assertEqual([item['id'] for item in status['connections']], [self.CLAUDE])
        self.assertEqual(self.lines(status), [(1, 'claude', self.CLAUDE)])


class RevivedRuntimeTests(StatusCase):
    """A runtime Codex started again for the thread of a bridge that is long gone, and that nobody used, is no connection
    (S17, S18): it is in no list and only counted in the diagnosis. Any use of it, even one call, keeps it an ended one."""
    BRIDGE = 'bridge-7001-%d' % (NOW-5000)

    def runtime(self, owner=BRIDGE, start=NOW-600, rss=(1000, 400, 2000), **fields):
        self.add_runtime(2000, start, rss=rss)
        return self.state.relay('r1', 2001, start, root_pid=2000, runtime_pid=2002, cwd='/work/c22', owner=owner, **fields)

    def listed(self):
        return [(item['agent'], item['state'], item['pid']) for item in self.status()['connections']]

    def test_it_is_in_no_list_and_not_even_as_a_runtime_nobody_has_a_record_of(self):
        self.start_world()
        self.runtime()
        status = self.status()
        self.assertEqual(status['connections'], [])
        self.assertEqual(status['leases']['maybe_left'], [])
        view = engine_status.build_view(self.context())
        [item] = view.revived
        self.assertEqual((item.pid, item.memory_bytes), (2001, (1000+400+2000)*1024))

    def test_it_is_counted_with_the_memory_of_the_whole_runtime(self):
        self.start_world()
        self.runtime(rss=(100_000, 60_000, 50_000))
        self.add_runtime(3000, NOW-500, rss=(100_000, 5_000, 5_000))
        self.state.relay('r2', 3001, NOW-500, root_pid=3000, runtime_pid=3002, cwd='/work/c19', owner='bridge-7002-%d' % (NOW-9000))
        self.assertEqual([item.memory_bytes for item in engine_status.build_view(self.context()).revived],
                         [210_000*1024, 110_000*1024])

    def test_two_minutes_after_the_bridge_are_not_enough(self):
        self.start_world()
        self.runtime(start=NOW-5000+120)
        self.assertEqual(self.listed(), [('claude', 'ended', 2001)])

    def test_more_than_two_minutes_after_the_bridge_are(self):
        self.start_world()
        self.runtime(start=NOW-5000+121)
        self.assertEqual(self.listed(), [])

    def test_a_runtime_that_was_called_stays_an_ended_connection(self):
        self.start_world()
        self.runtime(last_call_at=iso(at(500)))
        self.assertEqual(self.listed(), [('claude', 'ended', 2001)])

    # --- what the relay saw as it came up: was the bridge it names running? (`owner_running`, build 9) -------------

    def test_a_runtime_that_found_its_bridge_gone_as_it_came_up_is_one_however_soon_after_the_bridge(self):
        """The conversation of the 4th round (S4) lived 18 seconds; Codex started its runtime again right after it ended."""
        self.start_world()
        self.runtime(start=NOW-5000+18, owner_running=False)
        status = self.status()
        self.assertEqual((status['connections'], status['leases']['maybe_left']), ([], []))
        [item] = engine_status.build_view(self.context()).revived
        self.assertEqual((item.pid, item.memory_bytes), (2001, (1000+400+2000)*1024))

    def test_the_same_runtime_that_found_its_bridge_running_or_cannot_say_stays_an_ended_connection(self):
        self.start_world()
        # True: it came up under a bridge that ran. None: the look failed. Ellipsis: no such key, a record from before.
        # The rest is no boolean, and is not taken for "gone" either.
        for value in (True, None, Ellipsis, 0, 'false', []):
            with self.subTest(owner_running=value):
                self.runtime(start=NOW-5000+18, owner_running=value)
                self.assertEqual(self.listed(), [('claude', 'ended', 2001)])

    def test_a_value_that_says_nothing_leaves_it_to_the_age_of_the_runtime_as_before(self):
        self.start_world()
        for value in (True, None, Ellipsis):
            with self.subTest(owner_running=value):
                self.runtime(start=NOW-5000+120, owner_running=value)
                self.assertEqual(self.listed(), [('claude', 'ended', 2001)])
                self.runtime(start=NOW-5000+121, owner_running=value)
                self.assertEqual(self.listed(), [])

    def test_one_that_found_its_bridge_gone_is_an_ended_connection_when_anything_was_done_with_it(self):
        self.start_world()
        for label, fields in (('a call', {'last_call_at': iso(at(500))}), ('a call in flight', {'busy': True}),
                              ('an open scope', {'scopes': [State.scope(SESSION_A)], 'cleanup': 'open'})):
            with self.subTest(label):
                self.runtime(start=NOW-5000+18, owner_running=False, **fields)
                self.assertEqual(self.listed(), [('claude', 'ended', 2001)])
        self.runtime(start=NOW-5000+18, owner_running=False)
        self.assertEqual(self.listed(), [])
        self.state.activity([State.line('relay-2001-%d' % (NOW-5000+18), 300, None)])      # the activity log knows it
        self.assertEqual(self.listed(), [('claude', 'ended', 2001)])

    def test_one_that_found_its_bridge_gone_is_an_ended_connection_when_the_bridge_left_a_record(self):
        self.start_world()
        self.runtime(start=NOW-5000+18, owner_running=False)
        self.state.bridge('d1', 7001, NOW-5000, owner_pid=501)
        self.assertEqual(self.listed(), [('claude', 'ended', 2001)])

    def test_one_that_found_its_bridge_gone_is_never_one_while_that_bridge_runs(self):
        self.start_world()
        self.add_claude(500)
        self.add_bridge(7001, 500, NOW-5000)
        self.runtime(start=NOW-5000+18, owner_running=False)
        self.assertEqual(self.listed(), [('claude', 'active', 7001)])

    def test_a_runtime_that_names_no_bridge_is_a_codex_connection_whatever_it_says_about_one(self):
        self.start_world()
        self.runtime(owner=None, start=NOW-5000+18, owner_running=False)
        self.assertEqual(self.listed(), [('codex', 'active', 2001)])

    def test_a_runtime_with_an_open_scope_stays_an_ended_connection(self):
        self.start_world()
        self.runtime(scopes=[State.scope(SESSION_A)], cleanup='open')
        self.assertEqual(self.listed(), [('claude', 'ended', 2001)])

    def test_a_runtime_with_a_call_in_flight_stays_an_ended_connection(self):
        self.start_world()
        self.runtime(busy=True)
        self.assertEqual(self.listed(), [('claude', 'ended', 2001)])

    def test_a_runtime_the_activity_log_knows_stays_an_ended_connection(self):
        self.start_world()
        self.runtime()
        self.state.activity([State.line('relay-2001-%d' % (NOW-600), 300, None)])      # a call that named no session
        self.assertEqual(self.listed(), [('claude', 'ended', 2001)])
        self.state.activity([State.line('relay-2001-%d' % (NOW-600), 300, SESSION_A)])
        self.assertEqual(self.listed(), [('claude', 'ended', 2001)])
        self.state.activity([State.line('relay-9999-%d' % (NOW-600), 300, SESSION_A)])      # another writer's line
        self.assertEqual(self.listed(), [])

    def test_a_runtime_whose_bridge_still_has_a_record_stays_an_ended_connection(self):
        self.start_world()
        self.runtime()
        self.state.bridge('d1', 7001, NOW-5000, owner_pid=501)
        self.assertEqual(self.listed(), [('claude', 'ended', 2001)])

    def test_a_runtime_whose_bridge_runs_is_never_one(self):
        self.start_world()
        self.add_claude(500)
        self.add_bridge(7001, 500, NOW-5000)
        self.runtime()
        self.assertEqual(self.listed(), [('claude', 'active', 7001)])

    def test_a_runtime_that_names_no_bridge_is_a_codex_connection_as_before(self):
        self.start_world()
        self.runtime(owner=None)
        self.assertEqual(self.listed(), [('codex', 'active', 2001)])

    def test_the_runtime_of_a_conversation_that_ended_a_moment_after_it_began_is_still_found(self):
        """The runtime a killed bridge left behind came up with its bridge: that is a leak, and an ended connection."""
        self.start_world()
        self.runtime(start=NOW-5000+8)
        self.assertEqual(self.listed(), [('claude', 'ended', 2001)])


class OldHostScopeTests(StatusCase):
    """A live bridge that went to a new host keeps open scopes of the old one, which it cannot end any more."""
    ID = 'claude-4242-%d' % (NOW-900)
    WRITER = 'bridge-4242-%d' % (NOW-900)

    def live_bridge(self, **fields):
        self.add_claude(500)
        self.add_bridge(4242, 500, NOW-900)
        data = dict(owner_pid=500, cwd='/work/x', session_id=SESSION_D, cleanup='open',
                    scopes=[State.scope(SESSION_C, first=at(2000), last=at(1900)), State.scope(SESSION_D)])
        data.update(fields)
        return self.state.bridge('a1', 4242, NOW-900, **data)

    def left(self):
        return self.status()['leases']['maybe_left']

    def test_the_scope_of_an_earlier_session_may_have_been_left_but_the_current_session_is_not_listed(self):
        self.start_world()
        self.live_bridge()
        status = self.status()
        self.assertEqual(status['leases']['maybe_left'], [{
            'session_id': SESSION_C, 'agent': 'claude', 'connection_id': self.ID, 'cwd': '/work/x', 'ended_at': None,
            'releasable': True}])
        [connection] = status['connections']
        self.assertEqual((connection['id'], connection['session_id'], connection['state']), (self.ID, SESSION_D, 'active'))

    def test_a_bridge_that_is_still_on_its_first_host_lists_nothing(self):
        self.start_world()
        self.live_bridge(scopes=[State.scope(SESSION_D, turn='turn-1'), State.scope(SESSION_D, turn='turn-2')])
        self.assertEqual(self.left(), [])

    def test_not_releasable_without_a_ready_host_or_while_a_live_relay_still_serves_the_session(self):
        self.start_world()
        self.live_bridge()
        self.machine.remove(1200)
        self.assertFalse(self.left()[0]['releasable'])
        self.machine.add(1200, 1000, '/bin/proxy')
        self.assertTrue(self.left()[0]['releasable'])
        self.add_runtime(2000, NOW-890)
        self.state.relay('r1', 2001, NOW-890, root_pid=2000, runtime_pid=2002, scopes=[State.scope(SESSION_C)])
        [entry] = self.left()
        self.assertEqual((entry['session_id'], entry['releasable']), (SESSION_C, False))

    def test_an_old_scope_that_ended_before_chrome_started_is_dropped_and_the_bridge_record_is_left_alone(self):
        self.start_world()
        directory = self.live_bridge()
        before = (directory/'bridge.json').read_bytes()
        self.machine.add(5000, 1, self.commands.chrome, start=NOW-100)
        self.assertEqual(self.left(), [])
        self.assertEqual((directory/'bridge.json').read_bytes(), before)

    def test_what_was_released_is_remembered_in_the_engines_own_file_and_not_listed_again(self):
        self.start_world()
        directory = self.live_bridge()
        before = (directory/'bridge.json').read_bytes()
        engine_records.remember_released(self.state.root, UID, self.WRITER, SESSION_C, iso(NOW))
        self.assertEqual(self.left(), [])
        self.assertEqual((directory/'bridge.json').read_bytes(), before)             # a live writer's record is never rewritten

    def test_a_remembered_pair_is_for_that_writer_only(self):
        self.start_world()
        self.live_bridge()
        engine_records.remember_released(self.state.root, UID, 'bridge-9999-%d' % (NOW-900), SESSION_C, iso(NOW))
        self.assertEqual([entry['session_id'] for entry in self.left()], [SESSION_C])

    def test_the_memory_of_a_record_that_is_gone_is_dropped_by_the_next_status(self):
        self.start_world()
        directory = self.live_bridge()
        engine_records.remember_released(self.state.root, UID, self.WRITER, SESSION_C, iso(NOW))
        self.status()
        self.assertEqual(engine_records.read_released(self.state.root, UID), {(self.WRITER, SESSION_C)})
        shutil.rmtree(directory)
        self.status()
        self.assertEqual(engine_records.read_released(self.state.root, UID), set())

    def test_when_that_bridge_later_dies_the_remembered_scope_stays_hidden_and_a_record_with_only_remembered_scopes_goes(self):
        self.start_world()
        directory = self.live_bridge()
        engine_records.remember_released(self.state.root, UID, self.WRITER, SESSION_C, iso(NOW))
        self.machine.remove(4242)                                                     # the bridge ended without cleanup
        self.assertEqual([entry['session_id'] for entry in self.left()], [SESSION_D])
        self.assertTrue(directory.exists())                                            # session D is still open in it
        engine_records.remember_released(self.state.root, UID, self.WRITER, SESSION_D, iso(NOW))
        self.assertEqual(self.left(), [])
        self.assertFalse(directory.exists())
        self.status()
        self.assertEqual(engine_records.read_released(self.state.root, UID), set())


class StateTests(StatusCase):
    ID = 'claude-4242-%d' % (NOW-900)

    def test_active_until_the_call_is_more_than_thirty_minutes_ago(self):
        self.start_world()
        directory, _ = self.bridge_with_runtime(relay_last_call=None)
        for seconds, state in ((0, 'active'), (1799, 'active'), (1800, 'active'), (1801, 'idle'), (86400, 'idle')):
            self.update(directory, 'bridge', last_call_at=iso(at(seconds)))
            connection = self.find(self.status(), self.ID)
            self.assertEqual((connection['state'], connection['idle_seconds']), (state, seconds), seconds)

    def test_no_recorded_call_means_active_and_unknown_idle_time(self):
        self.start_world()
        self.bridge_with_runtime(last_call=None, relay_last_call=None)
        connection = self.find(self.status(), self.ID)
        self.assertEqual((connection['state'], connection['idle_seconds'], connection['last_call_at']),
                         ('active', None, None))

    def test_the_owner_gone_means_ended_however_recent_the_call_was(self):
        self.start_world()
        self.bridge_with_runtime()
        self.machine.remove(500)
        connection = self.find(self.status(), self.ID)
        self.assertEqual((connection['state'], connection['owner_alive'], connection['owner_pid']), ('ended', False, 500))

    def test_a_reused_owner_pid_does_not_count_as_the_owner(self):
        self.start_world()
        self.bridge_with_runtime()
        self.machine.procs[500]['start'] = NOW-100      # a newer process than the bridge now has that pid
        self.assertEqual(self.find(self.status(), self.ID)['state'], 'ended')

    def test_an_unrecorded_bridge_or_runtime_whose_parent_is_launchd_is_ended(self):
        self.start_world()
        self.add_bridge(4300, 1, NOW-700, command=self.commands.old_bridge)
        self.add_runtime(4000, NOW-5000, relay=False, parent=1)
        states = {item['pid']: (item['state'], item['owner_pid'], item['owner_alive']) for item in self.status()['connections']}
        self.assertEqual(states, {4300: ('ended', None, False), 4000: ('ended', None, False)})

    def test_busy_comes_from_the_bridge_or_the_relay(self):
        self.start_world()
        bridge_dir, relay_dir = self.bridge_with_runtime()
        self.assertFalse(self.find(self.status(), self.ID)['busy'])
        self.update(bridge_dir, 'bridge', busy=True)
        self.assertTrue(self.find(self.status(), self.ID)['busy'])
        self.update(bridge_dir, 'bridge', busy=False)
        self.update(relay_dir, 'relay', busy=True)
        self.assertTrue(self.find(self.status(), self.ID)['busy'])

    def test_the_last_call_is_the_newest_of_the_bridge_the_relay_and_the_activity_log(self):
        self.start_world()
        self.bridge_with_runtime(last_call=500, relay_last_call=400)
        self.state.activity([State.line('relay-2001-%d' % (NOW-890), 90, SESSION_A)])
        self.assertEqual(self.find(self.status(), self.ID)['idle_seconds'], 90)


class LeaseTests(StatusCase):
    def dead_bridge(self, name='d1', pid=7001, session=SESSION_C, last=1000, cleanup='open', **fields):
        return self.state.bridge(name, pid, NOW-5000, owner_pid=501, cwd='/work/dead', session_id=session,
                                 scopes=[State.scope(session, last=at(last))], cleanup=cleanup, **fields)

    def left(self, **settings):
        return self.status(**settings)['leases']['maybe_left']

    def test_a_session_in_a_dead_bridge_with_open_scopes_may_have_been_left(self):
        self.start_world()
        self.dead_bridge()
        self.assertEqual(self.left(), [{'session_id': SESSION_C, 'agent': 'claude', 'connection_id': 'claude-7001-%d' % (NOW-5000),
                                        'cwd': '/work/dead', 'ended_at': None, 'releasable': True}])

    def test_a_dead_relay_is_a_codex_session_and_one_session_is_listed_once_with_the_bridge_as_its_owner(self):
        self.start_world()
        self.state.relay('d2', 7101, NOW-4000, cwd='/work/codex', scopes=[State.scope(SESSION_D, last=at(900))])
        self.state.relay('d3', 7102, NOW-4000, cwd='/work/both', scopes=[State.scope(SESSION_C, last=at(2000))])
        self.dead_bridge()
        left = {item['session_id']: item for item in self.left()}
        self.assertEqual(sorted(left), [SESSION_C, SESSION_D])
        self.assertEqual((left[SESSION_D]['agent'], left[SESSION_D]['connection_id'], left[SESSION_D]['cwd']),
                         ('codex', 'codex-7101-%d' % (NOW-4000), '/work/codex'))
        self.assertEqual((left[SESSION_C]['agent'], left[SESSION_C]['connection_id']), ('claude', 'claude-7001-%d' % (NOW-5000)))

    def test_ended_at_is_only_known_when_the_writer_wrote_its_own_exit(self):
        self.start_world()
        self.dead_bridge('d1', 7001, SESSION_C, cleanup='not_confirmed', updated_at='2026-10-18T11:41:00Z')
        self.dead_bridge('d2', 7002, SESSION_D, cleanup='open', updated_at='2026-10-18T11:42:00Z')
        left = {item['session_id']: item['ended_at'] for item in self.left()}
        self.assertEqual(left, {SESSION_C: '2026-10-18T11:41:00Z', SESSION_D: None})

    def test_releasable_needs_a_live_host_and_no_live_record_that_lists_the_session(self):
        self.start_world()
        self.dead_bridge()
        self.assertTrue(self.left()[0]['releasable'])
        self.machine.remove(1200)
        self.assertFalse(self.left()[0]['releasable'])          # the host is gone
        self.machine.add(1200, 1000, '/bin/proxy')
        self.add_runtime(2000, NOW-890)
        self.state.relay('r1', 2001, NOW-890, root_pid=2000, runtime_pid=2002, scopes=[State.scope(SESSION_C)])
        entry = self.left()[0]
        self.assertFalse(entry['releasable'])                   # a live relay still lists it

    def test_the_engines_own_release_thread_does_not_make_the_session_it_releases_unreleasable(self):
        # While the automatic cleanup releases it, its thread's relay holds the very session (in a release folder).
        self.start_world()
        self.dead_bridge()
        self.add_runtime(2000, NOW-30)
        self.state.relay('r1', 2001, NOW-30, root_pid=2000, runtime_pid=2002, cwd='/tmp/codex-cua-release-abc12345',
                         scopes=[State.scope(SESSION_C)])
        self.assertTrue(self.left()[0]['releasable'])

    def named_relay(self, name='d9', pid=7101, session=SESSION_A, bridge='bridge-4242-%d' % (NOW-900), cleanup='not_confirmed'):
        """The relay of a Claude bridge's thread that died with a scope open (B7): its record names the bridge."""
        return self.state.relay(name, pid, NOW-4000, cwd='/work/x', owner=bridge, cleanup=cleanup,
                                scopes=[State.scope(session, last=at(900))])

    def needs_user(self):
        return [item['needs_user'] for item in engine_status.build_view(self.context()).maybe_left]

    def test_a_dead_relay_that_names_its_bridge_lists_a_claude_session_that_needs_no_click_and_is_held_while_the_bridge_lives(self):
        self.start_world()
        self.add_claude(500)
        self.add_bridge(4242, 500, NOW-900)
        self.state.bridge('a1', 4242, NOW-900, owner_pid=500, cwd='/work/x', session_id=SESSION_A)
        self.named_relay()
        [entry] = self.left()
        self.assertEqual((entry['agent'], entry['releasable'], entry['connection_id']),
                         ('claude', False, 'codex-7101-%d' % (NOW-4000)))      # the live bridge holds it; the id is the relay's
        self.assertEqual(self.needs_user(), [False])

    def test_when_the_bridge_is_gone_it_is_a_claude_session_the_engine_may_release_by_itself(self):
        self.start_world()
        self.named_relay()
        [entry] = self.left()
        self.assertEqual((entry['agent'], entry['releasable'], entry['session_id']), ('claude', True, SESSION_A))
        self.assertEqual(self.needs_user(), [False])

    def test_a_relay_that_names_no_bridge_is_still_a_codex_session_that_needs_a_click(self):
        self.start_world()
        self.state.relay('d2', 7102, NOW-4000, cwd='/work/codex', scopes=[State.scope(SESSION_B, last=at(900))], cleanup='open')
        [entry] = self.left()
        self.assertEqual((entry['agent'], entry['releasable']), ('codex', True))
        self.assertEqual(self.needs_user(), [True])
        self.state.relay('d3', 7103, NOW-4000, cwd='/work/codex', scopes=[State.scope(SESSION_C, last=at(900))], cleanup='open',
                         owner='relay-4242-%d' % (NOW-900))          # a name that is not a bridge's counts as none
        self.assertEqual({item['session_id']: item['agent'] for item in self.status()['leases']['maybe_left']},
                         {SESSION_B: 'codex', SESSION_C: 'codex'})

    def test_a_live_bridges_own_session_is_not_released_by_id_either(self):
        self.start_world()
        self.dead_bridge()
        self.add_claude(500)
        self.add_bridge(4242, 500, NOW-900)
        self.state.bridge('a1', 4242, NOW-900, owner_pid=500, session_id=SESSION_C)
        self.assertFalse(self.left()[0]['releasable'])

    def test_chrome_forgets_leases_when_it_restarts_so_older_sessions_are_dropped_and_their_records_pruned(self):
        self.start_world()
        old = self.dead_bridge('old', 7001, SESSION_C, last=1000)
        newer = self.dead_bridge('new', 7002, SESSION_D, last=50)
        self.machine.add(5000, 1, self.commands.chrome, start=NOW-100)
        self.assertEqual([item['session_id'] for item in self.left()], [SESSION_D])
        self.assertFalse(old.exists())
        self.assertTrue(newer.exists())

    def test_a_session_that_ended_exactly_when_chrome_started_may_still_hold_leases(self):
        self.start_world()
        self.dead_bridge(last=100)
        self.machine.add(5000, 1, self.commands.chrome, start=NOW-100)
        self.assertEqual(len(self.left()), 1)           # only a session that ended *before* the restart is dropped
        self.machine.procs[5000]['start'] = NOW-99
        self.assertEqual(self.left(), [])

    def test_a_record_that_lists_a_gone_and_a_remaining_session_stays_untouched(self):
        self.start_world()
        directory = self.state.bridge('mixed', 7001, NOW-5000, owner_pid=501, scopes=[
            State.scope(SESSION_C, last=at(1000)), State.scope(SESSION_D, last=at(50))], cleanup='open')
        self.machine.add(5000, 1, self.commands.chrome, start=NOW-100)
        self.assertEqual([item['session_id'] for item in self.left()], [SESSION_D])
        self.assertTrue(directory.exists())

    def test_without_a_chrome_main_process_nothing_is_dropped(self):
        self.start_world()
        self.dead_bridge(last=100000)
        self.machine.add(5001, 1, self.commands.chrome+' --headless=new', start=NOW-10)
        self.assertEqual(len(self.left()), 1)
        self.machine.add(5002, 1, '/Applications/Google Chrome.app/Contents/Frameworks/x/Google Chrome Helper --type=gpu', start=NOW-10)
        self.assertEqual(len(self.left()), 1)

    def test_the_earliest_chrome_main_process_decides(self):
        self.start_world()
        self.dead_bridge(last=200)
        self.machine.add(5000, 1, self.commands.chrome, start=NOW-100)
        self.machine.add(5001, 1, '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta', start=NOW-1000)
        self.assertEqual(len(self.left()), 1)       # the older Chrome started before the session ended

    def test_dead_records_without_open_scopes_are_deleted_but_not_a_record_that_was_just_written(self):
        self.start_world()
        stale = self.state.bridge('stale', 7001, NOW-5000)
        young = self.state.bridge('young', 7002, NOW-5000, age=10)
        kept = self.dead_bridge('kept', 7003, SESSION_C)
        live = self.state.relay('live', 2001, NOW-890)
        self.add_runtime(2000, NOW-890)
        self.status()
        self.assertEqual([stale.exists(), young.exists(), kept.exists(), live.exists()], [False, True, True, True])

    def test_a_state_directory_that_cannot_be_trusted_gives_no_leases_but_still_lists_connections(self):
        self.start_world()
        self.dead_bridge()
        self.add_runtime(4000, NOW-5000, relay=False)
        self.state.root.chmod(0o755)
        status = self.status()
        self.assertEqual(status['leases'], {'readable': False, 'items': [], 'maybe_left': [], 'release_blocked': False})
        self.assertEqual(len(status['connections']), 1)
        self.state.root.chmod(0o700)


class ActivityAndScreenTests(StatusCase):
    def test_lines_are_mapped_to_connections_newest_first(self):
        self.start_world()
        self.bridge_with_runtime()
        self.add_runtime(3000, NOW-2000)
        self.state.relay('r2', 3001, NOW-2000, root_pid=3000, runtime_pid=3002, scopes=[State.scope(SESSION_B)])
        self.state.activity([
            State.line('bridge-4242-%d' % (NOW-900), 300, SESSION_A, tool='js', ms=11),
            State.line('relay-2001-%d' % (NOW-890), 200, SESSION_A, tool='turn_ended', ms=22),
            State.line('relay-3001-%d' % (NOW-2000), 100, SESSION_B, tool='js_reset', ok=False, ms=33),
            State.line('relay-9001-%d' % (NOW-9000), 90, SESSION_A, tool='js', ms=44),      # a dead relay of the same thread
            State.line('relay-9002-%d' % (NOW-9000), 80, None, tool='js', ms=55),            # a dead relay, unknown thread
            State.line('bridge-8001-%d' % (NOW-8000), 70, SESSION_D, tool='js', ms=66)])     # a dead bridge
        activity = self.status()['activity']
        self.assertEqual([(item['tool'], item['connection_id'], item['agent'], item['ok'], item['ms']) for item in activity], [
            ('js', 'claude-8001-%d' % (NOW-8000), 'claude', True, 66),
            ('js', 'codex-9002-%d' % (NOW-9000), 'codex', True, 55),
            ('js', 'claude-4242-%d' % (NOW-900), 'claude', True, 44),
            ('js_reset', 'codex-3001-%d' % (NOW-2000), 'codex', False, 33),
            ('turn_ended', 'claude-4242-%d' % (NOW-900), 'claude', True, 22),
            ('js', 'claude-4242-%d' % (NOW-900), 'claude', True, 11)])
        self.assertEqual(activity[0]['at'], iso(at(70)))
        self.assertEqual(sorted(activity[0]), ['agent', 'at', 'connection_id', 'cwd', 'error', 'error_text', 'ms', 'ok',
                                               'tool'])
        self.assertEqual(activity[0]['cwd'], None, 'an older writer\'s line names no folder')
        self.assertEqual([item['error'] for item in activity], [None]*6, 'nor why a call failed')
        self.assertEqual([item['error_text'] for item in activity], [None]*6)

    def test_a_failed_call_s_line_says_why(self):
        self.start_world()
        self.state.activity([State.line('bridge-4242-%d' % (NOW-900), 30, SESSION_A, ok=False, error='screen_locked'),
                             State.line('bridge-4242-%d' % (NOW-900), 20, SESSION_A, ok=False, error='timeout')])
        self.assertEqual([item['error'] for item in self.status()['activity']], ['timeout', 'screen_locked'])

    def test_a_failed_call_s_error_text_shows_only_while_the_person_asks_for_it(self):
        self.start_world()
        writer = 'bridge-4242-%d' % (NOW-900)
        self.state.activity([State.line(writer, 30, SESSION_A, ok=False, error='error', error_text='ReferenceError: y'),
                             State.line(writer, 20, SESSION_A, ok=False, error='timeout')])
        status = self.status()
        self.assertEqual(status['settings'], {'error_text': False})
        self.assertEqual([item['error_text'] for item in status['activity']], [None, None])
        self.state.settings({'schema_version': 1, 'error_text': True})
        status = self.status()
        self.assertEqual(status['settings'], {'error_text': True})
        self.assertEqual([item['error_text'] for item in status['activity']], [None, 'ReferenceError: y'])
        # Turned off again, what was kept is not shown either.
        self.state.settings({'schema_version': 1, 'error_text': False})
        self.assertEqual([item['error_text'] for item in self.status()['activity']], [None, None])

    def test_a_line_names_the_folder_its_writer_worked_in_after_the_connection_is_gone(self):
        """Most of the log is of conversations that have ended and been tidied away: their records are gone, and the
        기록 tab showed "—" for 194 of 200 lines."""
        self.start_world()
        self.state.activity([
            State.line('bridge-8001-%d' % (NOW-8000), 30, SESSION_D, cwd='/Users/x/dev/gone'),
            State.line('relay-9002-%d' % (NOW-9000), 20, None, cwd='dev/relative'),
            State.line('relay-9003-%d' % (NOW-9000), 10, None, cwd=['/a'])])
        self.assertEqual([(item['connection_id'], item['cwd']) for item in self.status()['activity']], [
            ('codex-9003-%d' % (NOW-9000), None), ('codex-9002-%d' % (NOW-9000), None),
            ('claude-8001-%d' % (NOW-8000), '/Users/x/dev/gone')])

    def test_only_the_newest_two_hundred_lines_are_reported(self):
        self.start_world()
        writer = 'bridge-4242-%d' % (NOW-900)
        self.state.activity([State.line(writer, 1000-index, SESSION_A, ms=index) for index in range(250)])
        activity = self.status()['activity']
        self.assertEqual(len(activity), 200)
        self.assertEqual((activity[0]['ms'], activity[-1]['ms']), (249, 50))

    def test_the_screen_belongs_to_the_connection_with_a_call_in_the_last_ten_seconds(self):
        self.start_world()
        bridge_dir, relay_dir = self.bridge_with_runtime(last_call=9, relay_last_call=9)
        screen = self.status()['screen']
        self.assertEqual(screen, {'active_connection_id': 'claude-4242-%d' % (NOW-900), 'last_call_at': iso(at(9))})
        self.update(bridge_dir, 'bridge', last_call_at=iso(at(11)))
        self.update(relay_dir, 'relay', last_call_at=iso(at(11)))
        self.assertEqual(self.status()['screen'], {'active_connection_id': None, 'last_call_at': iso(at(11))})

    def test_an_ended_turn_is_no_call(self):
        """turn_ended only ends a turn, the AI's own or the one a release ends: the relay cannot tell which, and neither
        uses the screen. So it wakes no resting connection up and holds no screen; it is still a line of the log."""
        self.start_world()
        self.bridge_with_runtime(last_call=4000, relay_last_call=4000)
        self.state.activity([State.line('relay-2001-%d' % (NOW-890), 3, SESSION_A, tool='turn_ended',
                                        owner='bridge-4242-%d' % (NOW-900))])
        status = self.status()
        conn = next(item for item in status['connections'] if item['id'] == 'claude-4242-%d' % (NOW-900))
        self.assertEqual((conn['state'], conn['idle_seconds']), ('idle', 4000))
        self.assertEqual(status['screen'], {'active_connection_id': None, 'last_call_at': iso(at(4000))})
        self.assertEqual([(line['tool'], line['connection_id']) for line in status['activity']],
                         [('turn_ended', 'claude-4242-%d' % (NOW-900))])

    def test_a_call_that_is_still_running_keeps_the_screen_even_if_it_started_long_ago(self):
        self.start_world()
        self.bridge_with_runtime(last_call=120, relay_last_call=120, busy=True)
        self.assertEqual(self.status()['screen']['active_connection_id'], 'claude-4242-%d' % (NOW-900))

    def test_the_newest_of_several_active_connections_wins_and_a_dead_writers_call_counts_for_nobody(self):
        self.start_world()
        self.bridge_with_runtime(last_call=8, relay_last_call=8)
        self.add_runtime(3000, NOW-2000)
        self.state.relay('r2', 3001, NOW-2000, root_pid=3000, runtime_pid=3002, last_call_at=iso(at(3)),
                         scopes=[State.scope(SESSION_B)])
        self.state.activity([State.line('bridge-8001-%d' % (NOW-8000), 1, SESSION_D)])
        screen = self.status()['screen']
        self.assertEqual(screen['active_connection_id'], 'codex-3001-%d' % (NOW-2000))
        self.assertEqual(screen['last_call_at'], iso(at(1)))


if __name__ == '__main__':
    unittest.main()
