#!/usr/bin/python3
"""JSONL stdio <-> native app-server WebSocket-over-Unix transport.

Only message framing changes. Original JSON message bodies are not decoded,
rewritten, logged, approved, or retried. This starts no execution server.
"""
import argparse
import asyncio
import logging
import os
from pathlib import Path
import signal
import stat
import sys
import websockets

TRANSPORT_LOGGER = logging.getLogger('codex_host_cua.native_stdio')
TRANSPORT_LOGGER.disabled = True


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


async def serve(path):
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
    args = parser.parse_args()
    try:
        asyncio.run(serve(args.socket))
    except (Exception, KeyboardInterrupt) as error:
        print('Codex native Unix transport unavailable or closed (' + type(error).__name__ + ').', file=sys.stderr)
        raise SystemExit(1)
