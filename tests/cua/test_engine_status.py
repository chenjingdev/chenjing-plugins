"""The status the menu bar app reads: every contract field, attribution of runtimes, states, leases and activity."""
import json
import os
import re
import unittest

import engine_status
from engine_core import iso
from engine_support import (APP_VERSION, NOW, SESSION_A, SESSION_B, SESSION_C, SESSION_D, UID, EngineCase, State, at)

TOP_KEYS = ['schema_version', 'generated_at', 'plugin', 'codex', 'host', 'setup', 'connections', 'leases',
            'other_tools', 'screen', 'activity']
CONNECTION_KEYS = ['id', 'agent', 'state', 'pid', 'owner_pid', 'owner_alive', 'cwd', 'started_at', 'memory_bytes',
                   'last_call_at', 'idle_seconds', 'session_id', 'busy', 'can_release', 'can_stop']
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
        self.assertEqual(status['codex'], {'installed': False, 'app_path': None, 'app_version': None, 'running': False,
                                           'pids': []})
        self.assertEqual(status['host'], {'state': 'missing', 'since': None})
        self.assertEqual(list(status['setup']), ['command', 'dependencies', 'login_environment', 'wrapper', 'relay'])
        self.assertEqual(status['connections'], [])
        self.assertEqual(status['leases'], {'readable': False, 'items': [], 'maybe_left': []})
        self.assertEqual(status['other_tools'], [])
        self.assertEqual(status['screen'], {'active_connection_id': None, 'last_call_at': None})
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
        self.assertEqual(status['host'], {'state': 'ready', 'since': iso(NOW-300)})
        self.assertEqual(status['setup'], {'command': 'ready', 'dependencies': 'ready', 'login_environment': 'ready',
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

    def test_host_codex_and_setup_sections(self):
        self.machine.add(5, 1, '/bin/x')
        status = self.status()
        self.assertEqual((status['codex']['installed'], status['codex']['running'], status['codex']['pids']),
                         (True, False, []))
        self.assertEqual(status['host']['state'], 'missing')
        self.start_world(relay=False)
        self.assertEqual(self.status()['setup']['relay'], 'inactive')
        self.machine.remove(1200)
        self.assertEqual(self.status()['host']['state'], 'closed')


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
            'busy': False, 'can_release': False, 'can_stop': True})

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

    def test_nodes_directly_under_the_app_server_are_not_cua_runtimes(self):
        self.start_world()
        self.machine.add(2100, 1100, self.commands.node_repl)
        self.assertEqual(self.status()['connections'], [])

    def test_cmux_cua_is_never_a_connection_only_a_tool_with_clients(self):
        self.start_world()
        self.add_claude(500)
        self.machine.add(3000, 1, self.commands.cmux_serve)
        self.machine.add(3001, 1, self.commands.cmux_serve)
        self.machine.add(3002, 500, self.commands.cmux_mcp)
        self.machine.add(3003, 500, self.commands.cmux_mcp)
        self.machine.add(3004, 1100, self.commands.cmux_mcp)
        self.machine.cwds.update({500: '/work/claude-project', 1100: '/work/codex-project'})
        status = self.status()
        self.assertEqual(status['connections'], [])
        self.assertEqual(status['other_tools'], [{'name': 'cmux-cua', 'running': True, 'pids': [3000, 3001], 'clients': [
            {'pid': 500, 'agent': 'claude', 'cwd': '/work/claude-project'},
            {'pid': 1100, 'agent': 'codex', 'cwd': '/work/codex-project'}]}])

    def test_cmux_cua_that_is_installed_but_not_running_is_listed_as_stopped_and_unknown_clients_have_null_fields(self):
        self.machine.add(5, 1, '/bin/x')
        self.assertEqual(self.status()['other_tools'], [])
        (self.home/'Library/Application Support/cmux/cmux-cua').mkdir(parents=True)
        self.assertEqual(self.status()['other_tools'], [{'name': 'cmux-cua', 'running': False, 'pids': [], 'clients': []}])
        self.machine.add(3002, 77, self.commands.cmux_mcp)
        self.machine.add(77, 1, '/bin/sh -c something')
        self.assertEqual(self.status()['other_tools'], [{'name': 'cmux-cua', 'running': True, 'pids': [], 'clients': [
            {'pid': 77, 'agent': None, 'cwd': None}]}])

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
        self.assertEqual(status['leases'], {'readable': False, 'items': [], 'maybe_left': []})
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
        self.assertEqual(sorted(activity[0]), ['agent', 'at', 'connection_id', 'ms', 'ok', 'tool'])

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
