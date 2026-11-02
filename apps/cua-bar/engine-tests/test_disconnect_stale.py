"""Disconnect only one stale MCP bridge on a fake Mac; never a live user process."""
import signal
from unittest.mock import patch

import engine_actions
import test_engine_actions as actions
import test_engine_cli as cli
from engine_support import NOW
from test_runtime_identity import write_engine
from runtime_identity import installed_identity


class DisconnectTests(actions.ActionCase):
    def setUp(self):
        super().setUp()
        engines = self.home/'.local/share/codex-cua/engine'
        engines.mkdir(parents=True, mode=0o700)
        write_engine(engines/'0.8.18', version='0.8.18')
        (engines/'current').symlink_to('0.8.18')

    def bridge(self, **changes):
        directory, relay = self.bridge_with_runtime()
        self.update(directory, 'bridge', version='0.8.13', **changes)
        return directory, relay

    def disconnect(self):
        return engine_actions.disconnect_stale_connection(self.ctx(), actions.BRIDGE_ID)

    def test_stale_bridge_is_released_and_disconnected_without_signalling_owned_runtimes_or_clients(self):
        directory, _ = self.bridge()
        self.writer(directory, 4242, NOW-900, actions.DONE)
        self.watch(4242, 500, 1000, 1100, 2000, 2001, 2002)
        result = self.disconnect()
        self.assertEqual(result, {'ok': True, 'stopped': True, 'disconnected': True, 'released': True, 'reason': None})
        self.assertEqual(self.events, [('release', 4242), ('signal', 4242, signal.SIGTERM)])
        self.assertEqual(self.machine.signals, [(4242, signal.SIGTERM)])
        self.assertTrue(all(pid in self.machine.procs for pid in (500, 1000, 1100, 2000, 2001, 2002)))

    def test_busy_bridge_is_left_alone_without_release_or_signal(self):
        directory, _ = self.bridge(busy=True)
        writer = self.writer(directory, 4242, NOW-900, actions.DONE)
        self.assertEqual(self.disconnect()['reason'], 'request_in_flight')
        self.assertEqual(writer.requests, [])
        self.assertEqual(self.machine.signals, [])

    def test_release_discovering_an_inflight_request_does_not_disconnect(self):
        directory, _ = self.bridge()
        self.writer(directory, 4242, NOW-900, {'released': False, 'reason': 'request_in_flight', 'scope_count': 0})
        result = self.disconnect()
        self.assertFalse(result['disconnected'])
        self.assertEqual(result['reason'], 'request_in_flight')
        self.assertEqual(self.machine.signals, [])

    def test_a_request_starting_while_release_waits_is_left_running(self):
        directory, _ = self.bridge()
        def released(request):
            self.update(directory, 'bridge', busy=True)
            return actions.DONE
        self.writer(directory, 4242, NOW-900, released)
        self.assertEqual(self.disconnect()['reason'], 'request_in_flight')
        self.assertEqual(self.machine.signals, [])

    def test_current_bridge_is_not_disconnected_or_released(self):
        directory, _ = self.bridge()
        installed = installed_identity(self.home)
        self.update(directory, 'bridge', version=installed['version'], runtime_revision=installed['revision'])
        writer = self.writer(directory, 4242, NOW-900, actions.DONE)
        self.assertEqual(self.disconnect()['reason'], 'not_stale')
        self.assertEqual(writer.requests, [])
        self.assertEqual(self.machine.signals, [])

    def test_codex_connection_and_unknown_id_are_not_disconnected(self):
        self.codex_relay()
        self.assertEqual(engine_actions.disconnect_stale_connection(self.ctx(), actions.RELAY_ID)['reason'], 'unsupported')
        self.assertEqual(engine_actions.disconnect_stale_connection(self.ctx(), 'claude-1-2')['reason'], 'not_found')
        self.assertEqual(self.machine.signals, [])

    def test_pid_reuse_and_exec_of_another_program_are_never_signalled(self):
        directory, _ = self.bridge()
        def replaced(request):
            self.machine.procs[4242].update(command='/usr/bin/vim notes')
            return actions.DONE
        self.writer(directory, 4242, NOW-900, replaced)
        self.assertFalse(self.disconnect()['disconnected'])
        self.assertEqual(self.machine.signals, [])

    def test_bridge_ignoring_sigterm_is_reported_as_timeout_without_sigkill(self):
        directory, _ = self.bridge()
        self.writer(directory, 4242, NOW-900, actions.DONE)
        self.machine.ignore_term.add(4242)
        result = self.disconnect()
        self.assertFalse(result['disconnected'])
        self.assertEqual(result['reason'], 'timeout')
        self.assertEqual(self.machine.signals, [(4242, signal.SIGTERM)])

    def test_unverified_process_information_is_not_signalled(self):
        directory, _ = self.bridge()
        self.writer(directory, 4242, NOW-900, actions.DONE)
        with patch.object(engine_actions, 'lookup', side_effect=OSError('unavailable')):
            result = self.disconnect()
        self.assertEqual(result['reason'], 'unverified')
        self.assertEqual(self.machine.signals, [])


class DisconnectCliTests(cli.CliCase):
    def test_disconnect_returns_one_json_object_and_rejects_group_or_force(self):
        self.machine.add(5, 1, '/bin/x')
        self.assertEqual(self.run_json('disconnect', '--connection', 'claude-1-2', '--json'),
                         {'ok': False, 'stopped': False, 'disconnected': False, 'released': False, 'reason': 'not_found'})
        for args in (('disconnect',), ('disconnect', '--connection', 'claude-1-2', '--force'),
                     ('disconnect', '--group', 'all'), ('disconnect', '--connection', 'claude-1-2', '--ended')):
            with self.subTest(args=args):
                self.rejected(*args)

    rejected = cli.ArgumentTests.rejected
