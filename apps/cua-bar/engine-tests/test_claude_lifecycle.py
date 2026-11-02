"""Claude lifecycle ownership, hook isolation and bounded cleanup, without a real Claude or Codex."""
import asyncio
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import claude_lifecycle as lifecycle
import mcp_stdio
from bridge_case import BridgeCase


OWNER = (4200, 1700000000)


def bound(session='claude-one', agent='', prompt='prompt-one'):
    return {'claude_session_id': session, 'agent_id': agent, 'prompt_id': prompt}


def call_payload(**changes):
    return {'hook_event_name': 'PreToolUse', 'session_id': 'claude-one', 'prompt_id': 'prompt-one',
            'tool_name': 'mcp__cuabar__js', 'tool_use_id': 'toolu_one', **changes}


class PrivateStateCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir='/tmp', prefix='clh')
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name).resolve()
        self.state.chmod(0o700)


class BindingTests(PrivateStateCase):
    def test_binding_round_trip_stores_only_identity_not_code_or_transcript(self):
        payload = call_payload(agent_id='worker-one', tool_input={'code': 'PRIVATE_SCRIPT'},
                               transcript_path='/PRIVATE_TRANSCRIPT')
        self.assertTrue(lifecycle.bind_call(self.state, OWNER, payload))
        self.assertEqual(lifecycle.read_binding(self.state, OWNER, 'toolu_one'), bound(agent='worker-one'))
        path = lifecycle.binding_path(self.state, OWNER, 'toolu_one')
        self.assertEqual(path.parent, self.state/'claude-hook-calls'/('%d-%d' % OWNER))
        self.assertEqual(len(path.stem), 64)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        raw = path.read_text()
        self.assertNotIn('PRIVATE', raw)
        self.assertNotIn('tool_input', raw)
        self.assertNotIn('transcript_path', raw)

    def test_different_owner_start_or_tool_id_cannot_read_a_binding(self):
        lifecycle.bind_call(self.state, OWNER, call_payload())
        for owner, tool in (((OWNER[0]+1, OWNER[1]), 'toolu_one'),
                            ((OWNER[0], OWNER[1]+1), 'toolu_one'), (OWNER, 'toolu_other')):
            self.assertIsNone(lifecycle.read_binding(self.state, owner, tool))
        path = lifecycle.binding_path(self.state, OWNER, 'toolu_one')
        value = json.loads(path.read_text())
        value['owner_started_at'] += 1
        path.write_text(json.dumps(value))
        self.assertIsNone(lifecycle.read_binding(self.state, OWNER, 'toolu_one'))

    def test_only_cuabar_calls_with_valid_identifiers_are_bound(self):
        for changes in ({'tool_name': 'mcp__other__js'}, {'tool_name': 'mcp__cuabar__unrelated'},
                        {'tool_use_id': '../escape'}, {'tool_use_id': False}, {'session_id': ''},
                        {'agent_id': '../worker'}, {'prompt_id': 'x'*201}):
            with self.subTest(changes=changes):
                self.assertFalse(lifecycle.bind_call(self.state, OWNER, call_payload(**changes)))
        self.assertEqual(list(self.state.iterdir()), [])
        for name in ('mcp__cuabar__js', 'mcp__cuabar__js_reset', 'mcp__cuabar__turn_ended'):
            self.assertTrue(lifecycle.bind_call(self.state, OWNER, call_payload(tool_name=name)))

    def test_non_private_missing_invalid_and_symlink_json_are_refused(self):
        parent = self.state/'private'
        parent.mkdir(mode=0o700)
        path = parent/'record.json'
        self.assertIsNone(lifecycle.private_json(path))
        path.write_text('{}')
        path.chmod(0o600)
        self.assertEqual(lifecycle.private_json(path), {})
        for text in ('invalid json', '[]', 'x'*65537, '{"nested":'+'['*2000+'0'+']'*2000+'}'):
            path.write_text(text)
            self.assertIsNone(lifecycle.private_json(path))
        path.write_text('{}')
        path.chmod(0o644)
        self.assertIsNone(lifecycle.private_json(path))
        path.chmod(0o600)
        parent.chmod(0o755)
        self.assertIsNone(lifecycle.private_json(path))
        parent.chmod(0o700)
        link = parent/'link.json'
        link.symlink_to(path)
        self.assertIsNone(lifecycle.private_json(link))
        with patch.object(lifecycle.os, 'getuid', return_value=os.getuid()+1):
            self.assertIsNone(lifecycle.private_json(path))

    def test_source_uses_main_defaults_and_rejects_invalid_identity_types(self):
        self.assertEqual(lifecycle.source({'session_id': 'claude-one'}), bound(prompt=''))
        self.assertEqual(lifecycle.source(bound(agent='worker-one')), bound(agent='worker-one'))
        for changes in ({'session_id': None}, {'session_id': '../bad'}, {'agent_id': 5}, {'prompt_id': {}},
                        {'agent_id': False}, {'agent_id': []}, {'prompt_id': 0}):
            with self.subTest(changes=changes):
                self.assertIsNone(lifecycle.source({'session_id': 'claude-one', **changes}))


class PruningTests(PrivateStateCase):
    def add_binding(self, tool, original, owner=OWNER):
        lifecycle.bind_call(self.state, owner, call_payload(tool_use_id=tool, **original))
        return lifecycle.binding_path(self.state, owner, tool)

    def test_stop_subagent_stop_and_session_end_preserve_other_contexts_and_owners(self):
        parent = self.add_binding('tool_parent', bound())
        next_prompt = self.add_binding('tool_next', bound(prompt='prompt-two'))
        child = self.add_binding('tool_child', bound(agent='child-one'))
        sibling = self.add_binding('tool_sibling', bound(agent='child-two'))
        other_session = self.add_binding('tool_session', bound(session='other-session'))
        other_owner = self.add_binding('tool_owner', bound(), owner=(OWNER[0]+1, OWNER[1]))
        lifecycle.prune_bindings(self.state, OWNER, {'hook_event_name': 'Stop', **bound()})
        self.assertFalse(parent.exists())
        self.assertTrue(all(path.exists() for path in (next_prompt, child, sibling, other_session, other_owner)))
        lifecycle.prune_bindings(self.state, OWNER, {'hook_event_name': 'SubagentStop', **bound(agent='child-one')})
        self.assertFalse(child.exists())
        self.assertTrue(all(path.exists() for path in (next_prompt, sibling, other_session, other_owner)))
        lifecycle.prune_bindings(self.state, OWNER, {'hook_event_name': 'SessionEnd', **bound()})
        self.assertFalse(next_prompt.exists())
        self.assertFalse(sibling.exists())
        self.assertTrue(other_session.exists())
        self.assertTrue(other_owner.exists())
        lifecycle.prune_bindings(self.state, OWNER, {'hook_event_name': 'SessionEnd', **bound(session='other-session')})
        self.assertFalse(other_session.parent.exists(), 'only the now-empty owner directory is removed')
        self.assertTrue(other_owner.exists())

    def test_next_prompt_fallback_prunes_old_parent_bindings_only(self):
        old = self.add_binding('tool_old', bound())
        current = self.add_binding('tool_current', bound(prompt='prompt-two'))
        child = self.add_binding('tool_child', bound(agent='child-one'))
        lifecycle.prune_bindings(self.state, OWNER, {'hook_event_name': 'UserPromptSubmit', **bound(prompt='prompt-two')})
        self.assertFalse(old.exists())
        self.assertTrue(current.exists())
        self.assertTrue(child.exists())

    def test_unidentified_subagent_stop_cannot_prune_the_parent(self):
        parent = self.add_binding('tool_parent', bound())
        lifecycle.prune_bindings(self.state, OWNER, {'hook_event_name': 'SubagentStop', **bound()})
        self.assertTrue(parent.exists())

    def test_subagent_end_prunes_its_bindings_even_after_the_parent_prompt_advanced(self):
        child = self.add_binding('tool_child', bound(agent='child-one'))
        parent = self.add_binding('tool_parent', bound(prompt='prompt-two'))
        sibling = self.add_binding('tool_sibling', bound(agent='child-two'))
        lifecycle.prune_bindings(self.state, OWNER,
                                 {'hook_event_name': 'SubagentStop', **bound(agent='child-one', prompt='prompt-two')})
        self.assertFalse(child.exists())
        self.assertTrue(parent.exists())
        self.assertTrue(sibling.exists())

    def test_unsafe_and_foreign_binding_records_are_never_deleted(self):
        invalid = self.add_binding('tool_invalid', bound())
        invalid.write_text('[]')
        public = self.add_binding('tool_public', bound())
        public.chmod(0o644)
        foreign = self.add_binding('tool_foreign', bound())
        data = json.loads(foreign.read_text())
        data['owner_started_at'] += 1
        foreign.write_text(json.dumps(data))
        link = invalid.parent/'link.json'
        link.symlink_to(invalid)
        lifecycle.prune_bindings(self.state, OWNER, {'hook_event_name': 'SessionEnd', **bound()})
        self.assertTrue(all(path.exists() for path in (invalid, public, foreign, link)))


class OwnerTests(unittest.TestCase):
    def owner(self, table, expected='4200', first=4400):
        with patch.object(lifecycle.os, 'getppid', return_value=first), \
                patch.object(lifecycle, 'identity', side_effect=lambda pid: table.get(pid)):
            return lifecycle.hook_owner({'CLAUDE_PID': expected})

    def test_only_a_same_user_ancestor_is_accepted_with_its_start_time(self):
        uid = os.getuid()
        table = {4400: (uid, 4300, 30), 4300: (uid, OWNER[0], 20), OWNER[0]: (uid, 1, OWNER[1])}
        self.assertEqual(self.owner(table), OWNER)
        self.assertIsNone(self.owner(table, expected='4500'), 'an unrelated Claude process is not this hook owner')
        self.assertEqual(self.owner(table, first=OWNER[0]), OWNER, 'exec-form hooks can be direct children')

    def test_missing_foreign_cycle_and_overlong_ancestry_fail_closed(self):
        uid = os.getuid()
        self.assertIsNone(self.owner({}))
        self.assertIsNone(self.owner({4400: (uid+1, OWNER[0], 30), OWNER[0]: (uid, 1, OWNER[1])}))
        self.assertIsNone(self.owner({4400: (uid, 4300, 30), 4300: (uid, 4400, 20)}))
        table = {pid: (uid, pid-1, 10) for pid in range(4200, 4501)}
        self.assertIsNone(self.owner(table, first=4500))
        for value in ('', '1', '0', '-42', 'not-a-pid'):
            self.assertIsNone(self.owner({}, expected=value))

    def test_identity_requires_valid_ps_and_start_information(self):
        uid = os.getuid()
        with patch.object(lifecycle.subprocess, 'check_output', return_value=f'{uid} 123\n'), \
                patch.object(lifecycle, 'process_started_at', return_value=456):
            self.assertEqual(lifecycle.identity(99), (uid, 123, 456))
        for output in ('', 'invalid', f'{uid} 123 extra'):
            with patch.object(lifecycle.subprocess, 'check_output', return_value=output):
                self.assertIsNone(lifecycle.identity(99))
        with patch.object(lifecycle.subprocess, 'check_output', side_effect=subprocess.TimeoutExpired('ps', 2)):
            self.assertIsNone(lifecycle.identity(99))


class FakeClient:
    def __init__(self, reply=None, error=False):
        self.reply = json.dumps(reply or {'released': True, 'scope_count': 1}).encode()+b'\n'
        self.error = error
        self.sent = b''
        self.timeout = None
        self.connected = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def settimeout(self, timeout):
        self.timeout = timeout

    def connect(self, path):
        if self.error:
            raise OSError('stand-in endpoint unavailable')
        self.connected = path

    def sendall(self, data):
        self.sent += data

    def recv(self, size):
        reply, self.reply = self.reply[:size], self.reply[size:]
        return reply


class NotifyTests(PrivateStateCase):
    def setUp(self):
        super().setUp()
        self.identities = {}
        self.sockets = []
        self.addCleanup(lambda: [item.close() for item in self.sockets])

    def record(self, name, pid, owner=OWNER):
        directory = self.state/'bridges'/('bridge-'+name)
        directory.mkdir(parents=True, mode=0o700)
        path = directory/'bridge.json'
        control = directory/'control.sock'
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.bind(str(control))
        self.sockets.append(sock)
        control.chmod(0o600)
        value = {'pid': pid, 'started_at': 1000+pid, 'owner_pid': owner[0], 'owner_started_at': owner[1],
                 'control_path': str(control)}
        path.write_text(json.dumps(value))
        path.chmod(0o600)
        self.identities[pid] = (os.getuid(), owner[0], 1000+pid)
        return path, value

    def test_only_this_exact_claude_owner_and_live_bridge_receive_the_event(self):
        path, record = self.record('ours', 5001)
        self.record('other-cli', 5002, (OWNER[0]+1, OWNER[1]))
        self.record('reused-owner-pid', 5003, (OWNER[0], OWNER[1]+1))
        self.record('reused-bridge-pid', 5004)
        self.identities[5004] = (os.getuid(), OWNER[0], 1)
        client = FakeClient()
        with patch.object(lifecycle, 'identity', side_effect=lambda pid: self.identities.get(pid)), \
                patch.object(lifecycle.socket, 'socket', return_value=client) as factory:
            result = lifecycle.notify_bridges(self.state, OWNER, {'hook_event_name': 'Stop', **bound()})
        self.assertEqual(result, [{'released': True, 'scope_count': 1}])
        factory.assert_called_once()
        self.assertEqual(client.connected, record['control_path'])
        self.assertLessEqual(client.timeout, 6)
        self.assertEqual(json.loads(client.sent), {'action': 'claude_event', 'pid': 5001,
            'started_at': record['started_at'], 'event': 'Stop', **bound()})

    def test_unsafe_record_socket_or_wrong_control_path_is_not_contacted(self):
        for unsafe in ('record', 'socket', 'control_path', 'foreign-process'):
            with self.subTest(unsafe=unsafe):
                path, record = self.record(unsafe, 5010+len(self.sockets))
                if unsafe == 'record':
                    path.chmod(0o644)
                elif unsafe == 'socket':
                    Path(record['control_path']).chmod(0o666)
                elif unsafe == 'control_path':
                    record['control_path'] = '/unrelated/control.sock'
                    path.write_text(json.dumps(record))
                else:
                    self.identities[record['pid']] = (os.getuid()+1, OWNER[0], record['started_at'])
        with patch.object(lifecycle, 'identity', side_effect=lambda pid: self.identities.get(pid)), \
                patch.object(lifecycle.socket, 'socket') as factory:
            self.assertEqual(lifecycle.notify_bridges(self.state, OWNER, {'hook_event_name': 'Stop', **bound()}), [])
        factory.assert_not_called()

    def test_unavailable_socket_is_unconfirmed_and_bad_events_are_noop(self):
        self.record('unavailable', 5001)
        with patch.object(lifecycle, 'identity', side_effect=lambda pid: self.identities.get(pid)), \
                patch.object(lifecycle.socket, 'socket', return_value=FakeClient(error=True)):
            self.assertEqual(lifecycle.notify_bridges(self.state, OWNER, {'hook_event_name': 'Stop', **bound()}),
                             [{'released': False, 'reason': 'unconfirmed'}])
        with patch.object(lifecycle.socket, 'socket') as factory:
            self.assertEqual(lifecycle.notify_bridges(self.state, OWNER, {'hook_event_name': 'not-an-event', **bound()}), [])
            self.assertEqual(lifecycle.notify_bridges(self.state, OWNER, {'hook_event_name': 'Stop', 'session_id': ''}), [])
        factory.assert_not_called()


class FakeAdapter:
    def __init__(self):
        self.thread_id = 'native-thread-one'
        self.scopes = {}
        self.turn_lock = asyncio.Lock()
        self.connected = True
        self.cleanup_unconfirmed = False
        self.changed = Mock()
        self.boot = Mock(side_effect=AssertionError('lifecycle cleanup must never reopen the host'))
        self.ended = []
        self.confirmed = True
        self.failure = None
        self.router = lifecycle.ScopeRouter(self)

    async def end_scope(self, scope, timeout):
        self.ended.append((dict(scope), timeout))
        if self.failure is not None:
            raise self.failure
        if self.confirmed:
            self.scopes.pop((scope['session_id'], scope['turn_id']), None)
        self.router.retired(scope, self.confirmed)
        return self.confirmed, {}

    def open(self, original):
        token = self.router.context.set(dict(original))
        try:
            scope = self.router.scope()
            self.scopes[(scope['session_id'], scope['turn_id'])] = {}
            return scope
        finally:
            self.router.context.reset(token)


class RouterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.adapter = FakeAdapter()
        self.router = self.adapter.router

    def key(self, scope):
        return scope['session_id'], scope['turn_id']

    async def test_parent_agents_and_prompts_have_distinct_stable_native_turns(self):
        parent = self.adapter.open(bound())
        child = self.adapter.open(bound(agent='child-one'))
        sibling = self.adapter.open(bound(agent='child-two'))
        next_prompt = self.adapter.open(bound(prompt='prompt-two'))
        self.assertEqual(self.adapter.open(bound()), parent)
        self.assertEqual(len({self.key(scope) for scope in (parent, child, sibling, next_prompt)}), 4)
        self.assertEqual({scope['session_id'] for scope in (parent, child, sibling, next_prompt)}, {'native-thread-one'})

    async def test_stop_and_subagentstop_release_only_their_matching_context(self):
        parent = self.adapter.open(bound())
        child = self.adapter.open(bound(agent='child-one'))
        sibling = self.adapter.open(bound(agent='child-two'))
        other = self.adapter.open(bound(session='another-cli-session'))
        reply = await self.router.end({'event': 'SubagentStop', **bound(agent='child-one')})
        self.assertEqual(reply, {'released': True, 'reason': None, 'scope_count': 1})
        self.assertNotIn(self.key(child), self.adapter.scopes)
        self.assertEqual(set(self.adapter.scopes), {self.key(parent), self.key(sibling), self.key(other)})
        reply = await self.router.end({'event': 'Stop', **bound()})
        self.assertEqual(reply['scope_count'], 1)
        self.assertEqual(set(self.adapter.scopes), {self.key(sibling), self.key(other)})
        self.adapter.boot.assert_not_called()

    async def test_old_prompt_stop_cannot_end_the_next_prompt(self):
        first = self.adapter.open(bound())
        second = self.adapter.open(bound(prompt='prompt-two'))
        await self.router.end({'event': 'Stop', **bound()})
        self.assertEqual(set(self.adapter.scopes), {self.key(second)})
        self.assertNotIn(self.key(first), self.adapter.scopes)

    async def test_subagent_stop_remains_agent_scoped_after_the_parent_prompt_advanced(self):
        child = self.adapter.open(bound(agent='child-one'))
        parent = self.adapter.open(bound(prompt='prompt-two'))
        sibling = self.adapter.open(bound(agent='child-two'))
        reply = await self.router.end({'event': 'SubagentStop', **bound(agent='child-one', prompt='prompt-two')})
        self.assertEqual(reply['scope_count'], 1)
        self.assertNotIn(self.key(child), self.adapter.scopes)
        self.assertEqual(set(self.adapter.scopes), {self.key(parent), self.key(sibling)})

    async def test_next_prompt_fallback_releases_prior_parent_prompts_but_not_current_or_agents(self):
        self.adapter.open(bound())
        self.adapter.open(bound(prompt='prompt-two'))
        current = self.adapter.open(bound(prompt='prompt-three'))
        child = self.adapter.open(bound(agent='child-one'))
        reply = await self.router.end({'event': 'UserPromptSubmit', **bound(prompt='prompt-three')})
        self.assertEqual(reply['scope_count'], 2)
        self.assertEqual(set(self.adapter.scopes), {self.key(current), self.key(child)})

    async def test_session_end_closes_parent_and_children_in_only_one_claude_session(self):
        self.adapter.open(bound())
        self.adapter.open(bound(agent='child-one'))
        self.adapter.open(bound(prompt='prompt-two'))
        other = self.adapter.open(bound(session='other-session'))
        reply = await self.router.end({'event': 'SessionEnd', **bound()})
        self.assertEqual(reply['scope_count'], 3)
        self.assertEqual(set(self.adapter.scopes), {self.key(other)})

    async def test_missing_agent_subagentstop_invalid_events_and_unbound_scopes_are_noop(self):
        parent = self.adapter.open(bound())
        self.adapter.scopes[('native-unbound', 'turn-unbound')] = {}
        for request in ({'event': 'SubagentStop', **bound()}, {'event': 'not-an-event', **bound()},
                        {'event': 'Stop', 'claude_session_id': ''}):
            await self.router.end(request)
        self.assertEqual(set(self.adapter.scopes), {self.key(parent), ('native-unbound', 'turn-unbound')})
        self.assertEqual(self.adapter.ended, [])

    async def test_snapshot_and_retirement_preserve_unconfirmed_scope_but_rotate_future_calls(self):
        original = bound(agent='child-one')
        first = self.adapter.open(original)
        self.assertEqual(self.router.snapshot(), [{**original, **first}])
        self.router.retired(first, False)
        self.assertEqual(self.router.snapshot(), [{**original, **first}])
        second = self.adapter.open(original)
        self.assertNotEqual(first, second)
        self.router.retired(first, True)
        self.adapter.scopes.pop(self.key(first))
        self.assertEqual(self.router.snapshot(), [{**original, **second}])

    async def test_context_binding_comes_only_from_matching_private_tool_use_id(self):
        with tempfile.TemporaryDirectory(dir='/tmp', prefix='clb') as folder:
            state = Path(folder)
            state.chmod(0o700)
            self.adapter.control_state, self.adapter.claude_owner = state, OWNER
            lifecycle.bind_call(state, OWNER, call_payload(agent_id='child-one'))
            message = {'method': 'tools/call', 'params': {'_meta': {'claudecode/toolUseId': 'toolu_one'}}}
            token = self.router.enter(message)
            self.assertEqual(self.router.context.get(), bound(agent='child-one'))
            self.router.context.reset(token)
            for message in ({'method': 'tools/call', 'params': {'_meta': {'claudecode/toolUseId': 'unknown'}}},
                            {'method': 'tools/list', 'params': {'_meta': {'claudecode/toolUseId': 'toolu_one'}}},
                            {'method': 'tools/call', 'params': {'arguments': {'claude_session_id': 'spoofed'}}}):
                token = self.router.enter(message)
                self.assertIsNone(self.router.context.get())
                self.assertIsNone(self.router.scope())
                self.router.context.reset(token)

    async def test_concurrent_call_contexts_do_not_overwrite_each_other_or_snapshot(self):
        ready, release = asyncio.Event(), asyncio.Event()
        async def worker(original, first=False):
            token = self.router.context.set(original)
            try:
                scope = self.router.scope()
                self.adapter.scopes[self.key(scope)] = {}
                if first:
                    ready.set()
                    await release.wait()
                else:
                    await ready.wait()
                    release.set()
                await asyncio.sleep(0)
                self.assertEqual(self.router.context.get(), original)
                self.assertEqual(self.router.scope(), scope)
                return scope
            finally:
                self.router.context.reset(token)
        parent, child = await asyncio.gather(worker(bound(), True), worker(bound(agent='child-one')))
        self.assertNotEqual(parent, child)
        self.assertIsNone(self.router.context.get())
        self.assertEqual({item['agent_id'] for item in self.router.snapshot()}, {'', 'child-one'})

    async def test_offline_or_replaced_host_is_never_reopened_for_cleanup(self):
        self.adapter.open(bound())
        for offline in (True, False):
            self.adapter.connected = not offline
            if not offline:
                self.adapter.thread_id = 'new-native-thread'
            reply = await self.router.end({'event': 'Stop', **bound()})
            self.assertEqual(reply['reason'], 'host_unavailable')
        self.assertEqual(self.adapter.ended, [])
        self.adapter.boot.assert_not_called()

    async def test_unconfirmed_or_failed_cleanup_is_reported_and_does_not_claim_release(self):
        self.adapter.open(bound())
        for failure in (None, RuntimeError('stand-in failure')):
            self.adapter.confirmed, self.adapter.failure = False, failure
            reply = await self.router.end({'event': 'Stop', **bound()})
            self.assertEqual(reply, {'released': False, 'reason': 'cleanup_not_confirmed', 'scope_count': 0})
        self.assertTrue(self.adapter.cleanup_unconfirmed)
        self.assertEqual(len(self.adapter.scopes), 1)
        self.assertEqual(self.adapter.changed.call_count, 2)

    async def test_running_calls_are_bounded_and_only_matching_scope_busy_counts(self):
        parent = self.adapter.open(bound())
        child = self.adapter.open(bound(agent='child-one'))
        self.router.inflight[self.key(child)] = 1
        reply = await self.router.end({'event': 'Stop', **bound()})
        self.assertEqual(reply['scope_count'], 1, 'a sibling call cannot keep the parent scope open')
        self.router.inflight[self.key(child)] = 1
        with patch.object(lifecycle, 'END_SECONDS', .02, create=True):
            started = asyncio.get_running_loop().time()
            reply = await self.router.end({'event': 'SubagentStop', **bound(agent='child-one')})
            elapsed = asyncio.get_running_loop().time()-started
        self.assertEqual(reply, {'released': False, 'reason': 'request_in_flight', 'scope_count': 0})
        self.assertLess(elapsed, .3)
        self.assertIn(self.key(child), self.adapter.scopes)

    async def test_a_busy_scope_that_finishes_is_then_released(self):
        scope = self.adapter.open(bound())
        self.router.inflight[self.key(scope)] = 1
        async def finish():
            await asyncio.sleep(.01)
            self.router.inflight[self.key(scope)] = 0
        await asyncio.gather(finish(), self.router.end({'event': 'Stop', **bound()}))
        self.assertEqual(self.adapter.scopes, {})

    async def test_turn_lock_wait_cannot_outlive_the_cleanup_budget(self):
        self.adapter.open(bound())
        await self.adapter.turn_lock.acquire()
        try:
            with patch.object(lifecycle, 'END_SECONDS', .02, create=True):
                reply = await asyncio.wait_for(self.router.end({'event': 'Stop', **bound()}), .3)
            self.assertFalse(reply['released'])
            self.assertIn(reply['reason'], ('request_in_flight', 'cleanup_not_confirmed'))
            self.assertEqual(self.adapter.ended, [])
        finally:
            self.adapter.turn_lock.release()

    async def test_an_unresponsive_end_call_cannot_outlive_the_cleanup_budget(self):
        self.adapter.open(bound())
        async def unresponsive(scope, timeout):
            await asyncio.Event().wait()
        self.adapter.end_scope = unresponsive
        with patch.object(lifecycle, 'END_SECONDS', .02, create=True):
            reply = await asyncio.wait_for(self.router.end({'event': 'Stop', **bound()}), .3)
        self.assertEqual(reply['reason'], 'cleanup_not_confirmed')
        self.assertFalse(reply['released'])
        self.assertTrue(self.adapter.cleanup_unconfirmed)


class RegisteredHostLifecycleTests(BridgeCase):
    """Exercise the actual bridge routing and private control endpoint against the in-memory fake host."""
    async def prepared(self, agents=0):
        host = self.add_host(thread_id='native-main-thread')
        for index in range(agents):
            self.add_host(thread_id='native-agent-thread-%d' % index)
        endpoint = self.socket()
        ensure = patch.object(mcp_stdio, 'ensure_host', return_value={
            'socket_path': str(endpoint), 'native_cli': '/fixture/uninstalled-codex'})
        ensure_mock = ensure.start()
        self.addCleanup(ensure.stop)
        watch = patch.object(mcp_stdio, 'watch_first_call', return_value=False)
        watch.start()
        self.addCleanup(watch.stop)
        adapter = self.registered_adapter()
        control = await self.start_control(adapter)
        await self.initialize(adapter)
        return adapter, control, host, ensure_mock

    async def owned_call(self, adapter, control, tool_id, original):
        lifecycle.bind_call(self.state, (control.owner_pid, control.owner_started_at),
                            call_payload(tool_use_id=tool_id, **original))
        message = self.call(_meta={'claudecode/toolUseId': tool_id})
        await adapter.handle(message)
        self.assertFalse(self.reply(message['id'])['result'].get('isError', False))

    async def test_control_end_isolated_to_one_subagent_and_the_next_call_gets_a_new_turn(self):
        adapter, control, host, _ = await self.prepared(agents=2)
        await self.owned_call(adapter, control, 'toolu_parent', bound())
        await self.owned_call(adapter, control, 'toolu_child', bound(agent='child-one'))
        await self.owned_call(adapter, control, 'toolu_sibling', bound(agent='child-two'))
        by_agent = {item['agent_id']: (item['session_id'], item['turn_id'])
                    for item in self.record(control)['claude_scopes']}
        self.assertEqual(len({key[0] for key in by_agent.values()}), 3,
                         'parent and sibling agents have separate native threads and JavaScript kernels')
        reply = await self.ask(control, 'claude_event', event='SubagentStop', **bound(agent='child-one'))
        self.assertEqual(reply, {'released': True, 'reason': None, 'scope_count': 1})
        family = {(item['session_id'], item['turn_id']) for item in adapter.lifecycle_snapshot()}
        self.assertNotIn(by_agent['child-one'], family)
        self.assertEqual(family, {by_agent[''], by_agent['child-two']})
        self.assertEqual({(item['session_id'], item['turn_id']) for item in adapter.snapshot()['scopes']}, family)
        self.assertEqual(set(adapter.scopes), {by_agent['']}, 'the primary adapter never owns child scopes directly')
        await self.owned_call(adapter, control, 'toolu_child_again', bound(agent='child-one'))
        renewed = {item['agent_id']: (item['session_id'], item['turn_id'])
                   for item in self.record(control)['claude_scopes']}
        self.assertNotEqual(renewed['child-one'], by_agent['child-one'])
        self.assertEqual(renewed[''], by_agent[''])
        self.assertTrue(all(not item.reused for item in self.hosts),
                        'a new CUA call never reuses an already-ended native turn in any family member')
        self.assertIsNone(adapter.claude_lifecycle.context.get(), 'request metadata does not leak to the next handler')

    async def test_a_lifecycle_end_after_host_loss_does_not_autostart_a_replacement(self):
        adapter, control, host, ensure = await self.prepared()
        await self.owned_call(adapter, control, 'toolu_parent', bound())
        calls_before = ensure.call_count
        host.finish()
        await self.settle(lambda: not adapter.connected)
        reply = await self.ask(control, 'claude_event', event='Stop', **bound())
        self.assertEqual(reply['reason'], 'host_unavailable')
        self.assertFalse(reply['released'])
        self.assertEqual(ensure.call_count, calls_before)


if __name__ == '__main__':
    unittest.main()
