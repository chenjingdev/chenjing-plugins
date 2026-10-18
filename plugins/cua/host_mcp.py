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
import signal
import stat
import sys
import uuid

try:
    from websockets import unix_connect
except ImportError:
    unix_connect = None

NATIVE_PLUGIN_ID = 'unified-computer-use@openai-bundled'
VERSION = '0.7.0'
_WS_LOGGER = logging.getLogger('codex_computer_use.websocket')
_WS_LOGGER.disabled = True  # WebSocket debug/error logs may contain frames.


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
        self.rpc = ProxyRpc(cli_path, socket_path, self.host_request, startup_timeout)
        self.thread_id = None
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
        sys.stderr.write('cua: ' + event + '\n')
        sys.stderr.flush()

    def reply(self, ident, result=None, error=None):
        message = {'jsonrpc': '2.0', 'id': ident}
        message['error' if error is not None else 'result'] = error if error is not None else result
        self.emit(message)

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
        self.thread_creation_requested = True
        started = await request('thread/start', {'ephemeral': True, 'cwd': os.getcwd()})
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
                raise BridgeFailure('The selected host server is not identified as the original bundled CUA plugin.')
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
                    'serverInfo': {'name': 'cua', 'version': VERSION},
                    'instructions': 'Tools execute on this connection\'s new Codex-hosted ephemeral thread. This adapter does not start a runtime or reuse another thread. Call turn_ended with an empty object; the adapter supplies only its owned lifecycle scope.'})
            elif method == 'ping':
                self.reply(ident, {})
            elif not self.initialized or self.rpc.closed:
                raise BridgeFailure('The existing Codex host and original CUA catalogue are not connected.')
            elif method == 'tools/list':
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
                scope = {'session_id': self.thread_id, 'turn_id': self.turn_id}
                if name == 'turn_ended':
                    arguments = {'hook_event_name': 'Stop', **scope}
                # Use only this adapter-owned host thread and lifecycle. Never
                # copy client session/turn identities, policies or environment.
                self.active_tool_calls += 1
                try:
                    result = await self.rpc.request('mcpServer/tool/call', {
                        'threadId': self.thread_id, 'server': self.server, 'tool': name, 'arguments': arguments,
                        '_meta': {'thread_id': self.thread_id, 'threadId': self.thread_id,
                                  'x-codex-turn-metadata': scope}})
                finally:
                    self.active_tool_calls -= 1
                self.reply(ident, result)
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

    async def release_turn(self):
        if not self.initialized or self.rpc.closed or 'turn_ended' not in self.tool_names:
            return {'released': False, 'reason': 'cleanup_tool_unavailable'}
        scope = {'session_id': self.thread_id, 'turn_id': self.turn_id}
        try:
            result = await self.rpc.request('mcpServer/tool/call', {
                'threadId': self.thread_id, 'server': self.server, 'tool': 'turn_ended',
                'arguments': {'hook_event_name': 'Stop', **scope},
                '_meta': {'thread_id': self.thread_id, 'threadId': self.thread_id,
                          'x-codex-turn-metadata': scope}}, self.cleanup_timeout)
            if not isinstance(result, dict) or result.get('isError'):
                return {'released': False, 'reason': 'cleanup_not_confirmed'}
            return {'released': True, 'scopeCount': 1}
        except Exception:
            return {'released': False, 'reason': 'cleanup_not_confirmed'}

    async def close(self):
        async with self.close_lock:
            if self.cleanup_report is not None:
                return self.cleanup_report
            report = {'owned_thread_unsubscribe': 'not_created', 'connection_close': 'unconfirmed'}
            if self.initialized and not self.rpc.closed:
                await self.release_turn()
            if self.thread_id is not None and not self.rpc.closed:
                try:
                    result = await self.rpc.request('thread/unsubscribe', {'threadId': self.thread_id}, self.cleanup_timeout)
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
            try:
                await self.rpc.close()
                report['connection_close'] = 'confirmed'
            except Exception:
                self.log('owned_connection_cleanup_unconfirmed')
            self.cleanup_report = report
            return report


async def serve(adapter, control_factory=None):
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    stopped = asyncio.Event()
    previous = {}
    for signum in (signal.SIGINT, signal.SIGTERM):
        previous[signum] = signal.getsignal(signum)
        loop.add_signal_handler(signum, stopped.set)
    tasks = set()
    control = None
    control_lock = asyncio.Lock()

    async def handle(message):
        nonlocal control
        await adapter.handle(message)
        if control_factory and adapter.initialized and control is None:
            async with control_lock:
                if control is None:
                    control = control_factory(adapter)
                    await control.start()

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
            task = asyncio.create_task(handle(message))
            tasks.add(task)
            task.add_done_callback(completed)

    upstream = asyncio.create_task(incoming())
    signal_waiter = asyncio.create_task(stopped.wait())
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
        if control is not None:
            await control.close()
        cleanup = await adapter.close()
        for signum, handler in previous.items():
            loop.remove_signal_handler(signum)
            signal.signal(signum, handler)
    return cleanup
