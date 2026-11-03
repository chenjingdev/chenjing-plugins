"""The glow while CUA works (overlay.py, overlay-helper/): the bridge's lines, the helper's start, and that nothing stays.

The Overlay tests talk to a fake helper on a temporary socket. The helper tests start the real binary on a temporary
socket and only connect and leave, so nothing is drawn on the screen."""
import asyncio
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from bridge_case import BridgeCase
import overlay

ENGINE = Path(__file__).resolve().parent.parent/'engine'
HELPER = ENGINE/'overlay-helper'


def short_folder(case):
    # A Unix socket path has at most 103 bytes; the test home can be longer.
    folder = Path(tempfile.mkdtemp(prefix='ov-', dir='/tmp'))
    case.addCleanup(shutil.rmtree, folder, True)
    return folder


class FakeHelper:
    """A helper that records each connection's lines."""

    def __init__(self, socket):
        self.socket = socket
        self.connections = []
        self.server = None

    async def start(self):
        self.server = await asyncio.start_unix_server(self.serve, path=str(self.socket))

    async def serve(self, reader, writer):
        lines = []
        self.connections.append(lines)
        while True:
            line = await reader.readline()
            if not line:
                lines.append('EOF')
                break
            lines.append(line.decode().strip())
        writer.close()

    async def stop(self):
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
            self.server = None

    def lines(self):
        return [line for lines in self.connections for line in lines]


class OverlayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = short_folder(self)
        self.helper = FakeHelper(self.folder/overlay.SOCKET)
        self.started = []
        self.enabled = True
        binary = self.folder/'cuabar-overlay'
        binary.write_text('#!/bin/sh\n')
        binary.chmod(0o700)
        self.overlay = overlay.Overlay(self.folder, enabled=lambda: self.enabled, binary=binary, spawn=self.spawn,
                                       step=0.01)
        self.addAsyncCleanup(self.helper.stop)
        self.addAsyncCleanup(self.overlay.close)

    def spawn(self, binary, socket):
        self.started.append((binary, socket))
        asyncio.get_running_loop().create_task(self.helper.start())

    async def settle(self, predicate):
        for _ in range(300):
            if predicate():
                return
            await asyncio.sleep(0.01)
        self.fail('not reached: %r' % (self.helper.connections,))

    async def test_the_first_call_turns_it_on_and_the_last_one_off_and_turn_ended_clears(self):
        await self.helper.start()
        self.overlay.begin()
        self.overlay.begin()                # an agent's call alongside
        self.overlay.end()
        self.overlay.clear()                # a call still runs: turn_ended of another agent keeps it
        self.overlay.end()
        self.overlay.clear()
        await self.settle(lambda: len(self.helper.lines()) == 3)
        self.assertEqual(self.helper.lines(), ['on', 'off', 'clear'])
        self.assertEqual(self.started, [])

    async def test_a_missing_helper_is_started_once_and_then_reached(self):
        self.overlay.begin()
        await self.settle(lambda: self.helper.lines() == ['on'])
        self.overlay.end()
        self.overlay.begin()
        await self.settle(lambda: self.helper.lines() == ['on', 'off', 'on'])
        self.assertEqual(self.started, [(self.overlay.binary, self.folder/overlay.SOCKET)])

    async def test_turned_off_it_starts_nothing_and_an_open_glow_is_cleared(self):
        self.enabled = False
        self.overlay.begin()
        self.overlay.end()
        await asyncio.sleep(0.1)
        self.assertEqual((self.started, self.helper.connections), ([], []))
        self.enabled = True
        await self.helper.start()
        self.overlay.begin()
        await self.settle(lambda: self.helper.lines() == ['on'])
        self.enabled = False
        self.overlay.end()
        self.overlay.begin()
        await self.settle(lambda: self.helper.lines() == ['on', 'off', 'clear'])

    async def test_only_on_reaches_for_the_helper(self):
        self.overlay.clear()
        self.overlay.begin()
        self.overlay.end()
        await self.settle(lambda: self.helper.lines() == ['on', 'off'])
        self.assertEqual(len(self.started), 1)

    async def test_a_helper_that_went_away_is_started_again_by_the_next_call(self):
        await self.helper.start()
        self.overlay.begin()
        self.overlay.end()
        await self.settle(lambda: self.helper.lines() == ['on', 'off'])
        # The helper exits: its end of the connection closes and the socket goes.
        await self.helper.stop()
        os.unlink(self.helper.socket)
        self.overlay.writer.transport.abort()
        self.helper.connections.clear()
        await asyncio.sleep(0.05)
        self.overlay.begin()
        await self.settle(lambda: self.helper.lines()[:1] == ['on'])
        self.assertEqual(len(self.started), 1)

    async def test_a_helper_that_cannot_start_leaves_the_bridge_without_glow_and_without_errors(self):
        logs = []
        broken = overlay.Overlay(self.folder, binary=self.folder/'missing', spawn=self.spawn, log=logs.append, step=0.01)
        self.addAsyncCleanup(broken.close)
        broken.begin()
        await asyncio.sleep(0.1)
        broken.end()
        broken.begin()
        await asyncio.sleep(0.05)
        self.assertEqual((self.started, logs, broken.broken), ([], ['overlay_unavailable'], True))

    async def test_closing_the_bridge_closes_its_connection_so_the_helper_counts_it_off(self):
        await self.helper.start()
        self.overlay.begin()
        await self.settle(lambda: self.helper.lines() == ['on'])
        await self.overlay.close()
        await self.settle(lambda: self.helper.lines() == ['on', 'EOF'])


class Recorder:
    def __init__(self):
        self.events = []

    def begin(self):
        self.events.append('begin')

    def end(self):
        self.events.append('end')

    def clear(self):
        self.events.append('clear')


class BridgeWiringTests(BridgeCase):
    async def adapter(self):
        self.add_host()
        adapter = self.plain_adapter()
        await self.initialize(adapter)
        adapter.overlay = Recorder()
        return adapter

    async def test_a_js_call_glows_while_it_runs_and_turn_ended_clears(self):
        adapter = await self.adapter()
        await self.run_call(adapter)
        self.assertEqual(adapter.overlay.events, ['begin', 'end'])
        await self.run_call(adapter, 'turn_ended')
        self.assertEqual(adapter.overlay.events, ['begin', 'end', 'clear'])

    async def test_a_cancelled_call_ends_its_glow_too(self):
        adapter = await self.adapter()
        await adapter.turn_lock.acquire()
        try:
            message = self.call()
            task = asyncio.create_task(adapter.handle(message))
            await self.settle(lambda: adapter.overlay.events == ['begin'])
            await adapter.handle({'jsonrpc': '2.0', 'method': 'notifications/cancelled',
                                  'params': {'requestId': message['id']}})
            await asyncio.wait_for(task, 5)
        finally:
            adapter.turn_lock.release()
        self.assertEqual(adapter.overlay.events, ['begin', 'end'])

    async def test_probes_and_fixtures_have_no_glow(self):
        adapter = self.plain_adapter()
        self.assertIsNone(adapter.overlay)


@unittest.skipUnless(sys.platform == 'darwin', 'the helper is a macOS binary')
class HelperTests(unittest.TestCase):
    def test_the_binary_was_built_from_this_source(self):
        digest = hashlib.sha256((HELPER/'cuabar-overlay.swift').read_bytes()).hexdigest()
        self.assertEqual((HELPER/'cuabar-overlay.source-sha256').read_text().strip(), digest,
                         'run overlay-helper/build.sh and commit the binary')
        self.assertTrue(os.access(HELPER/'cuabar-overlay', os.X_OK))
        self.assertEqual(overlay.BINARY, (ENGINE/'overlay-helper'/'cuabar-overlay').resolve())

    def connect(self, path):
        import socket
        for _ in range(200):
            client = socket.socket(socket.AF_UNIX)
            try:
                client.connect(str(path))
                return client
            except OSError:
                client.close()
                time.sleep(0.02)
        self.fail('the helper did not listen')

    def test_the_helper_leaves_after_its_last_connection_and_a_second_one_steps_aside(self):
        path = short_folder(self)/'overlay.sock'
        helper = subprocess.Popen([str(HELPER/'cuabar-overlay'), str(path)], stdin=subprocess.DEVNULL,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: helper.poll() is None and helper.kill())
        client = self.connect(path)
        second = subprocess.run([str(HELPER/'cuabar-overlay'), str(path)], timeout=10, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.assertEqual(second.returncode, 0)
        time.sleep(0.5)
        self.assertIsNone(helper.poll())            # it stays while a bridge is connected
        closed = time.monotonic()
        client.close()
        self.assertEqual(helper.wait(timeout=15), 0)
        self.assertLess(time.monotonic()-closed, 10)
        self.assertFalse(path.exists())

    def test_a_helper_nobody_reaches_leaves_by_itself(self):
        path = short_folder(self)/'overlay.sock'
        helper = subprocess.Popen([str(HELPER/'cuabar-overlay'), str(path)], stdin=subprocess.DEVNULL,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: helper.poll() is None and helper.kill())
        self.assertEqual(helper.wait(timeout=15), 0)
        self.assertFalse(path.exists())


if __name__ == '__main__':
    unittest.main()
