#!/usr/bin/python3
"""Installed plugin entry point: connect only to the Codex-owned private host."""
import asyncio
import json
import os
from pathlib import Path
import stat
import sys
from bridge_control import BridgeControl
from host_autostart import AutostartFailure, ensure_host, give_back_first_call, watch_first_call
from host_mcp import HostMcp, serve, BridgeFailure
from runtime_paths import default_state, installation_from_native_cli, InstallationError

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
            # A Codex this process opened in the background is watched again at the first tool call: the first screen
            # call of a fresh Codex brings it forward (S4). The front app is read before the call goes out, off the
            # event loop, so a Codex that comes forward within milliseconds is not taken for one in front already;
            # the watch itself has a thread. A watch that cannot start must not fail the call, and a call that fails
            # leaves the chance to the next one.
            first = False
            try:
                first = await asyncio.to_thread(watch_first_call)
            except Exception:
                self.log('first_call_watch_unavailable')
            try:
                return await super().call_tool(name, arguments)
            except BaseException:
                if first:
                    give_back_first_call()
                raise

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
    cleanup = await serve(build_adapter(state), control_factory=BridgeControl)
    return 0 if cleanup['owned_thread_unsubscribe'] != 'unconfirmed' and cleanup['connection_close'] == 'confirmed' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(asyncio.run(main()))
    except (Exception, KeyboardInterrupt):
        print('Codex host MCP stopped or unavailable.', file=sys.stderr)
        raise SystemExit(1)
