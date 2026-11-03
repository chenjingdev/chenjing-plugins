"""The glow around the screen edges while the AI works the Mac through cuabar (0.9.1): the bridge's side.

overlay-helper/cuabar-overlay draws it. One helper runs per user, on <records state>/overlay.sock; every bridge connects and
says "on" when its first js call starts, "off" when its last one ends (the helper keeps the glow LINGER seconds, so short
calls in a row do not blink) and "clear" after turn_ended (off at once). The helper shows the glow while any bridge is
on, and exits a few seconds after its last connection closed, so it never outlives the bridges; a bridge that dies
closes its connection and counts as off.

Only "on" starts the helper or connects to it. Nothing here waits on the call: lines go through a queue to one worker,
and a helper that cannot start or answer leaves the bridge without the glow. `codex-cua settings --overlay off` turns
it off from the next call (bridge_records.shows_overlay). The pointer is Codex Computer Use's own virtual cursor, which
already moves to each click, drag and scroll, so the helper draws none.
"""
import asyncio
import os
from pathlib import Path
import subprocess

SOCKET = 'overlay.sock'
BINARY = Path(__file__).resolve().parent/'overlay-helper'/'cuabar-overlay'
CONNECT_TRIES = 20
CONNECT_STEP = 0.05


def start_helper(binary, socket):
    subprocess.Popen([str(binary), str(socket)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)


class Overlay:
    def __init__(self, state, enabled=lambda: True, binary=BINARY, spawn=start_helper, log=None,
                 connect=asyncio.open_unix_connection, step=CONNECT_STEP):
        self.socket = Path(state)/SOCKET
        self.enabled, self.binary, self.spawn, self.connect, self.step = enabled, binary, spawn, connect, step
        self.log = log or (lambda event: None)
        self.active = 0
        self.lines = None
        self.worker = None
        self.writer = None
        self.broken = False

    def begin(self):
        """A js call starts."""
        self.active += 1
        if self.active == 1:
            self.send('on' if self.enabled() else 'clear')

    def end(self):
        """A js call ended: answered, failed or cancelled."""
        self.active = max(0, self.active-1)
        if self.active == 0:
            self.send('off')

    def clear(self):
        """turn_ended: no linger, unless a call of another agent of this bridge still runs."""
        if self.active == 0:
            self.send('clear')

    def send(self, line):
        if self.broken:
            return
        if self.lines is None:
            self.lines = asyncio.Queue()
            self.worker = asyncio.get_running_loop().create_task(self.work())
        self.lines.put_nowait(line)

    async def work(self):
        while True:
            line = await self.lines.get()
            if self.writer is not None and self.writer.is_closing():
                # The helper went away (it closed its end); the next "on" starts a new one.
                self.drop()
            if self.writer is None and (line != 'on' or not await self.attach()):
                continue
            try:
                self.writer.write(line.encode()+b'\n')
                await self.writer.drain()
            except (OSError, ConnectionError):
                self.drop()

    async def attach(self):
        try:
            return await self.open() or (await self.start() and await self.open(CONNECT_TRIES))
        except Exception:
            self.broken = True
            self.log('overlay_unavailable')
            return False

    async def start(self):
        if not os.access(self.binary, os.X_OK):
            raise OSError('no overlay helper')
        self.spawn(self.binary, self.socket)
        return True

    async def open(self, tries=1):
        for attempt in range(tries):
            try:
                _, self.writer = await self.connect(str(self.socket))
                return True
            except (OSError, ConnectionError):
                if attempt+1 < tries:
                    await asyncio.sleep(self.step)
        return False

    def drop(self):
        if self.writer is not None:
            self.writer.close()
            self.writer = None

    async def close(self):
        if self.worker is not None:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)
            self.worker = None
        self.drop()
