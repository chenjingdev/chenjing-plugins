"""The connection test (`doctor --probe`): one call of cua.getState() on a thread of its own, and nothing left behind.

The thread works in a new private folder named like codex-cua-probe-XXXXXXXX. That folder is how the runtime Codex starts
for it is found and ended afterwards, and how the status leaves it out of every list while it lives. Fake host, fake
Mac and temporary folders only: no Codex, no process, no signal of the machine the tests run on.
"""
import asyncio
import json
import os
from pathlib import Path
import re
import signal
import stat
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import engine_core
import engine_status
import host_mcp
import mcp_stdio  # noqa: F401  (imported before the tests forbid the real home: it reads it once)
import setup
from engine_core import PROBE_FOLDER_PREFIX, is_probe_folder, iso
from engine_support import NOW, SESSION_A, SESSION_C, EngineCase, FakeHost, State, at

TITLE = 'Read-only Codex CUA inventory check'
FOLDER = '/private/var/folders/ab/xyz/T/codex-cua-probe-q1w2e3r4'


class FolderNameTests(unittest.TestCase):
    def test_only_a_folder_made_by_the_test_is_taken_for_one(self):
        for path in (FOLDER, FOLDER+'/', '/tmp/codex-cua-probe-aB3_xY9z', 'codex-cua-probe-q1w2e3r4'):
            with self.subTest(path):
                self.assertTrue(is_probe_folder(path))
        for path in (None, 7, '', '/', '/work/codex-cua-probe', '/work/codex-cua-probe-', '/work/codex-cua-probe-ab',
                     '/work/my-codex-cua-probe-q1w2e3r4', '/work/codex-cua-probe-q1w2e3r4/sub', '/work/codex-cua-release-q1w2e3r4',
                     '/work/codex-cua-probe-q1w2e3r4.bak', '/work/codex-cua-probe-q1w 2e3r4', '/work/codex-cua-probe-'+'x'*40):
            with self.subTest(path):
                self.assertFalse(is_probe_folder(path))

    def test_the_name_the_test_makes_is_one_it_recognises(self):
        with tempfile.TemporaryDirectory(prefix=PROBE_FOLDER_PREFIX) as folder:
            self.assertTrue(is_probe_folder(folder))
            self.assertTrue(is_probe_folder(os.path.realpath(folder)), 'lsof prints the real path')

    def test_the_relay_names_the_folder_the_same_way(self):
        # Two languages, one rule: the relay (relay.mjs) leaves a test's calls out of the activity log by this name.
        source = (Path(setup.__file__).parent/'relay/relay.mjs').read_text()
        found = re.search(r'^const PROBE_FOLDER = /(.+)/;$', source, re.MULTILINE)
        self.assertIsNotNone(found)
        self.assertEqual(found.group(1), engine_core._PROBE_FOLDER.pattern)


class StatusCase(EngineCase):
    def status(self, **settings):
        return engine_status.status(self.context(**settings))

    def probe_runtime(self, repl=3100, relay=False, folder=FOLDER, start=NOW-4):
        """The runtime Codex started for the test's thread: under the host's app-server, working in the thread's folder."""
        self.add_runtime(repl, start, relay=relay)
        self.machine.cwds[repl] = folder
        return repl


class LeftOutOfTheStatusTests(StatusCase):
    def setUp(self):
        super().setUp()
        self.start_world()

    def test_a_runtime_that_works_in_the_folder_of_the_test_is_no_connection(self):
        self.probe_runtime()
        self.add_runtime(3000, NOW-2000, relay=False)
        self.machine.cwds[3000] = '/work/codex'
        status = self.status()
        self.assertEqual([(item['agent'], item['pid'], item['cwd']) for item in status['connections']],
                         [('codex', 3000, '/work/codex')])
        self.assertEqual(status['screen'], {'active_connection_id': None, 'last_call_at': None})

    def test_a_relay_that_serves_the_test_is_no_connection_and_is_not_working(self):
        self.probe_runtime(relay=True)
        self.state.relay('probe', 3101, NOW-4, root_pid=3100, runtime_pid=3102, cwd=FOLDER, busy=True,
                         last_call_at=iso(at(1)), scopes=[State.scope(SESSION_C, first=at(2), last=at(1))], cleanup='open')
        status = self.status()
        self.assertEqual(status['connections'], [])
        self.assertEqual(status['screen'], {'active_connection_id': None, 'last_call_at': None})
        self.assertEqual(status['leases']['maybe_left'], [])

    def test_a_relay_of_an_older_version_that_logged_the_call_does_not_make_the_screen_busy(self):
        self.probe_runtime(relay=True)
        self.state.relay('probe', 3101, NOW-4, root_pid=3100, runtime_pid=3102, cwd=FOLDER, last_call_at=iso(at(1)))
        self.state.activity([State.line('relay-3101-%d' % (NOW-4), 1, SESSION_C, ms=40),
                             State.line('relay-3101-%d' % (NOW-4), 2, SESSION_C, tool='turn_ended', ms=3)])
        status = self.status()
        self.assertEqual(status['activity'], [])
        self.assertEqual(status['screen'], {'active_connection_id': None, 'last_call_at': None})

    def test_a_record_that_the_test_left_dead_with_an_open_scope_is_no_lease_and_goes(self):
        self.state.relay('probe', 3101, NOW-300, root_pid=3100, runtime_pid=3102, cwd=FOLDER,
                         scopes=[State.scope(SESSION_C, first=at(300), last=at(299))], cleanup='not_confirmed')
        self.state.relay('chat', 3201, NOW-300, root_pid=3200, runtime_pid=3202, cwd='/work/codex',
                         scopes=[State.scope(SESSION_A, first=at(300), last=at(299))], cleanup='not_confirmed')
        self.assertEqual(self.state.names('relay'), ['relay-chat', 'relay-probe'])
        status = self.status()
        self.assertEqual([item['session_id'] for item in status['leases']['maybe_left']], [SESSION_A])
        self.assertEqual(self.state.names('relay'), ['relay-chat'], 'the test holds no lease worth keeping its record for')

    def test_a_fresh_dead_record_of_the_test_is_kept_for_a_minute_like_any_other(self):
        self.state.relay('probe', 3101, NOW-300, age=10, cwd=FOLDER, scopes=[State.scope(SESSION_C)], cleanup='not_confirmed')
        self.assertEqual(self.status()['leases']['maybe_left'], [])
        self.assertEqual(self.state.names('relay'), ['relay-probe'])

    def test_a_folder_that_only_looks_like_the_one_of_the_test_is_a_connection_like_any_other(self):
        for index, folder in enumerate(('/work/codex-cua-probe', '/work/codex-cua-probe-ab', '/work/my-codex-cua-probe-q1w2e3r4',
                                        '/work/codex-cua-release-q1w2e3r4')):
            self.probe_runtime(repl=3100+10*index, folder=folder, start=NOW-2000)
        status = self.status()
        self.assertEqual(sorted(item['cwd'] for item in status['connections']),
                         ['/work/codex-cua-probe', '/work/codex-cua-probe-ab', '/work/codex-cua-release-q1w2e3r4',
                          '/work/my-codex-cua-probe-q1w2e3r4'])


class ProbeCase(EngineCase):
    """A ready host whose connection the fake host answers, the way the release tests have it."""

    def setUp(self):
        super().setUp()
        self.start_world()
        self.host_socket()
        self.hosts = []
        self.calls = []                 # the params of every js call the host got
        self.hooks = {}                 # method (or 'js') -> callable run when the host gets it
        self.js_result = {'content': [{'type': 'text', 'text': 'PRIVATE_INVENTORY'}]}
        self.js_delay = 0

        async def js(params):
            self.calls.append(params)
            if 'js' in self.hooks:
                self.hooks['js']()
            if self.js_delay:
                await asyncio.sleep(self.js_delay)
            return self.js_result
        self.tools = {'js': js}

        async def connect(**kwargs):
            host = FakeHost(self.tools)
            host.hooks.update({key: value for key, value in self.hooks.items() if key != 'js'})
            self.hosts.append(host)
            return host
        patcher = patch.object(host_mcp, 'unix_connect', AsyncMock(side_effect=connect))
        self.connect = patcher.start()
        self.addCleanup(patcher.stop)

    def registry(self):
        return json.loads((self.host_dir/'host.json').read_text())

    def run_probe(self, timeout=5, **settings):
        return setup.run_probe(self.registry(), timeout, self.context(**settings))

    def spawn_runtime(self, repl=3100, others=()):
        """Codex starting the thread's runtime while the probe waits for its catalogue; what else it does meanwhile."""
        def spawn():
            folder = os.path.realpath(self.hosts[-1].thread_params['cwd'])
            self.seen_folder = self.hosts[-1].thread_params['cwd']
            self.add_runtime(repl, int(self.machine.now), relay=False)
            self.machine.cwds[repl] = folder
            for other in others:
                other()
        self.hooks['mcpServerStatus/list'] = spawn
        return spawn


class ProbeRunTests(ProbeCase):
    def test_one_call_of_getState_with_its_title_on_a_thread_that_leaves_when_it_is_done(self):
        report = self.run_probe()
        self.assertEqual((report['status'], report['response_count'], report['is_error']), ('checked', 1, False))
        self.assertNotIn('PRIVATE_INVENTORY', json.dumps(report))
        [host] = self.hosts
        [js] = self.calls
        self.assertEqual(js['arguments'], {'code': 'await cua.getState();', 'title': TITLE})
        methods = [message.get('method') for message in host.received]
        self.assertEqual(methods[:6], ['initialize', 'initialized', 'plugin/installed', 'config/read', 'thread/start',
                                       'mcpServerStatus/list'])
        self.assertEqual(methods[-1], 'thread/unsubscribe')
        self.assertTrue(host.closed)
        [started] = [message['params'] for message in host.received if message.get('method') == 'thread/start']
        self.assertEqual(started, {'ephemeral': True, 'cwd': host.thread_params['cwd']})

    def test_the_thread_works_in_a_new_private_folder_that_is_gone_afterwards(self):
        seen = {}

        def look():
            folder = self.hosts[-1].thread_params['cwd']
            seen.update(folder=folder, mode=stat.S_IMODE(os.lstat(folder).st_mode), owner=os.lstat(folder).st_uid,
                        entries=os.listdir(folder))
        self.hooks['mcpServerStatus/list'] = look
        self.assertEqual(self.run_probe()['status'], 'checked')
        self.assertTrue(is_probe_folder(seen['folder']))
        self.assertNotEqual(seen['folder'], os.getcwd())
        self.assertEqual((seen['mode'], seen['owner'], seen['entries']), (0o700, os.getuid(), []))
        self.assertFalse(os.path.exists(seen['folder']))

    def test_every_test_has_a_folder_of_its_own(self):
        self.run_probe()
        self.run_probe()
        first, second = (host.thread_params['cwd'] for host in self.hosts)
        self.assertNotEqual(first, second)

    def test_the_runtime_that_works_in_that_folder_is_ended_and_no_other(self):
        self.add_runtime(3000, NOW-4000, relay=False)           # the runtime of another thread
        self.machine.cwds[3000] = '/work/codex'
        self.spawn_runtime(3100, others=[lambda: (self.add_runtime(3200, int(self.machine.now), relay=False),
                                                  self.machine.cwds.update({3200: '/work/other'}))])
        self.assertEqual(self.run_probe()['status'], 'checked')
        self.assertEqual(self.machine.signals, [(3100, signal.SIGTERM)])
        self.assertNotIn(3100, self.machine.procs)
        self.assertIn(3000, self.machine.procs)
        self.assertIn(3200, self.machine.procs)
        self.assertFalse(os.path.exists(self.seen_folder))

    def test_a_runtime_in_that_folder_that_is_not_under_the_hosts_app_server_is_left_alone(self):
        def spawn():
            self.add_runtime(3100, int(self.machine.now), relay=False, parent=1)
            self.machine.cwds[3100] = os.path.realpath(self.hosts[-1].thread_params['cwd'])
        self.hooks['mcpServerStatus/list'] = spawn
        self.assertEqual(self.run_probe()['status'], 'checked')
        self.assertEqual(self.machine.signals, [])

    def test_a_call_that_fails_ends_the_runtime_and_removes_the_folder_all_the_same(self):
        self.js_result = {'isError': True, 'content': [{'type': 'text', 'text': 'no screen'}]}
        self.spawn_runtime(3100)
        self.assertEqual(self.run_probe()['status'], 'failed')
        self.assertEqual(self.machine.signals, [(3100, signal.SIGTERM)])
        self.assertFalse(os.path.exists(self.seen_folder))

    def test_a_call_nobody_answers_ends_the_runtime_and_removes_the_folder_all_the_same(self):
        self.js_delay = 3600
        self.spawn_runtime(3100)
        self.assertEqual(self.run_probe(timeout=4.0)['status'], 'timeout')
        self.assertEqual(self.machine.signals, [(3100, signal.SIGTERM)])
        self.assertFalse(os.path.exists(self.seen_folder))

    def test_a_host_that_cannot_be_reached_leaves_no_folder_and_asks_nothing(self):
        folders = []
        real = tempfile.mkdtemp

        def made(*args, **kwargs):
            folder = real(*args, **kwargs)
            folders.append(folder)
            return folder
        with patch.object(host_mcp, 'unix_connect', AsyncMock(side_effect=OSError('gone'))), \
             patch.object(setup.tempfile, 'mkdtemp', side_effect=made):
            report = self.run_probe()
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(len(folders), 1)
        self.assertFalse(os.path.exists(folders[0]))
        self.assertEqual(self.machine.signals, [])

    def test_without_a_folder_there_is_no_test_and_no_connection_is_made(self):
        with patch.object(setup.tempfile, 'mkdtemp', side_effect=OSError('disk full')):
            report = self.run_probe()
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(report['tool_names'], [])
        self.connect.assert_not_called()

    def test_a_cleanup_that_goes_wrong_does_not_change_what_the_test_found(self):
        self.spawn_runtime(3100)
        with patch('engine_release.end_thread_runtimes', side_effect=RuntimeError('ps is gone')):
            report = self.run_probe()
        self.assertEqual(report['status'], 'checked')
        self.assertFalse(os.path.exists(self.seen_folder), 'the folder goes whatever else happened')


class TracesTests(ProbeCase):
    """Where a call of the test could remain: the activity log, the records of bridges and relays, the process list
    (the connection list and the question whether the screen is in use are made of those) and the leases."""

    def snapshot(self):
        return sorted(str(item.relative_to(self.state.root)) for item in self.state.root.rglob('*'))

    def status(self):
        return engine_status.status(self.context())

    def test_the_test_writes_no_record_and_no_line(self):
        before = self.snapshot()
        self.spawn_runtime(3100)
        self.assertEqual(self.run_probe()['status'], 'checked')
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.state.root/'activity.jsonl').exists())

    def test_nothing_of_it_is_in_the_status_once_it_is_done(self):
        self.add_runtime(3000, NOW-4000, relay=False)
        self.machine.cwds[3000] = '/work/codex'
        self.spawn_runtime(3100)
        self.assertEqual(self.run_probe()['status'], 'checked')
        status = self.status()
        self.assertEqual([item['pid'] for item in status['connections']], [3000])
        self.assertEqual([item['state'] for item in status['connections']], ['active'], 'no ended connection either')
        self.assertEqual((status['activity'], status['leases']['maybe_left']), ([], []))
        self.assertEqual(status['screen'], {'active_connection_id': None, 'last_call_at': None})
        self.assertFalse(any(item['busy'] for item in status['connections']))

    def test_while_the_call_runs_the_status_does_not_see_it(self):
        self.add_runtime(3000, NOW-4000, relay=False)
        self.machine.cwds[3000] = '/work/codex'
        self.spawn_runtime(3100)
        during = []
        self.hooks['js'] = lambda: during.append(self.status())
        self.assertEqual(self.run_probe()['status'], 'checked')
        [status] = during
        self.assertEqual([item['pid'] for item in status['connections']], [3000])
        self.assertEqual(status['screen'], {'active_connection_id': None, 'last_call_at': None})
        self.assertNotIn(3100, [item['pid'] for item in status['connections']])

    def test_a_runtime_that_serves_the_thread_through_the_relay_is_left_out_while_it_lives_and_leaves_no_line(self):
        # A host that gave the plain thread the relay: its record carries the thread's folder as working folder.
        def spawn():
            folder = os.path.realpath(self.hosts[-1].thread_params['cwd'])
            self.add_runtime(3100, int(self.machine.now), relay=True)
            self.machine.cwds[3100] = folder
            self.state.relay('probe', 3101, int(self.machine.now), root_pid=3100, runtime_pid=3102, cwd=folder)
        self.hooks['mcpServerStatus/list'] = spawn
        during = []

        def look():
            during.append(self.status())
            self.update(self.state.root/'relays/relay-probe', 'relay', busy=True, last_call_at=iso(self.machine.now),
                        scopes=[State.scope(self.hosts[-1].thread_id, first=self.machine.now, last=self.machine.now)])
            during.append(self.status())
        self.hooks['js'] = look
        self.assertEqual(self.run_probe()['status'], 'checked')
        for status in during:
            self.assertEqual(status['connections'], [])
            self.assertEqual(status['screen'], {'active_connection_id': None, 'last_call_at': None})
        self.assertEqual(self.machine.signals, [(3100, signal.SIGTERM)])


class DoctorTests(ProbeCase):
    """`doctor --probe` on a machine whose setup checks are replaced: they would start the interpreter of the venv."""

    def setUp(self):
        super().setUp()
        for target, value in (('venv_ready', True), ('login_environment_status', 'ready'), ('relay_status', 'ready')):
            patcher = patch.object(setup, target, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.environment = {'CODEX_CUA_APP_PATH': str(self.app), 'CODEX_HOST_CUA_STATE_DIR': str(self.host_dir)}
        registry = patch('mcp_stdio.read_host_registry', side_effect=lambda state: self.registry_or_refusal())
        registry.start()
        self.addCleanup(registry.stop)

    def registry_or_refusal(self):
        data = self.registry()
        if data.get('status') != 'ready':
            raise host_mcp.BridgeFailure('The Codex Desktop host launcher is not ready. No runtime was started.')
        return data

    def doctor(self, timeout=5):
        return setup.doctor(self.context().plugin_root, probe=True, timeout=timeout, home=self.home,
                            environment=self.environment, context=self.context())

    def test_a_ready_host_is_asked_once_and_the_report_says_what_was_found(self):
        self.spawn_runtime(3100)
        report = self.doctor()
        self.assertEqual((report['status'], report['cua'], report['probe']['status']),
                         ('checked', 'inventory_checked', 'checked'))
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.machine.signals, [(3100, signal.SIGTERM)])
        self.assertNotIn(str(self.home), json.dumps(report))

    def test_a_host_that_is_not_ready_is_not_started_asked_or_touched(self):
        (self.host_dir/'host.json').unlink()
        forbidden = AssertionError('the connection test starts and stops nothing')
        for state in (None, 'starting', 'stopping', 'closed', 'cleanup_unconfirmed'):
            with self.subTest(state), \
                 patch.object(setup.subprocess, 'run', side_effect=forbidden), \
                 patch.object(setup.subprocess, 'Popen', side_effect=forbidden), \
                 patch.object(setup.os, 'execve', side_effect=forbidden), \
                 patch.object(setup.os, 'kill', side_effect=forbidden), \
                 patch.object(setup, 'start_host', side_effect=forbidden), \
                 patch.object(setup, 'run_probe', side_effect=forbidden), \
                 patch.object(setup, 'probe_host', side_effect=forbidden), \
                 patch('host_autostart.ensure_host', side_effect=forbidden), \
                 patch.object(setup.tempfile, 'mkdtemp', side_effect=forbidden):
                if state is not None:
                    self.write_host(status=state)
                before = sorted(str(item) for item in self.root.rglob('*'))
                report = self.doctor()
                self.assertEqual(report['probe'], {'status': 'host_unavailable'})
                self.assertEqual(report['status'], 'host_unavailable')
                self.assertEqual(report['next_action'], 'reopen_app_normally_or_reconnect_mcp')
                self.assertEqual(sorted(str(item) for item in self.root.rglob('*')), before)
        self.connect.assert_not_called()
        self.assertEqual((self.machine.signals, self.machine.commands), ([], []))

    def test_a_host_whose_processes_are_gone_is_not_ready_either(self):
        self.write_host()
        with patch('mcp_stdio.read_host_registry', side_effect=host_mcp.BridgeFailure('The registered Codex host process is no longer available.')), \
             patch.object(setup, 'run_probe', side_effect=AssertionError('no test')):
            self.assertEqual(self.doctor()['probe'], {'status': 'host_unavailable'})
        self.connect.assert_not_called()

    def test_without_the_python_environment_the_host_is_not_asked(self):
        with patch.object(setup, 'venv_ready', return_value=False), \
             patch.object(setup, 'run_probe', side_effect=AssertionError('no test')):
            self.assertEqual(self.doctor()['probe'], {'status': 'dependencies_missing'})


if __name__ == '__main__':
    unittest.main()
