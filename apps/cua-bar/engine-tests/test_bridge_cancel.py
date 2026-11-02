"""Cancellation uses only fake hosts and temporary private relay endpoints; no real CUA process is touched."""
import asyncio
import copy
import json
import os
import time
import uuid

from bridge_case import BridgeCase
import bridge_cancel
import host_mcp


OWNER = 'bridge-4242-1792345678'
HOST_PID = 8484


class CancellationTests(BridgeCase):
    async def relay(self, *, owner=OWNER, host_pid=HOST_PID, capability=True, before_reply=None, responses=None):
        root = self.state/'relays'
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.state, 0o700)
        folder = root/('relay-'+str(len(list(root.iterdir()))))
        folder.mkdir(mode=0o700)
        socket = folder/'control.sock'
        requests = []

        async def handle(reader, writer):
            try:
                request = json.loads(await reader.readuntil(b'\n'))
                requests.append(request)
                if before_reply is not None:
                    await before_reply.wait()
                response = (responses[min(len(requests)-1, len(responses)-1)] if responses
                            else {'cancelled': True, 'reason': None})
                writer.write((json.dumps(response)+'\n').encode())
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_unix_server(handle, path=str(socket))
        self.addAsyncCleanup(server.wait_closed)
        self.addCleanup(server.close)
        os.chmod(socket, 0o600)
        record = {'schema_version': 1, 'kind': 'relay', 'owner': owner, 'app_server_pid': host_pid,
                  'pid': os.getpid(), 'started_at': int(time.time()), 'control_path': str(socket),
                  'cancel_by_request_token': capability}
        path = folder/'relay.json'
        path.write_text(json.dumps(record))
        os.chmod(path, 0o600)
        return requests, record, folder

    async def adapter(self, host, relay=True):
        adapter = self.plain_adapter()
        await self.initialize(adapter)
        adapter.host = {'pid': HOST_PID, 'relay': relay}
        adapter.owner = OWNER
        adapter.control_state = self.state
        return adapter

    async def cancel(self, adapter, ident):
        await adapter.handle({'jsonrpc': '2.0', 'method': 'notifications/cancelled',
                              'params': {'requestId': ident, 'reason': 'PRIVATE_CLIENT_REASON'}})

    def replies(self, ident):
        return [reply for reply in self.output if reply.get('id') == ident]

    async def test_cancellation_before_send_never_calls_the_host(self):
        host = self.add_host()
        adapter = await self.adapter(host)
        await adapter.turn_lock.acquire()
        try:
            message = self.call()
            task = asyncio.create_task(adapter.handle(message))
            await self.settle(lambda: len(adapter.client_calls) == 1)
            await self.cancel(adapter, message['id'])
            await task
            self.assertEqual(self.reply(message['id'])['error']['message'], host_mcp.CANCEL_BEFORE_SEND)
            self.assertEqual(host.calls, [])
            self.assertEqual((adapter.active_tool_calls, adapter.scopes, adapter.client_calls), (0, {}, {}))
        finally:
            adapter.turn_lock.release()

    async def test_only_the_matching_request_token_is_notified_and_it_gets_one_client_response(self):
        host = self.add_host()
        held = host.hold('js')
        adapter = await self.adapter(host)
        requests, record, _ = await self.relay()
        messages = [self.call(), self.call()]
        tasks = [asyncio.create_task(adapter.handle(message)) for message in messages]
        await self.settle(lambda: len(host.calls) == 2)
        await self.cancel(adapter, str(messages[0]['id']))   # a string ID is not the numeric request ID
        self.assertEqual(requests, [])
        await self.cancel(adapter, messages[0]['id'])
        await tasks[0]
        self.assertFalse(tasks[1].done(), 'the other client request still waits for its original host result')
        self.assertEqual(adapter.active_tool_calls, 1)
        sent = host.methods('mcpServer/tool/call')
        tokens = [entry['params']['_meta'][bridge_cancel.TOKEN_META] for entry in sent]
        self.assertNotEqual(*tokens)
        self.assertEqual(requests, [{'action': 'cancel', 'pid': record['pid'], 'started_at': record['started_at'],
                                     'owner': OWNER, 'request_token': tokens[0]}])
        self.assertEqual(self.reply(messages[0]['id'])['error']['message'], host_mcp.CANCEL_SENT)
        self.assertTrue(adapter.cleanup_unconfirmed)
        self.assertEqual(len(self.replies(messages[0]['id'])), 1)
        # Both a repeated cancellation and the original host's late answer are harmless.
        await self.cancel(adapter, messages[0]['id'])
        host.emit({'id': sent[0]['id'], 'result': {'content': [{'type': 'text', 'text': 'late'}]}})
        held.set()
        await tasks[1]
        await asyncio.sleep(0)
        self.assertEqual(len(self.replies(messages[0]['id'])), 1)
        self.assertNotIn('error', self.reply(messages[1]['id']))
        self.assertEqual(len(requests), 1)
        self.assertFalse(any(entry.get('method') in ('turn/interrupt', 'thread/unload') for entry in host.received))
        self.assertFalse(any(call['tool'] == 'js_reset' for call in host.calls))

    async def test_without_a_verified_relay_cancellation_is_honest_and_the_native_call_stays_tracked(self):
        host = self.add_host()
        held = host.hold('js')
        adapter = await self.adapter(host, relay=False)
        message = self.call()
        task = asyncio.create_task(adapter.handle(message))
        await self.settle(lambda: len(host.calls) == 1)
        await self.cancel(adapter, message['id'])
        self.assertEqual(self.reply(message['id'])['error']['message'], host_mcp.CANCEL_UNAVAILABLE)
        self.assertFalse(task.done())
        self.assertEqual(adapter.active_tool_calls, 1)
        self.assertNotIn(bridge_cancel.TOKEN_META, host.methods('mcpServer/tool/call')[0]['params']['_meta'])
        held.set()
        await task
        self.assertEqual(len(self.replies(message['id'])), 1)
        self.assertEqual(adapter.active_tool_calls, 0)

    async def test_a_completed_result_wins_a_race_with_the_cancel_control_answer(self):
        host = self.add_host()
        held = host.hold('js')
        adapter = await self.adapter(host)
        gate = asyncio.Event()
        requests, _, _ = await self.relay(before_reply=gate)
        message = self.call()
        task = asyncio.create_task(adapter.handle(message))
        await self.settle(lambda: len(host.calls) == 1)
        cancellation = asyncio.create_task(self.cancel(adapter, message['id']))
        await self.settle(lambda: len(requests) == 1)
        held.set()
        await task
        gate.set()
        await cancellation
        self.assertNotIn('error', self.reply(message['id']))
        self.assertEqual(len(self.replies(message['id'])), 1)

    async def test_late_unknown_or_invalid_cancellation_does_nothing(self):
        host = self.add_host()
        adapter = await self.adapter(host)
        requests, _, _ = await self.relay()
        message = self.call()
        await adapter.handle(message)
        before = copy.deepcopy(self.output)
        for ident in (message['id'], 99999, True, None, {}, []):
            await self.cancel(adapter, ident)
        self.assertEqual(self.output, before)
        self.assertEqual(requests, [])

    async def test_a_duplicate_active_request_does_not_run_twice_or_replace_the_cancel_target(self):
        host = self.add_host()
        held = host.hold('js')
        adapter = await self.adapter(host)
        await self.relay()
        message = self.call()
        task = asyncio.create_task(adapter.handle(message))
        await self.settle(lambda: len(host.calls) == 1)
        await adapter.handle(message)
        self.assertEqual(len(host.calls), 1)
        await self.cancel(adapter, message['id'])
        await task
        held.set()
        self.assertEqual(len(self.replies(message['id'])), 1)

    async def test_routing_refuses_other_owners_hosts_old_relays_and_public_or_aliased_endpoints(self):
        token = str(uuid.uuid4())
        for options, change in (
                ({'owner': 'bridge-99-1234'}, None), ({'host_pid': HOST_PID+1}, None),
                ({'capability': False}, None), ({}, 'public_record'), ({}, 'aliased_socket')):
            requests, _, folder = await self.relay(**options)
            if change == 'public_record':
                os.chmod(folder/'relay.json', 0o644)
            elif change == 'aliased_socket':
                socket = folder/'control.sock'
                socket.rename(folder/'actual.sock')
                socket.symlink_to(folder/'actual.sock')
            self.assertEqual((await bridge_cancel.cancel_request(OWNER, HOST_PID, token, self.state))['cancelled'], False)
            self.assertEqual(requests, [])

    async def test_cancellation_can_arrive_before_the_native_call_and_only_the_cancel_is_repeated(self):
        requests, _, _ = await self.relay(responses=[{'cancelled': False, 'reason': 'not_found'},
                                                   {'cancelled': True, 'reason': None}])
        token = str(uuid.uuid4())
        self.assertEqual(await bridge_cancel.cancel_request(OWNER, HOST_PID, token, self.state),
                         {'cancelled': True, 'reason': None})
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0], requests[1])
        self.assertEqual(requests[0]['action'], 'cancel')
        self.assertEqual(requests[0]['request_token'], token)

    async def test_a_duplicate_native_cancel_is_already_notified_and_not_reported_as_unavailable(self):
        requests, _, _ = await self.relay(responses=[{'cancelled': False, 'reason': 'already_cancelled'}])
        self.assertEqual(await bridge_cancel.cancel_request(OWNER, HOST_PID, str(uuid.uuid4()), self.state),
                         {'cancelled': True, 'reason': None})
        self.assertEqual(len(requests), 1)

    async def test_waiting_for_a_token_is_bounded_when_the_original_request_never_reaches_the_relay(self):
        await self.relay(responses=[{'cancelled': False, 'reason': 'not_found'}])
        started = asyncio.get_running_loop().time()
        self.assertEqual(await bridge_cancel.cancel_request(OWNER, HOST_PID, str(uuid.uuid4()), self.state, timeout=0.05),
                         {'cancelled': False, 'reason': 'not_found'})
        self.assertLess(asyncio.get_running_loop().time()-started, 0.3)

    async def test_lifecycle_tool_is_a_visible_manual_fallback_without_losing_other_native_metadata(self):
        host = self.add_host()
        host.tools['turn_ended']['_meta'] = {'original': {'nested': [1]}, 'ui': {'visibility': [], 'resourceUri': 'PRIVATE_URI'}}
        host.tools['turn_ended']['annotations'] = {'idempotentHint': True}
        original = copy.deepcopy(host.tools['turn_ended'])
        adapter = await self.adapter(host)
        await adapter.handle({'jsonrpc': '2.0', 'id': 900, 'method': 'tools/list', 'params': {}})
        tool = next(tool for tool in self.reply(900)['result']['tools'] if tool['name'] == 'turn_ended')
        self.assertEqual(tool['_meta'], {'original': {'nested': [1]}, 'ui': {'visibility': ['model'], 'resourceUri': 'PRIVATE_URI'}})
        self.assertEqual(tool['annotations'], original['annotations'])
        self.assertEqual(host.tools['turn_ended'], original)
