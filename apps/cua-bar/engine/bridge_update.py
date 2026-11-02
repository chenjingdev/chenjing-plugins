"""Let an old MCP transport close itself after its already accepted requests finish.

Only a verified difference from the atomically installed engine/current starts
the transition. Unknown or temporarily unreadable installation data does not.
The existing serve shutdown path owns scope cleanup and stdout EOF; this watcher
never cancels a native action, starts another process, or reconnects a client.
"""
import asyncio
from pathlib import Path

from runtime_identity import REVISION, RUNNING_IDENTITY, installed_identity, runtime_status

CHECK_SECONDS = 2.0


class UpdateWatch:
    def __init__(self, adapter, stopped, pending_requests, home=None, interval=CHECK_SECONDS,
                 running=None, read_installed=None):
        self.adapter, self.stopped = adapter, stopped
        self.pending_requests = pending_requests
        self.home = Path.home() if home is None else Path(home)
        self.interval = interval
        self.running = dict(RUNNING_IDENTITY if running is None else running)
        self.read_installed = installed_identity if read_installed is None else read_installed
        self.pending = False

    def check(self):
        if self.pending:
            return True
        try:
            installed = self.read_installed(self.home)
            status = runtime_status({'version': self.running.get('version'),
                                     'runtime_revision': self.running.get('revision')}, installed)
            # A known version and content identity on both sides are required.
            if (status['state'] != 'reconnect_required'
                    or not all(isinstance(value, str) and REVISION.fullmatch(value)
                               for value in (self.running.get('revision'), installed.get('revision')))):
                return False
            self.adapter.mark_update_pending()
            self.pending = True
            self.adapter.log('installed_update_waiting_for_requests')
            return True
        except Exception:
            return False

    def drained(self):
        if self.pending_requests():
            return False
        members = [self.adapter]
        seen = set()
        try:
            if self.adapter.snapshot().get('busy') is True:
                return False
            while members:
                member = members.pop()
                if id(member) in seen:
                    continue
                seen.add(id(member))
                if (getattr(member, 'initializing', False)
                        or getattr(member, 'active_tool_calls', 0) > 0
                        or any(not boot.done() for boot in getattr(member, 'agent_boots', {}).values())):
                    return False
                members.extend(getattr(member, 'agent_children', {}).values())
            return True
        except Exception:
            return False

    async def run(self):
        while not self.stopped.is_set():
            if self.check() and self.drained():
                self.adapter.log('installed_update_closing_old_mcp')
                self.stopped.set()
                return
            try:
                await asyncio.wait_for(self.stopped.wait(), self.interval)
            except asyncio.TimeoutError:
                pass
