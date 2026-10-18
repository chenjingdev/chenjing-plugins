"""A fake Codex app-server for the bridge tests. No process, no network, no real socket traffic.

`FakeHost` stands in for the WebSocket connection `unix_connect` returns: the bridge sends JSON-RPC through
`send` and reads the answers by iterating the object. It models what the bridge depends on in the real runtime
(E1): after a confirmed `turn_ended` for a (session, turn) pair, a browser call under the same pair runs into the js
timeout and resets the kernel, and a repeated `turn_ended` for the pair is ignored. A bridge that reuses a turn
therefore shows up in `reused` (and as an error result), and a repeated release in `repeated`.

Everything the bridge sent is kept in `received` and, for tool calls, in `calls`. Tests set `turn_ended` to
'ok', 'refuse' (isError), 'rpc_error' or 'silent' (no answer), `hold(tool)` to keep an answer back, `results`
to change what a tool returns and `unsubscribe` to 'silent' to leave thread/unsubscribe unanswered.
"""
import asyncio
import copy
import json
import os
from pathlib import Path
import socket

NATIVE_PLUGIN_ID = 'unified-computer-use@openai-bundled'
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
                   'annotations': {'readOnlyHint': False}, '_meta': {'original': True}},
}
RESULT_TEXT = 'PRIVATE_RESULT'


class FakeHost:
    def __init__(self, thread_id='fake-thread', tools=None, turn_ended='ok', log_path=None):
        self.thread_id = thread_id
        self.tools = copy.deepcopy(TOOLS if tools is None else tools)
        self.turn_ended = turn_ended
        self.log_path = log_path
        self.incoming = asyncio.Queue()
        self.received, self.calls, self.reused, self.repeated = [], [], [], []
        self.ended = set()
        self.holds = {}
        self.results = {}
        self.unsubscribe = 'ok'
        self.was_closed = False
        self.tasks = set()

    # The connection object the bridge holds.
    async def send(self, raw):
        if self.was_closed:
            raise ConnectionError('closed')
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

    async def close(self):
        self.finish()

    # What a test does to the host.
    def finish(self):
        """The host goes away: the bridge's reader ends and every unanswered request fails."""
        if self.was_closed:
            return
        self.was_closed = True
        self.incoming.put_nowait(None)
        for task in list(self.tasks):
            if not task.done() and task is not asyncio.current_task():
                task.cancel()

    def hold(self, tool):
        """Keep the answers to `tool` back until the returned event is set."""
        self.holds[tool] = asyncio.Event()
        return self.holds[tool]

    def emit(self, message):
        if not self.was_closed:
            self.incoming.put_nowait(json.dumps(message))

    def methods(self, name):
        return [message for message in self.received if message.get('method') == name]

    def turn_ended_calls(self):
        return [call['scope'] for call in self.calls if call['tool'] == 'turn_ended']

    def note(self, entry):
        if self.log_path:
            with open(self.log_path, 'a') as output:
                output.write(json.dumps(entry)+'\n')

    async def answer(self, message):
        method, ident = message.get('method'), message.get('id')
        if method is None or method == 'initialized':
            return
        params = message.get('params') or {}
        if method == 'initialize':
            result = {'userAgent': 'fixture', 'codexHome': '/fixture/codex-home', 'platformFamily': 'unix', 'platformOs': 'macos'}
        elif method == 'thread/start':
            result = {'thread': {'id': self.thread_id, 'ephemeral': True}}
        elif method == 'mcpServerStatus/list':
            result = {'data': [{'name': 'cua_repl', 'pluginId': NATIVE_PLUGIN_ID, 'runtimeStatus': 'connected',
                                'tools': self.tools, 'toolsError': None}], 'nextCursor': None}
        elif method == 'mcpServer/tool/call':
            result = await self.tool_call(ident, params)
            if result is None:
                return
        elif method == 'thread/unsubscribe':
            self.note({'method': method})
            if self.unsubscribe == 'silent':
                await asyncio.Event().wait()
            result = {'status': 'unsubscribed'}
        else:
            raise AssertionError('Unexpected method in the fake host: '+str(method))
        self.emit({'id': ident, 'result': result})

    async def tool_call(self, ident, params):
        tool = params['tool']
        scope = params['_meta']['x-codex-turn-metadata']
        pair = (scope['session_id'], scope['turn_id'])
        entry = {'tool': tool, 'scope': scope, 'arguments': params['arguments']}
        self.calls.append(entry)
        if tool == 'turn_ended':
            if pair in self.ended:
                self.repeated.append(pair)
            self.note({'tool': tool, 'scope': scope, 'mode': self.turn_ended})
            if self.turn_ended == 'silent':
                await asyncio.Event().wait()
            if tool in self.holds:
                await self.holds[tool].wait()
            if self.turn_ended == 'refuse':
                return {'content': [{'type': 'text', 'text': 'refused'}], 'isError': True}
            if self.turn_ended == 'rpc_error':
                self.emit({'id': ident, 'error': {'code': -32000, 'message': 'refused'}})
                return None
            self.ended.add(pair)
            return {'content': [{'type': 'text', 'text': 'ended'}]}
        if pair in self.ended:
            # The real runtime waits for its js timeout and then resets the kernel; the fake only answers sooner.
            self.reused.append(pair)
            self.note({'tool': tool, 'scope': scope, 'reused': True})
            await asyncio.sleep(0.05)
            return {'content': [{'type': 'text', 'text': 'js execution timed out; kernel reset'}], 'isError': True}
        self.note({'tool': tool, 'scope': scope})
        if tool in self.holds:
            await self.holds[tool].wait()
        return self.results.get(tool, {'content': [{'type': 'text', 'text': RESULT_TEXT}]})


def private_socket(directory, name='host.sock'):
    """A bound Unix socket (0600) that satisfies the bridge's endpoint checks; nothing ever connects to it."""
    path = Path(directory)/name
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(str(path))
    os.chmod(path, 0o600)
    return sock, path


def write_registry(state, socket_path, relay=None, pid=None, native_cli=None):
    """The host registry the wrapper writes (`host.json`), pointing at `socket_path`."""
    state = Path(state)
    state.mkdir(mode=0o700, exist_ok=True)
    pid = os.getpid() if pid is None else pid
    record = {'schema_version': 1, 'status': 'ready', 'mechanism': 'original_app_server_unix_websocket',
              'owner_pid': pid, 'backend_pid': pid, 'desktop_proxy_pid': pid, 'socket_path': str(socket_path)}
    if relay is not None:
        record['relay'] = relay
    if native_cli is not None:
        record['native_cli'] = str(native_cli)
    path = state/'host.json'
    path.write_text(json.dumps(record))
    path.chmod(0o600)
    return record
