"""Registered-host lifecycle integration using a fake Codex host and private temporary hook bindings only."""
import asyncio
import os
import threading
from unittest.mock import AsyncMock, patch

from bridge_case import BridgeCase
import claude_lifecycle
import mcp_stdio
from fake_host import write_registry


class RegisteredLifecycleTests(BridgeCase):
    async def registered(self):
        host = self.add_host(thread_id='registered-owned-thread')
        self.agent_hosts = {}
        write_registry(self.host_state, self.socket())
        prepared = patch.object(mcp_stdio, 'ensure_host',
                                side_effect=lambda *args, **kwargs: mcp_stdio.read_host_registry(self.host_state))
        prepared.start()
        self.addCleanup(prepared.stop)
        adapter = self.registered_adapter()
        control = await self.start_control(adapter)
        await self.initialize(adapter)
        return host, adapter, control

    def bound_call(self, adapter, tool_id, agent='', prompt='prompt-1', name='js'):
        if agent and agent not in self.agent_hosts:
            self.agent_hosts[agent] = self.add_host(thread_id='registered-agent-'+agent)
        payload = {'hook_event_name': 'PreToolUse', 'session_id': 'claude-session', 'agent_id': agent,
                   'prompt_id': prompt, 'tool_use_id': tool_id, 'tool_name': 'mcp__cuabar__'+name}
        self.assertTrue(claude_lifecycle.bind_call(self.state, adapter.claude_owner, payload))
        message = self.call(name)
        message['params']['_meta'] = {'claudecode/toolUseId': tool_id}
        return message

    async def cancel(self, adapter, ident):
        await adapter.handle({'jsonrpc': '2.0', 'method': 'notifications/cancelled',
                              'params': {'requestId': ident}})

    async def test_cancel_during_the_first_call_watch_clears_inflight_and_never_sends_the_native_call(self):
        host, adapter, _ = await self.registered()
        message = self.bound_call(adapter, 'toolu-sub-watch', agent='subagent-a')
        entered, finish = threading.Event(), threading.Event()

        def watch():
            entered.set()
            finish.wait(3)
            return False

        try:
            with patch.object(mcp_stdio, 'watch_first_call', side_effect=watch):
                task = asyncio.create_task(adapter.handle(message))
                await self.settle(entered.is_set)
                child = adapter.agent_children[('claude-session', 'subagent-a')]
                self.assertEqual(sum(child.claude_lifecycle.inflight.values()), 1)
                self.assertIsNone(adapter.claude_lifecycle.context.get(), 'the caller never inherits another task\'s agent')
                self.assertIsNone(child.claude_lifecycle.context.get())
                await self.cancel(adapter, message['id'])
                await task
            self.assertEqual(sum(adapter.claude_lifecycle.inflight.values()), 0)
            self.assertEqual(sum(child.claude_lifecycle.inflight.values()), 0)
            self.assertEqual(host.calls, [])
            self.assertEqual(self.agent_hosts['subagent-a'].calls, [])
            self.assertIn('before it was sent', self.reply(message['id'])['error']['message'])
            self.assertEqual(adapter.scopes, {})
            self.assertEqual(child.scopes, {})
            self.assertIsNone(adapter.claude_lifecycle.context.get())
        finally:
            finish.set()

    async def test_parallel_parent_and_subagent_bindings_keep_their_native_turns_separate(self):
        host, adapter, _ = await self.registered()
        held = host.hold('js')
        parent = self.bound_call(adapter, 'toolu-parent', prompt='parent-prompt')
        child = self.bound_call(adapter, 'toolu-child', agent='subagent-a', prompt='child-prompt')
        child_host = self.agent_hosts['subagent-a']
        child_held = child_host.hold('js')
        with patch.object(mcp_stdio, 'watch_first_call', return_value=False):
            tasks = [asyncio.create_task(adapter.handle(message)) for message in (parent, child)]
            await self.settle(lambda: len(host.calls) == len(child_host.calls) == 1)
            turns = {call['scope']['turn_id'] for call in [*host.calls, *child_host.calls]}
            self.assertEqual(len(turns), 2)
            bindings = adapter.lifecycle_snapshot()
            self.assertEqual({(item['agent_id'], item['prompt_id']) for item in bindings},
                             {('', 'parent-prompt'), ('subagent-a', 'child-prompt')})
            self.assertEqual({item['session_id'] for item in bindings},
                             {'registered-owned-thread', 'registered-agent-subagent-a'})
            self.assertIsNone(adapter.claude_lifecycle.context.get())
            held.set()
            child_held.set()
            await asyncio.gather(*tasks)
            child_scope = next(item for item in bindings if item['agent_id'])
            answer = await adapter.end_claude_event({'event': 'SubagentStop', 'claude_session_id': 'claude-session',
                                                   'agent_id': 'subagent-a', 'prompt_id': 'child-prompt'})
            self.assertEqual((answer['released'], answer['scope_count']), (True, 1))
            self.assertEqual(child_host.turn_ended_calls(), [{'session_id': child_scope['session_id'],
                                                             'turn_id': child_scope['turn_id']}])
            self.assertEqual(host.turn_ended_calls(), [])
            self.assertEqual({item['agent_id'] for item in adapter.lifecycle_snapshot()}, {''})
            self.assertEqual(len(adapter.snapshot()['scopes']), 1)
            again = self.bound_call(adapter, 'toolu-parent-again', prompt='parent-prompt')
            await adapter.handle(again)
            self.assertNotIn('error', self.reply(again['id']))
            self.assertEqual(host.reused, [])
        self.assertEqual(sum(adapter.claude_lifecycle.inflight.values()), 0)
        self.assertIsNone(adapter.claude_lifecycle.context.get())

    async def test_accepted_cancel_without_an_original_reply_does_not_leave_registered_inflight_stuck(self):
        host, adapter, _ = await self.registered()
        message = self.bound_call(adapter, 'toolu-cancel', agent='subagent-a')
        child_host = self.agent_hosts['subagent-a']
        held = child_host.hold('js')
        notified = AsyncMock(return_value={'cancelled': True, 'reason': None})
        with patch.object(mcp_stdio, 'watch_first_call', return_value=False):
            task = asyncio.create_task(adapter.handle(message))
            await self.settle(lambda: len(child_host.calls) == 1)
            child = adapter.agent_children[('claude-session', 'subagent-a')]
            with patch.object(child, 'cancel_native_request', notified):
                await self.cancel(adapter, message['id'])
                await task
        self.assertEqual(notified.await_count, 1)
        self.assertEqual(sum(adapter.claude_lifecycle.inflight.values()), 0)
        self.assertEqual(sum(child.claude_lifecycle.inflight.values()), 0)
        self.assertEqual(child.active_tool_calls, 0)
        self.assertTrue(child.cleanup_unconfirmed)
        self.assertEqual(len(adapter.snapshot()['scopes']), 1, 'the native result was not invented by local cancellation')
        self.assertIsNone(adapter.claude_lifecycle.context.get())
        # The later end event confirms only the cancelled agent's scope. The held original tool answer is absent.
        ended = await adapter.end_claude_event({'event': 'SubagentStop', 'claude_session_id': 'claude-session',
                                              'agent_id': 'subagent-a', 'prompt_id': 'prompt-1'})
        self.assertEqual((ended['released'], ended['scope_count']), (True, 1))
        self.assertEqual(adapter.snapshot()['scopes'], [])
        held.set()

    async def test_public_or_other_owner_bindings_are_not_accepted_as_agent_context(self):
        host, adapter, _ = await self.registered()
        public = self.bound_call(adapter, 'toolu-public', agent='should-not-bind')
        path = claude_lifecycle.binding_path(self.state, adapter.claude_owner, 'toolu-public')
        os.chmod(path, 0o644)
        foreign = self.call()
        foreign['params']['_meta'] = {'claudecode/toolUseId': 'toolu-other-owner'}
        owner = (adapter.claude_owner[0], adapter.claude_owner[1]+1)
        self.assertTrue(claude_lifecycle.bind_call(self.state, owner, {
            'session_id': 'claude-session', 'agent_id': 'foreign', 'prompt_id': 'prompt-1',
            'tool_use_id': 'toolu-other-owner', 'tool_name': 'mcp__cuabar__js'}))
        with patch.object(mcp_stdio, 'watch_first_call', return_value=False):
            await adapter.handle(public)
            await adapter.handle(foreign)
        self.assertEqual(adapter.claude_lifecycle.snapshot(), [])
        self.assertEqual({call['scope']['turn_id'] for call in host.calls}, {adapter.turn_id})
        self.assertIsNone(adapter.claude_lifecycle.context.get())
