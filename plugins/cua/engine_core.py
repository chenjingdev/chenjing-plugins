"""Shared pieces of the engine commands: times, ids, thresholds and the injectable edges of the system.

Every engine command works on a Context. It holds the home folder, the environment and the few places where
the machine is touched (running ps/lsof/osascript/open, the clock, sleeping, signals), so tests replace them
and never touch real processes, apps or folders.
"""
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import time

SCHEMA_VERSION = 1
IDLE_SECONDS = 30*60       # R16: an idle connection has had no CUA call for more than 30 minutes
ACTIVE_SECONDS = 10        # R13: a CUA call in the last 10 seconds means the screen is in use
ACTIVITY_LIMIT = 200       # R18: the newest 200 operations
CONNECTION_ID = re.compile(r'^(claude|codex)-([0-9]{1,10})-([0-9]{1,12})$')
SESSION_ID = re.compile(r'^[0-9A-Za-z][0-9A-Za-z._:-]{0,199}$')
REASON = re.compile(r'^[a-z][a-z0-9_]{0,39}$')
_ISO = re.compile(r'^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$')


def iso(epoch):
    """2026-10-18T12:00:00Z, or None for an unknown time."""
    if epoch is None:
        return None
    return datetime.datetime.fromtimestamp(int(epoch), datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse_iso(value):
    """Epoch seconds of an ISO 8601 string, or None when it is not one."""
    if not isinstance(value, str):
        return None
    match = _ISO.match(value.strip())
    if not match:
        return None
    try:
        year, month, day, hour, minute, second = (int(item) for item in match.groups()[:6])
        stamp = datetime.datetime(year, month, day, hour, minute, second,
                                  tzinfo=datetime.timezone.utc).timestamp()
    except (ValueError, OverflowError):
        return None
    zone = match.group(7)
    if zone and zone != 'Z':
        digits = zone[1:].replace(':', '')
        stamp -= (1 if zone[0] == '+' else -1)*(int(digits[:2])*3600+int(digits[2:])*60)
    return stamp


def connection_id(agent, pid, started):
    return '%s-%d-%d' % (agent, pid, started)


def run_process(argv, timeout=5.0, environment=None):
    """Run a system tool and return its text output; the tools used here never need input."""
    return subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                          encoding='utf-8', errors='replace', timeout=timeout, env=environment)


class Context:
    def __init__(self, plugin_root, setup=None, home=None, environment=None, run=None, clock=None,
                 sleep=None, kill=None, application_roots=None, uid=None, pid=None, checks=None):
        self.plugin_root = Path(plugin_root)
        self.home = Path.home() if home is None else Path(home)
        self.environment = os.environ if environment is None else environment
        self.uid = os.getuid() if uid is None else uid
        self.pid = os.getpid() if pid is None else pid
        self.run = run or run_process
        self.clock = clock or time.time
        self.sleep = sleep or time.sleep
        self.kill = kill or os.kill
        self.application_roots = application_roots
        # None: the real setup checks of engine_inventory. Tests replace them.
        self.checks = checks
        self._setup = setup

    @property
    def setup(self):
        """The running setup.py module (the CLI passes it in); imported only when a test did not supply one."""
        if self._setup is None:
            import setup
            self._setup = setup
        return self._setup

    @property
    def state_dir(self):
        """Directory of the bridge and relay records: $CODEX_CUA_STATE_DIR when absolute, else the cache folder."""
        value = self.environment.get('CODEX_CUA_STATE_DIR')
        if value and os.path.isabs(value):
            return Path(value)
        return self.home/'Library/Caches/codex-cua'

    @property
    def host_state_dir(self):
        return Path(self.setup.configured_state(self.environment, self.home))

    def plugin_version(self):
        try:
            version = json.loads((self.plugin_root/'.claude-plugin/plugin.json').read_text()).get('version')
        except (OSError, ValueError, AttributeError):
            return None
        return version if isinstance(version, str) else None

    def call_environment(self):
        """Environment of the system tools: C locale, so that ps prints start times in a fixed language."""
        return dict(os.environ, LC_ALL='C')
