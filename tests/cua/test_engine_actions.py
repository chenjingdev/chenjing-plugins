"""Release, stop and restart: results, reasons, order of events and what is never touched."""
import json
import signal
import subprocess
import time
import types
import unittest
from unittest.mock import patch

import engine_actions
import engine_status
from engine_support import ENGINE_PID, NOW, SESSION_A, SESSION_B, SESSION_C, SESSION_D, UID, EngineCase, State, at

BRIDGE_ID = 'claude-4242-%d' % (NOW-900)
RELAY_ID = 'codex-3001-%d' % (NOW-2000)
UNRECORDED_ID = 'codex-4000-%d' % (NOW-5000)
CMUX_ID = 'cmux-3501-%d' % (NOW-600)
DONE = {'released': True, 'reason': None, 'scope_count': 1}


class ActionCase(EngineCase):
    def setUp(self):
        super().setUp()
        self.start_world()
        self.events = []     # in order: ('release', pid) when a writer was asked, ('signal', pid, number) when signalled

    def ctx(self, **settings):
        return self.context(**settings)

    def writer(self, directory, pid, started_at, reply, delay=0.0):
        def handler(request):
            self.events.append(('release', pid))
            if delay:
                time.sleep(delay)
            return reply(request) if callable(reply) else reply
        return self.serve(directory, pid, started_at, handler)

    def watch(self, *pids):
        for pid in pids:
            self.machine.on_signal[pid] = lambda number, pid=pid: self.events.append(('signal', pid, number))

    def codex_relay(self, reply=DONE):
        self.add_runtime(3000, NOW-2000)
        directory = self.state.relay('r2', 3001, NOW-2000, root_pid=3000, runtime_pid=3002, cwd='/work/codex',
                                     scopes=[State.scope(SESSION_B)])
        return self.writer(directory, 3001, NOW-2000, reply)

    def unrecorded_runtime(self):
        self.add_runtime(4000, NOW-5000, relay=False)


class ReleaseTests(ActionCase):
    def release(self, wanted):
        return engine_actions.release_connection(self.ctx(), wanted)

    def test_a_claude_connection_is_released_through_its_own_bridge_only(self):
        directory, relay_dir = self.bridge_with_runtime()
        bridge = self.writer(directory, 4242, NOW-900, {'released': True, 'reason': None, 'scope_count': 2})
        relay = self.writer(relay_dir, 2001, NOW-890, DONE)
        self.assertEqual(self.release(BRIDGE_ID), {'ok': True, 'released': True, 'reason': None, 'scope_count': 2})
        self.assertEqual(bridge.requests, [{'action': 'release', 'pid': 4242, 'started_at': NOW-900}])
        self.assertEqual(relay.requests, [])

    def test_a_codex_connection_is_released_through_its_relay(self):
        relay = self.codex_relay({'released': True, 'reason': None, 'scope_count': 3})
        self.assertEqual(self.release(RELAY_ID), {'ok': True, 'released': True, 'reason': None, 'scope_count': 3})
        self.assertEqual(relay.requests, [{'action': 'release', 'pid': 3001, 'started_at': NOW-2000}])

    def test_a_refused_release_passes_its_reason_and_count_through(self):
        for reply, expected in (
                ({'released': False, 'reason': 'request_in_flight', 'scope_count': 0}, ('request_in_flight', 0)),
                ({'released': False, 'reason': 'cleanup_not_confirmed', 'scope_count': 1}, ('cleanup_not_confirmed', 1)),
                ({'released': False, 'reason': 'cleanup_tool_unavailable', 'scope_count': 0}, ('cleanup_not_confirmed', 0)),
                ({'released': False, 'scopeCount': 2}, ('cleanup_not_confirmed', 2)),
                ({'released': False, 'reason': 'Some Text! with spaces', 'scope_count': 'x'}, ('cleanup_not_confirmed', 0)),
                ({'released': 'yes', 'reason': None, 'scope_count': 1}, ('cleanup_not_confirmed', 1))):
            self.setUp()
            self.codex_relay(reply)
            result = self.release(RELAY_ID)
            self.assertEqual((result['ok'], result['released'], result['reason'], result['scope_count']),
                             (False, False, expected[0], expected[1]), reply)

    def test_nothing_to_release_is_no_failure_when_a_verified_writer_says_so(self):
        self.codex_relay({'released': False, 'reason': 'no_trusted_scope', 'scope_count': 0})
        self.assertEqual(self.release(RELAY_ID), {'ok': True, 'released': False, 'reason': 'no_trusted_scope', 'scope_count': 0})

    def test_a_contradicting_answer_is_not_taken_for_nothing_to_release(self):
        self.codex_relay({'released': False, 'reason': 'no_trusted_scope', 'scope_count': 2})
        self.assertEqual(self.release(RELAY_ID), {'ok': False, 'released': False, 'reason': 'no_trusted_scope', 'scope_count': 2})

    def test_a_connection_without_a_verified_control_endpoint_has_no_trusted_scope(self):
        self.unrecorded_runtime()
        self.assertEqual(self.release(UNRECORDED_ID),
                         {'ok': False, 'released': False, 'reason': 'no_trusted_scope', 'scope_count': 0})
        directory, _ = self.bridge_with_runtime()           # a record whose socket does not exist
        self.assertEqual(self.release(BRIDGE_ID)['reason'], 'no_trusted_scope')

    def test_unknown_dead_or_reused_connections_are_not_found(self):
        directory, _ = self.bridge_with_runtime()
        bridge = self.writer(directory, 4242, NOW-900, DONE)
        for wanted in ('claude-9999-%d' % (NOW-900), 'claude-4242-%d' % (NOW-899-5), 'codex-4242-%d' % (NOW-900),
                       'claude-4242', 'garbage', '', 'claude-4242-%d; rm -rf' % (NOW-900)):
            self.assertEqual(self.release(wanted), {'ok': False, 'released': False, 'reason': 'not_found', 'scope_count': 0}, wanted)
        self.assertEqual(bridge.requests, [])
        self.machine.remove(4242)
        self.assertEqual(self.release(BRIDGE_ID)['reason'], 'not_found')

    def test_a_writer_that_does_not_answer_or_cannot_be_reached(self):
        directory = self.codex_relay(lambda request: None).path.parent        # closes without an answer
        self.assertEqual(self.release(RELAY_ID)['reason'], 'relay_unavailable')
        self.servers[-1].close()
        self.assertEqual(self.release(RELAY_ID)['reason'], 'relay_unavailable')       # stale socket file
        bridge_dir, _ = self.bridge_with_runtime()
        self.writer(bridge_dir, 4242, NOW-901, DONE)                                  # does not know this identity
        self.assertEqual(self.release(BRIDGE_ID)['reason'], 'cleanup_not_confirmed')

    def test_a_writer_that_is_too_slow_times_out(self):
        self.codex_relay(DONE)
        self.servers[-1].handler = lambda request: time.sleep(1.5) or DONE
        with patch.object(engine_actions, 'release_timeout', return_value=0.3):
            self.assertEqual(self.release(RELAY_ID)['reason'], 'timeout')

    def waited_for(self, scopes, kind='bridge'):
        """The reply timeout a release of a record with this many open scopes is given."""
        seen = []

        def reply(record, action, uid, timeout=None, **kwargs):
            seen.append((action, timeout))
            return {'released': True, 'reason': None, 'scope_count': len(record.scopes)}
        if kind == 'bridge':
            directory, _ = self.bridge_with_runtime(scopes=False)
            self.update(directory, 'bridge', scopes=[State.scope(SESSION_A, turn='turn-%d' % number)
                                                     for number in range(scopes)], cleanup='open' if scopes else 'none')
            self.writer(directory, 4242, NOW-900, DONE)
            wanted = BRIDGE_ID
        else:
            self.add_runtime(3000, NOW-2000)
            directory = self.state.relay('r2', 3001, NOW-2000, root_pid=3000, runtime_pid=3002,
                                         scopes=[State.scope(SESSION_B, turn='turn-%d' % number) for number in range(scopes)])
            self.writer(directory, 3001, NOW-2000, DONE)
            wanted = RELAY_ID
        with patch.object(engine_actions, 'control_request', side_effect=reply):
            self.assertTrue(self.release(wanted)['ok'])
        [(action, timeout)] = seen
        self.assertEqual(action, 'release')
        return timeout

    def test_the_reply_timeout_grows_with_the_open_scopes_for_bridges_and_relays_alike(self):
        # A bridge waits 2.5 s for a running call and then up to 5 s for every open scope, with no overall cap.
        for kind in ('bridge', 'relay'):
            self.setUp()
            self.assertEqual(self.waited_for(0, kind), 13.0, kind)
            self.setUp()
            self.assertEqual(self.waited_for(1, kind), 13.0, kind)
            self.setUp()
            self.assertGreaterEqual(self.waited_for(4, kind), 23.0, kind)
            self.setUp()
            self.assertEqual(self.waited_for(7, kind), 38.0, kind)

    def test_stop_waits_as_long_for_the_release_as_release_does(self):
        seen = []

        def reply(record, action, uid, timeout=None, **kwargs):
            seen.append(timeout)
            return DONE
        directory, _ = self.bridge_with_runtime(scopes=False)
        self.update(directory, 'bridge', scopes=[State.scope(SESSION_A, turn='turn-%d' % number) for number in range(4)])
        self.writer(directory, 4242, NOW-900, DONE)
        with patch.object(engine_actions, 'control_request', side_effect=reply):
            engine_actions.stop_connection(self.ctx(), BRIDGE_ID)
        self.assertGreaterEqual(seen[0], 23.0)


class ReleaseEndedTests(ActionCase):
    def test_only_ended_connections_are_released_never_one_whose_owner_is_alive(self):
        directory, _ = self.bridge_with_runtime()
        ended = self.writer(directory, 4242, NOW-900, DONE)
        live_codex = self.codex_relay()
        self.machine.remove(500)                                    # the Claude Code process is gone
        result = engine_actions.release_ended(self.ctx())
        self.assertEqual(result, {'ok': True, 'results': [{'connection_id': BRIDGE_ID, 'released': True, 'reason': None}]})
        self.assertEqual(len(ended.requests), 1)
        self.assertEqual(live_codex.requests, [])

    def test_a_runtime_of_a_dead_bridge_and_an_unrecorded_ended_connection_are_both_listed(self):
        self.add_runtime(2000, NOW-890)
        relay_dir = self.state.relay('r1', 2001, NOW-890, root_pid=2000, runtime_pid=2002, scopes=[State.scope(SESSION_A)])
        orphan = self.writer(relay_dir, 2001, NOW-890, DONE)
        self.state.bridge('d1', 7001, NOW-5000, owner_pid=501, session_id=SESSION_A, scopes=[State.scope(SESSION_A)])
        self.add_runtime(4000, NOW-5000, relay=False, parent=1)
        results = engine_actions.release_ended(self.ctx())
        self.assertEqual(results['ok'], False)
        self.assertEqual({item['connection_id']: (item['released'], item['reason']) for item in results['results']
                          if item['connection_id'].startswith(('claude-2001', 'codex-4000'))},
                         {'claude-2001-%d' % (NOW-890): (True, None), UNRECORDED_ID: (False, 'no_trusted_scope')})
        self.assertEqual(len(orphan.requests), 1)

    def test_nothing_to_release_counts_as_fine(self):
        self.add_runtime(3000, NOW-2000, parent=1)
        directory = self.state.relay('r2', 3001, NOW-2000, root_pid=3000, runtime_pid=3002)
        self.writer(directory, 3001, NOW-2000, {'released': False, 'reason': 'no_trusted_scope', 'scope_count': 0})
        self.assertEqual(engine_actions.release_ended(self.ctx()), {'ok': True, 'results': [
            {'connection_id': RELAY_ID, 'released': False, 'reason': 'no_trusted_scope'}]})

    def test_nothing_ended_nothing_done(self):
        self.codex_relay()
        self.assertEqual(engine_actions.release_ended(self.ctx()), {'ok': True, 'results': []})
        self.assertEqual(self.events, [])


class KilledBridgeCase(ActionCase):
    """A bridge that was killed can never close its scopes, and the runtime it named lists the same ones (S16, S21)."""
    ENDED = 'claude-2001-%d' % (NOW-4990)

    def killed_bridge_and_its_runtime(self, reply=DONE, extra=()):
        """The bridge d1 was killed with an open scope (and maybe more); the runtime it named lists the first one.

        `reply` is what that runtime's relay answers to a release; a list is answered one after the other, the last
        one for good."""
        replies = list(reply) if isinstance(reply, list) else [reply]
        scopes = [State.scope(SESSION_A, last=at(100))] + [State.scope(session, last=at(2000)) for session in extra]
        bridge = self.state.bridge('d1', 7001, NOW-5000, owner_pid=501, cwd='/work/c21', session_id=SESSION_A,
                                   scopes=scopes, cleanup='open')
        self.add_runtime(2000, NOW-4990)
        relay = self.state.relay('r1', 2001, NOW-4990, root_pid=2000, runtime_pid=2002, cwd='/work/c21',
                                 owner='bridge-7001-%d' % (NOW-5000), scopes=[State.scope(SESSION_A, last=at(100))],
                                 cleanup='open')

        def answer(request):
            current = replies.pop(0) if len(replies) > 1 else replies[0]
            # What the real relay does when its release is confirmed: the scopes leave its own record.
            if current.get('released') is True:
                self.update(relay, 'relay', scopes=[], cleanup='none')
            return current
        self.writer(relay, 2001, NOW-4990, answer)
        return bridge, relay

    def left(self):
        return [item['session_id'] for item in engine_status.status(self.ctx())['leases']['maybe_left']]


class ReleaseBookingTests(KilledBridgeCase):
    """A connection that let go of a session also takes it out of the dead bridge that opened it.

    When the runtime has released the session, nothing may have been left behind any more; the dead bridge's record
    kept saying so."""

    def test_the_session_is_listed_with_no_way_to_release_it_while_the_runtime_still_lists_it(self):
        self.killed_bridge_and_its_runtime()
        [entry] = engine_status.status(self.ctx())['leases']['maybe_left']
        self.assertEqual((entry['session_id'], entry['connection_id'], entry['releasable']),
                         (SESSION_A, 'claude-7001-%d' % (NOW-5000), False))

    def test_ending_the_runtimes_release_takes_the_session_out_of_the_dead_bridge_at_once(self):
        bridge, _ = self.killed_bridge_and_its_runtime()
        self.assertEqual(engine_actions.release_ended(self.ctx()),
                         {'ok': True, 'results': [{'connection_id': self.ENDED, 'released': True, 'reason': None}]})
        self.assertFalse(bridge.exists())
        self.assertEqual(self.left(), [])

    def test_only_the_sessions_the_connection_let_go_of_leave_the_dead_bridge(self):
        bridge, _ = self.killed_bridge_and_its_runtime(extra=[SESSION_B])
        engine_actions.release_ended(self.ctx())
        self.assertEqual([item['session_id'] for item in json.loads((bridge/'bridge.json').read_text())['scopes']], [SESSION_B])
        self.assertEqual(self.left(), [SESSION_B])

    def test_a_release_that_is_not_confirmed_leaves_the_dead_bridge_alone(self):
        bridge, _ = self.killed_bridge_and_its_runtime({'released': False, 'reason': 'cleanup_not_confirmed', 'scope_count': 0})
        before = (bridge/'bridge.json').read_bytes()
        result = engine_actions.release_ended(self.ctx())
        self.assertEqual(result['results'][0], {'connection_id': self.ENDED, 'released': False, 'reason': 'cleanup_not_confirmed'})
        self.assertEqual((bridge/'bridge.json').read_bytes(), before)
        self.assertEqual(self.left(), [SESSION_A])

    def test_a_connection_with_nothing_to_release_books_nothing(self):
        bridge, _ = self.killed_bridge_and_its_runtime({'released': False, 'reason': 'no_trusted_scope', 'scope_count': 0})
        engine_actions.release_ended(self.ctx())
        self.assertTrue(bridge.exists())

    def test_stopping_the_runtime_books_what_its_release_let_go_of(self):
        bridge, _ = self.killed_bridge_and_its_runtime()
        self.assertEqual(engine_actions.stop_connection(self.ctx(), self.ENDED),
                         {'ok': True, 'stopped': True, 'released': True, 'reason': None})
        self.assertFalse(bridge.exists())
        self.assertEqual(self.left(), [])

    def test_a_group_stop_books_it_too(self):
        bridge, _ = self.killed_bridge_and_its_runtime()
        self.assertEqual(engine_actions.stop_group(self.ctx(), 'claude')['stopped'], 1)
        self.assertFalse(bridge.exists())

    def test_releasing_just_the_tabs_of_the_runtime_books_it_too(self):
        bridge, _ = self.killed_bridge_and_its_runtime()
        self.assertEqual(engine_actions.release_connection(self.ctx(), self.ENDED),
                         {'ok': True, 'released': True, 'reason': None, 'scope_count': 1})
        self.assertFalse(bridge.exists())

    def test_a_live_connections_release_takes_its_session_out_of_a_dead_record_too(self):
        """A Codex thread whose first runtime died with a scope open and that runs again: its 탭 풀기 lets go of it for good."""
        old = self.state.relay('d2', 7101, NOW-4000, cwd='/work/codex', scopes=[State.scope(SESSION_B, last=at(900))], cleanup='open')
        self.codex_relay()
        self.assertEqual(self.left(), [SESSION_B])
        self.assertEqual(engine_actions.release_connection(self.ctx(), RELAY_ID),
                         {'ok': True, 'released': True, 'reason': None, 'scope_count': 1})
        self.assertFalse(old.exists())
        self.assertEqual(self.left(), [])

    def test_a_live_writers_record_is_neither_rewritten_nor_remembered_for(self):
        """The bridge and the relay of a live thread both book their own scopes; a pair the engine remembered for them
        could hide a later scope of the same session."""
        directory, relay_directory = self.bridge_with_runtime()
        self.writer(directory, 4242, NOW-900, DONE)
        before = [(item/name).read_bytes() for item, name in ((directory, 'bridge.json'), (relay_directory, 'relay.json'))]
        self.assertTrue(engine_actions.release_connection(self.ctx(), BRIDGE_ID)['released'])
        self.assertEqual([(item/name).read_bytes() for item, name in ((directory, 'bridge.json'), (relay_directory, 'relay.json'))], before)
        self.assertFalse((self.state.root/'engine-released.json').exists())


class SecondAskTests(KilledBridgeCase):
    """A writer that answers `cleanup_not_confirmed` gave up waiting for the runtime to end a turn, which the runtime may
    have done a little later (the tab is closed, the scope stays open: S16). It is asked once more; nothing else is."""
    UNCONFIRMED = {'released': False, 'reason': 'cleanup_not_confirmed', 'scope_count': 0}

    def asked(self):
        return len(self.servers[-1].requests)

    def test_a_confirmed_second_answer_is_a_release_and_the_dead_bridge_is_booked(self):
        bridge, _ = self.killed_bridge_and_its_runtime([self.UNCONFIRMED, DONE])
        self.assertEqual(engine_actions.release_ended(self.ctx()),
                         {'ok': True, 'results': [{'connection_id': self.ENDED, 'released': True, 'reason': None}]})
        self.assertEqual(self.asked(), 2)
        self.assertFalse(bridge.exists())
        self.assertEqual(self.left(), [])          # so there is no line for the session, and nothing to be notified about

    def test_two_unconfirmed_answers_are_two_asks_and_it_stays_unconfirmed(self):
        bridge, _ = self.killed_bridge_and_its_runtime([self.UNCONFIRMED])
        before = (bridge/'bridge.json').read_bytes()
        result = engine_actions.release_ended(self.ctx())
        self.assertEqual(result['results'][0], {'connection_id': self.ENDED, 'released': False, 'reason': 'cleanup_not_confirmed'})
        self.assertEqual(self.asked(), 2, 'once more, and no more')
        self.assertEqual((bridge/'bridge.json').read_bytes(), before)

    def test_a_timeout_is_not_asked_again(self):
        self.killed_bridge_and_its_runtime()
        self.servers[-1].handler = lambda request: time.sleep(1.5) or DONE
        with patch.object(engine_actions, 'release_timeout', return_value=0.3):
            result = engine_actions.release_ended(self.ctx())
        self.assertEqual(result['results'][0]['reason'], 'timeout')
        self.assertEqual(self.asked(), 1)

    def test_no_other_answer_is_asked_again(self):
        for reply in ({'released': False, 'reason': 'request_in_flight', 'scope_count': 0},
                      {'released': False, 'reason': 'no_trusted_scope', 'scope_count': 0},
                      {'released': False, 'reason': 'cleanup_tool_unavailable', 'scope_count': 0},
                      {'released': False, 'reason': 'relay_unavailable', 'scope_count': 0},
                      {'released': False, 'scope_count': 0}):                  # not even a reason
            self.setUp()
            self.killed_bridge_and_its_runtime(reply)
            engine_actions.release_ended(self.ctx())
            self.assertEqual(self.asked(), 1, reply)

    def test_an_endpoint_that_hangs_up_is_not_asked_again_though_a_bridge_then_comes_to_the_same_reason(self):
        directory, _ = self.bridge_with_runtime()
        self.writer(directory, 4242, NOW-900, lambda request: None)            # closes without an answer
        self.assertEqual(engine_actions.release_connection(self.ctx(), BRIDGE_ID)['reason'], 'cleanup_not_confirmed')
        self.assertEqual(self.asked(), 1)

    def test_release_stop_and_the_tab_release_of_a_live_bridge_all_ask_the_same_way(self):
        self.killed_bridge_and_its_runtime([self.UNCONFIRMED, DONE])
        self.assertTrue(engine_actions.release_connection(self.ctx(), self.ENDED)['released'])
        self.assertEqual(self.asked(), 2)
        self.setUp()
        self.killed_bridge_and_its_runtime([self.UNCONFIRMED, DONE])
        self.assertEqual(engine_actions.stop_connection(self.ctx(), self.ENDED),
                         {'ok': True, 'stopped': True, 'released': True, 'reason': None})
        self.assertEqual(self.asked(), 2)
        self.setUp()
        directory, _ = self.bridge_with_runtime()                               # a live conversation's 탭 풀기
        replies = [self.UNCONFIRMED, {'released': True, 'reason': None, 'scope_count': 1}]
        self.writer(directory, 4242, NOW-900, lambda request: replies.pop(0) if len(replies) > 1 else replies[0])
        self.assertEqual(engine_actions.release_connection(self.ctx(), BRIDGE_ID),
                         {'ok': True, 'released': True, 'reason': None, 'scope_count': 1})
        self.assertEqual(self.asked(), 2)


class RevivedRuntimeActionTests(ActionCase):
    """A runtime Codex started again for a conversation that is long gone is no connection (S17, S18): neither the
    automatic cleanup nor a stop reaches it, and it cannot be asked for by an id."""
    ID = 'claude-2001-%d' % (NOW-600)

    def revived(self):
        self.add_runtime(2000, NOW-600)
        directory = self.state.relay('r1', 2001, NOW-600, root_pid=2000, runtime_pid=2002, cwd='/work/c22',
                                     owner='bridge-7001-%d' % (NOW-5000))
        return self.writer(directory, 2001, NOW-600, DONE)

    def test_the_automatic_cleanup_does_not_ask_it_to_release_anything(self):
        server = self.revived()
        self.assertEqual(engine_actions.release_ended(self.ctx()), {'ok': True, 'results': []})
        self.assertEqual(server.requests, [])

    def test_no_group_stop_signals_it(self):
        self.revived()
        for group in ('all', 'claude', 'codex'):
            self.assertEqual(engine_actions.stop_group(self.ctx(), group)['results'], [])
        self.assertEqual(self.machine.signals, [])

    def test_it_is_not_found_by_its_id(self):
        server = self.revived()
        self.assertEqual(engine_actions.release_connection(self.ctx(), self.ID)['reason'], 'not_found')
        self.assertEqual(engine_actions.stop_connection(self.ctx(), self.ID)['reason'], 'not_found')
        self.assertEqual((self.machine.signals, server.requests), ([], []))


class SessionReleaseInEndedTests(ActionCase):
    """release --ended also frees the sessions of dead bridges, through the host."""

    def setUp(self):
        super().setUp()
        import host_mcp
        from unittest.mock import AsyncMock
        from engine_support import DECOY, FakeHost
        self.host_socket()
        self.chrome_plugin()
        self.hosts = []

        async def js(params):
            return {'content': [{'type': 'text', 'text': DECOY+'\n@@count 2\n'}]}

        async def connect(**kwargs):
            host = FakeHost({'js': js})
            self.hosts.append(host)
            return host
        patcher = patch.object(host_mcp, 'unix_connect', AsyncMock(side_effect=connect))
        patcher.start()
        self.addCleanup(patcher.stop)

    def dead(self, name, pid, session, kind='bridge'):
        builder = self.state.bridge if kind == 'bridge' else self.state.relay
        return builder(name, pid, NOW-5000, cwd='/work/dead', scopes=[State.scope(session, last=at(1000))], cleanup='open')

    def test_sessions_of_dead_bridges_are_released_and_those_of_codex_threads_are_left_for_a_click(self):
        bridge = self.dead('d1', 7001, SESSION_C)
        relay = self.dead('d2', 7101, SESSION_D, kind='relay')
        result = engine_actions.release_ended(self.ctx())
        self.assertEqual(result, {'ok': True, 'results': [{'connection_id': 'claude-7001-%d' % (NOW-5000), 'released': True, 'reason': None}]})
        self.assertFalse(bridge.exists())
        self.assertTrue(relay.exists())
        self.assertNotIn(SESSION_D, json.dumps([call for host in self.hosts for call in host.calls]))

    def test_a_dead_bridge_with_two_sessions_is_one_result_that_reports_the_first_failure(self):
        self.state.bridge('d1', 7001, NOW-5000, scopes=[State.scope(SESSION_C, last=at(1000)), State.scope(SESSION_D, last=at(900))],
                          cleanup='open')
        self.add_runtime(2000, NOW-890)
        self.state.relay('r1', 2001, NOW-890, root_pid=2000, runtime_pid=2002, scopes=[State.scope(SESSION_D)])
        result = engine_actions.release_ended(self.ctx())
        item = [entry for entry in result['results'] if entry['connection_id'].startswith('claude-7001')]
        self.assertEqual(item, [{'connection_id': 'claude-7001-%d' % (NOW-5000), 'released': False, 'reason': 'session_live'}])
        self.assertFalse(result['ok'])

    def test_without_a_host_the_result_says_why(self):
        self.dead('d1', 7001, SESSION_C)
        self.machine.remove(1200)
        result = engine_actions.release_ended(self.ctx())
        self.assertEqual(result['results'], [{'connection_id': 'claude-7001-%d' % (NOW-5000), 'released': False, 'reason': 'not_running'}])
        self.assertEqual(self.hosts, [])

    def live_bridge_with_old_scope(self):
        """A live bridge that is on its second host: its current session D, and an open scope of session C from the first."""
        self.add_claude(500)
        self.add_bridge(4242, 500, NOW-900)
        return self.state.bridge('a1', 4242, NOW-900, owner_pid=500, cwd='/work/x', session_id=SESSION_D, cleanup='open',
                                 scopes=[State.scope(SESSION_C, first=at(2000), last=at(1900)), State.scope(SESSION_D)])

    def test_the_scope_a_live_bridge_left_behind_on_an_earlier_host_is_released_once_and_its_record_is_not_touched(self):
        directory = self.live_bridge_with_old_scope()
        before = (directory/'bridge.json').read_bytes()
        result = engine_actions.release_ended(self.ctx())
        self.assertEqual(result, {'ok': True, 'results': [{'connection_id': BRIDGE_ID, 'released': True, 'reason': None}]})
        called = {call['_meta']['x-codex-turn-metadata']['session_id'] for host in self.hosts for call in host.calls}
        self.assertIn(SESSION_C, called)
        self.assertNotIn(SESSION_D, called)                           # the live session is never touched
        self.assertEqual((directory/'bridge.json').read_bytes(), before)     # a live writer's record is not rewritten
        hosts = len(self.hosts)
        self.assertEqual(engine_actions.release_ended(self.ctx()), {'ok': True, 'results': []})
        self.assertEqual(len(self.hosts), hosts)                      # not even a connection for the second time

    def test_the_order_is_connections_first_then_dead_bridges(self):
        self.add_runtime(3000, NOW-2000, parent=1)
        directory = self.state.relay('r2', 3001, NOW-2000, root_pid=3000, runtime_pid=3002, scopes=[State.scope(SESSION_B)])
        self.writer(directory, 3001, NOW-2000, DONE)
        self.dead('d1', 7001, SESSION_C)
        ids = [item['connection_id'] for item in engine_actions.release_ended(self.ctx())['results']]
        self.assertEqual(ids, [RELAY_ID, 'claude-7001-%d' % (NOW-5000)])


class StopTests(ActionCase):
    def stop(self, wanted, force=False):
        return engine_actions.stop_connection(self.ctx(), wanted, force=force)

    def test_release_comes_first_then_the_bridge_is_asked_to_end_and_nothing_else_is_signalled(self):
        directory, _ = self.bridge_with_runtime()
        self.writer(directory, 4242, NOW-900, DONE)
        self.watch(4242, 500, 1000, 1100, 2000, 2001, 2002)
        result = self.stop(BRIDGE_ID)
        self.assertEqual(result, {'ok': True, 'stopped': True, 'released': True, 'reason': None})
        self.assertEqual(self.events, [('release', 4242), ('signal', 4242, signal.SIGTERM)])
        self.assertEqual(self.machine.signals, [(4242, signal.SIGTERM)])
        self.assertNotIn(4242, self.machine.procs)

    def test_a_codex_connection_with_a_relay_signals_the_relay(self):
        self.codex_relay()
        result = self.stop(RELAY_ID)
        self.assertEqual(result, {'ok': True, 'stopped': True, 'released': True, 'reason': None})
        self.assertEqual(self.machine.signals, [(3001, signal.SIGTERM)])

    def test_without_a_relay_the_runtimes_cua_repl_is_signalled(self):
        self.unrecorded_runtime()
        result = self.stop(UNRECORDED_ID)
        self.assertEqual(result, {'ok': True, 'stopped': True, 'released': False, 'reason': 'no_trusted_scope'})
        self.assertEqual(self.machine.signals, [(4000, signal.SIGTERM)])

    def test_a_refused_release_does_not_keep_the_connection_from_stopping(self):
        directory, _ = self.bridge_with_runtime()
        self.writer(directory, 4242, NOW-900, {'released': False, 'reason': 'request_in_flight', 'scope_count': 0})
        result = self.stop(BRIDGE_ID)
        self.assertEqual(result, {'ok': True, 'stopped': True, 'released': False, 'reason': 'request_in_flight'})
        self.assertEqual(self.machine.signals, [(4242, signal.SIGTERM)])

    def test_a_process_that_ignores_sigterm_is_left_running_without_force_after_the_grace_period(self):
        self.unrecorded_runtime()
        self.machine.ignore_term.add(4000)
        began = self.machine.now
        result = self.stop(UNRECORDED_ID)
        self.assertEqual(result, {'ok': False, 'stopped': False, 'released': False, 'reason': 'timeout'})
        self.assertEqual(self.machine.signals, [(4000, signal.SIGTERM)])
        self.assertGreaterEqual(self.machine.now-began, engine_actions.STOP_GRACE)
        self.assertIn(4000, self.machine.procs)

    def test_force_waits_out_the_grace_period_before_it_kills(self):
        self.unrecorded_runtime()
        self.machine.ignore_term.add(4000)
        killed_at = []
        self.machine.on_signal[4000] = lambda number: killed_at.append((number, self.machine.now))
        began = self.machine.now
        result = self.stop(UNRECORDED_ID, force=True)
        self.assertEqual(result['stopped'], True)
        self.assertEqual([item[0] for item in killed_at], [signal.SIGTERM, signal.SIGKILL])
        self.assertGreaterEqual(killed_at[1][1]-began, engine_actions.STOP_GRACE)
        self.assertNotIn(4000, self.machine.procs)

    def test_force_does_not_kill_what_already_ended_on_its_own(self):
        self.unrecorded_runtime()
        self.machine.later(2.0, lambda: self.machine.remove(4000))
        self.machine.ignore_term.add(4000)
        self.assertTrue(self.stop(UNRECORDED_ID, force=True)['stopped'])
        self.assertEqual(self.machine.signals, [(4000, signal.SIGTERM)])

    def test_a_signal_that_is_not_permitted_is_a_failure_not_a_crash(self):
        self.unrecorded_runtime()
        self.machine.deny.add(4000)
        self.assertEqual(self.stop(UNRECORDED_ID, force=True),
                         {'ok': False, 'stopped': False, 'released': False, 'reason': 'permission_denied'})
        self.assertEqual(self.machine.signals, [(4000, signal.SIGTERM)])

    def test_a_process_whose_identity_cannot_be_checked_is_not_signalled(self):
        self.unrecorded_runtime()
        original = self.machine.run

        def run(argv, timeout=None, environment=None):
            if argv[0] == '/bin/ps' and '-p' in argv:
                raise subprocess.TimeoutExpired(argv, timeout)
            return original(argv, timeout=timeout, environment=environment)
        result = engine_actions.stop_connection(self.context(run=run), UNRECORDED_ID, force=True)
        self.assertEqual(result, {'ok': False, 'stopped': False, 'released': False, 'reason': 'unverified'})
        self.assertEqual(self.machine.signals, [])

    def test_unknown_connections_are_not_found_and_nothing_is_signalled(self):
        self.unrecorded_runtime()
        for wanted in ('codex-4000-%d' % (NOW-5001-5), 'codex-4001-%d' % (NOW-5000), 'codex-1100-%d' % (NOW-7100),
                       'claude-1000-%d' % (NOW-7200), 'whatever'):
            self.assertEqual(self.stop(wanted, force=True), {'ok': False, 'stopped': False, 'released': False, 'reason': 'not_found'})
        self.assertEqual(self.machine.signals, [])

    def test_a_pid_that_was_reused_while_the_release_ran_is_never_signalled(self):
        directory, _ = self.bridge_with_runtime()

        def release_then_the_process_is_replaced(request):
            self.machine.procs[4242]['start'] = NOW-3        # another process has this pid now
            return DONE
        self.writer(directory, 4242, NOW-900, release_then_the_process_is_replaced)
        result = self.stop(BRIDGE_ID, force=True)
        self.assertEqual(result, {'ok': True, 'stopped': True, 'released': True, 'reason': None})
        self.assertEqual(self.machine.signals, [])
        self.assertIn(4242, self.machine.procs)

    def test_a_pid_that_is_reused_while_waiting_does_not_get_the_kill(self):
        self.unrecorded_runtime()
        self.machine.ignore_term.add(4000)

        def replaced(number):
            if number == signal.SIGTERM:
                self.machine.later(1.0, lambda: self.machine.procs[4000].update(start=NOW-1))
        self.machine.on_signal[4000] = replaced
        result = self.stop(UNRECORDED_ID, force=True)
        self.assertTrue(result['stopped'])
        self.assertEqual(self.machine.signals, [(4000, signal.SIGTERM)])

    def test_a_connection_that_vanishes_before_the_signal_counts_as_stopped(self):
        directory, _ = self.bridge_with_runtime()
        self.writer(directory, 4242, NOW-900, lambda request: self.machine.remove(4242) or DONE)
        result = self.stop(BRIDGE_ID)
        self.assertEqual((result['stopped'], result['released']), (True, True))
        self.assertEqual(self.machine.signals, [])

    def test_a_connection_that_is_also_the_engine_or_one_of_its_ancestors_is_protected(self):
        self.add_runtime(4000, NOW-5000, relay=False)
        self.machine.add(ENGINE_PID, 4000, '/usr/bin/python3 setup.py stop')    # the engine runs below this runtime
        result = self.stop(UNRECORDED_ID, force=True)
        self.assertEqual(result, {'ok': False, 'stopped': False, 'released': False, 'reason': 'protected'})
        self.assertEqual(self.machine.signals, [])


class RuntimeEndTests(ActionCase):
    """A stopped Claude connection also ends the runtime of its thread, which Codex would keep until it quits."""

    def named(self):
        directory, relay_directory = self.bridge_with_runtime()
        self.update(relay_directory, 'relay', owner='bridge-4242-%d' % (NOW-900))
        self.writer(directory, 4242, NOW-900, DONE)
        self.watch(4242, 500, 1000, 1100, 2000, 2001, 2002)

    def stop(self, wanted=BRIDGE_ID, force=False):
        return engine_actions.stop_connection(self.ctx(), wanted, force=force)

    def test_the_runtime_that_names_the_bridge_is_ended_after_the_bridge(self):
        self.named()
        self.assertEqual(self.stop(), {'ok': True, 'stopped': True, 'released': True, 'reason': None})
        self.assertEqual(self.events, [('release', 4242), ('signal', 4242, signal.SIGTERM),
                                       ('signal', 2000, signal.SIGTERM)])
        self.assertNotIn(2000, self.machine.procs)

    def test_nothing_is_sent_to_a_runtime_that_the_bridge_ended_on_its_way_out(self):
        self.named()
        self.machine.on_signal[4242] = lambda number: self.machine.remove(2000)
        self.assertTrue(self.stop()['stopped'])
        self.assertEqual(self.machine.signals, [(4242, signal.SIGTERM)])

    def test_the_runtime_of_a_conversation_that_is_gone_is_ended_after_its_relay(self):
        self.add_runtime(2000, NOW-890)
        directory = self.state.relay('r1', 2001, NOW-890, root_pid=2000, runtime_pid=2002, cwd='/work/x',
                                     owner='bridge-7001-%d' % (NOW-5000), scopes=[State.scope(SESSION_A)])
        self.writer(directory, 2001, NOW-890, DONE)
        result = self.stop('claude-2001-%d' % (NOW-890))
        self.assertEqual(result, {'ok': True, 'stopped': True, 'released': True, 'reason': None})
        self.assertEqual(self.machine.signals, [(2001, signal.SIGTERM), (2000, signal.SIGTERM)])

    def test_a_runtime_that_ignores_sigterm_is_left_without_force_and_killed_with_it(self):
        self.named()
        self.machine.ignore_term.add(2000)
        self.assertTrue(self.stop()['stopped'])
        self.assertEqual(self.machine.signals, [(4242, signal.SIGTERM), (2000, signal.SIGTERM)])
        self.assertIn(2000, self.machine.procs)

    def test_force_kills_a_runtime_that_ignores_sigterm_after_a_short_wait(self):
        self.named()
        self.machine.ignore_term.add(2000)
        killed_at = []
        self.machine.on_signal[2000] = lambda number: killed_at.append((number, self.machine.now))
        self.assertTrue(self.stop(force=True)['stopped'])
        self.assertEqual([item[0] for item in killed_at], [signal.SIGTERM, signal.SIGKILL])
        self.assertGreaterEqual(killed_at[1][1]-killed_at[0][1], engine_actions.KILL_WAIT)
        self.assertNotIn(2000, self.machine.procs)

    def test_a_pid_that_runs_another_program_by_then_is_not_signalled(self):
        self.named()
        self.machine.on_signal[4242] = lambda number: self.machine.procs[2000].update(command='/usr/bin/vim notes')
        self.assertTrue(self.stop(force=True)['stopped'])
        self.assertEqual(self.machine.signals, [(4242, signal.SIGTERM)])

    def test_a_bridge_that_does_not_stop_keeps_its_runtime(self):
        self.named()
        self.machine.ignore_term.add(4242)
        self.assertFalse(self.stop()['stopped'])
        self.assertEqual(self.machine.signals, [(4242, signal.SIGTERM)])

    def test_a_runtime_found_only_through_sessions_or_a_codex_runtime_is_not_ended(self):
        directory, _ = self.bridge_with_runtime()
        self.writer(directory, 4242, NOW-900, DONE)
        self.codex_relay()
        result = engine_actions.stop_group(self.ctx(), 'all')
        self.assertEqual(result['stopped'], 2)
        self.assertEqual(sorted(self.machine.signals), [(3001, signal.SIGTERM), (4242, signal.SIGTERM)])

    def test_claude_only_ends_the_runtimes_of_the_connections_it_stopped(self):
        self.named()
        self.codex_relay()
        result = engine_actions.stop_group(self.ctx(), 'claude')
        self.assertEqual(result['stopped'], 1)
        self.assertEqual(self.machine.signals, [(4242, signal.SIGTERM), (2000, signal.SIGTERM)])


class CmuxConnectionTests(ActionCase):
    """One `cmux-cua mcp` process (a conversation's connection to cmux-cua) is stopped on its own, with nothing to release.
    The daemon and the AI client next to it are never signalled."""

    def setUp(self):
        super().setUp()
        self.add_claude(500)
        self.machine.add(3500, 1, self.commands.cmux_serve, start=NOW-7000)
        self.machine.add(3501, 500, self.commands.cmux_mcp, start=NOW-600)
        self.machine.add(3502, 500, self.commands.cmux_mcp, start=NOW-300)
        self.watch(500, 3500, 3501, 3502)
        self.untouched = {500, 3500, 3502, 1000, 1100, 1200}

    def stop(self, wanted=CMUX_ID, force=False):
        return engine_actions.stop_connection(self.ctx(), wanted, force=force)

    def release(self, wanted=CMUX_ID):
        return engine_actions.release_connection(self.ctx(), wanted)

    def after_the_view_was_read(self, change):
        """A context whose first identity check (`ps -p`, right before a signal) sees the machine after `change()`."""
        original, done = self.machine.run, []

        def run(argv, timeout=None, environment=None):
            if argv[0] == '/bin/ps' and '-p' in argv and not done:
                done.append(True)
                change()
            return original(argv, timeout=timeout, environment=environment)
        return self.context(run=run)

    def test_only_the_mcp_process_is_signalled_and_nothing_is_released(self):
        directory, _ = self.bridge_with_runtime()
        bridge = self.writer(directory, 4242, NOW-900, DONE)
        self.watch(4242)
        self.assertEqual(self.stop(), {'ok': True, 'stopped': True, 'released': False, 'reason': None})
        self.assertEqual(self.machine.signals, [(3501, signal.SIGTERM)])
        self.assertEqual(self.events, [('signal', 3501, signal.SIGTERM)])
        self.assertEqual(bridge.requests, [])
        self.assertNotIn(3501, self.machine.procs)
        self.assertTrue(self.untouched <= set(self.machine.procs))

    def test_force_does_not_add_a_signal_when_the_process_ends_at_once(self):
        self.assertEqual(self.stop(force=True), {'ok': True, 'stopped': True, 'released': False, 'reason': None})
        self.assertEqual(self.machine.signals, [(3501, signal.SIGTERM)])

    def test_a_process_that_ignores_sigterm_is_left_running_without_force_after_the_grace_period(self):
        self.machine.ignore_term.add(3501)
        began = self.machine.now
        self.assertEqual(self.stop(), {'ok': False, 'stopped': False, 'released': False, 'reason': 'timeout'})
        self.assertEqual(self.machine.signals, [(3501, signal.SIGTERM)])
        self.assertGreaterEqual(self.machine.now-began, engine_actions.STOP_GRACE)
        self.assertIn(3501, self.machine.procs)

    def test_force_kills_only_that_process_and_only_after_the_grace_period(self):
        self.machine.ignore_term.add(3501)
        sent = []
        self.machine.on_signal[3501] = lambda number: sent.append((number, self.machine.now))
        began = self.machine.now
        self.assertEqual(self.stop(force=True), {'ok': True, 'stopped': True, 'released': False, 'reason': None})
        self.assertEqual([number for number, _ in sent], [signal.SIGTERM, signal.SIGKILL])
        self.assertGreaterEqual(sent[1][1]-began, engine_actions.STOP_GRACE)
        self.assertEqual({pid for pid, _ in self.machine.signals}, {3501})
        self.assertTrue(self.untouched <= set(self.machine.procs))

    def test_force_does_not_kill_what_ended_on_its_own_during_the_grace_period(self):
        self.machine.ignore_term.add(3501)
        self.machine.later(2.0, lambda: self.machine.remove(3501))
        self.assertTrue(self.stop(force=True)['stopped'])
        self.assertEqual(self.machine.signals, [(3501, signal.SIGTERM)])

    def test_a_signal_that_is_not_permitted_is_a_failure_not_a_crash(self):
        self.machine.deny.add(3501)
        self.assertEqual(self.stop(force=True), {'ok': False, 'stopped': False, 'released': False, 'reason': 'permission_denied'})
        self.assertEqual(self.machine.signals, [(3501, signal.SIGTERM)])

    def test_a_process_whose_identity_cannot_be_checked_is_not_signalled(self):
        original = self.machine.run

        def run(argv, timeout=None, environment=None):
            if argv[0] == '/bin/ps' and '-p' in argv:
                raise subprocess.TimeoutExpired(argv, timeout)
            return original(argv, timeout=timeout, environment=environment)
        result = engine_actions.stop_connection(self.context(run=run), CMUX_ID, force=True)
        self.assertEqual(result, {'ok': False, 'stopped': False, 'released': False, 'reason': 'unverified'})
        self.assertEqual(self.machine.signals, [])

    def test_a_pid_that_is_used_by_another_process_by_the_time_of_the_signal_counts_as_gone_and_is_not_signalled(self):
        for change in (lambda: self.machine.procs[3501].update(start=NOW-3),                         # a new process
                       lambda: self.machine.procs[3501].update(uid=UID+1),                           # another user's
                       lambda: self.machine.procs[3501].update(command=self.commands.cmux_serve),    # the daemon's program
                       lambda: self.machine.procs[3501].update(command='/usr/bin/python3 other.py')):
            self.setUp()
            result = engine_actions.stop_connection(self.after_the_view_was_read(change), CMUX_ID, force=True)
            self.assertEqual(result, {'ok': True, 'stopped': True, 'released': False, 'reason': None})
            self.assertEqual(self.machine.signals, [])
            self.assertIn(3501, self.machine.procs)

    def changes_a_second_after_sigterm(self, **changes):
        self.machine.ignore_term.add(3501)

        def replaced(number):
            if number == signal.SIGTERM:
                self.machine.later(1.0, lambda: self.machine.procs[3501].update(**changes))
        self.machine.on_signal[3501] = replaced

    def test_a_pid_that_is_reused_while_waiting_does_not_get_the_kill(self):
        self.changes_a_second_after_sigterm(start=NOW-1)
        self.assertTrue(self.stop(force=True)['stopped'])
        self.assertEqual(self.machine.signals, [(3501, signal.SIGTERM)])

    def test_a_process_that_turns_into_another_program_while_waiting_does_not_get_the_kill(self):
        self.changes_a_second_after_sigterm(command='/usr/bin/python3 other.py')
        self.assertTrue(self.stop(force=True)['stopped'])
        self.assertEqual(self.machine.signals, [(3501, signal.SIGTERM)])

    def test_the_engine_and_everything_above_it_is_protected(self):
        self.machine.add(ENGINE_PID, 3501, '/usr/bin/python3 setup.py stop')        # the engine runs below this process
        self.assertEqual(self.stop(force=True), {'ok': False, 'stopped': False, 'released': False, 'reason': 'protected'})
        self.assertEqual(self.machine.signals, [])

    def test_an_mcp_process_that_started_another_one_is_a_client_and_stays_protected(self):
        self.machine.add(3503, 3501, self.commands.cmux_mcp, start=NOW-100)
        self.assertEqual(self.stop(force=True)['reason'], 'protected')
        self.assertEqual(self.machine.signals, [])
        self.assertEqual(self.stop('cmux-3503-%d' % (NOW-100)), {'ok': True, 'stopped': True, 'released': False, 'reason': None})
        self.assertEqual(self.machine.signals, [(3503, signal.SIGTERM)])

    def test_the_daemon_and_the_ai_client_cannot_be_asked_for_by_a_cmux_id(self):
        for wanted in ('cmux-3500-%d' % (NOW-7000), 'cmux-500-%d' % (NOW-8000), 'cmux-1100-%d' % (NOW-7100),
                       'cmux-1000-%d' % (NOW-7200)):
            for force in (False, True):
                self.assertEqual(self.stop(wanted, force=force), {'ok': False, 'stopped': False, 'released': False,
                                                                  'reason': 'not_found'}, wanted)
            self.assertEqual(self.release(wanted)['reason'], 'not_found', wanted)
        self.assertEqual(self.machine.signals, [])

    def test_unknown_stale_and_wrongly_named_cmux_ids_are_not_found(self):
        wrong = ('cmux-9999-%d' % (NOW-600), 'cmux-3501-%d' % (NOW-601), 'cmux-3501-%d' % (NOW-605), 'cmux-3501-%d' % (NOW-599),
                 'claude-3501-%d' % (NOW-600), 'codex-3501-%d' % (NOW-600), 'cmux-3501', 'cmux-3501-', 'cmux--%d' % (NOW-600),
                 'cmux-3501-%d; rm -rf' % (NOW-600), 'CMUX-3501-%d' % (NOW-600), 'cmux')
        for wanted in wrong:
            self.assertEqual(self.stop(wanted, force=True), {'ok': False, 'stopped': False, 'released': False,
                                                             'reason': 'not_found'}, wanted)
        self.machine.remove(3501)
        self.assertEqual(self.stop(CMUX_ID), {'ok': False, 'stopped': False, 'released': False, 'reason': 'not_found'})
        self.assertEqual(self.machine.signals, [])

    def test_another_users_mcp_process_is_not_found(self):
        self.machine.add(3600, 1, self.commands.cmux_mcp, start=NOW-100, uid=UID+1)
        self.assertEqual(self.stop('cmux-3600-%d' % (NOW-100), force=True)['reason'], 'not_found')
        self.assertEqual(self.machine.signals, [])

    def test_a_connection_that_ended_before_the_signal_counts_as_stopped(self):
        result = engine_actions.stop_connection(self.after_the_view_was_read(lambda: self.machine.remove(3501)), CMUX_ID)
        self.assertEqual(result, {'ok': True, 'stopped': True, 'released': False, 'reason': None})
        self.assertEqual(self.machine.signals, [])

    def test_two_connections_of_one_ai_client_are_stopped_one_by_one(self):
        self.assertTrue(self.stop('cmux-3502-%d' % (NOW-300))['stopped'])
        self.assertEqual(self.machine.signals, [(3502, signal.SIGTERM)])
        self.assertIn(3501, self.machine.procs)
        self.assertEqual(self.stop('cmux-3502-%d' % (NOW-300))['reason'], 'not_found')       # and only once

    def test_there_is_no_release_step_for_a_cmux_connection(self):
        self.assertEqual(self.release(), {'ok': False, 'released': False, 'reason': 'unsupported', 'scope_count': 0})
        self.assertEqual(self.release('cmux-3999-%d' % (NOW-600)),
                         {'ok': False, 'released': False, 'reason': 'not_found', 'scope_count': 0})
        self.assertEqual((self.machine.signals, self.events), ([], []))
        self.assertIn(3501, self.machine.procs)


class GroupStopTests(ActionCase):
    def world(self):
        """Two bridges (one with a relay runtime), a codex relay and an unrecorded runtime, next to everything
        that must never be touched."""
        directory, relay_dir = self.bridge_with_runtime()
        self.writer(directory, 4242, NOW-900, DONE)
        self.writer(relay_dir, 2001, NOW-890, DONE)
        self.add_bridge(4300, 500, NOW-700, command=self.commands.old_bridge)
        self.codex_relay()
        self.unrecorded_runtime()
        self.machine.add(3500, 1, self.commands.cmux_serve)
        self.machine.add(3501, 500, self.commands.cmux_mcp)
        self.machine.add(5000, 1, self.commands.chrome)
        self.machine.add(2100, 1100, self.commands.node_repl)          # the user's own node_repl
        self.machine.add(6000, 1, '/bin/zsh')
        self.machine.add(ENGINE_PID, 6000, '/usr/bin/python3 setup.py stop')
        self.untouchable = {1000, 1100, 1200, 500, 3500, 3501, 5000, 2100, 6000, ENGINE_PID, 2000, 2001, 2002}
        self.watch(4242, 4300, 3001, 4000)

    def test_all_stops_every_connection_and_only_connections(self):
        self.world()
        result = engine_actions.stop_group(self.ctx(), 'all')
        self.assertEqual((result['ok'], result['stopped'], result['failed']), (True, 4, 0))
        self.assertEqual(sorted(item['connection_id'] for item in result['results']),
                         sorted([BRIDGE_ID, 'claude-4300-%d' % (NOW-700), RELAY_ID, UNRECORDED_ID]))
        signalled = {pid for pid, _ in self.machine.signals}
        self.assertEqual(signalled, {4242, 4300, 3001, 4000})
        self.assertFalse(signalled & self.untouchable)
        self.assertEqual({number for _, number in self.machine.signals}, {signal.SIGTERM})

    def test_every_release_comes_before_the_first_signal(self):
        self.world()
        engine_actions.stop_group(self.ctx(), 'all')
        kinds = [event[0] for event in self.events]
        self.assertEqual(kinds.count('release'), 2)                     # the two writers that exist and are asked
        self.assertLess(max(index for index, kind in enumerate(kinds) if kind == 'release'),
                        min(index for index, kind in enumerate(kinds) if kind == 'signal'))

    def test_claude_only_and_codex_only(self):
        self.world()
        result = engine_actions.stop_group(self.ctx(), 'claude')
        self.assertEqual((result['stopped'], result['failed']), (2, 0))
        self.assertEqual({pid for pid, _ in self.machine.signals}, {4242, 4300})
        self.machine.signals.clear()
        result = engine_actions.stop_group(self.ctx(), 'codex')
        # The runtime that no record covers (4000) may serve a Claude conversation while the relay is off: it is
        # neither released nor signalled, and it is listed as unattributed.
        self.assertEqual({pid for pid, _ in self.machine.signals}, {3001})
        by_id = {item['connection_id']: item for item in result['results']}
        self.assertEqual(sorted(by_id), sorted([RELAY_ID, UNRECORDED_ID]))
        self.assertEqual(by_id[UNRECORDED_ID], {'connection_id': UNRECORDED_ID, 'stopped': False, 'released': False,
                                                'reason': 'unattributed'})
        self.assertEqual(by_id[RELAY_ID], {'connection_id': RELAY_ID, 'stopped': True, 'released': True, 'reason': None})
        self.assertEqual((result['ok'], result['stopped'], result['failed']), (True, 1, 0))
        self.assertIn(4000, self.machine.procs)

    def unattributed_relay(self):
        """A live relay with no open scope and no activity line, so its session is unknown."""
        self.add_runtime(3000, NOW-2000)
        directory = self.state.relay('r2', 3001, NOW-2000, root_pid=3000, runtime_pid=3002, cwd='/work/codex', scopes=[])
        return self.writer(directory, 3001, NOW-2000, DONE)

    def test_codex_only_neither_releases_nor_signals_a_connection_without_a_session_even_when_it_could_be(self):
        writer = self.unattributed_relay()
        self.watch(3001)
        result = engine_actions.stop_group(self.ctx(), 'codex')
        self.assertEqual(result, {'ok': True, 'stopped': 0, 'failed': 0, 'results': [
            {'connection_id': RELAY_ID, 'stopped': False, 'released': False, 'reason': 'unattributed'}]})
        self.assertEqual((writer.requests, self.machine.signals, self.events), ([], [], []))

    def test_codex_only_stops_a_relay_whose_turn_ended_but_whose_activity_names_its_chat(self):
        # A Codex turn that ended normally closes its scope; the activity log still shows the chat it serves.
        writer = self.unattributed_relay()
        self.state.activity([State.line('relay-3001-%d' % (NOW-2000), 120, SESSION_C),
                             State.line('relay-3001-%d' % (NOW-2000), 60, SESSION_D)])
        conn = next(item for item in engine_status.status(self.ctx())['connections'] if item['id'] == RELAY_ID)
        self.assertEqual((conn['agent'], conn['session_id']), ('codex', SESSION_D))
        result = engine_actions.stop_group(self.ctx(), 'codex')
        self.assertEqual(result, {'ok': True, 'stopped': 1, 'failed': 0, 'results': [
            {'connection_id': RELAY_ID, 'stopped': True, 'released': True, 'reason': None}]})
        self.assertEqual(len(writer.requests), 1)
        self.assertEqual(self.machine.signals, [(3001, signal.SIGTERM)])

    def test_all_and_a_single_connection_still_stop_a_connection_without_a_session(self):
        writer = self.unattributed_relay()
        self.assertEqual(engine_actions.stop_group(self.ctx(), 'all')['stopped'], 1)
        self.assertEqual(len(writer.requests), 1)
        self.assertEqual(self.machine.signals, [(3001, signal.SIGTERM)])
        self.setUp()
        self.unattributed_relay()
        self.assertEqual(engine_actions.stop_connection(self.ctx(), RELAY_ID),
                         {'ok': True, 'stopped': True, 'released': True, 'reason': None})

    def test_skipped_entries_keep_their_place_and_do_not_count_as_failures(self):
        self.world()
        self.machine.ignore_term.add(3001)                    # a real failure next to the skipped one
        order = [item['id'] for item in engine_status.status(self.ctx())['connections'] if item['agent'] == 'codex']
        result = engine_actions.stop_group(self.ctx(), 'codex')
        self.assertEqual([item['connection_id'] for item in result['results']], order)
        self.assertEqual((result['ok'], result['stopped'], result['failed']), (False, 0, 1))
        self.assertEqual({item['reason'] for item in result['results']}, {'unattributed', 'timeout'})

    def test_claude_only_never_skips_a_bridge_that_has_no_record(self):
        self.add_bridge(4300, 500, NOW-700, command=self.commands.old_bridge)
        result = engine_actions.stop_group(self.ctx(), 'claude')
        self.assertEqual((result['stopped'], result['failed']), (1, 0))
        self.assertEqual(self.machine.signals, [(4300, signal.SIGTERM)])

    def test_a_runtime_that_belongs_to_a_claude_connection_is_not_stopped_by_codex_only(self):
        directory, relay_dir = self.bridge_with_runtime()
        self.writer(relay_dir, 2001, NOW-890, DONE)
        result = engine_actions.stop_group(self.ctx(), 'codex')
        self.assertEqual(result, {'ok': True, 'stopped': 0, 'failed': 0, 'results': []})
        self.assertEqual(self.machine.signals, [])

    def test_the_result_has_one_entry_per_connection_and_failures_are_counted(self):
        self.world()
        self.machine.ignore_term.add(4000)
        result = engine_actions.stop_group(self.ctx(), 'all')
        self.assertEqual((result['ok'], result['stopped'], result['failed']), (False, 3, 1))
        by_id = {item['connection_id']: item for item in result['results']}
        self.assertEqual(by_id[UNRECORDED_ID], {'connection_id': UNRECORDED_ID, 'stopped': False, 'released': False, 'reason': 'timeout'})
        self.assertEqual(by_id[BRIDGE_ID], {'connection_id': BRIDGE_ID, 'stopped': True, 'released': True, 'reason': None})

    def test_force_kills_only_the_stragglers_and_only_after_the_grace_period(self):
        self.world()
        self.machine.ignore_term.add(4000)
        result = engine_actions.stop_group(self.ctx(), 'all', force=True)
        self.assertEqual((result['stopped'], result['failed']), (4, 0))
        self.assertEqual([signal for pid, signal in self.machine.signals if pid == 4000], [signal.SIGTERM, signal.SIGKILL])
        self.assertEqual({pid for pid, number in self.machine.signals if number == signal.SIGKILL}, {4000})

    def test_an_empty_group_is_fine(self):
        self.machine.add(5, 1, '/bin/x')
        self.assertEqual(engine_actions.stop_group(self.ctx(), 'all'), {'ok': True, 'stopped': 0, 'failed': 0, 'results': []})

    def test_no_group_stop_reaches_cmux_cua_not_even_with_force(self):
        for group in ('all', 'claude', 'codex'):
            self.setUp()
            self.world()
            self.machine.add(3502, 500, self.commands.cmux_mcp, start=NOW-300)       # a second connection of that client
            self.untouchable.add(3502)
            result = engine_actions.stop_group(self.ctx(), group, force=True)
            self.assertEqual([item['connection_id'] for item in result['results'] if item['connection_id'].startswith('cmux-')],
                             [], group)
            self.assertTrue(self.machine.signals, group)                             # the group itself was stopped
            self.assertFalse({pid for pid, _ in self.machine.signals} & {500, 3500, 3501, 3502}, group)
            self.assertTrue(self.untouchable <= set(self.machine.procs), group)

    def test_the_whole_machine_survives_a_group_stop(self):
        self.world()
        before = {pid for pid in self.machine.procs}
        engine_actions.stop_group(self.ctx(), 'all', force=True)
        self.assertEqual(before-set(self.machine.procs), {4242, 4300, 3001, 4000})


class RestartTests(ActionCase):
    def setUp(self):
        super().setUp()
        self.machine.add(1300, 1, '/bin/x')       # something else, so that the process list is never empty

    def restart(self, **options):
        return engine_actions.restart_codex(self.ctx(), **options)

    def tools(self):
        return [command[0] for command in self.machine.commands if command[0] != '/bin/ps']

    def test_a_normal_quit_through_apple_events_then_open_in_the_background(self):
        result = self.restart()
        self.assertEqual(result, {'ok': True, 'reason': None})
        quit_command = [command for command in self.machine.commands if command[0] == '/usr/bin/osascript']
        self.assertEqual(quit_command, [['/usr/bin/osascript', '-e', 'tell application id "com.openai.codex" to quit']])
        self.assertEqual([command for command in self.machine.commands if command[0] == '/usr/bin/open'],
                         [['/usr/bin/open', '-g', '-a', str(self.app)]])
        self.assertEqual(self.tools(), ['/usr/bin/osascript', '/usr/bin/open'])
        self.assertEqual(self.machine.signals, [])                 # never a kill of any kind
        self.assertEqual([proc['command'] for proc in self.machine.procs.values()
                          if proc['command'].endswith('/Contents/MacOS/ChatGPT')], [self.commands.app_main])

    def test_codex_that_is_not_running_is_not_started_by_a_restart(self):
        self.machine.remove(1000)
        self.assertEqual(self.restart(), {'ok': False, 'reason': 'not_running'})
        self.assertEqual(self.tools(), [])

    def test_no_installed_app_is_not_running_either(self):
        self.assertEqual(engine_actions.restart_codex(self.context(application_roots=[self.home/'Nowhere'])),
                         {'ok': False, 'reason': 'not_running'})
        self.assertEqual(self.tools(), [])

    def test_a_quit_that_codex_took_but_has_not_finished_is_pending_and_nothing_is_opened_or_killed(self):
        self.machine.quit_delay = None
        began = self.machine.now
        self.assertEqual(self.restart(quit_timeout=12), {'ok': False, 'reason': 'quit_pending'})
        self.assertGreaterEqual(self.machine.now-began, 12)
        self.assertEqual(self.tools(), ['/usr/bin/osascript'])
        self.assertEqual(self.machine.signals, [])
        self.assertIn(1000, self.machine.procs)

    def test_a_user_who_takes_a_while_to_confirm_the_quit_dialog_still_gets_the_restart(self):
        self.machine.quit_delay = 20.0
        self.assertEqual(self.restart(), {'ok': True, 'reason': None})

    def test_the_quit_call_that_stays_open_behind_a_dialog_does_not_end_the_wait(self):
        def run(argv, timeout=None, environment=None):
            if argv[0] == '/usr/bin/osascript':
                self.machine.commands.append(list(argv))
                self.machine.later(3.0, self.machine.close_app)
                raise subprocess.TimeoutExpired(argv, timeout)
            return self.machine.run(argv, timeout=timeout, environment=environment)
        self.assertEqual(engine_actions.restart_codex(self.context(run=run)), {'ok': True, 'reason': None})

    def test_a_quit_event_that_stays_open_and_a_codex_that_stays_is_pending_too(self):
        def run(argv, timeout=None, environment=None):
            if argv[0] == '/usr/bin/osascript':
                raise subprocess.TimeoutExpired(argv, timeout)
            return self.machine.run(argv, timeout=timeout, environment=environment)
        self.assertEqual(engine_actions.restart_codex(self.context(run=run), quit_timeout=5),
                         {'ok': False, 'reason': 'quit_pending'})

    def test_an_apple_events_tool_that_cannot_run_means_codex_did_not_quit(self):
        def run(argv, timeout=None, environment=None):
            if argv[0] == '/usr/bin/osascript':
                raise OSError('no osascript')
            return self.machine.run(argv, timeout=timeout, environment=environment)
        self.assertEqual(engine_actions.restart_codex(self.context(run=run)), {'ok': False, 'reason': 'quit_cancelled'})

    def test_a_quit_that_is_refused_at_once_is_cancelled_after_a_moment_not_after_the_whole_wait(self):
        self.machine.quit_status = 1             # -128: the user pressed Cancel in the app's own dialog
        self.machine.quit_delay = None
        began = self.machine.now
        self.assertEqual(self.restart(), {'ok': False, 'reason': 'quit_cancelled'})
        self.assertLess(self.machine.now-began, 10)                  # not the 30 s of a quit that is still pending
        self.assertGreater(engine_actions.QUIT_TIMEOUT, 10)
        self.assertEqual(self.tools(), ['/usr/bin/osascript'])
        self.assertEqual(self.machine.signals, [])
        self.assertIn(1000, self.machine.procs)

    def test_a_quit_event_that_failed_only_because_the_app_ended_before_it_replied_still_reopens_codex(self):
        self.machine.quit_status = 1             # osascript's own error (-609) when the app ends in the middle of the event
        self.machine.quit_delay = 0.5
        self.assertEqual(self.restart(), {'ok': True, 'reason': None})
        self.assertEqual(self.tools(), ['/usr/bin/osascript', '/usr/bin/open'])

    def failing_ps_after(self, trigger, failure):
        """restart_codex with a process list that fails once `trigger` (a tool path) has been run."""
        original, triggered = self.machine.run, []

        def run(argv, timeout=None, environment=None):
            if argv[0] == trigger:
                triggered.append(True)
            if argv[0] == '/bin/ps' and triggered:
                if failure == 'empty':
                    return types.SimpleNamespace(returncode=1, stdout='')
                raise failure
            return original(argv, timeout=timeout, environment=environment)
        return engine_actions.restart_codex(self.context(run=run))

    def test_a_process_list_that_fails_after_the_quit_or_the_open_is_a_failed_relaunch_never_a_crash(self):
        for failure in (subprocess.TimeoutExpired(['ps'], 5), OSError('no ps'), 'empty'):
            for trigger in ('/usr/bin/osascript', '/usr/bin/open'):
                self.setUp()
                self.machine.add(1300, 1, '/bin/x')
                self.assertEqual(self.failing_ps_after(trigger, failure), {'ok': False, 'reason': 'relaunch_failed'},
                                 (failure, trigger))
                self.assertEqual(self.machine.signals, [])

    def test_codex_is_opened_only_after_its_old_host_finished_closing(self):
        self.machine.add(1100, 1000, self.commands.app_server)
        self.machine.add(1200, 1000, '/bin/proxy')
        self.write_host()
        self.machine.quit_delay = 1.0                                  # the app is gone a second after the quit event ...
        opened_at = []
        original = self.machine.run

        def run(argv, timeout=None, environment=None):
            if argv[0] == '/usr/bin/osascript':
                self.machine.later(6.0, lambda: [self.machine.remove(pid) for pid in (1100, 1200)])   # ... its host 5 s after that
            if argv[0] == '/usr/bin/open':
                opened_at.append((self.machine.now, 1100 in self.machine.procs, 1200 in self.machine.procs))
            return original(argv, timeout=timeout, environment=environment)
        self.assertEqual(engine_actions.restart_codex(self.context(run=run)), {'ok': True, 'reason': None})
        [(when, backend_alive, proxy_alive)] = opened_at
        self.assertEqual((backend_alive, proxy_alive), (False, False))

    def test_codex_that_cannot_be_opened_or_does_not_come_back_is_a_failed_relaunch(self):
        self.machine.open_status = 1
        self.assertEqual(self.restart(), {'ok': False, 'reason': 'relaunch_failed'})
        self.setUp()
        self.machine.launch_delay = None
        began = self.machine.now
        self.assertEqual(self.restart(launch_timeout=9), {'ok': False, 'reason': 'relaunch_failed'})
        self.assertGreaterEqual(self.machine.now-began, 9)

    def test_an_open_that_cannot_run_is_a_failed_relaunch(self):
        def run(argv, timeout=None, environment=None):
            if argv[0] == '/usr/bin/open':
                raise subprocess.TimeoutExpired(argv, timeout)
            return self.machine.run(argv, timeout=timeout, environment=environment)
        self.assertEqual(engine_actions.restart_codex(self.context(run=run)), {'ok': False, 'reason': 'relaunch_failed'})


if __name__ == '__main__':
    unittest.main()
