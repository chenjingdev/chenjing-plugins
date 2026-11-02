"""Updates drain only this MCP's work and preserve the result of an action already sent."""
import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from bridge_update import UpdateWatch
import test_host_mcp as fixtures

RUNNING = {'version': '0.8.18', 'revision': 'a' * 64}
NEW = {'version': '0.8.19', 'revision': 'b' * 64}


class UpdateWatchTests(unittest.IsolatedAsyncioTestCase):
    def watch(self, installed=NEW, running=RUNNING):
        self.adapter = SimpleNamespace(mark_update_pending=Mock(), log=Mock(),
                                       snapshot=Mock(return_value={'busy': False}), initializing=False,
                                       active_tool_calls=0, agent_children={}, agent_boots={})
        self.stopped = asyncio.Event()
        self.pending = False
        return UpdateWatch(self.adapter, self.stopped, lambda: self.pending, home='/temporary-home',
                           interval=0.001, running=running, read_installed=Mock(return_value=installed))

    async def test_verified_update_marks_pending_then_closes_only_after_all_request_tasks_finish(self):
        watch = self.watch()
        self.pending = True
        task = asyncio.create_task(watch.run())
        await asyncio.sleep(0.01)
        self.adapter.mark_update_pending.assert_called_once_with()
        self.assertFalse(self.stopped.is_set())
        self.pending = False
        await asyncio.wait_for(task, 1)
        self.assertTrue(self.stopped.is_set())

    async def test_idle_verified_update_requests_normal_serve_shutdown(self):
        watch = self.watch()
        await watch.run()
        self.assertTrue(self.stopped.is_set())
        self.adapter.mark_update_pending.assert_called_once_with()

    async def test_unknown_current_and_temporarily_unreadable_identities_never_disconnect(self):
        for installed, running in ((RUNNING, RUNNING), ({'version': None, 'revision': None}, RUNNING),
                                   (NEW, {'version': '0.8.18', 'revision': None}),
                                   (dict(NEW, revision='unverified'), RUNNING)):
            with self.subTest(installed=installed, running=running):
                watch = self.watch(installed, running)
                self.assertFalse(watch.check())
                self.adapter.mark_update_pending.assert_not_called()
                self.assertFalse(self.stopped.is_set())
        watch = self.watch()
        watch.read_installed.side_effect = OSError('installation switch in progress')
        self.assertFalse(watch.check())
        self.adapter.mark_update_pending.assert_not_called()

    async def test_background_child_initialization_and_native_busy_state_are_drained(self):
        watch = self.watch()
        boot = asyncio.create_task(asyncio.sleep(60))
        child = SimpleNamespace(initializing=True, active_tool_calls=0, agent_boots={}, agent_children={})
        self.adapter.agent_children = {'agent': child}
        self.adapter.agent_boots = {'agent': boot}
        self.assertFalse(watch.drained())
        child.initializing = False
        self.assertFalse(watch.drained())
        boot.cancel()
        await asyncio.gather(boot, return_exceptions=True)
        self.adapter.snapshot.return_value = {'busy': True}
        self.assertFalse(watch.drained())
        self.adapter.snapshot.return_value = {'busy': False}
        self.assertTrue(watch.drained())

    async def test_same_version_changed_content_is_also_an_update(self):
        watch = self.watch(dict(RUNNING, revision='b' * 64))
        self.assertTrue(watch.check())
        self.adapter.mark_update_pending.assert_called_once_with()


class UpdateRequestTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixtures.AdapterTests.asyncSetUp
    asyncTearDown = fixtures.AdapterTests.asyncTearDown
    fixture = fixtures.AdapterTests.fixture
    initialize = fixtures.AdapterTests.initialize

    async def test_pending_update_rejects_new_screen_actions_but_does_not_cancel_the_sent_action(self):
        adapter, proxy, output, _, _ = self.fixture()
        await self.initialize(adapter)
        gate = asyncio.Event()
        original = proxy.answer
        async def held(message):
            if message.get('method') == 'mcpServer/tool/call' and message.get('params', {}).get('tool') == 'js':
                await gate.wait()
            await original(message)
        proxy.answer = held
        first = asyncio.create_task(adapter.handle({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
            'params': {'name': 'js', 'arguments': {'code': 'ONE_ACTION'}}}))
        for _ in range(100):
            if adapter.active_tool_calls:
                break
            await asyncio.sleep(0.001)
        self.assertEqual(adapter.active_tool_calls, 1)
        adapter.mark_update_pending()
        await adapter.handle({'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call',
                              'params': {'name': 'js_reset', 'arguments': {}}})
        blocked = next(item for item in output if item.get('id') == 3)
        self.assertEqual(blocked['error']['code'], -32004)
        self.assertIn('/mcp reconnect cuabar', blocked['error']['message'])
        self.assertFalse(first.done())
        self.assertEqual(adapter.active_tool_calls, 1)
        gate.set()
        await first
        self.assertEqual(next(item for item in output if item.get('id') == 2)['result'], proxy.result)
        calls = [item['params']['tool'] for item in proxy.received if item.get('method') == 'mcpServer/tool/call']
        self.assertEqual(calls, ['js'])
        self.assertFalse(any(item.get('method') == 'notifications/cancelled' for item in proxy.received))

    async def test_request_queued_at_the_turn_lock_does_not_run_after_update_is_marked(self):
        adapter, proxy, output, _, _ = self.fixture()
        await self.initialize(adapter)
        await adapter.turn_lock.acquire()
        call = asyncio.create_task(adapter.handle({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
            'params': {'name': 'js', 'arguments': {'code': 'UNSENT_ACTION'}}}))
        await asyncio.sleep(0)
        adapter.mark_update_pending()
        adapter.turn_lock.release()
        await call
        self.assertIn('not sent', output[-1]['error']['message'])
        self.assertFalse(any(item.get('method') == 'mcpServer/tool/call' for item in proxy.received))

    async def test_new_call_after_initialization_is_blocked_before_native_rpc(self):
        adapter, proxy, output, _, _ = self.fixture()
        await self.initialize(adapter)
        self.assertNotIn('error', output[-1])
        adapter.mark_update_pending()
        await adapter.handle({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
                              'params': {'name': 'js', 'arguments': {'code': 'UNSENT_ACTION'}}})
        self.assertEqual(output[-1]['error']['code'], -32004)
        self.assertFalse(any(item.get('method') == 'mcpServer/tool/call' for item in proxy.received))
