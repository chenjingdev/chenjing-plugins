"""No live Codex process, native app, browser, socket connection or credential."""
import asyncio
import copy
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

PLUGIN_ROOT = Path(__file__).resolve().parents[2] / 'plugins/cua'
spec = importlib.util.spec_from_file_location('host_mcp', PLUGIN_ROOT / 'host_mcp.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

TOOLS = {
    'js': {'name': 'js', 'description': 'Original CUA instructions',
           'inputSchema': {'type': 'object', 'properties': {'code': {'type': 'string'}}},
           'annotations': {'readOnlyHint': False}, '_meta': {'original': True}},
    'js_reset': {'name': 'js_reset', 'inputSchema': {'type': 'object'}},
    'turn_ended': {'name': 'turn_ended', 'description': 'Native lifecycle scope is required.',
                   'inputSchema': {'type': 'object', 'properties': {
                       'hook_event_name': {'type': 'string'}, 'session_id': {'type': 'string'},
                       'turn_id': {'type': 'string'}},
                       'required': ['hook_event_name', 'session_id', 'turn_id']},
                   'outputSchema': {'type': 'object'},
                   'annotations': {'readOnlyHint': False}, '_meta': {'original': True}},
}
HOST_THREAD = 'host-issued-owned-thread'


class FakeProxy:
    def __init__(self, *, mode='normal', tools=None, result=None, unsubscribe=None, states=None,
                 plugin_id=bridge.NATIVE_PLUGIN_ID, installed=None, config=None):
        self.mode = mode
        # What plugin/installed and config/read answer: by default nothing to turn off in the owned thread.
        self.installed = {'marketplaces': []} if installed is None else installed
        self.config = {} if config is None else config
        self.tools = copy.deepcopy(TOOLS if tools is None else tools)
        self.result = copy.deepcopy(result if result is not None else {'content': [{'type': 'text', 'text': 'fixture'}]})
        self.unsubscribe = {'status': 'unsubscribed'} if unsubscribe is None else unsubscribe
        self.states = list(states or ['connected'])
        self.plugin_id = plugin_id
        self.incoming = asyncio.Queue()
        self.was_closed = False
        self.received, self.tasks = [], set()
        self.approval_answer = asyncio.get_running_loop().create_future()

    async def send(self, raw):
        if self.was_closed:
            raise ConnectionError('PRIVATE_CONNECTION_ERROR')
        message = json.loads(raw)
        self.received.append(message)
        task = asyncio.create_task(self.answer(message))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        await asyncio.sleep(0)

    def __aiter__(self):
        return self

    async def __anext__(self):
        value = await self.incoming.get()
        if value is None:
            raise StopAsyncIteration
        return value

    def emit(self, message):
        if not self.was_closed:
            self.incoming.put_nowait(json.dumps(message))

    def finish(self):
        if self.was_closed:
            return
        self.was_closed = True
        self.incoming.put_nowait(None)
        for task in list(self.tasks):
            if not task.done() and task is not asyncio.current_task():
                task.cancel()

    async def close(self):
        self.finish()

    async def answer(self, message):
        method, ident = message.get('method'), message.get('id')
        if method is None:
            if ident == 'native-approval' and not self.approval_answer.done():
                self.approval_answer.set_result(message)
            return
        if method == 'initialize':
            if self.mode == 'disconnect':
                self.finish()
                return
            result = {'userAgent': 'fixture', 'codexHome': '/fixture/codex-home', 'platformFamily': 'unix', 'platformOs': 'macos'}
            if self.mode == 'invalid_initialize':
                result = {}
        elif method == 'initialized':
            return
        elif method == 'thread/start':
            if self.mode == 'refuse_config' and 'config' in message['params']:
                self.emit({'id': ident, 'error': {'code': -32602, 'message': 'PRIVATE_UNKNOWN_KEY'}})
                return
            result = {'thread': {'id': HOST_THREAD, 'ephemeral': self.mode != 'not_ephemeral'}}
        elif method == 'mcpServerStatus/list':
            state = self.states.pop(0) if len(self.states) > 1 else self.states[0]
            result = {'data': [{'name': 'cua_repl', 'pluginId': self.plugin_id, 'runtimeStatus': state, 'tools': self.tools, 'toolsError': None}], 'nextCursor': None}
            if self.mode == 'missing_catalogue':
                result = {'data': [], 'nextCursor': None}
        elif method == 'mcpServer/tool/call':
            if self.mode == 'rpc_error':
                self.emit({'id': ident, 'error': {'code': -32000, 'message': 'PRIVATE_NATIVE_ERROR', 'data': {'original': [1, 2]}}})
                return
            if self.mode == 'approval':
                self.emit({'id': 'native-approval', 'method': 'mcpServer/elicitation/request', 'params': {
                    'threadId': HOST_THREAD, 'turnId': None, 'serverName': 'cua_repl', 'mode': 'form',
                    'message': 'PRIVATE_ORIGINAL_APPROVAL', 'requestedSchema': {'type': 'object', 'properties': {}},
                    '_meta': {'native': 'PRIVATE_APPROVAL_META'}}})
                await self.approval_answer
            result = self.result
        elif method == 'thread/unsubscribe':
            result = self.unsubscribe
        elif method == 'plugin/installed':
            if self.mode == 'no_plugin_list':
                self.emit({'id': ident, 'error': {'code': -32601, 'message': 'PRIVATE_NO_METHOD'}})
                return
            result = self.installed
        elif method == 'config/read':
            result = {'config': self.config, 'origins': {}}
        else:
            raise AssertionError('Unexpected method in mock: ' + str(method))
        self.emit({'id': ident, 'result': result})


INSTALLED = {'marketplaces': [
    {'name': 'openai-bundled', 'plugins': [{'id': bridge.NATIVE_PLUGIN_ID, 'enabled': True},
                                           {'id': 'browser-use@openai-bundled', 'enabled': True}]},
    {'name': 'team', 'plugins': [{'id': 'team-memory@team', 'enabled': True}, {'id': 'off@team', 'enabled': False},
                                 {'id': 'odd.name@team', 'enabled': True}, {'enabled': True}, 'junk']},
    'junk']}
CONFIGURED = {'mcp_servers': {'honcho': {'command': 'honcho'}, 'cua_repl': {'command': 'cua'},
                              'paused': {'command': 'p', 'enabled': False}, 'has space': {'command': 's'}}}


class QuietConfigTests(unittest.TestCase):
    def test_every_other_enabled_plugin_and_configured_server_is_turned_off(self):
        self.assertEqual(bridge.quiet_config(INSTALLED, {'config': CONFIGURED}), {
            'plugins.browser-use@openai-bundled.enabled': False, 'plugins.team-memory@team.enabled': False,
            'mcp_servers.honcho.enabled': False})

    def test_answers_that_are_missing_or_malformed_turn_nothing_off(self):
        for installed, config in ((None, None), ({}, {}), ({'marketplaces': 'x'}, {'config': {'mcp_servers': []}}),
                                  ([], 'x')):
            self.assertEqual(bridge.quiet_config(installed, config), {})


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.stacks, self.adapters = [], []

    async def asyncTearDown(self):
        for adapter in self.adapters:
            await adapter.close()
        for stack in reversed(self.stacks):
            stack.close()

    def fixture(self, **options):
        proxy = FakeProxy(**options)
        stack = ExitStack()
        stack.enter_context(patch.object(Path, 'stat', new=lambda path: SimpleNamespace(
            st_mode=(stat.S_IFSOCK | 0o600) if path.suffix == '.sock' else (stat.S_IFDIR | 0o700), st_uid=os.getuid())))
        stack.enter_context(patch.object(Path, 'lstat', new=lambda path: SimpleNamespace(
            st_mode=(stat.S_IFREG | 0o700) if path.suffix == '.mjs' else (stat.S_IFSOCK | 0o600), st_uid=os.getuid())))
        stack.enter_context(patch.object(Path, 'resolve', new=lambda path, strict=False: path))
        spawn = stack.enter_context(patch.object(bridge, 'unix_connect', new=AsyncMock(return_value=proxy)))
        stack.enter_context(patch.object(bridge.asyncio, 'create_subprocess_exec', side_effect=AssertionError('No subprocess is permitted')))
        output, logs = [], []
        adapter = bridge.HostMcp(Path('/fixture/codex'), Path('/fixture/existing-host.sock'),
            emit=output.append, log=logs.append, startup_timeout=0.3, cleanup_timeout=0.2)
        self.stacks.append(stack)
        self.adapters.append(adapter)
        return adapter, proxy, output, logs, spawn

    async def initialize(self, adapter):
        await adapter.handle({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': '2025-06-18', 'capabilities': {'elicitation': {}}}})

    def call(self, ident=3, name='js', **extra):
        return {'jsonrpc': '2.0', 'id': ident, 'method': 'tools/call',
                'params': {'name': name, 'arguments': {'code': 'PRIVATE_SCRIPT'}, **extra}}

    async def settle(self, predicate):
        for _ in range(100):
            if predicate():
                return
            await asyncio.sleep(0.001)
        self.fail('Mock did not reach expected state')

    async def test_only_private_unix_websocket_connects_and_owned_thread_uses_host_defaults(self):
        adapter, proxy, output, logs, spawn = self.fixture()
        await self.initialize(adapter)
        self.assertNotIn('error', output[-1])
        self.assertEqual(spawn.call_count, 1)
        self.assertEqual(spawn.call_args.kwargs, {'path': '/fixture/existing-host.sock',
            'uri': 'ws://localhost/rpc', 'max_size': None, 'open_timeout': 0.3, 'ping_interval': None,
            'logger': bridge._WS_LOGGER})
        self.assertTrue(bridge._WS_LOGGER.disabled)
        start = next(m for m in proxy.received if m.get('method') == 'thread/start')
        self.assertEqual(start['params'], {'ephemeral': True, 'cwd': os.getcwd()})
        self.assertEqual(adapter.thread_id, HOST_THREAD)
        self.assertFalse(any(m.get('method') in ('thread/resume', 'turn/start', 'thread/fork') for m in proxy.received))
        self.assertNotIn('PRIVATE', json.dumps(logs))

    async def test_the_owned_thread_turns_off_the_other_servers_of_the_users_set_up(self):
        adapter, proxy, output, logs, _ = self.fixture(installed=INSTALLED, config=CONFIGURED)
        await self.initialize(adapter)
        self.assertNotIn('error', output[-1])
        methods = [m.get('method') for m in proxy.received]
        self.assertEqual(methods[:5], ['initialize', 'initialized', 'plugin/installed', 'config/read', 'thread/start'])
        start = next(m for m in proxy.received if m.get('method') == 'thread/start')
        self.assertEqual(start['params'], {'ephemeral': True, 'cwd': os.getcwd(), 'config': {
            'plugins.browser-use@openai-bundled.enabled': False, 'plugins.team-memory@team.enabled': False,
            'mcp_servers.honcho.enabled': False}})
        self.assertNotIn('owned_thread_config_refused', logs)

    async def test_a_host_that_refuses_the_configuration_starts_the_thread_with_its_own(self):
        adapter, proxy, output, logs, _ = self.fixture(mode='refuse_config', installed=INSTALLED)
        await self.initialize(adapter)
        self.assertNotIn('error', output[-1])
        starts = [m['params'] for m in proxy.received if m.get('method') == 'thread/start']
        self.assertEqual(starts, [{'ephemeral': True, 'cwd': os.getcwd(), 'config': {
            'plugins.browser-use@openai-bundled.enabled': False, 'plugins.team-memory@team.enabled': False}},
            {'ephemeral': True, 'cwd': os.getcwd()}])
        self.assertEqual(adapter.thread_id, HOST_THREAD)
        self.assertIn('owned_thread_config_refused', logs)
        self.assertNotIn('PRIVATE', json.dumps(logs))

    async def test_a_host_without_the_plugin_list_still_turns_off_the_configured_servers(self):
        adapter, proxy, output, _, _ = self.fixture(mode='no_plugin_list', config=CONFIGURED)
        await self.initialize(adapter)
        self.assertNotIn('error', output[-1])
        start = next(m for m in proxy.received if m.get('method') == 'thread/start')
        self.assertEqual(start['params']['config'], {'mcp_servers.honcho.enabled': False})

    async def test_server_without_the_bundled_plugin_identity_is_rejected_and_owned_thread_is_cleaned(self):
        adapter, proxy, output, _, _ = self.fixture(plugin_id=None)
        await self.initialize(adapter)
        self.assertIn('original bundled CUA plugin', output[-1]['error']['message'])
        self.assertTrue(proxy.was_closed)
        self.assertTrue(any(m.get('method') == 'thread/unsubscribe' for m in proxy.received))
        # No other source of identity is consulted (the configuration is read only to set up the thread, before it
        # starts), and nothing is ever called on the unidentified server.
        methods = [m.get('method') for m in proxy.received]
        self.assertNotIn('config/read', methods[methods.index('thread/start'):])
        self.assertNotIn('mcpServer/tool/call', methods)
        self.assertFalse(adapter.initialized)

    async def test_catalogue_preserves_native_tools_except_owned_lifecycle_contract(self):
        adapter, proxy, output, _, _ = self.fixture()
        await self.initialize(adapter)
        await adapter.handle({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}})
        advertised = {tool['name']: tool for tool in output[-1]['result']['tools']}
        self.assertEqual(advertised['js'], TOOLS['js'])
        self.assertEqual(advertised['js_reset'], TOOLS['js_reset'])
        self.assertEqual(advertised['turn_ended']['inputSchema'], {
            'type': 'object', 'properties': {}, 'additionalProperties': False})
        self.assertIn('empty object', advertised['turn_ended']['description'])
        self.assertEqual({key: value for key, value in advertised['turn_ended'].items()
                          if key not in ('inputSchema', 'description')},
                         {key: value for key, value in TOOLS['turn_ended'].items()
                          if key not in ('inputSchema', 'description')})
        self.assertEqual(proxy.tools, TOOLS)

    async def test_lifecycle_advertised_empty_call_executes_native_scope_and_preserves_result(self):
        result = {'content': [{'type': 'text', 'text': 'Native lifecycle result'}],
                  'structuredContent': {'original': [1, 2]}, '_meta': {'original': True}}
        adapter, proxy, output, _, _ = self.fixture(result=result)
        await self.initialize(adapter)
        await adapter.handle({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}})
        lifecycle = next(tool for tool in output[-1]['result']['tools'] if tool['name'] == 'turn_ended')
        self.assertNotIn('required', lifecycle['inputSchema'])
        ended = adapter.turn_id
        await adapter.handle({'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call',
                              'params': {'name': lifecycle['name'], 'arguments': {}}})
        self.assertEqual(output[-1]['result'], result)
        sent = next(m for m in proxy.received if m.get('method') == 'mcpServer/tool/call')
        self.assertEqual(sent['params']['arguments'], {
            'hook_event_name': 'Stop', 'session_id': HOST_THREAD, 'turn_id': ended})
        # The confirmed turn_ended ended that turn; the next call is made under a new one.
        self.assertNotEqual(adapter.turn_id, ended)
        self.assertEqual(proxy.tools, TOOLS)

    async def test_release_version_and_server_identity_are_advertised_consistently(self):
        version = json.loads((PLUGIN_ROOT / '.claude-plugin/plugin.json').read_text())['version']
        adapter, proxy, output, _, _ = self.fixture()
        await self.initialize(adapter)
        self.assertEqual(output[-1]['result']['serverInfo'], {
            'name': 'cua', 'version': version})
        initialized = next(m for m in proxy.received if m.get('method') == 'initialize')
        self.assertEqual(initialized['params']['clientInfo'], {
            'name': 'claude_codex_computer_use', 'title': 'Claude Codex Computer Use', 'version': version})

    async def test_image_text_errors_and_all_result_metadata_are_semantically_preserved(self):
        result = {'content': [{'type': 'text', 'text': 'PRIVATE_RESULT'},
                              {'type': 'image', 'data': 'PRIVATE_PIXELS', 'mimeType': 'image/png'}],
                  'isError': True, 'structuredContent': {'original': 7},
                  '_meta': {'nested': {'original': [1, 'PRIVATE_META']}}}
        adapter, proxy, output, logs, _ = self.fixture(result=result)
        await self.initialize(adapter)
        await adapter.handle(self.call(_meta={'thread_id': 'foreign-thread', 'turn_id': 'foreign-turn', 'approval_policy': 'never'}))
        self.assertEqual(output[-1]['result'], result)
        sent = next(m for m in proxy.received if m.get('method') == 'mcpServer/tool/call')
        self.assertEqual(sent['params'], {'threadId': HOST_THREAD, 'server': 'cua_repl', 'tool': 'js',
            'arguments': {'code': 'PRIVATE_SCRIPT'}, '_meta': {'thread_id': HOST_THREAD, 'threadId': HOST_THREAD,
                'x-codex-turn-metadata': {'session_id': HOST_THREAD, 'turn_id': adapter.turn_id}}})
        self.assertNotIn('PRIVATE', json.dumps(logs))
        self.assertNotIn('foreign', json.dumps(sent))

    async def test_original_json_rpc_error_is_preserved_without_logging_body(self):
        adapter, _, output, logs, _ = self.fixture(mode='rpc_error')
        await self.initialize(adapter)
        await adapter.handle(self.call())
        self.assertEqual(output[-1]['error'], {'code': -32000, 'message': 'PRIVATE_NATIVE_ERROR', 'data': {'original': [1, 2]}})
        self.assertNotIn('PRIVATE', json.dumps(logs))

    async def test_unadvertised_tool_and_invalid_arguments_never_reach_host(self):
        adapter, proxy, output, _, _ = self.fixture()
        await self.initialize(adapter)
        await adapter.handle(self.call(name='unadvertised'))
        self.assertEqual(output[-1]['error']['code'], -32601)
        bad = self.call()
        bad['params']['arguments'] = []
        await adapter.handle(bad)
        self.assertEqual(output[-1]['error']['code'], -32602)
        self.assertFalse(any(m.get('method') == 'mcpServer/tool/call' for m in proxy.received))

    async def test_non_native_plugin_identity_is_rejected_and_owned_thread_is_cleaned(self):
        adapter, proxy, output, _, _ = self.fixture(plugin_id='unrelated-plugin')
        await self.initialize(adapter)
        self.assertIn('original bundled CUA plugin', output[-1]['error']['message'])
        self.assertTrue(any(m.get('method') == 'thread/unsubscribe' for m in proxy.received))
        self.assertFalse(adapter.initialized)

    async def test_turn_ended_cannot_supply_foreign_session_or_turn_scope(self):
        adapter, proxy, output, _, _ = self.fixture()
        await self.initialize(adapter)
        call = self.call(name='turn_ended')
        call['params']['arguments'] = {'session_id': 'foreign-session', 'turn_id': 'foreign-turn', 'hook_event_name': 'Stop'}
        await adapter.handle(call)
        self.assertEqual(output[-1]['error']['code'], -32602)
        self.assertFalse(any(m.get('method') == 'mcpServer/tool/call' for m in proxy.received))
        call['params']['arguments'] = {}
        owned = adapter.turn_id
        await adapter.handle(call)
        sent = next(m for m in proxy.received if m.get('method') == 'mcpServer/tool/call')
        self.assertEqual(sent['params']['arguments'], {'hook_event_name': 'Stop', 'session_id': HOST_THREAD, 'turn_id': owned})
        self.assertEqual(sent['params']['_meta'], {'thread_id': HOST_THREAD, 'threadId': HOST_THREAD,
            'x-codex-turn-metadata': {'session_id': HOST_THREAD, 'turn_id': owned}})

    async def test_missing_socket_does_not_connect_or_spawn_anything(self):
        adapter, _, output, _, spawn = self.fixture()
        with patch.object(Path, 'stat', side_effect=FileNotFoundError):
            await self.initialize(adapter)
        self.assertIn('No server was started', output[-1]['error']['message'])
        spawn.assert_not_called()

    async def test_foreign_owner_or_public_socket_permissions_never_connect(self):
        for mode, uid in ((stat.S_IFSOCK | 0o600, os.getuid() + 1),
                          (stat.S_IFSOCK | 0o660, os.getuid()),
                          (stat.S_IFREG | 0o600, os.getuid())):
            adapter, _, output, _, connect = self.fixture()
            with patch.object(Path, 'stat', return_value=SimpleNamespace(st_mode=mode, st_uid=uid)):
                await self.initialize(adapter)
            self.assertIn('private Unix socket', output[-1]['error']['message'])
            connect.assert_not_called()

    async def test_owned_native_socket_symlink_is_allowed_with_private_source_and_target_parents(self):
        adapter, _, output, _, connect = self.fixture()
        with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=os.getuid())), \
             patch.object(Path, 'resolve', return_value=Path('/fixture/target-private/native.sock')):
            await self.initialize(adapter)
        self.assertNotIn('error', output[-1])
        connect.assert_awaited_once()

    async def test_foreign_symlink_owner_or_public_parent_never_connect(self):
        adapter, _, output, _, connect = self.fixture()
        with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=os.getuid() + 1)):
            await self.initialize(adapter)
        self.assertIn('error', output[-1])
        connect.assert_not_called()
        other, _, output, _, connect = self.fixture()
        with patch.object(Path, 'stat', new=lambda path: SimpleNamespace(
            st_mode=(stat.S_IFSOCK | 0o600) if path.suffix == '.sock' else (stat.S_IFDIR | 0o755), st_uid=os.getuid())):
            await self.initialize(other)
        self.assertIn('error', output[-1])
        connect.assert_not_called()

    async def test_disconnected_host_fails_clearly_and_cannot_spawn_again(self):
        adapter, _, output, _, spawn = self.fixture(mode='disconnect')
        await self.initialize(adapter)
        self.assertIn('error', output[-1])
        await self.initialize(adapter)
        self.assertIn('error', output[-1])
        self.assertEqual(spawn.call_count, 1)

    async def test_catalogue_failure_closes_only_own_thread_and_proxy(self):
        adapter, proxy, output, _, spawn = self.fixture(mode='missing_catalogue')
        await self.initialize(adapter)
        self.assertIn('error', output[-1])
        self.assertTrue(proxy.was_closed)
        cleanup = [m for m in proxy.received if m.get('method') == 'thread/unsubscribe']
        self.assertEqual([m['params'] for m in cleanup], [{'threadId': HOST_THREAD}])
        await self.initialize(adapter)
        self.assertEqual(spawn.call_count, 1)

    async def test_invalid_initialization_or_non_ephemeral_thread_fail_closed(self):
        for mode in ('invalid_initialize', 'not_ephemeral'):
            adapter, proxy, output, _, _ = self.fixture(mode=mode)
            await self.initialize(adapter)
            self.assertIn('error', output[-1])
            self.assertTrue(proxy.was_closed)
            if mode == 'not_ephemeral':
                self.assertTrue(any(m.get('method') == 'thread/unsubscribe' for m in proxy.received))

    async def test_invalid_or_missing_cua_schema_fails_instead_of_fabricating_tools(self):
        variants = ({'js': {'name': 'js', 'inputSchema': {'type': 'object'}}},
                    {'js': {'name': 'js', 'inputSchema': 'invalid'}, 'js_reset': TOOLS['js_reset']},
                    {'a': TOOLS['js'], 'b': TOOLS['js'], 'js_reset': TOOLS['js_reset']})
        for tools in variants:
            adapter, _, output, _, _ = self.fixture(tools=tools)
            await self.initialize(adapter)
            self.assertIn('error', output[-1])
            self.assertEqual(adapter.tools, [])

    async def test_transient_catalogue_startup_is_bounded_and_only_discovery_repeats(self):
        adapter, proxy, output, _, spawn = self.fixture(states=['notStarted', 'starting', 'connected'])
        await self.initialize(adapter)
        self.assertNotIn('error', output[-1])
        self.assertEqual(sum(m.get('method') == 'mcpServerStatus/list' for m in proxy.received), 3)
        self.assertFalse(any(m.get('method') == 'mcpServer/tool/call' for m in proxy.received))
        self.assertEqual(spawn.call_count, 1)
        stuck, child, results, _, _ = self.fixture(states=['starting'])
        stuck.startup_timeout = 0.06
        await self.initialize(stuck)
        self.assertIn('error', results[-1])
        self.assertTrue(child.was_closed)

    async def test_accept_decline_and_cancel_require_original_host_response(self):
        for action in ('accept', 'decline', 'cancel'):
            adapter, proxy, output, logs, _ = self.fixture(mode='approval')
            await self.initialize(adapter)
            call = asyncio.create_task(adapter.handle(self.call()))
            await self.settle(lambda: any(m.get('method') == 'elicitation/create' for m in output))
            request = next(m for m in output if m.get('method') == 'elicitation/create')
            self.assertEqual(request['params'], {'message': 'PRIVATE_ORIGINAL_APPROVAL',
                'requestedSchema': {'type': 'object', 'properties': {}}, '_meta': {'native': 'PRIVATE_APPROVAL_META'}})
            self.assertFalse(call.done())
            self.assertFalse(any(m.get('id') == 'native-approval' and 'method' not in m for m in proxy.received))
            # A concurrent tool-list request must remain responsive.
            await adapter.handle({'jsonrpc': '2.0', 'id': 4, 'method': 'tools/list', 'params': {}})
            self.assertEqual(output[-1]['id'], 4)
            decision = {'action': action, 'content': {'original': 'PRIVATE_DECISION'}, '_meta': {'original': True}}
            await adapter.handle({'jsonrpc': '2.0', 'id': request['id'], 'result': decision})
            await asyncio.wait_for(call, 1)
            forwarded = [m for m in proxy.received if m.get('id') == 'native-approval']
            self.assertEqual(forwarded, [{'id': 'native-approval', 'result': decision}])
            self.assertEqual(output[-1]['result'], proxy.result)
            self.assertNotIn('PRIVATE', json.dumps(logs))

    async def test_foreign_thread_elicitation_is_not_answered_or_exposed(self):
        adapter, proxy, output, _, _ = self.fixture()
        await self.initialize(adapter)
        before = len(output)
        proxy.emit({'id': 'foreign-approval', 'method': 'mcpServer/elicitation/request', 'params': {
            'threadId': 'foreign-thread', 'serverName': 'cua_repl', 'mode': 'form',
            'message': 'PRIVATE_FOREIGN_REQUEST', 'requestedSchema': {'type': 'object'}}})
        await asyncio.sleep(0.01)
        self.assertEqual(len(output), before)
        self.assertFalse(any(m.get('id') == 'foreign-approval' for m in proxy.received))

    async def test_unsupported_owned_elicitation_fails_without_approval(self):
        adapter, proxy, output, _, _ = self.fixture()
        await self.initialize(adapter)
        before = len(output)
        proxy.emit({'id': 'owned-url-request', 'method': 'mcpServer/elicitation/request', 'params': {
            'threadId': HOST_THREAD, 'serverName': 'cua_repl', 'mode': 'url',
            'message': 'PRIVATE_URL_REQUEST', 'url': 'https://private.invalid'}})
        await self.settle(lambda: any(m.get('id') == 'owned-url-request' for m in proxy.received))
        response = next(m for m in proxy.received if m.get('id') == 'owned-url-request')
        self.assertIn('error', response)
        self.assertNotIn('result', response)
        self.assertEqual(len(output), before)

    async def test_cleanup_is_own_thread_only_and_unconfirmed_status_is_reported(self):
        adapter, proxy, output, logs, _ = self.fixture(unsubscribe={'status': 'notSubscribed'})
        await self.initialize(adapter)
        report = await adapter.close()
        self.assertEqual(report['owned_thread_unsubscribe'], 'unconfirmed')
        self.assertEqual(report['connection_close'], 'confirmed')
        self.assertIn('owned_thread_cleanup_unconfirmed', logs)
        self.assertNotIn('owned_thread_unsubscribe_confirmed', logs)
        cleanup = [m for m in proxy.received if m.get('method') == 'thread/unsubscribe']
        self.assertEqual([m['params'] for m in cleanup], [{'threadId': HOST_THREAD}])
        self.assertFalse(any(m.get('method') in ('thread/archive', 'thread/delete', 'turn/interrupt') for m in proxy.received))

    async def test_close_is_idempotent_and_unknown_creation_is_never_reported_as_unloaded(self):
        adapter, proxy, _, _, _ = self.fixture()
        await self.initialize(adapter)
        first, second = await asyncio.gather(adapter.close(), adapter.close())
        self.assertEqual(first, second)
        self.assertEqual(sum(m.get('method') == 'thread/unsubscribe' for m in proxy.received), 1)
        unknown, _, _, logs, _ = self.fixture()
        unknown.thread_creation_requested = True
        result = await unknown.close()
        self.assertEqual(result['owned_thread_unsubscribe'], 'unconfirmed')
        self.assertIn('owned_thread_cleanup_unconfirmed', logs)


if __name__ == '__main__':
    unittest.main(verbosity=2)
