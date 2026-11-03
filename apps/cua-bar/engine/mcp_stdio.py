#!/usr/bin/python3
"""Installed plugin entry point: connect only to the Codex-owned private host."""
import asyncio
import json
import os
from pathlib import Path
import stat
import sys
import uuid
import bridge_records
from bridge_control import BridgeControl
from host_autostart import AutostartFailure, ensure_host, give_back_first_call, watch_first_call
from host_mcp import (HostMcp, serve, BridgeFailure, RpcFailure, CANCEL_BEFORE_SEND, UPDATE_CLOSING, ident_key,
                      error_with_note, failure_note, mac_locked)
from runtime_paths import default_state, installation_from_native_cli, InstallationError
from claude_lifecycle import ScopeRouter, END_EVENTS, source as claude_source
from overlay import Overlay

DEFAULT_STATE = default_state()


def read_host_registry(state):
    if not state.is_absolute():
        raise BridgeFailure('The configured Codex host state path must be absolute.')
    parent = state.lstat()
    path = state/'host.json'
    info = path.lstat()
    if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid()
            or stat.S_IMODE(parent.st_mode) & 0o077
            or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) & 0o077):
        raise BridgeFailure('The Codex host registry is not private and owned.')
    data = json.loads(path.read_text())
    if (not isinstance(data, dict) or data.get('schema_version') != 1
            or data.get('status') != 'ready'
            or data.get('mechanism') != 'original_app_server_unix_websocket'):
        raise BridgeFailure('The Codex Desktop host launcher is not ready. No runtime was started.')
    for field in ('owner_pid', 'backend_pid', 'desktop_proxy_pid'):
        pid = data.get(field)
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
            raise BridgeFailure('The Codex host registry has no valid owned process binding.')
        try:
            os.kill(pid, 0)
        except (ProcessLookupError, PermissionError):
            raise BridgeFailure('The registered Codex host process is no longer available.') from None
    value = data.get('socket_path')
    if not isinstance(value, str) or not Path(value).is_absolute():
        raise BridgeFailure('The registered Codex Unix endpoint is invalid.')
    # HostMcp performs the endpoint ownership/mode and native plugin checks.
    return data


def endpoint_from_registry(state):
    return Path(read_host_registry(state)['socket_path'])


def build_adapter(state, **options):
    # Resolve on initialize, and again whenever the host connection was lost. A closed app is opened as the
    # original host; a failure stays a real MCP error instead of an independent CUA process.
    class RegisteredHost(HostMcp):
        lock_reader = staticmethod(mac_locked)

        def __init__(self, *args, agent_key=None, **kwargs):
            super().__init__(*args, **kwargs)
            self.claude_lifecycle = ScopeRouter(self)
            self.agent_key = agent_key
            self.agent_children = {}
            self.agent_boots = {}
            self.agent_requests = {}
            self.agent_approvals = {}
            self.family_closing = False
            self.family_close_lock = asyncio.Lock()
            self.family_report = None

        async def handle(self, message):
            if self.reject_updated_request(message):
                return
            token = self.claude_lifecycle.enter(message)
            try:
                if self.agent_key is None and isinstance(message, dict):
                    if 'method' not in message:
                        approval_key = ident_key(message.get('id'))
                        approval = self.agent_approvals.get(approval_key)
                        if approval is not None:
                            child, original = approval
                            await child.handle({**message, 'id': original})
                            if ident_key(original) not in child.approvals:
                                self.agent_approvals.pop(approval_key, None)
                            return
                    params = message.get('params')
                    if message.get('method') == 'notifications/cancelled' and isinstance(params, dict):
                        route = self.agent_requests.get(ident_key(params.get('requestId')))
                        if route is not None:
                            if not route['cancel_requested']:
                                route['cancel_requested'] = True
                                if route['delegated']:
                                    await route['child'].handle(message)
                                else:
                                    route['task'].cancel()
                            return
                    if message.get('method') == 'tools/call' and 'id' in message:
                        key = ident_key(message['id'])
                        if key in self.agent_requests or key in self.client_calls:
                            self.log('duplicate_active_request_ignored')
                            return
                        bound = self.claude_lifecycle.context.get()
                        if (bound and bound['agent_id']
                                and (params.get('name') if isinstance(params, dict) else None) not in ('status', 'repair')):
                            return await self.route_agent_call(message, bound)
                return await super().handle(message)
            finally:
                self.claude_lifecycle.context.reset(token)

        async def handle_bound(self, message, bound):
            # The primary bridge already verified this private binding before booting the child's thread. A Stop
            # hook may have pruned its file in the meantime; the request keeps that verified identity.
            token = self.claude_lifecycle.context.set(dict(bound))
            try:
                return await super().handle(message)
            finally:
                self.claude_lifecycle.context.reset(token)

        def child_emit(self, child, prefix, message):
            if message.get('method') == 'elicitation/create' and 'id' in message:
                original = message['id']
                external = prefix+str(original)
                self.agent_approvals[ident_key(external)] = (child, original)
                message = {**message, 'id': external}
            self.emit(message)

        def new_agent_child(self, key):
            child = RegisteredHost(*self.rpc_arguments, server=self.server, emit=lambda message: None,
                log=self.log, startup_timeout=self.startup_timeout, cleanup_timeout=self.cleanup_timeout,
                expected_plugin_id=self.expected_plugin_id, native_cua_root=self.native_cua_root, agent_key=key)
            prefix = 'cuabar-agent-'+uuid.uuid4().hex+'-'
            child.emit = lambda message: self.child_emit(child, prefix, message)
            child.owner = self.owner
            for attribute in ('control_state', 'claude_owner'):
                if hasattr(self, attribute):
                    setattr(child, attribute, getattr(self, attribute))
            child.thread_cwd = self.thread_cwd
            child.supports_elicitation = self.supports_elicitation
            child.update_pending = self.update_pending
            child.on_change = self.changed

            def record_call(*values):
                if self.on_call is not None:
                    self.on_call(*values)

            def browser_blocked(version):
                if self.on_browser_blocked is not None:
                    self.on_browser_blocked(version)

            child.on_call, child.on_browser_blocked = record_call, browser_blocked
            return child

        def mark_update_pending(self):
            super().mark_update_pending()
            for child in self.agent_children.values():
                child.mark_update_pending()

        async def boot_agent(self, child):
            child.initializing = child.boot_attempted = True
            try:
                await child.boot()
                return child
            except BaseException:
                await child.close()
                raise
            finally:
                child.initializing = False

        async def agent_child(self, bound, route):
            key = (bound['claude_session_id'], bound['agent_id'])
            child, boot = self.agent_children.get(key), self.agent_boots.get(key)
            if boot is not None and boot.done() and not boot.cancelled() and boot.exception() is not None:
                # A previous client may have stopped waiting before a failed lazy boot finished. A later request
                # starts a fresh owned connection instead of inheriting that already-failed boot task.
                child = None
            if child is None:
                child = self.new_agent_child(key)
                self.agent_children[key] = child
                boot = asyncio.create_task(self.boot_agent(child))
                self.agent_boots[key] = boot
                # A cancelled client call may stop waiting before boot finishes. Always retrieve a background boot
                # exception; it contains no client response and must not produce an unhandled-task traceback.
                boot.add_done_callback(lambda task: None if task.cancelled() else task.exception())
            route['child'] = child
            try:
                return await asyncio.shield(boot)
            except Exception:
                if self.agent_boots.get(key) is boot:
                    self.agent_boots.pop(key, None)
                    self.agent_children.pop(key, None)
                raise

        async def route_agent_call(self, message, bound):
            ident, params = message['id'], message.get('params')
            if (not self.initialized or self.family_closing or self.stopping or not isinstance(params, dict)
                    or params.get('name') not in self.tool_names or not isinstance(params.get('arguments', {}), dict)):
                # Let the ordinary validator report the invalid request, without creating a child or executing a tool.
                if not self.initialized or self.family_closing or self.stopping:
                    self.reply(ident, error={'code': -32001, 'message': 'This owned CUA connection is unavailable or stopping.'})
                    return
                self.reply(ident, error={'code': -32602, 'message': 'The agent CUA tool or its arguments are invalid.'})
                return
            key = ident_key(ident)
            route = {'task': asyncio.current_task(), 'child': None, 'delegated': False,
                     'cancel_requested': False, 'bound': dict(bound)}
            self.agent_requests[key] = route
            try:
                child = await self.agent_child(bound, route)
                if route['cancel_requested']:
                    raise asyncio.CancelledError
                route['delegated'] = True
                return await child.handle_bound(message, bound)
            except asyncio.CancelledError:
                if not route['cancel_requested']:
                    raise
                if not route['delegated']:
                    self.reply(ident, error={'code': -32800, 'message': CANCEL_BEFORE_SEND})
            except RpcFailure as error:
                self.reply(ident, error=error.error)
            except BridgeFailure as error:
                self.reply(ident, error=error_with_note({'code': -32001, 'message': str(error)}, failure_note(str(error))))
            except Exception:
                self.reply(ident, error={'code': -32603, 'message': 'The owned agent CUA connection could not be initialized.'})
            finally:
                if self.agent_requests.get(key) is route:
                    self.agent_requests.pop(key, None)

        def lifecycle_snapshot(self):
            return [entry for member in (self, *self.agent_children.values()) for entry in member.claude_lifecycle.snapshot()]

        def snapshot(self):
            own = super().snapshot()
            if self.agent_key is not None or not self.agent_children:
                return own
            views = [own, *[child.snapshot() for child in self.agent_children.values()]]
            scopes = [scope for view in views for scope in view['scopes']]
            return {**own, 'scopes': scopes, 'busy': any(view['busy'] for view in views),
                    'last_call_at': max((view['last_call_at'] for view in views if view['last_call_at']), default=None),
                    'cleanup': 'none' if not scopes else 'not_confirmed' if any(view['cleanup'] == 'not_confirmed' for view in views) else 'open'}

        async def end_claude_event(self, request):
            # ScopeRouter's session/agent/prompt filter makes a parent's Stop leave its children alone, and a
            # SubagentStop selects only that child. SessionEnd selects every owned scope of that Claude session.
            event, bound = request.get('event'), claude_source(request)
            if event not in END_EVENTS or bound is None:
                return {'released': False, 'reason': 'invalid_event', 'scope_count': 0}
            waiting = []
            for route in list(self.agent_requests.values()):
                original = route['bound']
                if route['delegated'] or original['claude_session_id'] != bound['claude_session_id']:
                    continue
                if event != 'SessionEnd':
                    if original['agent_id'] != bound['agent_id'] or (event == 'SubagentStop' and not bound['agent_id']):
                        continue
                    if event == 'UserPromptSubmit':
                        if bound['prompt_id'] and original['prompt_id'] == bound['prompt_id']:
                            continue
                    elif event != 'SubagentStop' and bound['prompt_id'] and original['prompt_id'] != bound['prompt_id']:
                        continue
                # No native scope exists while the thread is still booting. End hooks must also prevent those
                # matching requests from executing later, without cancelling another agent's shared boot waiter.
                route['cancel_requested'] = True
                route['task'].cancel()
                waiting.append(route['task'])
            if waiting:
                await asyncio.gather(*waiting, return_exceptions=True)
            answers = await asyncio.gather(*(member.claude_lifecycle.end(request)
                for member in (self, *self.agent_children.values())))
            failed = next((answer for answer in answers if not answer['released']), None)
            return {'released': failed is None, 'reason': failed['reason'] if failed else None,
                    'scope_count': sum(answer['scope_count'] for answer in answers)}

        async def release_scopes(self, wait=None, budget=None):
            if self.agent_key is not None or self.family_closing:
                return await super().release_scopes(wait, budget)
            members = [member for member in (self, *self.agent_children.values()) if member.scopes]
            if not members:
                return self.release_result(False, 'no_trusted_scope', 0)
            answers = await asyncio.gather(*(HostMcp.release_scopes(member, wait, budget) for member in members))
            failed = next((answer for answer in answers if not answer['released']), None)
            return self.release_result(failed is None, failed['reason'] if failed else None,
                                       sum(answer['scope_count'] for answer in answers))

        async def close(self):
            if self.agent_key is not None:
                return await super().close()
            async with self.family_close_lock:
                if self.family_report is not None:
                    return self.family_report
                self.family_closing = self.stopping = True
                boots = list(self.agent_boots.values())
                for boot in boots:
                    if not boot.done():
                        boot.cancel()
                await asyncio.gather(*boots, return_exceptions=True)
                members = [self, *self.agent_children.values()]
                reports = await asyncio.gather(*(HostMcp.close(member) for member in members))
                self.agent_approvals.clear()
                if self.overlay is not None:
                    await self.overlay.close()
                self.family_report = {
                    'owned_thread_unsubscribe': ('unconfirmed' if any(report['owned_thread_unsubscribe'] == 'unconfirmed' for report in reports)
                        else 'confirmed' if any(report['owned_thread_unsubscribe'] == 'confirmed' for report in reports) else 'not_created'),
                    'connection_close': 'confirmed' if all(report['connection_close'] == 'confirmed' for report in reports) else 'unconfirmed'}
                return self.family_report

        def current_scope(self):
            return self.claude_lifecycle.scope() or super().current_scope()

        async def end_scope(self, scope, timeout=None):
            confirmed = False
            try:
                confirmed, result = await super().end_scope(scope, timeout)
                return confirmed, result
            finally:
                self.claude_lifecycle.retired(scope, confirmed)

        async def end_turn_tool(self):
            bound = self.claude_lifecycle.context.get()
            if bound is None:
                return await super().end_turn_tool()
            result = await self.claude_lifecycle.end({'event': 'SubagentStop' if bound['agent_id'] else 'Stop', **bound})
            return {'content': [{'type': 'text', 'text': 'CUA lifecycle ended.' if result['released']
                                else 'CUA lifecycle cleanup was not confirmed.'}], 'isError': not result['released']}

        async def boot(self):
            try:
                try:
                    registry = await asyncio.to_thread(ensure_host, state, read_host_registry, log=self.log)
                except AutostartFailure as error:
                    raise BridgeFailure(str(error)) from None
                except InstallationError:
                    raise BridgeFailure('Install Codex Desktop, or set CODEX_CUA_APP_PATH to its original app bundle.') from None
                self.rpc.socket_path = Path(registry['socket_path'])
                self.registry = registry
                self.native_cua_root = None
                if isinstance(registry.get('native_cli'), str):
                    try:
                        self.native_cua_root = installation_from_native_cli(registry['native_cli']).cua_root
                    except InstallationError:
                        # Bundled plugin identity remains independently checked.
                        # A user relay requires a verifiable original runtime.
                        pass
            except BridgeFailure:
                raise
            except (OSError, ValueError):
                raise BridgeFailure('Start Codex with the prepared host launcher before using this MCP plugin. No runtime was started.') from None
            await super().boot()

        async def call_tool(self, name, arguments):
            if self.update_pending and name in ('js', 'js_reset'):
                raise BridgeFailure(UPDATE_CLOSING)
            # A Codex this process opened in the background is watched again at the first tool call: the first screen
            # call of a fresh Codex brings it forward (S4). The front app is read before the call goes out, off the
            # event loop, so a Codex that comes forward within milliseconds is not taken for one in front already;
            # the watch itself has a thread. A watch that cannot start must not fail the call, and a call that failed
            # on this side (BridgeFailure: never sent, or the connection was lost) leaves the chance to the next one;
            # a call Codex answered with an error did reach it.
            first = False
            scope = self.current_scope()
            key = (scope['session_id'], scope['turn_id'])
            self.claude_lifecycle.inflight[key] += 1
            try:
                try:
                    first = await asyncio.to_thread(watch_first_call)
                except Exception:
                    self.log('first_call_watch_unavailable')
                try:
                    return await super().call_tool(name, arguments)
                except BridgeFailure:
                    if first:
                        give_back_first_call()
                    raise
            finally:
                self.claude_lifecycle.inflight[key] -= 1

        async def thread_config(self, request):
            # The desktop app takes the launcher's relay override out of the host's configuration, so the relay
            # definition the launcher verified is given to this thread directly, with this bridge's name.
            config = await super().thread_config(request)
            try:
                from relay_install import SERVER_KEY, relay_thread_server
            except Exception:
                return config
            server = relay_thread_server(getattr(self, 'registry', None), self.native_cua_root, self.owner)
            if server is not None:
                config[SERVER_KEY] = server
            return config

        def codex_app_version(self):
            # The version of the app the registered host's CLI belongs to (its Info.plist, as the status reads it).
            try:
                import plistlib
                installation = installation_from_native_cli(getattr(self, 'registry', {})['native_cli'])
                with (installation.app_path/'Contents/Info.plist').open('rb') as source:
                    value = plistlib.load(source).get('CFBundleShortVersionString')
                return value if isinstance(value, str) and value else None
            except Exception:
                return None

        def host_info(self):
            # The registry the host wrote, but only when it still names the endpoint this connection is on.
            try:
                registry = read_host_registry(state)
                if Path(registry['socket_path']) == self.rpc.socket_path:
                    return {'pid': registry['backend_pid'], 'relay': registry.get('relay') is True}
            except Exception:
                pass
            return {'pid': None, 'relay': False}
    return RegisteredHost(None, Path('/unconfigured-codex-host'), 'cua_repl', **options)


async def main():
    state = Path(os.environ.get('CODEX_HOST_CUA_STATE_DIR', str(DEFAULT_STATE)))
    adapter = build_adapter(state)
    records_state = bridge_records.state_dir()
    type(adapter).overlay = Overlay(records_state, enabled=lambda: bridge_records.shows_overlay(records_state),
                                    log=adapter.log)
    cleanup = await serve(adapter, control_factory=BridgeControl, watch_updates=True)
    return 0 if cleanup['owned_thread_unsubscribe'] != 'unconfirmed' and cleanup['connection_close'] == 'confirmed' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(asyncio.run(main()))
    except (Exception, KeyboardInterrupt):
        print('Codex host MCP stopped or unavailable.', file=sys.stderr)
        raise SystemExit(1)
