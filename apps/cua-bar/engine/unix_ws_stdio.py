#!/usr/bin/python3
"""JSONL stdio <-> native app-server WebSocket-over-Unix transport.

Lines are framed, not interpreted: nothing is logged, approved or retried here, and this starts no execution server.
Every line goes to the other side as it came in, except in one case that exists only when the host launcher verified
the CUA relay and passed the --relay-* arguments. The desktop app starts and resumes its own threads with a
configuration of the bundled cua_repl server (params.config["mcp_servers.cua_repl"] of a client request). A line
that contains that literal key is decoded; if it is a client request whose cua_repl configuration is exactly the
verified bundled one (command, script, runtime path), it is encoded again as compact JSON with one change: the
environment of that server points at the relay launcher (more variables name the original runtime and node, and the
state directory when there is one). A line that is decoded but does not have exactly that shape goes out as it came
in, and so does every line without the key, every response and everything the app-server sends.
"""
import argparse
import asyncio
import json
import logging
import os
from pathlib import Path
import signal
import stat
import sys

TRANSPORT_LOGGER = logging.getLogger('codex_host_cua.native_stdio')
TRANSPORT_LOGGER.disabled = True

CONFIG_KEY = 'mcp_servers.cua_repl'
MARKER = b'"' + CONFIG_KEY.encode() + b'"'
RUNTIME_PATH = 'CUA_REPL_NODE_REPL_PATH'
RELAY_NAMES = ('CODEX_CUA_NATIVE_RUNTIME', 'CODEX_CUA_RELAY_NODE', 'CODEX_CUA_STATE_DIR')


async def lines(stream):
    pending = bytearray()
    while True:
        block = await stream.read(65536)
        if not block:
            if pending.strip():
                yield bytes(pending)
            return
        pending.extend(block)
        while True:
            index = pending.find(b'\n')
            if index < 0:
                break
            body = bytes(pending[:index])
            del pending[:index+1]
            if body.strip():
                yield body


def _launcher_trusted(path):
    """A runnable regular file of this user that nobody else can write, in a directory nobody else can write."""
    try:
        info = os.lstat(path)
        parent = os.lstat(os.path.dirname(path))
    except OSError:
        return False
    return (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_mode & stat.S_IXUSR
            and not info.st_mode & 0o022
            and stat.S_ISDIR(parent.st_mode) and parent.st_uid == os.getuid() and not parent.st_mode & 0o022)


class RelayRewrite:
    """Point the bundled cua_repl thread configuration of a client request at the relay launcher."""

    def __init__(self, launcher, native_runtime, node, script, state_dir=None):
        self.launcher, self.native_runtime, self.node, self.script = launcher, native_runtime, node, script
        self.state_dir = state_dir

    def __call__(self, body):
        if MARKER not in body:
            return body
        try:
            return self.rewrite(body)
        except Exception:
            return body

    def rewrite(self, body):
        message = json.loads(body)
        if not isinstance(message, dict) or not isinstance(message.get('method'), str):
            return body
        params = message.get('params')
        config = params.get('config') if isinstance(params, dict) else None
        entry = config.get(CONFIG_KEY) if isinstance(config, dict) else None
        env = entry.get('env') if isinstance(entry, dict) else None
        if (not isinstance(env, dict) or entry.get('command') != self.node or entry.get('args') != [self.script]
                or env.get(RUNTIME_PATH) != self.native_runtime or any(name in env for name in RELAY_NAMES)
                or not _launcher_trusted(self.launcher)):
            return body
        env[RUNTIME_PATH] = self.launcher
        env['CODEX_CUA_NATIVE_RUNTIME'] = self.native_runtime
        env['CODEX_CUA_RELAY_NODE'] = self.node
        if self.state_dir:
            env['CODEX_CUA_STATE_DIR'] = self.state_dir
        return json.dumps(message, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def validate_socket(path):
    entry = path.lstat()
    resolved = path.resolve(strict=True)
    info = resolved.stat()
    parent = path.parent.lstat()
    target_parent = resolved.parent.stat()
    if (not path.is_absolute() or not stat.S_ISSOCK(info.st_mode)
            or entry.st_uid != os.getuid()
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077
            or not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid()
            or stat.S_IMODE(parent.st_mode) & 0o077
            or not stat.S_ISDIR(target_parent.st_mode) or target_parent.st_uid != os.getuid()
            or stat.S_IMODE(target_parent.st_mode) & 0o077):
        raise RuntimeError('The existing Unix endpoint must be private and owned.')


async def serve(path, rewrite=None):
    import websockets
    validate_socket(path)
    loop = asyncio.get_running_loop()
    stream = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(stream), sys.stdin.buffer)
    stopped = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopped.set)
    async with websockets.unix_connect(str(path), uri='ws://localhost/rpc',
            max_size=None, max_queue=16, ping_interval=None,
            open_timeout=15, close_timeout=3, logger=TRANSPORT_LOGGER) as connection:
        async def outbound():
            async for body in lines(stream):
                if rewrite is not None:
                    body = rewrite(body)
                await connection.send(body.decode('utf-8'))
        async def inbound():
            async for body in connection:
                if not isinstance(body, str):
                    raise RuntimeError('Native app-server returned a non-text frame.')
                sys.stdout.buffer.write(body.encode('utf-8') + b'\n')
                sys.stdout.buffer.flush()
        tasks = [asyncio.create_task(outbound()), asyncio.create_task(inbound()),
                 asyncio.create_task(stopped.wait())]
        try:
            complete, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in complete:
                task.result()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.remove_signal_handler(sig)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', type=Path, required=True)
    parser.add_argument('--relay-launcher')
    parser.add_argument('--relay-native-runtime')
    parser.add_argument('--relay-node')
    parser.add_argument('--relay-script')
    parser.add_argument('--relay-state-dir')
    args = parser.parse_args()
    # The relay is all or nothing; a half-given set of paths means no rewriting at all.
    paths = (args.relay_launcher, args.relay_native_runtime, args.relay_node, args.relay_script)
    relay = (RelayRewrite(*paths, args.relay_state_dir) if all(item and os.path.isabs(item) for item in paths) else None)
    try:
        asyncio.run(serve(args.socket, relay))
    except (Exception, KeyboardInterrupt) as error:
        print('Codex native Unix transport unavailable or closed (' + type(error).__name__ + ').', file=sys.stderr)
        raise SystemExit(1)
