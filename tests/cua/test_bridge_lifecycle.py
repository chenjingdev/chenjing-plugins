"""The Claude bridge keeps a record and a control endpoint, rotates turns and releases every scope it opened.

All against a fake host (fake_host.py) and temp directories: no Codex, no browser, no real signal, nothing outside
the temp root. Exit by stdin end and by signal, which need a process of their own, are in test_bridge_process.py.
"""
import asyncio
import copy
import json
import os
import stat
import subprocess
from types import SimpleNamespace
import time
import unittest
from unittest.mock import patch

import bridge_control
import bridge_records
import host_autostart
import host_mcp
import mcp_stdio
from bridge_case import BridgeCase, ISO
from fake_host import TOOLS, write_registry
from test_runtime_paths import fake_app

RECORD_KEYS = {'schema_version', 'kind', 'pid', 'started_at', 'owner_pid', 'cwd', 'control_path', 'host', 'session_id',
               'turn_id', 'connected_at', 'last_call_at', 'busy', 'scopes', 'cleanup', 'updated_at'}


class RecordTests(BridgeCase):
    async def test_record_and_socket_exist_privately_before_any_connection(self):
        control = await self.start_control(self.plain_adapter())
        directory = control.directory
        self.assertEqual(directory.parent, self.state/'bridges')
        self.assertTrue(directory.name.startswith('bridge-'))
        for path, mode in ((self.state, 0o700), (self.state/'bridges', 0o700), (directory, 0o700),
                           (directory/'bridge.json', 0o600), (directory/'control.sock', 0o600)):
            self.assertEqual(stat.S_IMODE(path.lstat().st_mode), mode, str(path))
        self.assertTrue(stat.S_ISSOCK((directory/'control.sock').lstat().st_mode))
        self.assertEqual(sorted(entry.name for entry in directory.iterdir()), ['bridge.json', 'control.sock'])
        record = self.record(control)
        self.assertEqual(set(record), RECORD_KEYS)
        self.assertEqual((record['schema_version'], record['kind']), (1, 'bridge'))
        self.assertEqual(record['pid'], os.getpid())
        self.assertEqual(record['started_at'], bridge_records.process_started_at(os.getpid()))
        self.assertEqual(record['owner_pid'], os.getppid())
        self.assertEqual(record['cwd'], os.getcwd())
        self.assertEqual(record['control_path'], str(directory/'control.sock'))
        # Not connected yet: nothing about a host, a session or a call.
        self.assertEqual([record[key] for key in ('host', 'session_id', 'turn_id', 'connected_at', 'last_call_at')], [None]*5)
        self.assertEqual((record['busy'], record['scopes'], record['cleanup']), (False, [], 'none'))
        self.assertRegex(record['updated_at'], ISO)

    async def test_record_follows_the_connection_and_each_call(self):
        host = self.add_host(thread_id='thread-A')
        adapter = self.plain_adapter()
        control = await self.start_control(adapter)
        await self.initialize(adapter)
        record = self.record(control)
        self.assertEqual(record['host'], {'pid': None, 'relay': False})
        self.assertEqual((record['session_id'], record['turn_id']), ('thread-A', adapter.turn_id))
        self.assertRegex(record['connected_at'], ISO)
        self.assertIsNone(record['last_call_at'])
        self.assertEqual((record['busy'], record['scopes'], record['cleanup']), (False, [], 'none'))
        gate = host.hold('js')
        running = asyncio.create_task(adapter.handle(self.call()))
        await self.settle(lambda: self.record(control)['busy'])
        during = self.record(control)
        self.assertEqual([(scope['session_id'], scope['turn_id']) for scope in during['scopes']],
                         [('thread-A', adapter.turn_id)])
        self.assertRegex(during['scopes'][0]['first_at'], ISO)
        self.assertRegex(during['scopes'][0]['last_at'], ISO)
        self.assertEqual(during['cleanup'], 'open')
        self.assertRegex(during['last_call_at'], ISO)
        gate.set()
        await running
        after = self.record(control)
        self.assertFalse(after['busy'])
        self.assertRegex(after['last_call_at'], ISO)
        self.assertEqual((len(after['scopes']), after['cleanup']), (1, 'open'))

    async def test_last_call_at_and_the_scope_follow_the_end_of_each_call(self):
        ticks = iter(range(10000))
        clock = lambda: '2026-10-18T12:%02d:%02dZ' % divmod(next(ticks), 60)
        host = self.add_host(thread_id='thread-A')
        adapter = self.plain_adapter()
        control = await self.start_control(adapter)
        with patch.object(host_mcp, 'utc_now', side_effect=clock):
            await self.initialize(adapter)
            gate = host.hold('js')
            running = asyncio.create_task(adapter.handle(self.call()))
            await self.settle(lambda: self.record(control)['busy'])
            during = self.record(control)
            gate.set()
            await running
            after = self.record(control)
            await adapter.handle(self.call('js_reset'))
            again = self.record(control)
        self.assertLess(during['last_call_at'], after['last_call_at'])
        [scope] = after['scopes']
        self.assertEqual(scope['first_at'], during['scopes'][0]['first_at'])
        self.assertLess(scope['first_at'], scope['last_at'])
        self.assertEqual(scope['last_at'], after['last_call_at'])
        # A later call under the same scope moves both on, and the scope is still the same one.
        self.assertLess(after['last_call_at'], again['last_call_at'])
        self.assertEqual([(item['session_id'], item['turn_id'], item['first_at']) for item in again['scopes']],
                         [(scope['session_id'], scope['turn_id'], scope['first_at'])])
        self.assertEqual(again['scopes'][0]['last_at'], again['last_call_at'])

    async def test_a_release_made_by_the_bridge_itself_is_not_a_call_of_the_ai(self):
        ticks = iter(range(10000))
        clock = lambda: '2026-10-18T12:%02d:%02dZ' % divmod(next(ticks), 60)
        host = self.add_host(thread_id='thread-A')
        adapter = self.plain_adapter()
        control = await self.start_control(adapter)
        with patch.object(host_mcp, 'utc_now', side_effect=clock):
            await self.initialize(adapter)
            await adapter.handle(self.call())
            before = self.record(control)
            self.assertEqual(await self.ask(control, 'release'), {'released': True, 'reason': None, 'scope_count': 1})
            after = self.record(control)
        # An idle connection the app releases must not look active again, and nothing counts as an operation.
        self.assertEqual(after['last_call_at'], before['last_call_at'])
        self.assertEqual([call['tool'] for call in host.calls], ['js', 'turn_ended'])
        lines = [json.loads(line) for line in (self.state/'activity.jsonl').read_text().splitlines()]
        self.assertEqual([line['tool'] for line in lines], ['js'])

    async def test_records_hold_ids_and_times_only_never_arguments_or_results(self):
        self.add_host()
        adapter = self.plain_adapter()
        control = await self.start_control(adapter)
        await self.initialize(adapter)
        await adapter.handle(self.call(title='PRIVATE_TITLE'))
        await adapter.handle({'jsonrpc': '2.0', 'id': 7, 'method': 'tools/call', 'params': {
            'name': 'js', 'arguments': {'code': 'PRIVATE_SCRIPT', 'title': 'PRIVATE_TITLE', 'url': 'https://private.invalid'}}})
        self.assertIn('PRIVATE_RESULT', json.dumps(self.reply(7)))
        for path in control.directory.iterdir():
            if path.is_file():
                self.assertNotIn(b'PRIVATE', path.read_bytes(), path.name)
        self.assertNotIn('PRIVATE', json.dumps(self.logs))


class ControlTests(BridgeCase):
    async def connected(self, **options):
        host = self.add_host(thread_id='thread-A')
        adapter = self.plain_adapter()
        control = await self.start_control(adapter, **options)
        await self.initialize(adapter)
        return host, adapter, control

    def test_the_protocol_constants_are_the_specified_ones(self):
        self.assertEqual((bridge_control.BridgeControl.IN_FLIGHT_WAIT, bridge_control.BridgeControl.READ_TIMEOUT,
                          bridge_control.BridgeControl.MAX_REQUEST), (2.5, 2.0, 1024))

    async def test_status_reports_busy_and_the_number_of_open_scopes(self):
        host, adapter, control = await self.connected()
        self.assertEqual(await self.ask(control, 'status'), {'ok': True, 'busy': False, 'open_scopes': 0})
        gate = host.hold('js')
        running = asyncio.create_task(adapter.handle(self.call()))
        await self.settle(lambda: adapter.active_tool_calls)
        self.assertEqual(await self.ask(control, 'status'), {'ok': True, 'busy': True, 'open_scopes': 1})
        gate.set()
        await running
        self.assertEqual(await self.ask(control, 'status'), {'ok': True, 'busy': False, 'open_scopes': 1})

    async def test_a_request_with_the_wrong_identity_gets_no_answer_and_changes_nothing(self):
        host, adapter, control = await self.connected()
        await adapter.handle(self.call())
        for action in ('status', 'release'):
            for wrong in ({'pid': control.pid+1}, {'started_at': control.started_at+1}, {'pid': str(control.pid)},
                          {'started_at': float(control.started_at)}, {'pid': True}, {'pid': None}):
                self.assertIsNone(await self.ask(control, action, **wrong), (action, wrong))
        for missing in ('pid', 'started_at'):
            request = {'action': 'status', 'pid': control.pid, 'started_at': control.started_at}
            del request[missing]
            self.assertIsNone(await self.exchange(control, json.dumps(request).encode()+b'\n'))
        self.assertEqual(host.turn_ended_calls(), [])
        self.assertEqual(self.record(control)['cleanup'], 'open')

    async def test_malformed_unknown_and_oversized_requests_get_no_answer(self):
        host, adapter, control = await self.connected()
        await adapter.handle(self.call())
        self.assertIsNone(await self.exchange(control, b'not json\n'))
        self.assertIsNone(await self.exchange(control, b'[1, 2]\n'))
        self.assertIsNone(await self.ask(control, 'stop'))
        self.assertIsNone(await self.ask(control, 'release-session', session_id='thread-A'))
        # 1 KB is the limit: the line itself, without its newline.
        def padded(size):
            request = {'action': 'status', 'pid': control.pid, 'started_at': control.started_at, 'pad': ''}
            request['pad'] = 'x'*(size-len(json.dumps(request)))
            data = json.dumps(request).encode()
            self.assertEqual(len(data), size)
            return data+b'\n'
        self.assertEqual(await self.exchange(control, padded(1024)), {'ok': True, 'busy': False, 'open_scopes': 1})
        self.assertIsNone(await self.exchange(control, padded(1025)))
        self.assertEqual(host.turn_ended_calls(), [])

    async def test_a_request_that_never_ends_its_line_is_dropped(self):
        host, adapter, control = await self.connected()
        control.READ_TIMEOUT = 0.2
        started = time.monotonic()
        request = json.dumps({'action': 'status', 'pid': control.pid, 'started_at': control.started_at}).encode()
        self.assertIsNone(await self.exchange(control, request, wait=3))
        self.assertLess(time.monotonic()-started, 2.5)
        self.assertEqual(await self.ask(control, 'status'), {'ok': True, 'busy': False, 'open_scopes': 0})

    async def test_release_ends_the_scope_rotates_the_turn_and_keeps_serving(self):
        host, adapter, control = await self.connected()
        first = adapter.turn_id
        await adapter.handle(self.call())
        self.assertEqual(await self.ask(control, 'release'), {'released': True, 'reason': None, 'scope_count': 1})
        self.assertEqual(host.turn_ended_calls(), [{'session_id': 'thread-A', 'turn_id': first}])
        self.assertNotEqual(adapter.turn_id, first)
        record = self.record(control)
        self.assertEqual((record['scopes'], record['cleanup'], record['turn_id']), ([], 'none', adapter.turn_id))
        # The bridge keeps serving, under the new turn; the runtime would hang on the ended one.
        second = adapter.turn_id
        self.assertEqual((await self.run_call(adapter))['result']['content'][0]['text'], 'PRIVATE_RESULT')
        self.assertEqual(host.reused, [])
        self.assertEqual(host.calls[-1]['scope'], {'session_id': 'thread-A', 'turn_id': second})
        # A second release sends the new pair, not the first one again.
        self.assertEqual(await self.ask(control, 'release'), {'released': True, 'reason': None, 'scope_count': 1})
        self.assertEqual(host.turn_ended_calls(), [{'session_id': 'thread-A', 'turn_id': first},
                                                   {'session_id': 'thread-A', 'turn_id': second}])
        self.assertEqual(host.repeated, [])
        self.assertNotIn(adapter.turn_id, (first, second))

    async def test_release_with_nothing_open_says_so_and_sends_nothing(self):
        host, adapter, control = await self.connected()
        self.assertEqual(await self.ask(control, 'release'), {'released': False, 'reason': 'no_trusted_scope', 'scope_count': 0})
        self.assertEqual(host.turn_ended_calls(), [])

    async def test_release_waits_two_and_a_half_seconds_for_a_running_call_then_says_so(self):
        host, adapter, control = await self.connected()
        gate = host.hold('js')
        running = asyncio.create_task(adapter.handle(self.call()))
        await self.settle(lambda: adapter.active_tool_calls)
        started = time.monotonic()
        waiting = asyncio.create_task(self.ask(control, 'release'))
        await asyncio.sleep(0.3)
        # The app keeps polling while a release waits.
        polled = time.monotonic()
        self.assertEqual(await self.ask(control, 'status'), {'ok': True, 'busy': True, 'open_scopes': 1})
        self.assertLess(time.monotonic()-polled, 1.5)
        # A call that arrives meanwhile is not turned away; it runs once the release is over.
        later = self.call()
        queued = asyncio.create_task(adapter.handle(later))
        reply = await waiting
        elapsed = time.monotonic()-started
        self.assertEqual(reply, {'released': False, 'reason': 'request_in_flight', 'scope_count': 0})
        self.assertGreaterEqual(elapsed, 2.45)
        self.assertLess(elapsed, 8)
        self.assertEqual(host.turn_ended_calls(), [])
        self.assertEqual(self.record(control)['cleanup'], 'open')
        gate.set()
        await asyncio.gather(running, queued)
        self.assertNotIn('error', self.reply(later['id']))
        self.assertEqual(len({(call['scope']['session_id'], call['scope']['turn_id']) for call in host.calls}), 1)

    async def test_a_running_call_that_ends_within_the_wait_lets_the_release_through(self):
        host, adapter, control = await self.connected(in_flight_wait=2.5)
        gate = host.hold('js')
        running = asyncio.create_task(adapter.handle(self.call()))
        await self.settle(lambda: adapter.active_tool_calls)
        waiting = asyncio.create_task(self.ask(control, 'release'))
        await asyncio.sleep(0.2)
        gate.set()
        await running
        self.assertEqual(await waiting, {'released': True, 'reason': None, 'scope_count': 1})

    async def test_two_releases_at_once_end_each_scope_once(self):
        host, adapter, control = await self.connected()
        await adapter.handle(self.call())
        replies = await asyncio.gather(self.ask(control, 'release'), self.ask(control, 'release'))
        self.assertEqual(sorted(reply['reason'] or '' for reply in replies), ['', 'no_trusted_scope'])
        self.assertEqual(len(host.turn_ended_calls()), 1)

    async def test_a_catalogue_without_turn_ended_cannot_release_and_is_not_confirmed(self):
        host = self.add_host(thread_id='thread-A', tools={name: tool for name, tool in TOOLS.items() if name != 'turn_ended'})
        adapter = self.plain_adapter()
        control = await self.start_control(adapter)
        await self.initialize(adapter)
        await adapter.handle(self.call())
        self.assertEqual(await self.ask(control, 'release'), {'released': False, 'reason': 'cleanup_not_confirmed', 'scope_count': 0})
        self.assertEqual(self.record(control)['cleanup'], 'not_confirmed')
        self.assertEqual((await self.run_call(adapter, 'turn_ended'))['error']['code'], -32601)
        self.assertEqual(host.turn_ended_calls(), [])

    async def test_a_refused_release_keeps_the_scope_and_the_turn_and_is_marked_not_confirmed(self):
        host, adapter, control = await self.connected()
        host.turn_ended = 'refuse'
        turn = adapter.turn_id
        await adapter.handle(self.call())
        self.assertEqual(await self.ask(control, 'release'), {'released': False, 'reason': 'cleanup_not_confirmed', 'scope_count': 0})
        self.assertEqual(adapter.turn_id, turn)
        record = self.record(control)
        self.assertEqual((record['cleanup'], len(record['scopes']), record['turn_id']), ('not_confirmed', 1, turn))
        # The pair is still alive, so work goes on under it and a later release ends it.
        self.assertEqual((await self.run_call(adapter))['result']['content'][0]['text'], 'PRIVATE_RESULT')
        host.turn_ended = 'ok'
        self.assertEqual(await self.ask(control, 'release'), {'released': True, 'reason': None, 'scope_count': 1})
        self.assertEqual(host.turn_ended_calls(), [{'session_id': 'thread-A', 'turn_id': turn}]*2)
        self.assertEqual((self.record(control)['cleanup'], self.record(control)['scopes']), ('none', []))

    async def test_a_release_the_host_answers_with_an_rpc_error_is_not_confirmed_either(self):
        host, adapter, control = await self.connected()
        host.turn_ended = 'rpc_error'
        await adapter.handle(self.call())
        self.assertEqual((await self.ask(control, 'release'))['reason'], 'cleanup_not_confirmed')
        self.assertEqual(self.record(control)['cleanup'], 'not_confirmed')


class TurnTests(BridgeCase):
    async def connected(self):
        host = self.add_host(thread_id='thread-A')
        adapter = self.plain_adapter()
        control = await self.start_control(adapter)
        await self.initialize(adapter)
        return host, adapter, control

    async def test_the_ais_turn_ended_closes_the_scope_and_the_next_call_runs_under_a_new_turn(self):
        host, adapter, control = await self.connected()
        first = adapter.turn_id
        await adapter.handle(self.call())
        reply = await self.run_call(adapter, 'turn_ended')
        self.assertEqual(reply['result']['content'][0]['text'], 'ended')
        self.assertEqual(host.turn_ended_calls(), [{'session_id': 'thread-A', 'turn_id': first}])
        self.assertNotEqual(adapter.turn_id, first)
        self.assertEqual((self.record(control)['scopes'], self.record(control)['cleanup']), ([], 'none'))
        self.assertEqual((await self.run_call(adapter))['result']['content'][0]['text'], 'PRIVATE_RESULT')
        self.assertEqual(host.reused, [])
        self.assertEqual(host.calls[-1]['scope']['turn_id'], adapter.turn_id)
        # The release that follows ends the pair the last call used.
        self.assertEqual(await self.ask(control, 'release'), {'released': True, 'reason': None, 'scope_count': 1})
        self.assertEqual(host.turn_ended_calls()[-1], {'session_id': 'thread-A', 'turn_id': host.calls[-2]['scope']['turn_id']})
        self.assertEqual(host.repeated, [])

    async def test_every_confirmed_turn_ended_starts_a_fresh_turn(self):
        host, adapter, control = await self.connected()
        seen = [adapter.turn_id]
        for _ in range(3):
            await adapter.handle(self.call())
            await adapter.handle(self.call('turn_ended'))
            seen.append(adapter.turn_id)
        self.assertEqual(len(set(seen)), 4)
        self.assertEqual([scope['turn_id'] for scope in host.turn_ended_calls()], seen[:3])
        self.assertEqual((host.reused, host.repeated), ([], []))

    async def test_a_refused_turn_ended_reaches_the_ai_and_keeps_the_scope_open(self):
        host, adapter, control = await self.connected()
        host.turn_ended = 'refuse'
        turn = adapter.turn_id
        await adapter.handle(self.call())
        reply = await self.run_call(adapter, 'turn_ended')
        self.assertTrue(reply['result']['isError'])
        self.assertEqual(adapter.turn_id, turn)
        record = self.record(control)
        self.assertEqual((record['cleanup'], len(record['scopes'])), ('not_confirmed', 1))
        host.turn_ended = 'ok'
        reply = await self.run_call(adapter, 'turn_ended')
        self.assertNotIn('isError', reply['result'])
        self.assertNotEqual(adapter.turn_id, turn)
        self.assertEqual((self.record(control)['cleanup'], self.record(control)['scopes']), ('none', []))

    async def test_calls_made_while_turn_ended_runs_wait_and_use_the_new_turn(self):
        host, adapter, control = await self.connected()
        await adapter.handle(self.call())
        first = adapter.turn_id
        # turn_ended answers only after the gate; the call made meanwhile must not leave under the ending turn.
        gate = host.hold('turn_ended')
        ending = asyncio.create_task(adapter.handle(self.call('turn_ended')))
        await self.settle(lambda: host.turn_ended_calls())
        meanwhile = self.call()
        waiting = asyncio.create_task(adapter.handle(meanwhile))
        await asyncio.sleep(0.1)
        self.assertEqual([call['tool'] for call in host.calls], ['js', 'turn_ended'])
        gate.set()
        await asyncio.gather(ending, waiting)
        self.assertEqual(host.calls[-1]['scope']['turn_id'], adapter.turn_id)
        self.assertNotEqual(adapter.turn_id, first)
        self.assertEqual((host.reused, host.repeated), ([], []))

    async def test_an_unanswered_release_rotates_the_turn_and_open_scopes_accumulate_until_all_are_ended(self):
        host, adapter, control = await self.connected()
        adapter.cleanup_timeout = 0.3
        first = adapter.turn_id
        await adapter.handle(self.call())
        host.turn_ended = 'silent'
        self.assertEqual(await self.ask(control, 'release'), {'released': False, 'reason': 'cleanup_not_confirmed', 'scope_count': 0})
        # The runtime may still end the first pair, so nothing is sent under it again; it stays open for a retry.
        second = adapter.turn_id
        self.assertNotEqual(second, first)
        await adapter.handle(self.call())
        record = self.record(control)
        self.assertEqual([scope['turn_id'] for scope in record['scopes']], [first, second])
        self.assertEqual((record['cleanup'], record['turn_id']), ('not_confirmed', second))
        self.assertEqual(await self.ask(control, 'status'), {'ok': True, 'busy': False, 'open_scopes': 2})
        host.turn_ended = 'ok'
        self.assertEqual(await self.ask(control, 'release'), {'released': True, 'reason': None, 'scope_count': 2})
        self.assertEqual(host.turn_ended_calls()[-2:], [{'session_id': 'thread-A', 'turn_id': first},
                                                        {'session_id': 'thread-A', 'turn_id': second}])
        record = self.record(control)
        self.assertEqual((record['scopes'], record['cleanup']), ([], 'none'))
        self.assertNotIn(adapter.turn_id, (first, second))
        self.assertEqual(host.reused, [])

    async def test_a_turn_ended_the_runtime_never_answers_gives_up_and_does_not_hold_back_later_calls(self):
        host, adapter, control = await self.connected()
        adapter.cleanup_timeout = 0.3
        first = adapter.turn_id
        await adapter.handle(self.call())
        host.turn_ended = 'silent'
        started = time.monotonic()
        reply = await self.run_call(adapter, 'turn_ended')
        self.assertLess(time.monotonic()-started, 5)
        self.assertEqual(reply['error']['code'], -32001)
        self.assertIn('did not answer', reply['error']['message'])
        # The runtime may still end the pair: the turn moves on and the scope stays open for a later try.
        self.assertNotEqual(adapter.turn_id, first)
        record = self.record(control)
        self.assertEqual((record['cleanup'], [scope['turn_id'] for scope in record['scopes']]), ('not_confirmed', [first]))
        # The calls behind it are not held back, and they run under the new turn.
        self.assertEqual((await self.run_call(adapter))['result']['content'][0]['text'], 'PRIVATE_RESULT')
        self.assertEqual(host.calls[-1]['scope']['turn_id'], adapter.turn_id)
        self.assertEqual(host.reused, [])

    async def test_tools_cannot_name_a_session_or_turn(self):
        host, adapter, control = await self.connected()
        await adapter.handle(self.call(_meta={'x-codex-turn-metadata': {'session_id': 'other', 'turn_id': 'other'}}))
        bad = self.call('turn_ended')
        bad['params']['arguments'] = {'session_id': 'other', 'turn_id': 'other', 'hook_event_name': 'Stop'}
        await adapter.handle(bad)
        self.assertEqual(self.reply(bad['id'])['error']['code'], -32602)
        self.assertEqual({call['scope']['session_id'] for call in host.calls}, {'thread-A'})
        # Neither does the control socket: extra keys are ignored and only this bridge's own scope is ended.
        reply = await self.ask(control, 'release', session_id='other', turn_id='other')
        self.assertEqual(reply['scope_count'], 1)
        self.assertEqual(host.turn_ended_calls()[0]['session_id'], 'thread-A')


class ExitReleaseTests(BridgeCase):
    async def test_closing_releases_every_reachable_scope_and_removes_the_record(self):
        host = self.add_host(thread_id='thread-A')
        adapter = self.plain_adapter()
        control = await self.start_control(adapter)
        await self.initialize(adapter)
        turn = adapter.turn_id
        await adapter.handle(self.call())
        directory = control.directory
        await control.stop()
        report = await adapter.close()
        await control.finalize()
        self.assertEqual(host.turn_ended_calls(), [{'session_id': 'thread-A', 'turn_id': turn}])
        self.assertEqual((report['owned_thread_unsubscribe'], report['connection_close']), ('confirmed', 'confirmed'))
        self.assertFalse(directory.exists())
        self.assertEqual(list((self.state/'bridges').iterdir()), [])

    async def test_a_host_that_refuses_leaves_the_record_not_confirmed_without_its_socket(self):
        host = self.add_host(thread_id='thread-A', turn_ended='refuse')
        adapter = self.plain_adapter()
        control = await self.start_control(adapter)
        await self.initialize(adapter)
        turn = adapter.turn_id
        await adapter.handle(self.call())
        await control.stop()
        await adapter.close()
        await control.finalize()
        directory = control.directory
        self.assertEqual(sorted(entry.name for entry in directory.iterdir()), ['bridge.json'])
        self.assertEqual(stat.S_IMODE((directory/'bridge.json').stat().st_mode), 0o600)
        record = json.loads((directory/'bridge.json').read_text())
        self.assertEqual(record['cleanup'], 'not_confirmed')
        self.assertEqual([(scope['session_id'], scope['turn_id']) for scope in record['scopes']], [('thread-A', turn)])
        self.assertEqual((record['busy'], record['host']), (False, None))
        self.assertRegex(record['updated_at'], ISO)

    async def test_a_call_that_waits_behind_the_exit_release_is_turned_away_not_sent(self):
        host = self.add_host(thread_id='thread-A')
        adapter = self.plain_adapter()
        control = await self.start_control(adapter)
        await self.initialize(adapter)
        await adapter.handle(self.call())
        gate = host.hold('turn_ended')
        closing = asyncio.create_task(adapter.close())
        await self.settle(lambda: host.turn_ended_calls())
        late = self.call()
        waiting = asyncio.create_task(adapter.handle(late))
        await asyncio.sleep(0.1)
        gate.set()
        await asyncio.gather(closing, waiting)
        self.assertEqual(self.reply(late['id'])['error']['message'], 'This owned CUA connection is stopping.')
        self.assertEqual([call['tool'] for call in host.calls], ['js', 'turn_ended'])
        await control.stop()
        await control.finalize()
        self.assertEqual(list((self.state/'bridges').iterdir()), [])

    async def test_a_failure_while_releasing_does_not_keep_the_thread_attached(self):
        host = self.add_host(thread_id='thread-A')
        adapter = self.plain_adapter()
        control = await self.start_control(adapter)
        await self.initialize(adapter)
        await adapter.handle(self.call())
        async def broken(**options):
            raise RuntimeError('PRIVATE_FAILURE')
        adapter.release_scopes = broken
        await control.stop()
        report = await adapter.close()
        await control.finalize()
        self.assertEqual((report['owned_thread_unsubscribe'], report['connection_close']), ('confirmed', 'confirmed'))
        self.assertEqual(len(host.methods('thread/unsubscribe')), 1)
        self.assertEqual(self.record(control)['cleanup'], 'not_confirmed')

    async def test_the_release_at_exit_takes_three_seconds_at_most(self):
        host = self.add_host(thread_id='thread-A', turn_ended='silent')
        adapter = self.plain_adapter()
        adapter.cleanup_timeout = 30
        control = await self.start_control(adapter)
        await self.initialize(adapter)
        await adapter.handle(self.call())
        await control.stop()
        started = time.monotonic()
        await adapter.close()
        elapsed = time.monotonic()-started
        self.assertGreaterEqual(elapsed, 2.9)
        self.assertLess(elapsed, 4.5)
        self.assertEqual(host_mcp.EXIT_RELEASE_SECONDS, 3.0)
        await control.finalize()
        self.assertEqual(self.record(control)['cleanup'], 'not_confirmed')

    async def test_the_unsubscribe_at_exit_gets_only_what_is_left_of_the_three_seconds(self):
        host = self.add_host(thread_id='thread-A', turn_ended='silent')
        host.unsubscribe = 'silent'
        adapter = self.plain_adapter()
        adapter.cleanup_timeout = 30
        control = await self.start_control(adapter)
        await self.initialize(adapter)
        await adapter.handle(self.call())
        await control.stop()
        started = time.monotonic()
        report = await adapter.close()
        elapsed = time.monotonic()-started
        # The release used the three seconds, so nothing is left to wait for the unsubscribe.
        self.assertGreaterEqual(elapsed, 2.9)
        self.assertLess(elapsed, 4.5)
        self.assertEqual((report['owned_thread_unsubscribe'], report['connection_close']), ('unconfirmed', 'confirmed'))
        self.assertEqual(len(host.methods('thread/unsubscribe')), 1)
        await control.finalize()

    async def test_a_connection_without_any_open_scope_leaves_nothing_behind(self):
        host = self.add_host(thread_id='thread-A')
        adapter = self.plain_adapter()
        control = await self.start_control(adapter)
        await self.initialize(adapter)
        await control.stop()
        await adapter.close()
        await control.finalize()
        self.assertEqual(host.turn_ended_calls(), [])
        self.assertEqual(list((self.state/'bridges').iterdir()), [])



class RegisteredCase(BridgeCase):
    """The registered-host entry point: the host registry names the socket, and a closed Codex is opened by `open`."""
    async def asyncSetUp(self):
        await super().asyncSetUp()
        app, _, _ = fake_app(self.root/'apps')
        environment = patch.dict(os.environ, {'CODEX_CUA_APP_PATH': str(app), 'CODEX_HOST_CUA_AUTOSTART_TIMEOUT': '1'})
        environment.start()
        self.addCleanup(environment.stop)
        self.commands, self.processes, self.reopen = [], [], None
        stub = SimpleNamespace(run=self.run_command, DEVNULL=subprocess.DEVNULL, PIPE=subprocess.PIPE,
                               TimeoutExpired=subprocess.TimeoutExpired)
        for target, replacement in ((host_autostart, {'subprocess': stub}),
                                    (host_autostart, {'app_processes': lambda executable: list(self.processes)}),
                                    (host_autostart, {'front_bundle': lambda: None})):
            patcher = patch.multiple(target, **replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_command(self, command, **kwargs):
        # The only command the autostart runs here is `open`; the app is a fixture and nothing is really opened.
        self.commands.append(command)
        if command[:2] == ['/usr/bin/open', '-g'] and self.reopen is not None:
            self.reopen()
        return SimpleNamespace(returncode=0, stdout='')

    def opened(self):
        return [command for command in self.commands if command[:2] == ['/usr/bin/open', '-g']]

    async def registered(self, relay=None, thread_id='thread-A', native_cli=None, **options):
        host = self.add_host(thread_id=thread_id, **options)
        path = self.socket()
        write_registry(self.host_state, path, relay=relay, native_cli=native_cli)
        adapter = self.registered_adapter()
        control = await self.start_control(adapter)
        await self.initialize(adapter)
        return host, adapter, control, path

    def activity(self):
        path = self.state/'activity.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


class ActivityTests(RegisteredCase):
    async def lines_for(self, relay):
        host, adapter, control, _ = await self.registered(relay=relay)
        host.results['js_reset'] = {'content': [{'type': 'text', 'text': 'PRIVATE_FAILURE'}], 'isError': True}
        await adapter.handle(self.call())
        await adapter.handle(self.call('js_reset'))
        await adapter.handle(self.call('turn_ended'))
        return host, control, self.activity()

    async def check_lines(self, control, lines):
        self.assertEqual([(line['tool'], line['ok']) for line in lines], [('js', True), ('js_reset', False), ('turn_ended', True)])
        writer = 'bridge-%d-%d' % (control.pid, control.started_at)
        for line in lines:
            self.assertEqual(set(line), {'at', 'writer', 'session_id', 'tool', 'ok', 'ms'})
            self.assertRegex(line['at'], ISO)
            self.assertEqual((line['writer'], line['session_id']), (writer, 'thread-A'))
            self.assertIs(type(line['ms']), int)
            self.assertGreaterEqual(line['ms'], 0)
        self.assertEqual(stat.S_IMODE((self.state/'activity.jsonl').stat().st_mode), 0o600)
        # Names, outcome and duration only: neither the code, the result, nor the failure text.
        self.assertNotIn(b'PRIVATE', (self.state/'activity.jsonl').read_bytes())
        self.assertNotIn('PRIVATE', json.dumps(self.logs))

    async def test_a_host_registry_without_a_relay_flag_gets_one_line_per_call(self):
        host, control, lines = await self.lines_for(None)
        self.assertEqual(self.record(control)['host'], {'pid': os.getpid(), 'relay': False})
        await self.check_lines(control, lines)

    async def test_a_host_registry_that_says_no_relay_gets_one_line_per_call(self):
        host, control, lines = await self.lines_for(False)
        self.assertEqual(self.record(control)['host'], {'pid': os.getpid(), 'relay': False})
        await self.check_lines(control, lines)

    async def test_a_host_with_a_relay_gets_no_lines_from_the_bridge(self):
        host, control, lines = await self.lines_for(True)
        self.assertEqual(self.record(control)['host'], {'pid': os.getpid(), 'relay': True})
        self.assertEqual(len(host.calls), 3)
        self.assertEqual(lines, [])
        self.assertFalse((self.state/'activity.jsonl').exists())

    async def test_only_a_true_relay_flag_counts_as_a_relay(self):
        host, control, lines = await self.lines_for('true')
        self.assertEqual(self.record(control)['host']['relay'], False)
        self.assertEqual(len(lines), 3)

    async def test_calls_that_never_reach_the_host_leave_no_line(self):
        host, adapter, control, _ = await self.registered()
        await adapter.handle(self.call('unadvertised'))
        bad = self.call()
        bad['params']['arguments'] = []
        await adapter.handle(bad)
        self.assertEqual(self.activity(), [])


class ReconnectTests(RegisteredCase):
    def tools_with(self, *names):
        tools = copy.deepcopy(TOOLS)
        for name in names:
            tools[name] = {'name': name, 'inputSchema': {'type': 'object'}}
        return tools

    async def lose_host(self, host):
        host.finish()
        await self.settle(lambda: self.record_of_last_control()['host'] is None)

    def record_of_last_control(self):
        [directory] = list((self.state/'bridges').iterdir())
        return json.loads((directory/'bridge.json').read_text())

    async def test_the_call_in_flight_fails_and_the_next_one_runs_on_a_new_thread_of_the_restarted_codex(self):
        host1, adapter, control, first_socket = await self.registered(thread_id='thread-A')
        host2 = self.add_host(thread_id='thread-B')
        second_socket = self.socket()
        old_turn = adapter.turn_id
        await adapter.handle(self.call())
        gate = host1.hold('js')
        flying = self.call()
        task = asyncio.create_task(adapter.handle(flying))
        await self.settle(lambda: len(host1.calls) == 2)
        self.assertTrue(self.record(control)['busy'])
        host1.finish()
        await task
        # A fixed text, an error the AI can act on; the call is not sent again to anyone.
        self.assertEqual(self.reply(flying['id'])['error'], {'code': -32001, 'message': host_mcp.LOST_DURING_CALL})
        await self.settle(lambda: self.record(control)['host'] is None)
        record = self.record(control)
        self.assertEqual((record['busy'], record['session_id'], record['turn_id']), (False, 'thread-A', old_turn))
        self.assertEqual([scope['turn_id'] for scope in record['scopes']], [old_turn])
        self.assertEqual(record['cleanup'], 'open')
        self.assertEqual(len(self.connects), 1)
        # The catalogue stays available without a host, and asking for it connects to nothing.
        await adapter.handle({'jsonrpc': '2.0', 'id': 9, 'method': 'tools/list', 'params': {}})
        self.assertEqual(sorted(tool['name'] for tool in self.reply(9)['result']['tools']), ['js', 'js_reset', 'turn_ended'])
        self.assertEqual(len(self.connects), 1)
        # Codex quits and is reopened in the background by the next call, exactly as at a conversation start.
        (self.host_state/'host.json').unlink()
        self.reopen = lambda: write_registry(self.host_state, second_socket)
        result = await self.run_call(adapter)
        self.assertEqual(result['result']['content'][0]['text'], 'PRIVATE_RESULT')
        [command] = self.opened()
        self.assertEqual(command[2:5], ['-j', '-a', str(os.environ['CODEX_CUA_APP_PATH'])])
        self.assertEqual([connect['path'] for connect in self.connects], [str(first_socket), str(second_socket)])
        self.assertEqual(len(host1.calls), 2)
        self.assertEqual([(call['tool'], call['scope']['session_id']) for call in host2.calls], [('js', 'thread-B')])
        start = host2.methods('thread/start')[0]
        self.assertEqual(start['params'], {'ephemeral': True, 'cwd': os.getcwd()})
        record = self.record(control)
        self.assertEqual((record['session_id'], record['host'], record['busy']), ('thread-B', {'pid': os.getpid(), 'relay': False}, False))
        self.assertNotEqual(record['turn_id'], old_turn)
        self.assertEqual([(scope['session_id'], scope['turn_id']) for scope in record['scopes']],
                         [('thread-A', old_turn), ('thread-B', adapter.turn_id)])
        self.assertEqual(record['cleanup'], 'open')
        self.assertRegex(record['connected_at'], ISO)

    async def test_the_ended_connection_is_marked_in_the_activity_and_scopes_of_the_old_host_are_never_released_on_the_new_one(self):
        host1, adapter, control, _ = await self.registered(thread_id='thread-A')
        host2 = self.add_host(thread_id='thread-B')
        second_socket = self.socket()
        await adapter.handle(self.call())
        await self.lose_host(host1)
        write_registry(self.host_state, second_socket)
        await adapter.handle(self.call())
        old, current = [(scope['session_id'], scope['turn_id']) for scope in self.record(control)['scopes']]
        self.assertEqual(old[0], 'thread-A')
        # A release reaches this host's scope only; the old one stays open and the result says it is not complete.
        self.assertEqual(await self.ask(control, 'release'), {'released': True, 'reason': None, 'scope_count': 1})
        self.assertEqual(host2.turn_ended_calls(), [{'session_id': current[0], 'turn_id': current[1]}])
        self.assertEqual(host1.turn_ended_calls(), [])
        record = self.record(control)
        self.assertEqual([(scope['session_id'], scope['turn_id']) for scope in record['scopes']], [old])
        self.assertEqual(record['cleanup'], 'not_confirmed')
        self.assertEqual(await self.ask(control, 'status'), {'ok': True, 'busy': False, 'open_scopes': 1})
        self.assertEqual(await self.ask(control, 'release'), {'released': False, 'reason': 'cleanup_not_confirmed', 'scope_count': 0})
        self.assertEqual(host2.turn_ended_calls(), [{'session_id': current[0], 'turn_id': current[1]}])
        # At exit the old scope is what is left for the engine.
        await control.stop()
        await adapter.close()
        await control.finalize()
        record = self.record(control)
        self.assertEqual(record['cleanup'], 'not_confirmed')
        self.assertEqual([(scope['session_id'], scope['turn_id']) for scope in record['scopes']], [old])

    async def test_the_new_catalogue_decides_which_tools_still_exist(self):
        host1, adapter, control, _ = await self.registered(tools=self.tools_with('screenshot'))
        second_socket = self.socket()
        host2 = self.add_host(thread_id='thread-B')
        await self.lose_host(host1)
        write_registry(self.host_state, second_socket)
        reply = await self.run_call(adapter, 'screenshot')
        self.assertEqual(reply['error'], {'code': -32601, 'message': 'The tool is not advertised by the owned host CUA server.'})
        self.assertEqual(len(self.connects), 2)
        self.assertEqual(host2.calls, [])
        await adapter.handle({'jsonrpc': '2.0', 'id': 9, 'method': 'tools/list', 'params': {}})
        self.assertEqual(sorted(tool['name'] for tool in self.reply(9)['result']['tools']), ['js', 'js_reset', 'turn_ended'])
        # The connection to the new host stays; the next call needs no other connect.
        self.assertEqual((await self.run_call(adapter))['result']['content'][0]['text'], 'PRIVATE_RESULT')
        self.assertEqual(len(self.connects), 2)

    async def test_a_new_host_without_the_cua_tools_fails_the_call_cleans_up_and_keeps_the_old_catalogue(self):
        host1, adapter, control, _ = await self.registered(thread_id='thread-A')
        await adapter.handle(self.call())
        broken = self.add_host(thread_id='thread-B', tools={'other': {'name': 'other', 'inputSchema': {'type': 'object'}}})
        fixed = self.add_host(thread_id='thread-C')
        await self.lose_host(host1)
        write_registry(self.host_state, self.socket())
        reply = await self.run_call(adapter)
        self.assertEqual(reply['error']['code'], -32001)
        self.assertIn('js and js_reset', reply['error']['message'])
        # The thread made on the broken host was given up and the connection closed.
        self.assertEqual(len(broken.methods('thread/unsubscribe')), 1)
        self.assertTrue(broken.was_closed)
        self.assertEqual(broken.calls, [])
        record = self.record(control)
        self.assertEqual((record['host'], record['session_id']), (None, 'thread-A'))
        self.assertEqual(len(record['scopes']), 1)
        await adapter.handle({'jsonrpc': '2.0', 'id': 9, 'method': 'tools/list', 'params': {}})
        self.assertEqual(sorted(tool['name'] for tool in self.reply(9)['result']['tools']), ['js', 'js_reset', 'turn_ended'])
        # The next call tries again, and now works.
        write_registry(self.host_state, self.socket())
        self.assertEqual((await self.run_call(adapter))['result']['content'][0]['text'], 'PRIVATE_RESULT')
        self.assertEqual(self.record(control)['session_id'], 'thread-C')
        self.assertEqual(len(fixed.calls), 1)

    async def test_turn_ended_after_a_host_loss_never_reopens_codex_and_keeps_the_scopes(self):
        host1, adapter, control, _ = await self.registered(thread_id='thread-A')
        await adapter.handle(self.call())
        await self.lose_host(host1)
        (self.host_state/'host.json').unlink()
        host2 = self.add_host(thread_id='thread-B')
        second_socket = self.socket()
        self.reopen = lambda: write_registry(self.host_state, second_socket)
        with patch.object(mcp_stdio, 'ensure_host', side_effect=AssertionError('turn_ended must not look for a host')) as ensure:
            reply = await self.run_call(adapter, 'turn_ended')
        # A fixed answer; the registry was not read, nothing was opened, nothing was connected.
        self.assertEqual(reply['error'], {'code': -32001, 'message': host_mcp.TURN_ENDED_WITHOUT_HOST})
        ensure.assert_not_called()
        self.assertEqual((self.commands, len(self.connects)), ([], 1))
        self.assertEqual(len(adapter.scopes), 1)
        record = self.record(control)
        self.assertEqual((record['cleanup'], len(record['scopes']), record['host'], record['session_id']),
                         ('not_confirmed', 1, None, 'thread-A'))
        self.assertEqual([line['tool'] for line in self.activity()], ['js'])
        # The next real call still finds the host again, as before.
        self.assertEqual((await self.run_call(adapter))['result']['content'][0]['text'], 'PRIVATE_RESULT')
        self.assertEqual(len(self.opened()), 1)
        self.assertEqual(self.connects[-1]['path'], str(second_socket))
        self.assertEqual(len(host2.calls), 1)
        self.assertEqual(self.record(control)['session_id'], 'thread-B')

    async def test_a_call_that_finds_the_host_gone_when_it_is_about_to_leave_does_not_run_and_leaves_no_scope(self):
        host1, adapter, control, _ = await self.registered(thread_id='thread-A')
        await self.lose_host(host1)
        with self.assertRaises(host_mcp.BridgeFailure) as raised:
            await adapter.call_tool('js', {'code': 'PRIVATE_SCRIPT'})
        self.assertEqual(str(raised.exception), host_mcp.LOST_BEFORE_SEND)
        # No scope was opened, so ending the turn without a host is not an error.
        self.assertEqual(await adapter.end_turn_tool(), {'content': [{'type': 'text', 'text': host_mcp.NOTHING_TO_END}]})
        self.assertEqual((host1.calls, adapter.scopes, adapter.active_tool_calls), ([], {}, 0))
        self.assertEqual(self.activity(), [])

    async def test_the_boot_of_a_reconnect_runs_on_the_new_connection_and_keeps_nothing_of_the_old_host(self):
        # The identity check of boot reads self.rpc and the registry of that socket, so both must be new by then.
        app, native, cua = fake_app(self.root/'second-apps')
        host1, adapter, control, first_socket = await self.registered(thread_id='thread-A', native_cli=native)
        self.assertEqual(adapter.native_cua_root, cua.resolve())
        first_rpc = adapter.rpc
        host2 = self.add_host(thread_id='thread-B')
        second_socket = self.socket()
        seen = []
        original = host_mcp.HostMcp.boot
        async def spy(owner):
            seen.append((owner.rpc, str(owner.rpc.socket_path), owner.native_cua_root))
            return await original(owner)
        await self.lose_host(host1)
        write_registry(self.host_state, second_socket)
        with patch.object(host_mcp.HostMcp, 'boot', spy):
            await adapter.handle(self.call())
        [(rpc, socket_path, native_root)] = seen
        self.assertIsNot(rpc, first_rpc)
        self.assertIs(rpc, adapter.rpc)
        self.assertEqual(socket_path, str(second_socket))
        # Nothing the first registry said about its host (here: the app it named) is still believed.
        self.assertIsNone(native_root)
        self.assertIsNone(adapter.native_cua_root)
        self.assertEqual(self.record(control)['session_id'], 'thread-B')

    async def test_the_relay_flag_is_read_again_for_every_host_the_bridge_attaches_to(self):
        host1, adapter, control, _ = await self.registered(relay=False, thread_id='thread-A')
        host2, host3 = self.add_host(thread_id='thread-B'), self.add_host(thread_id='thread-C')
        await adapter.handle(self.call())
        self.assertEqual([line['session_id'] for line in self.activity()], ['thread-A'])
        # A host that Codex started with the relay: the relay writes the lines now, the bridge stays out of it.
        await self.lose_host(host1)
        write_registry(self.host_state, self.socket(), relay=True)
        await adapter.handle(self.call())
        self.assertEqual(self.record(control)['host'], {'pid': os.getpid(), 'relay': True})
        self.assertEqual([line['session_id'] for line in self.activity()], ['thread-A'])
        # And a later host without it brings the lines back.
        await self.lose_host(host2)
        write_registry(self.host_state, self.socket())
        await adapter.handle(self.call())
        self.assertEqual(self.record(control)['host'], {'pid': os.getpid(), 'relay': False})
        self.assertEqual([line['session_id'] for line in self.activity()], ['thread-A', 'thread-C'])

    async def test_a_codex_that_is_open_without_the_host_listener_is_left_alone_and_reported(self):
        host1, adapter, control, _ = await self.registered(thread_id='thread-A')
        await self.lose_host(host1)
        (self.host_state/'host.json').unlink()
        self.processes.append(4242)
        reply = await self.run_call(adapter)
        self.assertEqual(reply['error']['code'], -32001)
        self.assertIn('Quit Codex normally', reply['error']['message'])
        self.assertEqual(self.commands, [])
        self.assertEqual(len(self.connects), 1)
        self.assertEqual(self.record(control)['host'], None)
        # Still disconnected: another call asks again instead of giving up for good.
        self.processes.clear()
        host2 = self.add_host(thread_id='thread-B')
        self.reopen = lambda: write_registry(self.host_state, self.socket())
        self.assertEqual((await self.run_call(adapter))['result']['content'][0]['text'], 'PRIVATE_RESULT')
        self.assertEqual(len(self.opened()), 1)
        self.assertEqual(len(host2.calls), 1)

    async def test_exit_after_a_failed_reattach_still_says_the_thread_could_not_be_detached(self):
        host1, adapter, control, _ = await self.registered(thread_id='thread-A')
        await self.lose_host(host1)
        (self.host_state/'host.json').unlink()
        self.processes.append(4242)
        self.assertEqual((await self.run_call(adapter))['error']['code'], -32001)
        # The same answer as before the attempt: there is no host to detach the thread from.
        report = await adapter.close()
        self.assertEqual((report['owned_thread_unsubscribe'], report['connection_close']), ('unconfirmed', 'confirmed'))

    async def test_calls_that_arrive_together_after_a_loss_share_one_new_connection(self):
        host1, adapter, control, _ = await self.registered(thread_id='thread-A')
        host2 = self.add_host(thread_id='thread-B')
        await self.lose_host(host1)
        write_registry(self.host_state, self.socket())
        calls = [self.call() for _ in range(3)]
        await asyncio.gather(*(adapter.handle(call) for call in calls))
        self.assertEqual(len(self.connects), 2)
        self.assertEqual(len(host2.methods('thread/start')), 1)
        self.assertEqual(len(host2.calls), 3)
        self.assertEqual({call['scope']['turn_id'] for call in host2.calls}, {adapter.turn_id})

    async def test_a_lost_host_is_noticed_without_any_call_and_exit_still_cleans_up_what_it_can(self):
        host1, adapter, control, _ = await self.registered(thread_id='thread-A')
        await adapter.handle(self.call())
        await self.lose_host(host1)
        self.assertEqual(await self.ask(control, 'release'), {'released': False, 'reason': 'cleanup_not_confirmed', 'scope_count': 0})
        self.assertEqual(self.record(control)['cleanup'], 'not_confirmed')
        await control.stop()
        report = await adapter.close()
        await control.finalize()
        self.assertEqual(report['connection_close'], 'confirmed')
        self.assertEqual(self.record(control)['cleanup'], 'not_confirmed')
        self.assertEqual(sorted(entry.name for entry in control.directory.iterdir()), ['bridge.json'])


class ServeTests(BridgeCase):
    async def serving(self, adapter, factory='default'):
        read, write = os.pipe()
        stdin, writer = os.fdopen(read, 'rb', buffering=0), os.fdopen(write, 'wb', buffering=0)
        self.addCleanup(lambda: stdin.close() if not stdin.closed else None)
        if factory == 'default':
            factory = lambda owner: bridge_control.BridgeControl(owner, state=self.state)
        task = asyncio.create_task(host_mcp.serve(adapter, control_factory=factory, stdin=stdin))
        self.addCleanup(lambda: writer.close() if not writer.closed else None)
        return task, writer

    def send(self, writer, message):
        writer.write(json.dumps(message).encode()+b'\n')

    async def conversation(self, adapter, writer):
        self.send(writer, {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}}})
        await self.settle(lambda: any(item.get('id') == 1 for item in self.output))
        self.assertNotIn('error', self.reply(1))
        call = self.call()
        self.send(writer, call)
        await self.settle(lambda: any(item.get('id') == call['id'] for item in self.output))
        return self.reply(call['id'])

    async def test_the_record_exists_from_the_start_and_stdin_end_releases_and_removes_it(self):
        host = self.add_host(thread_id='thread-A')
        adapter = self.plain_adapter()
        task, writer = await self.serving(adapter)
        await self.settle(lambda: list((self.state/'bridges').glob('bridge-*/bridge.json')))
        [path] = (self.state/'bridges').glob('bridge-*/bridge.json')
        self.assertEqual(json.loads(path.read_text())['host'], None)
        self.assertEqual((await self.conversation(adapter, writer))['result']['content'][0]['text'], 'PRIVATE_RESULT')
        self.assertEqual(json.loads(path.read_text())['session_id'], 'thread-A')
        turn = adapter.turn_id
        writer.close()
        cleanup = await asyncio.wait_for(task, 10)
        self.assertEqual(host.turn_ended_calls(), [{'session_id': 'thread-A', 'turn_id': turn}])
        self.assertEqual(cleanup['connection_close'], 'confirmed')
        self.assertEqual(list((self.state/'bridges').iterdir()), [])

    async def test_a_conversation_start_that_fails_leaves_a_record_without_a_host_that_exit_removes(self):
        self.add_host(thread_id='thread-A', tools={'other': {'name': 'other', 'inputSchema': {'type': 'object'}}})
        adapter = self.plain_adapter()
        task, writer = await self.serving(adapter)
        self.send(writer, {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'capabilities': {}}})
        await self.settle(lambda: any(item.get('id') == 1 for item in self.output))
        self.assertEqual(self.reply(1)['error']['code'], -32001)
        [path] = (self.state/'bridges').glob('bridge-*/bridge.json')
        record = json.loads(path.read_text())
        self.assertEqual([record[key] for key in ('host', 'session_id', 'turn_id', 'connected_at', 'cleanup')],
                         [None, None, None, None, 'none'])
        writer.close()
        await asyncio.wait_for(task, 10)
        self.assertEqual(list((self.state/'bridges').iterdir()), [])

    async def test_stdin_end_with_a_refusing_host_leaves_the_record_not_confirmed(self):
        host = self.add_host(thread_id='thread-A', turn_ended='refuse')
        adapter = self.plain_adapter()
        task, writer = await self.serving(adapter)
        await self.conversation(adapter, writer)
        turn = adapter.turn_id
        writer.close()
        await asyncio.wait_for(task, 10)
        [directory] = (self.state/'bridges').iterdir()
        self.assertEqual(sorted(entry.name for entry in directory.iterdir()), ['bridge.json'])
        record = json.loads((directory/'bridge.json').read_text())
        self.assertEqual(record['cleanup'], 'not_confirmed')
        self.assertEqual([(scope['session_id'], scope['turn_id']) for scope in record['scopes']], [('thread-A', turn)])

    async def test_a_state_directory_with_the_wrong_mode_means_no_records_and_the_calls_still_work(self):
        self.state.mkdir(mode=0o755)
        self.state.chmod(0o755)
        host = self.add_host(thread_id='thread-A')
        adapter = self.plain_adapter()
        task, writer = await self.serving(adapter)
        reply = await self.conversation(adapter, writer)
        self.assertEqual(reply['result']['content'][0]['text'], 'PRIVATE_RESULT')
        self.assertIn('bridge_records_unavailable', self.logs)
        self.assertEqual(adapter.on_change, None)
        self.assertEqual(adapter.on_call, None)
        writer.close()
        await asyncio.wait_for(task, 10)
        # Nothing was created in the directory, and exit still ended the scope it opened.
        self.assertEqual(list(self.state.iterdir()), [])
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o755)
        self.assertEqual(len(host.turn_ended_calls()), 1)

    async def test_a_state_directory_that_is_a_file_or_a_symlink_means_no_records_either(self):
        self.state.write_text('not a directory')
        host = self.add_host(thread_id='thread-A')
        adapter = self.plain_adapter()
        task, writer = await self.serving(adapter)
        self.assertEqual((await self.conversation(adapter, writer))['result']['content'][0]['text'], 'PRIVATE_RESULT')
        writer.close()
        await asyncio.wait_for(task, 10)
        self.assertEqual(self.state.read_text(), 'not a directory')

    async def test_a_control_endpoint_that_cannot_start_does_not_stop_the_bridge(self):
        host = self.add_host(thread_id='thread-A')
        adapter = self.plain_adapter()
        def failing(owner):
            raise RuntimeError('PRIVATE_REASON')
        task, writer = await self.serving(adapter, failing)
        self.assertEqual((await self.conversation(adapter, writer))['result']['content'][0]['text'], 'PRIVATE_RESULT')
        self.assertIn('bridge_records_unavailable', self.logs)
        self.assertNotIn('PRIVATE', json.dumps(self.logs))
        writer.close()
        await asyncio.wait_for(task, 10)


if __name__ == '__main__':
    unittest.main()
