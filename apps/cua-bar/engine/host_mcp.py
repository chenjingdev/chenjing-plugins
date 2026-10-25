#!/usr/bin/env python3
"""Route MCP to an explicitly listening, existing Codex app-server.

This never starts an app-server, proxy process, CUA runtime, or native service.
It connects only to an explicitly selected private Unix WebSocket endpoint.
All observations go to the MCP protocol stream; stderr contains fixed,
content-free event names only.
"""
import asyncio
import json
import logging
import os
from pathlib import Path
import re
import signal
import stat
import sys
import time
import uuid

try:
    from websockets import unix_connect
except ImportError:
    unix_connect = None

NATIVE_PLUGIN_ID = 'unified-computer-use@openai-bundled'
VERSION = '0.8.4'
# A plugin or server name that can stand in a dotted configuration key as itself.
CONFIG_NAME = re.compile(r'^[A-Za-z0-9_@-]{1,128}$')
EXIT_RELEASE_SECONDS = 3.0
# Fixed texts: a call that lost its host is never sent again, and the AI is told so (R12).
LOST_BEFORE_SEND = ('The Codex host connection was lost before this call was sent, so it did not run. '
                    'The next call connects to Codex again.')
LOST_DURING_CALL = ('The Codex host connection was lost while this call ran, so its outcome is unknown. '
                    'The call was not sent again. The next call connects to Codex again.')
# turn_ended never starts or reopens Codex: a new host could not end the turn of the old one anyway.
TURN_ENDED_WITHOUT_HOST = ('The Codex host connection was lost, so the CUA turn of this connection could not be ended. '
                           'turn_ended never connects to Codex again; the next CUA tool call does.')
NOTHING_TO_END = 'No CUA turn of this connection is open, so there was nothing to end.'
_WS_LOGGER = logging.getLogger('codex_computer_use.websocket')
_WS_LOGGER.disabled = True  # WebSocket debug/error logs may contain frames.
JS_TIMEOUT_MS = 30000           # how long cua_repl runs js when a call gives no timeout_ms
# What the computer-use service says, in every one of its refusals, when the Mac's lock stopped a call.
LOCKED_MARKERS = ('The Mac is locked', 'screenLocked')


def utc_now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def answer_texts(answer):
    """The texts of a failed call's answer: a JSON-RPC error's message, or those of a result's content."""
    texts = []
    if isinstance(answer, dict):
        texts.append(answer.get('message'))
        content = answer.get('content')
        if isinstance(content, list):
            texts.extend(item.get('text') for item in content if isinstance(item, dict))
    return [text for text in texts if isinstance(text, str)]


def error_texts(answer):
    """What a failed call's answer says went wrong, for its activity line: a JSON-RPC error's message, or the first
    text of a result's content that is not blank. The texts after it are the script's console lines and the guidance
    Codex adds to a thread's first answer."""
    if not isinstance(answer, dict):
        return []
    content = answer.get('content')
    texts = [item.get('text') for item in content if isinstance(item, dict)] if isinstance(content, list) else []
    first = next((text for text in texts if isinstance(text, str) and text.strip()), None)
    return [text for text in (answer.get('message'), first) if isinstance(text, str)]


def failure(name, arguments, answer, ms):
    """Why a call failed, as one word for the activity log (the relay uses the same words).

    `screen_locked` when the answer (a result, or a JSON-RPC error) says the Mac's lock stopped the call, `timeout`
    when js ran for all the time it had, else `error`, also when there was no answer at all."""
    if any(marker in text for text in answer_texts(answer) for marker in LOCKED_MARKERS):
        return 'screen_locked'
    if name == 'js':
        limit = arguments.get('timeout_ms') if isinstance(arguments, dict) else None
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            limit = JS_TIMEOUT_MS
        if ms >= limit:
            return 'timeout'
    return 'error'


class BridgeFailure(Exception):
    pass


class RpcFailure(Exception):
    def __init__(self, error):
        self.error = error
        super().__init__('The existing Codex host returned a JSON-RPC error.')


async def frames(stream):
    """Read JSONL without imposing an image/result line-size truncation limit."""
    pending = bytearray()
    while True:
        chunk = await stream.read(65536)
        if not chunk:
            if pending:
                yield bytes(pending)
            return
        pending.extend(chunk)
        while True:
            end = pending.find(b'\n')
            if end < 0:
                break
            yield bytes(pending[:end + 1])
            del pending[:end + 1]


def encode(message):
    return (json.dumps(message, ensure_ascii=True, separators=(',', ':')) + '\n').encode()


def quiet_config(installed, config, server='cua_repl', keep_plugin=NATIVE_PLUGIN_ID):
    """Thread configuration that turns off every MCP server of the user's set-up except the CUA one.

    An owned thread never runs a model turn, so the other servers would only start processes there, and the host keeps
    them, like the thread, for about half an hour after its last use (it does not unload a thread when its last client
    leaves). Built from the answers of plugin/installed and config/read; a name that cannot stand in a dotted key is
    left as it is.
    """
    out = {}
    markets = installed.get('marketplaces') if isinstance(installed, dict) else None
    for market in markets if isinstance(markets, list) else []:
        plugins = market.get('plugins') if isinstance(market, dict) else None
        for plugin in plugins if isinstance(plugins, list) else []:
            if not isinstance(plugin, dict) or plugin.get('enabled') is not True:
                continue
            ident = plugin.get('id')
            if isinstance(ident, str) and ident != keep_plugin and CONFIG_NAME.match(ident):
                out['plugins.' + ident + '.enabled'] = False
    settings = config.get('config') if isinstance(config, dict) else None
    servers = settings.get('mcp_servers') if isinstance(settings, dict) else None
    for name, entry in servers.items() if isinstance(servers, dict) else ():
        if (isinstance(name, str) and name != server and CONFIG_NAME.match(name)
                and not (isinstance(entry, dict) and entry.get('enabled') is False)):
            out['mcp_servers.' + name + '.enabled'] = False
    return out


def ident_key(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


class ProxyRpc:
    def __init__(self, cli_path, socket_path, request_handler, connect_timeout=15.0):
        # cli_path is retained only for older prototype callers; never executed.
        self.socket_path = Path(socket_path)
        self.request_handler = request_handler
        self.connect_timeout = connect_timeout
        self.connection = None
        self.reader_task = None
        self.pending = {}
        self.next_id = 0
        self.closed = False
        # Called with this object once the connection has ended, whichever side ended it.
        self.on_closed = None

    async def start(self):
        if not self.socket_path.is_absolute():
            raise BridgeFailure('The explicit Codex host socket path must be absolute. No server was started.')
        try:
            link_info = self.socket_path.lstat()
            info = self.socket_path.stat()
            resolved = self.socket_path.resolve(strict=True)
            parents = (self.socket_path.parent.stat(), resolved.parent.stat())
        except OSError:
            raise BridgeFailure('The explicit Codex host socket is missing. No server was started.') from None
        if (link_info.st_uid != os.getuid()
                or not (stat.S_ISLNK(link_info.st_mode) or stat.S_ISSOCK(link_info.st_mode))
                or not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077
                or any(not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o077 for parent in parents)):
            raise BridgeFailure('The Codex host socket must be a private Unix socket owned by this user. No server was started.')
        if unix_connect is None:
            raise BridgeFailure('The Python Unix WebSocket client is unavailable. No host was contacted.')
        try:
            self.connection = await unix_connect(path=str(self.socket_path),
                uri='ws://localhost/rpc', max_size=None,
                open_timeout=self.connect_timeout, ping_interval=None, logger=_WS_LOGGER)
        except (Exception, asyncio.TimeoutError):
            raise BridgeFailure('The private Codex host WebSocket could not connect. No server was started.') from None
        self.reader_task = asyncio.create_task(self.read())

    async def send(self, message):
        if self.closed or self.connection is None:
            raise BridgeFailure('The existing Codex host connection is disconnected.')
        try:
            await self.connection.send(json.dumps(message, ensure_ascii=True, separators=(',', ':')))
        except Exception:
            raise BridgeFailure('The existing Codex host connection disconnected while sending.') from None

    async def request(self, method, params, timeout=None):
        self.next_id += 1
        ident = 'bridge-rpc-' + str(self.next_id)
        future = asyncio.get_running_loop().create_future()
        self.pending[ident_key(ident)] = future
        try:
            await self.send({'id': ident, 'method': method, 'params': params})
            return await asyncio.wait_for(future, timeout) if timeout is not None else await future
        except asyncio.TimeoutError:
            raise BridgeFailure('The existing Codex host did not answer before the connection deadline.') from None
        finally:
            self.pending.pop(ident_key(ident), None)

    async def read(self):
        failure = BridgeFailure('The existing Codex host connection closed before answering.')
        try:
            async for raw in self.connection:
                try:
                    message = json.loads(raw)
                except (ValueError, UnicodeError):
                    raise BridgeFailure('The existing Codex host returned invalid JSON.') from None
                if not isinstance(message, dict):
                    raise BridgeFailure('The existing Codex host returned an invalid message.')
                if 'method' in message:
                    if 'id' in message:
                        await self.request_handler(message)
                    continue
                future = self.pending.get(ident_key(message.get('id')))
                if future is None or future.done():
                    continue
                if 'error' in message:
                    future.set_exception(RpcFailure(message['error']))
                elif 'result' in message:
                    future.set_result(message['result'])
                else:
                    future.set_exception(BridgeFailure('The Codex host returned a response without a result or error.'))
        except asyncio.CancelledError:
            raise
        except BridgeFailure as error:
            failure = error
        except Exception:
            failure = BridgeFailure('The existing Codex host connection could not be read.')
        finally:
            self.closed = True
            for future in tuple(self.pending.values()):
                if not future.done():
                    future.set_exception(failure)
            if self.on_closed is not None:
                try:
                    self.on_closed(self)
                except Exception:
                    pass

    async def close(self):
        failure = None
        if self.connection is not None:
            try:
                await asyncio.wait_for(self.connection.close(), 2)
            except asyncio.TimeoutError:
                transport = getattr(self.connection, 'transport', None)
                if transport is not None:
                    transport.close()  # Only this client's socket transport.
                failure = BridgeFailure('The owned WebSocket connection did not confirm close.')
            except Exception:
                failure = BridgeFailure('The owned WebSocket connection could not confirm close.')
        if self.reader_task is not None and not self.reader_task.done():
            self.reader_task.cancel()
        if self.reader_task is not None:
            await asyncio.gather(self.reader_task, return_exceptions=True)
        self.closed = True
        if failure is not None:
            raise failure


class HostMcp:
    def __init__(self, cli_path, socket_path, server='cua_repl', emit=None, log=None,
                 startup_timeout=15.0, cleanup_timeout=5.0,
                 expected_plugin_id=NATIVE_PLUGIN_ID, native_cua_root=None):
        self.emit = emit or self.emit_stdout
        self.log = log or self.log_stderr
        self.server = server
        # None is an explicit mock-fixture injection point, never a CLI option.
        self.expected_plugin_id = expected_plugin_id
        # The registered-host entry point derives this from the installed CLI.
        # No installation is assumed when only a raw socket is supplied.
        self.native_cua_root = Path(native_cua_root) if native_cua_root is not None else None
        self.startup_timeout, self.cleanup_timeout = startup_timeout, cleanup_timeout
        self.rpc_arguments = (cli_path, socket_path)
        self.rpc = self.new_rpc()
        self.thread_id = None
        # The owned thread works in this folder: the bridge's own (the Claude conversation's).
        self.thread_cwd = os.getcwd()
        # The bridge's name for the relay record (bridge-<pid>-<started_at>), set by whoever keeps its record.
        self.owner = None
        # Whether this plugin's relay runs in front of the owned thread's runtime: then the relay logs the calls.
        self.thread_relay = False
        # A connection owns one ephemeral host thread and one tool lifecycle.
        # Context is authored here, never copied from the calling agent.
        self.turn_id = str(uuid.uuid4())
        self.active_tool_calls = 0
        self.stopping = False
        self.thread_creation_requested = False
        self.tools = []
        self.tool_names = set()
        self.initialized = self.initializing = False
        self.boot_attempted = False
        self.cleanup_report = None
        self.close_lock = asyncio.Lock()
        self.approvals = {}
        self.next_approval = 0
        self.supports_elicitation = False
        # Scopes and lifecycle. A scope is the exact (session, turn) pair a tool call was sent under; it stays open
        # until the runtime confirmed turn_ended for that pair. Calls register their scope and turn_ended runs under
        # turn_lock, so a call never goes out under a pair that is being ended.
        self.scopes = {}
        self.turn_lock = asyncio.Lock()
        self.reconnect_lock = asyncio.Lock()
        self.cleanup_unconfirmed = False
        self.ready = False
        self.host = None
        self.session_id = None  # the thread of the last verified connection; what the records call the session
        self.connected_at = self.last_call_at = None
        # Set by whoever keeps the records; both are best effort and never raise into a call.
        self.on_change = self.on_call = None

    @staticmethod
    def emit_stdout(message):
        try:
            sys.stdout.buffer.write(encode(message))
            sys.stdout.buffer.flush()
        except BrokenPipeError:
            pass

    @staticmethod
    def log_stderr(event):
        # All call sites use authored fixed strings, never exception/result text.
        try:
            sys.stderr.write('cua: ' + event + '\n')
            sys.stderr.flush()
        except (OSError, ValueError):
            # Claude closes the bridge's stdio a few milliseconds after it stops it, while the bridge still cleans up and
            # logs what it does (c43, c45). A log that raised there would cut the clean-up short. Like emit_stdout, it
            # says nothing instead: the pipe, the descriptor or the file object can be the closed one.
            pass

    def reply(self, ident, result=None, error=None):
        message = {'jsonrpc': '2.0', 'id': ident}
        message['error' if error is not None else 'result'] = error if error is not None else result
        self.emit(message)

    def new_rpc(self):
        rpc = ProxyRpc(self.rpc_arguments[0], self.rpc_arguments[1], self.host_request, self.startup_timeout)
        rpc.on_closed = self.connection_lost
        return rpc

    @property
    def connected(self):
        """The host connection is up, and its owned thread and CUA catalogue were verified."""
        return self.ready and not self.rpc.closed

    def changed(self):
        callback = self.on_change
        if callback is not None:
            try:
                callback()
            except Exception:
                pass

    def host_info(self):
        """Which host this connection is attached to; the registered-host entry point knows more."""
        return {'pid': None, 'relay': False}

    async def thread_config(self, request):
        """The configuration of the owned thread: only the CUA server starts there. An answer the host does not
        give is left out; the thread then starts with the host's own configuration, as before."""
        answers = []
        for method, params in (('plugin/installed', {}), ('config/read', {'includeLayers': False})):
            try:
                answers.append(await request(method, params))
            except RpcFailure:
                answers.append(None)
        return quiet_config(answers[0], answers[1], self.server)

    def mark_connected(self):
        # A new connection has a new owned thread and never inherits the turn id of an older one.
        self.rotate_turn()
        self.session_id = self.thread_id
        # The record says relay only when the relay really runs in front of this thread's runtime; the calls of a
        # connection are logged by the relay then, else by the bridge.
        self.host = {**self.host_info(), 'relay': self.thread_relay}
        self.connected_at = utc_now()
        self.ready = True
        self.changed()

    def connection_lost(self, rpc):
        if rpc is not self.rpc:
            return
        if self.ready:
            self.log('host_connection_lost')
        self.ready = False
        self.host = None
        self.changed()

    def snapshot(self):
        """What the records say about this connection right now."""
        # Until a replacement host is verified, the session of the lost one stays the current one.
        return {'host': dict(self.host) if self.host is not None else None,
                'session_id': self.session_id, 'turn_id': self.turn_id if self.session_id is not None else None,
                'connected_at': self.connected_at, 'last_call_at': self.last_call_at,
                'busy': self.active_tool_calls > 0,
                'scopes': [{'session_id': key[0], 'turn_id': key[1], **times} for key, times in self.scopes.items()],
                'cleanup': 'none' if not self.scopes else 'not_confirmed' if self.cleanup_unconfirmed else 'open'}

    def current_scope(self):
        return {'session_id': self.thread_id, 'turn_id': self.turn_id}

    def is_current(self, scope):
        return scope['session_id'] == self.thread_id and scope['turn_id'] == self.turn_id

    def rotate_turn(self):
        """The one place a turn id is made after construction. Release paths reach it through end_scope.

        A turn the runtime has ended must not be used again: the next browser call under that pair hangs until the
        js timeout and resets the kernel, and a repeated turn_ended for the pair is ignored.
        """
        self.turn_id = str(uuid.uuid4())

    def open_scope(self, scope):
        key = (scope['session_id'], scope['turn_id'])
        now = utc_now()
        entry = self.scopes.get(key)
        if entry is None:
            self.scopes[key] = {'first_at': now, 'last_at': now}
        else:
            entry['last_at'] = now

    def drop_scope(self, scope):
        self.scopes.pop((scope['session_id'], scope['turn_id']), None)
        if not self.scopes:
            self.cleanup_unconfirmed = False

    def tool_request(self, name, arguments, scope):
        # Use only this adapter-owned host thread and lifecycle. Never copy client
        # session/turn identities, policies or environment.
        session = scope['session_id']
        return {'threadId': session, 'server': self.server, 'tool': name, 'arguments': arguments,
                '_meta': {'thread_id': session, 'threadId': session, 'x-codex-turn-metadata': dict(scope)}}

    async def boot(self):
        deadline = asyncio.get_running_loop().time() + self.startup_timeout

        async def request(method, params):
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise BridgeFailure('The existing Codex host did not become ready before the connection deadline.')
            return await self.rpc.request(method, params, remaining)

        await self.rpc.start()
        initialized = await request('initialize', {
            'clientInfo': {'name': 'claude_codex_computer_use', 'title': 'Claude Codex Computer Use', 'version': VERSION},
            'capabilities': {'experimentalApi': True, 'requestAttestation': False}})
        if (not isinstance(initialized, dict) or any(not isinstance(initialized.get(field), str) or not initialized[field]
                for field in ('userAgent', 'platformFamily', 'platformOs', 'codexHome'))
                or not Path(initialized['codexHome']).is_absolute()):
            raise BridgeFailure('The existing Codex host returned an invalid initialization response.')
        await self.rpc.send({'method': 'initialized', 'params': {}})
        config = await self.thread_config(request)
        self.thread_relay = False
        self.thread_creation_requested = True
        plain = {'ephemeral': True, 'cwd': self.thread_cwd}
        try:
            started = await request('thread/start', {**plain, 'config': config} if config else plain)
        except RpcFailure:
            if not config:
                raise
            # A host that does not take one of these keys starts the thread with its own configuration, as before.
            self.log('owned_thread_config_refused')
            started = await request('thread/start', plain)
        thread = started.get('thread') if isinstance(started, dict) else None
        if isinstance(thread, dict) and isinstance(thread.get('id'), str) and thread['id']:
            self.thread_id = thread['id']
        if self.thread_id is None or thread.get('ephemeral') is not True:
            raise BridgeFailure('The Codex host did not return an owned ephemeral thread. No existing thread was selected.')
        while True:
            status = await request('mcpServerStatus/list', {
                'threadId': self.thread_id, 'serverName': self.server, 'detail': 'toolsAndAuthOnly'})
            data = status.get('data') if isinstance(status, dict) else None
            matches = [item for item in data if isinstance(item, dict) and item.get('name') == self.server] if isinstance(data, list) else []
            if len(matches) != 1:
                raise BridgeFailure('The owned Codex thread has no configured CUA server. No fallback runtime was started.')
            selected = matches[0]
            if self.expected_plugin_id is not None and selected.get('pluginId') != self.expected_plugin_id:
                from relay_install import accept_relay  # only this plugin's relay in front of the bundled runtime
                if not await accept_relay(self, request, selected):
                    raise BridgeFailure('The selected host server is not identified as the original bundled CUA plugin.')
                self.thread_relay = True
            state = selected.get('runtimeStatus')
            tools = selected.get('tools')
            if state in ('notStarted', 'starting', None) or (state == 'connected' and tools == {} and selected.get('toolsError') is None):
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise BridgeFailure('The original host CUA catalogue did not become ready before the connection deadline.')
                # Only discovery is repeated. No tool/action or approval is retried.
                await asyncio.sleep(min(0.05, remaining))
                continue
            if state != 'connected':
                raise BridgeFailure('The owned Codex thread has no connected CUA server. No fallback runtime was started.')
            break
        tools = selected.get('tools')
        if selected.get('toolsError') is not None or not isinstance(tools, dict) or not tools:
            raise BridgeFailure('The Codex host did not provide the original CUA tool catalogue.')
        names, original = set(), []
        for tool in tools.values():
            if (not isinstance(tool, dict) or not isinstance(tool.get('name'), str) or not tool['name']
                    or tool['name'] in names or not isinstance(tool.get('inputSchema'), dict)
                    or tool['inputSchema'].get('type') != 'object'):
                raise BridgeFailure('The original CUA catalogue is invalid or ambiguous.')
            names.add(tool['name'])
            if tool['name'] == 'turn_ended':
                # Caller-authored lifecycle identities are never accepted. The
                # client schema must describe that contract, not the native one.
                original.append({**tool,
                    'description': 'End this connection\'s current CUA tool lifecycle. Call with an empty object; the bridge supplies its owned session and turn scope.',
                    'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False}})
            else:
                original.append(tool)
        if not {'js', 'js_reset'}.issubset(names):
            raise BridgeFailure('The selected host server does not advertise the original CUA js and js_reset tools.')
        self.tools, self.tool_names = original, names
        self.initialized = True
        self.mark_connected()
        self.log('connected_owned_thread_and_catalogue')

    async def host_request(self, message):
        params = message.get('params')
        if not isinstance(params, dict) or params.get('threadId') != self.thread_id or self.thread_id is None:
            # Another subscriber might receive this request. Do not answer it.
            self.log('ignored_unrelated_host_request')
            return
        if (message.get('method') != 'mcpServer/elicitation/request' or params.get('serverName') != self.server
                or params.get('mode') != 'form' or not isinstance(params.get('message'), str)
                or not isinstance(params.get('requestedSchema'), dict) or not self.supports_elicitation):
            await self.rpc.send({'id': message['id'], 'error': {
                'code': -32601, 'message': 'This adapter cannot present this owned-thread host interaction. No approval was granted.'}})
            self.log('unsupported_owned_thread_interaction')
            return
        self.next_approval += 1
        ident = 'host-cua-elicitation-' + str(self.next_approval)
        self.approvals[ident_key(ident)] = message['id']
        original = {'message': params['message'], 'requestedSchema': params['requestedSchema']}
        if params.get('_meta') is not None:
            original['_meta'] = params['_meta']
        self.emit({'jsonrpc': '2.0', 'id': ident, 'method': 'elicitation/create', 'params': original})
        self.log('original_owned_thread_elicitation_forwarded')

    async def handle(self, message):
        if not isinstance(message, dict) or message.get('jsonrpc') != '2.0':
            self.reply(None, error={'code': -32600, 'message': 'Invalid MCP JSON-RPC request.'})
            return
        if 'method' not in message:
            key = ident_key(message.get('id'))
            original_id = self.approvals.get(key)
            if original_id is None:
                return
            if 'error' in message:
                await self.rpc.send({'id': original_id, 'error': message['error']})
            else:
                result = message.get('result')
                if not isinstance(result, dict) or result.get('action') not in ('accept', 'decline', 'cancel'):
                    self.log('invalid_host_elicitation_response_ignored')
                    return
                await self.rpc.send({'id': original_id, 'result': result})
            self.approvals.pop(key, None)
            self.log('original_host_elicitation_response_forwarded')
            return
        method = message.get('method')
        if 'id' not in message:
            # No action is executed from notifications, including cancellation.
            return
        ident = message['id']
        params = message.get('params', {})
        if not isinstance(params, dict):
            self.reply(ident, error={'code': -32602, 'message': 'MCP params must be an object.'})
            return
        try:
            if method == 'initialize':
                if self.initialized or self.initializing or self.boot_attempted:
                    self.reply(ident, error={'code': -32600, 'message': 'This MCP adapter is already initialized or initializing.'})
                    return
                self.initializing = True
                self.boot_attempted = True
                capabilities = params.get('capabilities', {})
                self.supports_elicitation = isinstance(capabilities, dict) and isinstance(capabilities.get('elicitation'), dict)
                try:
                    await self.boot()
                except Exception:
                    await self.close()
                    raise
                finally:
                    self.initializing = False
                requested_protocol = params.get('protocolVersion')
                protocol_version = requested_protocol if requested_protocol in ('2025-06-18', '2025-11-25') else '2025-06-18'
                self.reply(ident, {'protocolVersion': protocol_version, 'capabilities': {'tools': {}},
                    'serverInfo': {'name': 'cuabar', 'version': VERSION},
                    'instructions': 'Tools execute on this connection\'s new Codex-hosted ephemeral thread. This adapter does not start a runtime or reuse another thread. Call turn_ended with an empty object; the adapter supplies only its owned lifecycle scope.'})
            elif method == 'ping':
                self.reply(ident, {})
            elif not self.initialized:
                raise BridgeFailure('The existing Codex host and original CUA catalogue are not connected.')
            elif method == 'tools/list':
                # The last verified catalogue, also while the host is away.
                self.reply(ident, {'tools': self.tools})
            elif method == 'tools/call':
                if self.stopping:
                    raise BridgeFailure('This owned CUA connection is stopping.')
                name = params.get('name')
                if not isinstance(name, str) or name not in self.tool_names:
                    self.reply(ident, error={'code': -32601, 'message': 'The tool is not advertised by the owned host CUA server.'})
                    return
                arguments = params.get('arguments', {})
                if not isinstance(arguments, dict):
                    self.reply(ident, error={'code': -32602, 'message': 'Tool arguments must be an object.'})
                    return
                if name == 'turn_ended' and arguments:
                    self.reply(ident, error={'code': -32602,
                        'message': 'This host adapter accepts only empty turn_ended arguments; caller session or turn scope is not accepted.'})
                    return
                if name != 'turn_ended':
                    # A host that went away is found again the way the conversation start finds it (R12). turn_ended
                    # is left out on purpose: ending a turn must never start or reopen Codex.
                    await self.ensure_connected()
                if name not in self.tool_names:
                    # The catalogue of the new host does not have this tool any more.
                    self.reply(ident, error={'code': -32601, 'message': 'The tool is not advertised by the owned host CUA server.'})
                    return
                self.reply(ident, await (self.end_turn_tool() if name == 'turn_ended' else self.call_tool(name, arguments)))
            else:
                self.reply(ident, error={'code': -32601, 'message': 'Unsupported MCP method.'})
        except RpcFailure as error:
            self.reply(ident, error=error.error)
            self.log('original_codex_rpc_error_forwarded')
        except BridgeFailure as error:
            self.reply(ident, error={'code': -32001, 'message': str(error)})
            self.log('connection_or_catalogue_unavailable')
        except Exception:
            self.reply(ident, error={'code': -32603, 'message': 'The Codex host CUA adapter could not complete this request.'})
            self.log('local_request_failure')

    async def ensure_connected(self):
        if self.connected:
            return
        async with self.reconnect_lock:
            if self.connected:
                return
            if self.stopping:
                raise BridgeFailure('This owned CUA connection is stopping.')
            await self.reconnect()

    async def reconnect(self):
        """Attach to the host again after the old one went away, the way a conversation start attaches (R12).

        Transport, owned thread and catalogue are new. The scopes of the old host stay open: its runtime is gone,
        and only an exact (session, turn) pair on that runtime could have ended them.
        """
        old, old_thread = self.rpc, self.thread_id
        self.ready = False
        self.host = None
        self.thread_id = None
        self.thread_creation_requested = False
        self.approvals.clear()
        self.changed()
        try:
            await old.close()
        except Exception:
            pass
        self.rpc = self.new_rpc()
        try:
            await self.boot()
        except BaseException:
            await self.abandon_connection()
            self.thread_id = old_thread
            self.changed()
            raise

    async def abandon_connection(self):
        """Detach from the host this connection is on and close it, without ending the bridge."""
        rpc = self.rpc
        if self.thread_id is not None and rpc.connection is not None and not rpc.closed:
            try:
                await rpc.request('thread/unsubscribe', {'threadId': self.thread_id}, self.cleanup_timeout)
            except Exception:
                self.log('owned_thread_cleanup_unconfirmed')
        try:
            await rpc.close()
        except Exception:
            self.log('owned_connection_cleanup_unconfirmed')

    def begin_call(self, uses_screen=True):
        """A tool call goes out. turn_ended only ends a turn: it is in flight like any call, but no use of the screen,
        so it leaves last_call_at as it is."""
        self.active_tool_calls += 1
        if uses_screen:
            self.last_call_at = utc_now()
        self.changed()

    def finish_call(self, name, ok, started, scope, relay, error='error', texts=()):
        """A tool call came back. `error` is the activity log's word for why a failed one failed (see failure), `texts`
        what its answer says went wrong (error_texts): the log keeps them only when the person asked for it."""
        self.active_tool_calls -= 1
        if name != 'turn_ended':
            self.last_call_at = utc_now()
            entry = self.scopes.get((scope['session_id'], scope['turn_id']))
            if entry is not None:
                entry['last_at'] = self.last_call_at
        self.changed()
        callback = self.on_call
        if callback is not None:
            try:
                callback(name, ok, int((time.monotonic()-started)*1000), scope['session_id'], relay,
                         None if ok else error, () if ok else texts)
            except Exception:
                pass

    async def call_tool(self, name, arguments):
        """One tool call under the current scope. It is recorded as open before it leaves, and never sent twice."""
        await self.turn_lock.acquire()
        try:
            if self.stopping:
                raise BridgeFailure('This owned CUA connection is stopping.')
            if not self.connected:
                raise BridgeFailure(LOST_BEFORE_SEND)
            rpc, scope = self.rpc, self.current_scope()
            relay = bool(self.host and self.host.get('relay'))
            self.open_scope(scope)
            started = time.monotonic()
            self.begin_call()
        finally:
            self.turn_lock.release()
        ok, answer = False, None
        try:
            answer = await rpc.request('mcpServer/tool/call', self.tool_request(name, arguments, scope))
            ok = isinstance(answer, dict) and not answer.get('isError')
            return answer
        except RpcFailure as refusal:
            answer = refusal.error
            raise
        except BridgeFailure as lost:
            # The bridge's own fixed text is what the AI is told, so it is the answer the activity log may keep.
            if rpc.closed:
                answer = {'message': LOST_DURING_CALL}
                raise BridgeFailure(LOST_DURING_CALL) from None
            answer = {'message': str(lost)}
            raise
        finally:
            ms = int((time.monotonic()-started)*1000)
            self.finish_call(name, ok, started, scope, relay, None if ok else failure(name, arguments, answer, ms),
                             () if ok else error_texts(answer))

    async def end_scope(self, scope, timeout=None):
        """Ask the runtime to end one exact (session, turn) pair; returns (confirmed, result).

        The one place a scope closes and the turn rotates, whoever asked: the AI's turn_ended, a control release or
        the exit release. Confirmed means a result without isError. Only confirmation rotates the turn of the
        current scope: a refusal leaves the pair usable and open for the next try. An unanswered request is
        different, because the runtime may still end the pair; the turn rotates and the scope stays open for a retry.
        """
        rpc = self.rpc
        request = self.tool_request('turn_ended', {'hook_event_name': 'Stop', **scope}, scope)
        try:
            result = await rpc.request('mcpServer/tool/call', request, timeout)
        except BridgeFailure:
            if timeout is not None and not rpc.closed and self.is_current(scope):
                self.rotate_turn()
                self.changed()
            raise
        confirmed = isinstance(result, dict) and not result.get('isError')
        if confirmed:
            self.drop_scope(scope)
            if self.is_current(scope):
                self.rotate_turn()
            self.changed()
        return confirmed, result

    async def end_turn_tool(self):
        """The AI's turn_ended: end the current scope. Calls made meanwhile wait and run under the next turn.

        Without a host there is nothing to ask: the answer is fixed, the scopes stay as they are and, if any are
        open, the record says they could not be confirmed. The request is bounded by cleanup_timeout, so a runtime
        that never answers cannot hold up the calls behind it; the turn then rotates like in any unanswered release.
        """
        await self.turn_lock.acquire()
        try:
            if self.stopping:
                raise BridgeFailure('This owned CUA connection is stopping.')
            if not self.connected:
                if not self.scopes:
                    # Nothing was opened, so there is nothing to confirm: not an error, like an empty turn on a host.
                    return {'content': [{'type': 'text', 'text': NOTHING_TO_END}]}
                self.cleanup_unconfirmed = True
                self.changed()
                raise BridgeFailure(TURN_ENDED_WITHOUT_HOST)
            rpc, scope = self.rpc, self.current_scope()
            relay = bool(self.host and self.host.get('relay'))
            started = time.monotonic()
            self.begin_call(uses_screen=False)
            ok = False
            try:
                ok, result = await self.end_scope(scope, self.cleanup_timeout)
                return result
            except BridgeFailure:
                if rpc.closed:
                    raise BridgeFailure(LOST_DURING_CALL) from None
                raise
            finally:
                if not ok and (scope['session_id'], scope['turn_id']) in self.scopes:
                    self.cleanup_unconfirmed = True
                self.finish_call('turn_ended', ok, started, scope, relay)
        finally:
            self.turn_lock.release()

    async def take_turn_lock(self, timeout):
        """Take turn_lock, or give up after `timeout` seconds. None waits as long as it takes."""
        if timeout is None or not self.turn_lock.locked():
            await self.turn_lock.acquire()
            return True
        try:
            await asyncio.wait_for(self.turn_lock.acquire(), timeout)
        except asyncio.TimeoutError:
            return False
        return True

    async def release_scopes(self, wait=None, budget=None):
        """End every open scope this connection can still reach, oldest first.

        wait: seconds to give tool calls that are still running (the control release: 2.5). None does not wait.
        budget: seconds for the whole operation (exit: 3). None leaves each request its own cleanup timeout.
        Returns {'released', 'reason', 'scope_count'}; scope_count counts the scopes this request confirmed.
        New calls wait behind the release and then run under the rotated turn, so the release is not starved.
        """
        begun = time.monotonic()
        if not await self.take_turn_lock(wait if wait is not None else budget):
            return self.release_result(False, 'request_in_flight', 0)
        try:
            if wait is not None:
                while self.active_tool_calls and time.monotonic()-begun < wait:
                    await asyncio.sleep(0.025)
                if self.active_tool_calls:
                    return self.release_result(False, 'request_in_flight', 0)
            if not self.scopes:
                return self.release_result(False, 'no_trusted_scope', 0)
            if not self.connected or 'turn_ended' not in self.tool_names:
                self.cleanup_unconfirmed = True
                self.changed()
                return self.release_result(False, 'cleanup_not_confirmed', 0)
            # Only this host's thread can end its scopes; those of an earlier host stay open in the records.
            targets = [key for key in self.scopes if key[0] == self.thread_id]
            confirmed, failed = 0, not targets
            for session, turn in targets:
                timeout = self.cleanup_timeout
                if budget is not None:
                    timeout = min(timeout, budget-(time.monotonic()-begun))
                if timeout <= 0 or not self.connected:
                    failed = True
                    break
                try:
                    done, _ = await self.end_scope({'session_id': session, 'turn_id': turn}, timeout)
                except Exception:
                    done = False
                confirmed += 1 if done else 0
                failed = failed or not done
            self.cleanup_unconfirmed = bool(self.scopes)
            self.changed()
            return self.release_result(not failed, 'cleanup_not_confirmed' if failed else None, confirmed)
        finally:
            self.turn_lock.release()

    @staticmethod
    def release_result(released, reason, scope_count):
        return {'released': released, 'reason': reason, 'scope_count': scope_count}

    async def close(self):
        async with self.close_lock:
            if self.cleanup_report is not None:
                return self.cleanup_report
            self.stopping = True
            begun = time.monotonic()
            report = {'owned_thread_unsubscribe': 'not_created', 'connection_close': 'unconfirmed'}
            if self.initialized and self.connected:
                try:
                    await self.release_scopes(budget=EXIT_RELEASE_SECONDS)
                except Exception:
                    pass  # whatever failed, the thread is still detached and the connection closed below
            if self.thread_id is not None and not self.rpc.closed:
                try:
                    # The release and this request share the exit budget; whatever the release left is all there is.
                    left = max(0.0, EXIT_RELEASE_SECONDS-(time.monotonic()-begun))
                    result = await self.rpc.request('thread/unsubscribe', {'threadId': self.thread_id},
                                                    min(self.cleanup_timeout, left))
                    status = result.get('status') if isinstance(result, dict) else None
                    if status not in ('unsubscribed', 'notLoaded'):
                        raise BridgeFailure('The host did not confirm owned-thread detachment.')
                    report['owned_thread_unsubscribe'] = 'confirmed' if status == 'unsubscribed' else 'already_unloaded'
                    self.log('owned_thread_unsubscribe_confirmed')
                except Exception:
                    report['owned_thread_unsubscribe'] = 'unconfirmed'
                    self.log('owned_thread_cleanup_unconfirmed')
            elif self.thread_id is not None or self.thread_creation_requested:
                # A cancelled creation may have reached the host before its
                # thread ID reached us. Connection close is not proof of unload.
                report['owned_thread_unsubscribe'] = 'unconfirmed'
                self.log('owned_thread_cleanup_unconfirmed')
            self.approvals.clear()
            self.initialized = False
            self.ready = False
            try:
                await self.rpc.close()
                report['connection_close'] = 'confirmed'
            except Exception:
                self.log('owned_connection_cleanup_unconfirmed')
            self.cleanup_report = report
            return report


async def serve(adapter, control_factory=None, stdin=None):
    """Run the MCP session on stdin and stdout until stdin ends or a stop signal arrives.

    control_factory(adapter) makes the record and control endpoint of this bridge. They exist from the start, also
    before the host is connected. If they cannot be set up the bridge runs without them: records never decide
    whether a CUA call works. On the way out the open scopes are released first (adapter.close), then the record
    is removed, or left as not confirmed when scopes are still open.
    """
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer if stdin is None else stdin)
    stopped = asyncio.Event()
    previous = {}
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        handler = signal.getsignal(signum)
        if signum == signal.SIGHUP and handler == signal.SIG_IGN:
            continue  # started under nohup: a closing terminal must not end this bridge
        previous[signum] = handler
        loop.add_signal_handler(signum, stopped.set)
    tasks = set()
    control = None
    if control_factory is not None:
        try:
            control = control_factory(adapter)
            await control.start()
        except Exception:
            control = None
            adapter.log('bridge_records_unavailable')

    def completed(task):
        tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            adapter.log('request_task_failed')

    async def incoming():
        async for raw in frames(reader):
            try:
                message = json.loads(raw)
            except (ValueError, UnicodeError):
                adapter.reply(None, error={'code': -32700, 'message': 'Invalid MCP JSON.'})
                continue
            task = asyncio.create_task(adapter.handle(message))
            tasks.add(task)
            task.add_done_callback(completed)

    upstream = asyncio.create_task(incoming())
    signal_waiter = asyncio.create_task(stopped.wait())
    cleanup = None
    try:
        done, _ = await asyncio.wait((upstream, signal_waiter), return_when=asyncio.FIRST_COMPLETED)
        if upstream in done:
            upstream.result()
    finally:
        upstream.cancel()
        signal_waiter.cancel()
        await asyncio.gather(upstream, signal_waiter, return_exceptions=True)
        # Stop local request tasks before closing the connection, including a
        # pending initialization, so none can create resources after close.
        # This does not send remote action retries, approvals or turn interrupts.
        for task in list(tasks):
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        try:
            if control is not None:
                try:
                    await control.stop()
                except Exception:
                    pass
            cleanup = await adapter.close()
        finally:
            if control is not None:
                await control.finalize()
            for signum, handler in previous.items():
                loop.remove_signal_handler(signum)
                if handler is not None:
                    signal.signal(signum, handler)
    return cleanup
