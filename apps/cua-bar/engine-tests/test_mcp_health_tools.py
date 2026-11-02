"""Health calls stay local, and update notes never alter native output or replay actions."""
import copy
import unittest
from unittest.mock import AsyncMock, patch

import test_host_mcp as fixtures

bridge = fixtures.bridge


class HealthToolRoutingTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixtures.AdapterTests.asyncSetUp
    asyncTearDown = fixtures.AdapterTests.asyncTearDown
    fixture = fixtures.AdapterTests.fixture
    initialize = fixtures.AdapterTests.initialize

    async def test_health_tools_are_advertised_and_status_never_reconnects_a_lost_host(self):
        adapter, proxy, output, _, _ = self.fixture()
        await self.initialize(adapter)
        self.assertIn('status', adapter.tool_names)
        self.assertIn('repair', adapter.tool_names)
        before = len(proxy.received)
        adapter.ready = False
        with patch.object(adapter, 'ensure_connected', new=AsyncMock(side_effect=AssertionError('not local'))), \
                patch('mcp_health.read_health', return_value={'runtime': {'reconnect_required': True}}):
            await adapter.handle({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
                                  'params': {'name': 'status', 'arguments': {}}})
        self.assertEqual(output[-1]['result']['structuredContent']['runtime']['reconnect_required'], True)
        self.assertEqual(len(proxy.received), before)
        self.assertEqual(adapter.scopes, {})

    async def test_repair_is_the_local_targeted_helper_and_never_a_native_tool(self):
        adapter, proxy, output, _, _ = self.fixture()
        await self.initialize(adapter)
        before = len(proxy.received)
        repair = AsyncMock(return_value={'repaired': True, 'runtime': {'reconnect_required': True}})
        with patch('mcp_health.repair_health', new=repair):
            await adapter.handle({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
                                  'params': {'name': 'repair', 'arguments': {}}})
        repair.assert_awaited_once_with(adapter)
        self.assertTrue(output[-1]['result']['structuredContent']['runtime']['reconnect_required'])
        self.assertEqual(len(proxy.received), before)

    async def test_health_tools_reject_all_caller_arguments(self):
        adapter, proxy, output, _, _ = self.fixture()
        await self.initialize(adapter)
        before = len(proxy.received)
        for name in ('status', 'repair'):
            await adapter.handle({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
                                  'params': {'name': name, 'arguments': {'path': '/somewhere'}}})
            self.assertEqual(output[-1]['error']['code'], -32602)
        self.assertEqual(len(proxy.received), before)

    async def test_native_health_name_collisions_are_rejected_without_calling_that_tool(self):
        tools = {**fixtures.TOOLS, 'status': {'name': 'status', 'inputSchema': {'type': 'object'}}}
        adapter, proxy, output, _, _ = self.fixture(tools=tools)
        await self.initialize(adapter)
        self.assertIn('conflicts with CUA Bar local health tools', output[-1]['error']['message'])
        self.assertFalse(adapter.initialized)
        self.assertFalse(any(message.get('method') == 'mcpServer/tool/call' for message in proxy.received))


class RuntimeReplyTests(unittest.TestCase):
    def test_unreadable_installation_or_internal_probe_preserves_the_native_result(self):
        answer = {'content': [{'type': 'text', 'text': 'native success'}]}
        with patch.object(bridge, 'installed_identity', side_effect=AssertionError('unavailable')) as inspect:
            self.assertIs(bridge.with_runtime_note('js', answer), answer)
            inspect.reset_mock()
            self.assertIs(bridge.with_runtime_note('js', answer, enabled=False), answer)
            inspect.assert_not_called()

    def test_same_version_content_change_adds_an_update_note_and_preserves_native_blocks(self):
        answer = {'content': [{'type': 'text', 'text': 'done'}, {'type': 'image', 'data': 'original'}],
                  'isError': True, '_meta': {'native': True}, 'structuredContent': {'native': 'result'}}
        original = copy.deepcopy(answer)
        with patch.object(bridge, 'RUNNING_IDENTITY', {'version': '1.2.3', 'revision': 'a' * 64}), \
                patch.object(bridge, 'installed_identity', return_value={'version': '1.2.3', 'revision': 'b' * 64}):
            result = bridge.with_runtime_note('js', answer)
        self.assertEqual(answer, original)
        self.assertEqual(result['content'][:-1], original['content'])
        self.assertEqual({key: value for key, value in result.items() if key != 'content'},
                         {key: value for key, value in original.items() if key != 'content'})
        self.assertIn('reconnect cuabar in /mcp', result['content'][-1]['text'])

    def test_rpc_errors_keep_the_original_code_and_lifecycle_results_get_no_update_note(self):
        error = {'code': -1234, 'message': 'native refusal', 'data': {'native': True}}
        with patch.object(bridge, 'RUNNING_IDENTITY', {'version': '1.0.0', 'revision': 'a' * 64}), \
                patch.object(bridge, 'installed_identity', return_value={'version': '2.0.0', 'revision': 'b' * 64}):
            result = bridge.with_runtime_note('js', error)
            self.assertEqual(bridge.with_runtime_note('turn_ended', error), error)
        self.assertEqual(result['code'], error['code'])
        self.assertEqual(result['data'], error['data'])
        self.assertTrue(result['message'].startswith('native refusal\n\nCUA Bar update:'))

    def test_verified_current_runtime_is_not_noisy(self):
        answer = {'content': [{'type': 'text', 'text': 'done'}]}
        current = {'version': '1.0.0', 'revision': 'a' * 64}
        with patch.object(bridge, 'RUNNING_IDENTITY', current), \
                patch.object(bridge, 'installed_identity', return_value=current):
            self.assertIs(bridge.with_runtime_note('js', answer), answer)
