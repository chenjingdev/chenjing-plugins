"""Separate agent kernels on fake owned Codex threads; no live Codex, CUA, browser or application is used."""
import asyncio
from unittest.mock import AsyncMock, patch

from bridge_case import BridgeCase
import claude_lifecycle
import mcp_stdio
from fake_host import FakeHost, write_registry


class KernelHost(FakeHost):
    def __init__(self, *args, start_gate=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.start_gate = start_gate
        self.values = {}
        self.approval = asyncio.Event()
        self.approval_answers = []

    async def answer(self, message):
        if message.get('method') is None and message.get('id') == 'native-approval':
            self.approval_answers.append(message)
            self.approval.set()
            return
        if message.get('method') == 'thread/start' and self.start_gate is not None:
            await self.start_gate.wait()
        return await super().answer(message)

    async def tool_call(self, ident, params):
        original = await super().tool_call(ident, params)
        if params['tool'] == 'turn_ended' or original.get('isError'):
            return original
        if params['tool'] == 'js_reset':
            self.values.clear()
            return {'content': [{'type': 'text', 'text': 'reset'}]}
        code = params['arguments'].get('code', '')
        if code.startswith('set:'):
            key, value = code[4:].split('=', 1)
            self.values[key] = value
            return {'content': [{'type': 'text', 'text': value}]}
        if code.startswith('get:'):
            return {'content': [{'type': 'text', 'text': self.values.get(code[4:], 'undefined')}]}
        if code == 'ask':
            self.emit({'id': 'native-approval', 'method': 'mcpServer/elicitation/request', 'params': {
                'threadId': self.thread_id, 'serverName': 'cua_repl', 'mode': 'form',
                'message': 'Allow '+self.thread_id+'?', 'requestedSchema': {'type': 'object', 'properties': {}}}})
            await self.approval.wait()
            return {'content': [{'type': 'text', 'text': 'approved'}]}
        return original


class AgentKernelTests(BridgeCase):
    def kernel(self, name, **options):
        host = KernelHost(thread_id=name, **options)
        self.hosts.append(host)
        return host

    async def registered(self, elicitation=False):
        parent = self.kernel('native-parent-thread')
        write_registry(self.host_state, self.socket())
        prepared = patch.object(mcp_stdio, 'ensure_host',
                                side_effect=lambda *args, **kwargs: mcp_stdio.read_host_registry(self.host_state))
        prepare_mock = prepared.start()
        self.addCleanup(prepared.stop)
        watch = patch.object(mcp_stdio, 'watch_first_call', return_value=False)
        watch.start()
        self.addCleanup(watch.stop)
        adapter = self.registered_adapter()
        await self.start_control(adapter)
        await adapter.handle({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': '2025-06-18', 'capabilities': {'elicitation': {}} if elicitation else {}}})
        self.assertNotIn('error', self.reply(1))
        return parent, adapter, prepare_mock

    def request(self, adapter, code='', *, agent='', prompt='prompt-1', name='js', session='claude-session'):
        message = self.call(name)
        if name == 'js':
            message['params']['arguments'] = {'code': code}
        tool_id = 'toolu-'+str(message['id'])
        self.assertTrue(claude_lifecycle.bind_call(self.state, adapter.claude_owner, {
            'session_id': session, 'agent_id': agent, 'prompt_id': prompt, 'tool_use_id': tool_id,
            'tool_name': 'mcp__cuabar__'+name}))
        message['params']['_meta'] = {'claudecode/toolUseId': tool_id}
        return message

    async def run_tool(self, adapter, code='', **options):
        message = self.request(adapter, code, **options)
        await adapter.handle(message)
        return self.reply(message['id'])

    async def cancel(self, adapter, ident):
        await adapter.handle({'jsonrpc': '2.0', 'method': 'notifications/cancelled', 'params': {'requestId': ident}})

    @staticmethod
    def value(reply):
        return reply['result']['content'][0]['text']

    async def test_an_agent_gets_its_own_lazy_thread_and_reset_cannot_clear_parent_or_sibling_bindings(self):
        parent, adapter, _ = await self.registered()
        self.assertEqual(adapter.agent_children, {})
        self.assertEqual(self.value(await self.run_tool(adapter, 'set:shared=parent')), 'parent')
        child = self.kernel('native-child-A')
        self.assertEqual(self.value(await self.run_tool(adapter, 'set:shared=child', agent='agent-a')), 'child')
        sibling = self.kernel('native-child-B')
        self.assertEqual(self.value(await self.run_tool(adapter, 'set:shared=sibling', agent='agent-b')), 'sibling')
        await self.run_tool(adapter, agent='agent-a', name='js_reset')
        self.assertEqual(child.values, {})
        self.assertEqual(parent.values, {'shared': 'parent'})
        self.assertEqual(sibling.values, {'shared': 'sibling'})
        self.assertEqual(self.value(await self.run_tool(adapter, 'get:shared')), 'parent')
        self.assertEqual(self.value(await self.run_tool(adapter, 'get:shared', agent='agent-a')), 'undefined')
        self.assertEqual(self.value(await self.run_tool(adapter, 'get:shared', agent='agent-b')), 'sibling')
        self.assertEqual([call['tool'] for call in parent.calls].count('js_reset'), 0)
        self.assertEqual([call['tool'] for call in sibling.calls].count('js_reset'), 0)
        self.assertEqual({call['scope']['session_id'] for call in child.calls}, {'native-child-A'})
        self.assertEqual(len(adapter.snapshot()['scopes']), 3)
        self.assertEqual({scope['agent_id'] for scope in adapter.lifecycle_snapshot()}, {'', 'agent-a', 'agent-b'})

    async def test_parallel_calls_of_one_agent_boot_one_child_and_prompts_keep_the_same_kernel(self):
        parent, adapter, _ = await self.registered()
        child = self.kernel('native-one-child')
        held = child.hold('js')
        messages = [self.request(adapter, 'set:x='+str(index), agent='agent-a') for index in range(2)]
        tasks = [asyncio.create_task(adapter.handle(message)) for message in messages]
        await self.settle(lambda: len(child.calls) == 2)
        self.assertEqual(len(child.methods('thread/start')), 1)
        self.assertEqual(parent.calls, [])
        self.assertTrue(adapter.snapshot()['busy'])
        held.set()
        await asyncio.gather(*tasks)
        await self.run_tool(adapter, 'set:later=yes', agent='agent-a', prompt='prompt-2')
        self.assertEqual(child.values['later'], 'yes')
        self.assertEqual(len(child.methods('thread/start')), 1)
        self.assertEqual(len(adapter.agent_children), 1)

    async def test_cancel_while_child_boots_never_sends_the_original_tool_or_cancels_another_waiter(self):
        _, adapter, _ = await self.registered()
        gate = asyncio.Event()
        child = self.kernel('native-delayed-child', start_gate=gate)
        cancelled = self.request(adapter, 'set:must-not-run=yes', agent='agent-a')
        survivor = self.request(adapter, 'set:survivor=yes', agent='agent-a')
        first = asyncio.create_task(adapter.handle(cancelled))
        second = asyncio.create_task(adapter.handle(survivor))
        await self.settle(lambda: len(child.methods('thread/start')) == 1)
        await self.cancel(adapter, cancelled['id'])
        await first
        self.assertIn('before it was sent', self.reply(cancelled['id'])['error']['message'])
        self.assertEqual(child.calls, [])
        self.assertFalse(second.done())
        gate.set()
        await second
        self.assertEqual(child.values, {'survivor': 'yes'})
        self.assertEqual(len(child.calls), 1)
        self.assertEqual(len([reply for reply in self.output if reply.get('id') == cancelled['id']]), 1)

    async def test_end_events_prevent_matching_lazy_calls_from_running_after_the_agent_stopped(self):
        _, adapter, _ = await self.registered()
        gate_a, gate_b = asyncio.Event(), asyncio.Event()
        first = self.kernel('native-delayed-A', start_gate=gate_a)
        second = self.kernel('native-delayed-B', start_gate=gate_b)
        messages = [self.request(adapter, 'set:ran=yes', agent=agent) for agent in ('agent-a', 'agent-b')]
        tasks = [asyncio.create_task(adapter.handle(message)) for message in messages]
        await self.settle(lambda: len(first.methods('thread/start')) == len(second.methods('thread/start')) == 1)
        bound = {'claude_session_id': 'claude-session', 'agent_id': '', 'prompt_id': 'prompt-1'}
        await adapter.end_claude_event({'event': 'Stop', **bound})
        self.assertFalse(any(task.done() for task in tasks), 'a parent Stop does not stop its children')
        # A background child may finish after its parent has accepted another prompt.
        await adapter.end_claude_event({'event': 'SubagentStop', **dict(bound, agent_id='agent-a', prompt_id='prompt-2')})
        await asyncio.wait_for(tasks[0], .3)
        self.assertIn('before it was sent', self.reply(messages[0]['id'])['error']['message'])
        self.assertFalse(tasks[1].done())
        gate_a.set()
        gate_b.set()
        await tasks[1]
        self.assertEqual(first.calls, [])
        self.assertEqual(second.values, {'ran': 'yes'})

    async def test_cancellation_after_boot_is_delivered_only_to_the_matching_child(self):
        parent, adapter, _ = await self.registered()
        child = self.kernel('native-child-A')
        await self.run_tool(adapter, 'set:warm=yes', agent='agent-a')
        agent = adapter.agent_children[('claude-session', 'agent-a')]
        parent_held, child_held = parent.hold('js'), child.hold('js')
        parent_message = self.request(adapter, 'get:parent')
        child_message = self.request(adapter, 'get:child', agent='agent-a')
        parent_call = asyncio.create_task(adapter.handle(parent_message))
        child_call = asyncio.create_task(adapter.handle(child_message))
        await self.settle(lambda: len(parent.calls) == 1 and len(child.calls) == 2)
        accepted = AsyncMock(return_value={'cancelled': True, 'reason': None})
        with patch.object(agent, 'cancel_native_request', accepted):
            await self.cancel(adapter, child_message['id'])
            await child_call
        self.assertEqual(accepted.await_count, 1)
        self.assertFalse(parent_call.done())
        self.assertTrue(adapter.snapshot()['busy'], 'the parent remains active')
        self.assertEqual(self.reply(child_message['id'])['error']['code'], -32800)
        parent_held.set()
        child_held.set()
        await parent_call
        self.assertNotIn('error', self.reply(parent_message['id']))
        self.assertEqual(sum(agent.claude_lifecycle.inflight.values()), 0)

    async def test_end_events_and_manual_release_select_only_owned_scopes_across_the_family(self):
        parent, adapter, _ = await self.registered()
        first, second = self.kernel('native-child-A'), self.kernel('native-child-B')
        await self.run_tool(adapter, 'set:p=yes')
        await self.run_tool(adapter, 'set:a=yes', agent='agent-a')
        await self.run_tool(adapter, 'set:b=yes', agent='agent-b')
        base = {'claude_session_id': 'claude-session', 'agent_id': '', 'prompt_id': 'prompt-1'}
        self.assertEqual((await adapter.end_claude_event({'event': 'Stop', **base}))['scope_count'], 1)
        self.assertEqual((len(parent.turn_ended_calls()), len(first.turn_ended_calls()), len(second.turn_ended_calls())), (1, 0, 0))
        self.assertEqual((await adapter.end_claude_event({'event': 'SubagentStop', **dict(base, agent_id='agent-a')}))['scope_count'], 1)
        self.assertEqual(len(second.turn_ended_calls()), 0)
        self.assertEqual({scope['agent_id'] for scope in adapter.lifecycle_snapshot()}, {'agent-b'})
        self.assertEqual((await adapter.end_claude_event({'event': 'SessionEnd', **base}))['scope_count'], 1)
        self.assertEqual(adapter.snapshot()['scopes'], [])
        await self.run_tool(adapter, 'get:a', agent='agent-a', prompt='prompt-2')
        await self.run_tool(adapter, 'get:b', agent='agent-b', prompt='prompt-2')
        released = await adapter.release_scopes(wait=.1, budget=1)
        self.assertEqual((released['released'], released['scope_count']), (True, 2))
        self.assertEqual(adapter.snapshot()['cleanup'], 'none')

    async def test_close_releases_and_unsubscribes_every_owned_thread_and_never_contacts_an_unrelated_host(self):
        parent, adapter, prepared = await self.registered()
        first, second = self.kernel('native-child-A'), self.kernel('native-child-B')
        unrelated = self.kernel('unrelated-thread')
        for agent in ('', 'agent-a', 'agent-b'):
            await self.run_tool(adapter, 'set:x=yes', agent=agent)
        before = prepared.call_count
        report = await adapter.close()
        self.assertEqual(report, {'owned_thread_unsubscribe': 'confirmed', 'connection_close': 'confirmed'})
        self.assertEqual(prepared.call_count, before, 'close never opens Codex or a new thread')
        for host in (parent, first, second):
            self.assertEqual(len(host.turn_ended_calls()), 1)
            self.assertEqual(host.methods('thread/unsubscribe')[0]['params'], {'threadId': host.thread_id})
            self.assertTrue(host.was_closed)
        self.assertEqual(unrelated.received, [])
        self.assertEqual(await adapter.close(), report)
        self.assertEqual([len(host.methods('thread/unsubscribe')) for host in (parent, first, second)], [1, 1, 1])

    async def test_child_approval_requests_have_distinct_client_ids_and_answers_reach_the_correct_host(self):
        _, adapter, _ = await self.registered(elicitation=True)
        first, second = self.kernel('native-child-A'), self.kernel('native-child-B')
        messages = [self.request(adapter, 'ask', agent=agent) for agent in ('agent-a', 'agent-b')]
        tasks = [asyncio.create_task(adapter.handle(message)) for message in messages]
        await self.settle(lambda: len([message for message in self.output if message.get('method') == 'elicitation/create']) == 2)
        prompts = [message for message in self.output if message.get('method') == 'elicitation/create']
        self.assertNotEqual(prompts[0]['id'], prompts[1]['id'])
        by_message = {message['params']['message']: message['id'] for message in prompts}
        first_id = by_message['Allow native-child-A?']
        # An invalid response must not discard the mapping needed to send a valid answer next.
        await adapter.handle({'jsonrpc': '2.0', 'id': first_id, 'result': {'action': 'invalid'}})
        self.assertEqual(first.approval_answers, [])
        await adapter.handle({'jsonrpc': '2.0', 'id': first_id, 'result': {'action': 'accept'}})
        self.assertEqual(second.approval_answers, [])
        await adapter.handle({'jsonrpc': '2.0', 'id': by_message['Allow native-child-B?'], 'result': {'action': 'decline'}})
        await asyncio.gather(*tasks)
        self.assertEqual(first.approval_answers[0]['result']['action'], 'accept')
        self.assertEqual(second.approval_answers[0]['result']['action'], 'decline')
        self.assertEqual(adapter.agent_approvals, {})

    async def test_close_cancels_pending_child_boot_without_sending_its_original_tool(self):
        _, adapter, prepared = await self.registered()
        child = self.kernel('native-pending-child', start_gate=asyncio.Event())
        message = self.request(adapter, 'set:must-not-run=yes', agent='agent-a')
        task = asyncio.create_task(adapter.handle(message))
        await self.settle(lambda: len(child.methods('thread/start')) == 1)
        before = prepared.call_count
        await asyncio.wait_for(adapter.close(), 3)
        await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(child.calls, [])
        self.assertEqual(prepared.call_count, before)
        self.assertTrue(child.was_closed)

    async def test_manual_turn_end_does_not_accept_caller_native_ids_on_a_child(self):
        _, adapter, _ = await self.registered()
        child = self.kernel('native-child-A')
        message = self.request(adapter, agent='agent-a', name='turn_ended')
        message['params']['arguments'] = {'session_id': 'not-owned', 'turn_id': 'not-owned'}
        await adapter.handle(message)
        self.assertEqual(self.reply(message['id'])['error']['code'], -32602)
        self.assertEqual(child.calls, [])
