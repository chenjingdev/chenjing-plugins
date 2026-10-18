"""What is running on this Mac, read once: processes, the Codex app, the host registry and the setup state.

No network, no connection to the host and no browser call happen here, because the menu bar app asks for this
every few seconds. The process list comes from one ps call; lsof is asked only for the working folder of
processes that have no record, and only by the status command.
"""
from collections import namedtuple
from concurrent.futures import ThreadPoolExecutor
import json
import os
import plistlib
import re
import stat
import subprocess
import time

from engine_core import REASON

PS_FIELDS = 'pid=,ppid=,uid=,stat=,lstart=,rss=,command='
MONTHS = {name: number for number, name in enumerate(
    ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'), 1)}
_PS_LINE = re.compile(r'^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+'
                      r'(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s+(\d+)\s*(.*)$')
_BRIDGE = re.compile(r'/(?:cua|codex-computer-use|claude-computer-use-plugin)(?:/[0-9][0-9A-Za-z.+_-]*)?'
                     r'/mcp_stdio\.py(?=\s|$)')
_CMUX = re.compile(r'^/.*/cmux-cua(?:\s+([A-Za-z][\w-]*))?\s*$')
_CHROME = re.compile(r'^/.*?/(Google Chrome(?: Beta| Dev| Canary)?|Chromium)\.app/Contents/MacOS/\1(?:\s|$)')
CUA_REPL_SCRIPT = '/@oai/cua-repl/bin/cua-repl.mjs'
Proc = namedtuple('Proc', 'pid ppid uid start rss_kb command')
Host = namedtuple('Host', 'state since registry relay relay_reason')


def parse_ps(text):
    """pid -> Proc from `ps -o pid=,ppid=,uid=,stat=,lstart=,rss=,command=` printed with LC_ALL=C.

    Zombies are skipped (they hold nothing and cannot be told apart from a live process otherwise), and so is
    any line that does not parse, for example one printed in another language."""
    found = {}
    for line in text.splitlines():
        match = _PS_LINE.match(line)
        if not match:
            continue
        pid, ppid, uid, state, month, day, hour, minute, second, year, rss, command = match.groups()
        if state.startswith('Z') or month not in MONTHS:
            continue
        try:
            start = int(time.mktime((int(year), MONTHS[month], int(day), int(hour), int(minute), int(second),
                                     0, 0, -1)))
        except (ValueError, OverflowError):
            continue
        found[int(pid)] = Proc(int(pid), int(ppid), int(uid), start, int(rss), command)
    return found


def snapshot(ctx):
    result = ctx.run(['/bin/ps', '-axww', '-o', PS_FIELDS], timeout=5, environment=ctx.call_environment())
    procs = parse_ps(result.stdout or '')
    if not procs:
        raise RuntimeError('The process list could not be read.')
    return procs


def lookup(ctx, pid):
    """One process as it is right now, or None. Used to re-verify identity right before signalling."""
    result = ctx.run(['/bin/ps', '-ww', '-o', PS_FIELDS, '-p', str(pid)], timeout=5,
                     environment=ctx.call_environment())
    return parse_ps(result.stdout or '').get(pid)


def same_process(proc, uid, pid, started):
    """The identity of a process is its pid together with its start time (within a second)."""
    return proc is not None and proc.pid == pid and proc.uid == uid and abs(proc.start-started) <= 1


def mark_live(records, procs, uid):
    for record in records:
        record.live = same_process(procs.get(record.pid), uid, record.pid, record.started_at)


# --- what a process is ------------------------------------------------------------------------------------

def is_cua_repl(command):
    """A CUA runtime root: the bundled node running cua-repl.mjs (it starts node_repl or the relay)."""
    index = command.find(CUA_REPL_SCRIPT)
    return index > 0 and re.search(r'(?:^|/)node\s', command[:index]) is not None


def is_bridge(command, plugin_root):
    """A Claude bridge: a Python running this plugin's mcp_stdio.py (current or an older plugin name)."""
    match = _BRIDGE.search(command)
    start = match.start() if match else -1
    if match is None:
        own = str(plugin_root/'mcp_stdio.py')
        start = command.find(own)
        if start < 0 or command[start+len(own):start+len(own)+1] not in ('', ' ', '\t'):
            return False
    return any(os.path.basename(word).lower().startswith('python') for word in command[:start].split())


def cmux_mode(command):
    """None when the process is not cmux-cua; otherwise its first argument ('serve', 'mcp', or '')."""
    head = re.split(r'\s-', command, maxsplit=1)[0].strip()
    match = _CMUX.match(head)
    return None if match is None else (match.group(1) or '')


def is_app_server(command):
    before, found, _ = command.partition(' app-server')
    return bool(found) and re.match(r'^/.*?/codex(?:\s|$)', before) is not None


def is_chrome_main(command):
    return (_CHROME.match(command) is not None and '--type=' not in command and '--headless' not in command
            and '--user-data-dir' not in command)


# --- the host registry ------------------------------------------------------------------------------------

def read_host(ctx, procs):
    """State of the Codex host registry (host.json in the host state directory)."""
    directory = ctx.host_state_dir
    path = directory/'host.json'
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return Host('missing', None, None, False, None)
    except OSError:
        return Host('unknown', None, None, False, None)
    since = info.st_mtime
    try:
        parent = os.lstat(directory)
        private = (stat.S_ISDIR(parent.st_mode) and parent.st_uid == ctx.uid and not stat.S_IMODE(parent.st_mode) & 0o077
                   and stat.S_ISREG(info.st_mode) and info.st_uid == ctx.uid
                   and not stat.S_IMODE(info.st_mode) & 0o077)
        data = json.loads(path.read_text()) if private else None
    except (OSError, ValueError):
        data = None
    if (not isinstance(data, dict) or data.get('schema_version') != 1
            or data.get('mechanism') != 'original_app_server_unix_websocket'):
        return Host('unknown', since, None, False, None)

    def alive(pid):
        proc = procs.get(pid) if isinstance(pid, int) and not isinstance(pid, bool) else None
        return proc is not None and proc.uid == ctx.uid
    relay = data.get('relay') is True
    # relay_reason is a fixed code word (stable_copy, unknown_field, ...) that says why the wrapper left the relay out.
    code = data.get('relay_reason')
    code = code if isinstance(code, str) and REASON.match(code) and not relay else None
    status = data.get('status')
    pids = [data.get(key) for key in ('owner_pid', 'backend_pid', 'desktop_proxy_pid')]
    if status == 'ready':
        socket_path = data.get('socket_path')
        if (not isinstance(socket_path, str) or not os.path.isabs(socket_path)
                or any(not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0 for pid in pids)):
            return Host('unknown', since, None, relay, code)
        return Host('ready' if all(alive(pid) for pid in pids) else 'closed', since, data, relay, code)
    if status == 'starting':
        return Host('starting' if alive(pids[0]) else 'closed', since, data, relay, code)
    if status in ('closed', 'cleanup_unconfirmed'):
        return Host('closed', since, data, relay, code)
    return Host('unknown', since, None, relay, code)


# --- the Codex app ----------------------------------------------------------------------------------------

def find_installation(ctx):
    from runtime_paths import discover_installation, InstallationError
    try:
        return discover_installation(ctx.environment, ctx.home, ctx.application_roots)
    except (InstallationError, OSError):
        return None


def app_version(installation):
    try:
        with (installation.app_path/'Contents/Info.plist').open('rb') as source:
            value = plistlib.load(source).get('CFBundleShortVersionString')
    except (OSError, ValueError, plistlib.InvalidFileException):
        return None
    return value if isinstance(value, str) and value else None


def app_pids(procs, installation, uid):
    """Main processes of the Codex app (its helpers have other executables)."""
    if installation is None:
        return []
    executables = {str(installation.executable),
                   str(installation.app_path/'Contents/MacOS'/installation.executable.name)}
    return sorted(proc.pid for proc in procs.values() if proc.uid == uid and any(
        proc.command == item or proc.command.startswith(item+' ') for item in executables))


# --- the setup state (what doctor looks at, without probing the host) -------------------------------------

def _guard(function, default):
    try:
        return function()
    except Exception:
        return default


def command_state(ctx, support):
    target = ctx.home/'.local/bin/codex-cua'
    try:
        info = os.lstat(target)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != ctx.uid:
            return 'missing'
        authored = ctx.setup.MARKER in target.read_text().splitlines()[:3]
    except (OSError, UnicodeError):
        return 'missing'
    return 'ready' if authored and (support/'command.py').is_file() else 'missing'


def login_environment_state(ctx):
    setup = ctx.setup
    try:
        agent = setup.login_agent_path(ctx.home)
        if agent.is_file():
            try:
                label = plistlib.loads(agent.read_bytes()).get('Label')
            except (ValueError, OSError):
                return 'unknown'
            if label != setup.LOGIN_LABEL:
                return 'conflict'
            return setup.login_environment_status(ctx.home, ctx.environment)
        # Without our agent a value that someone else put into the login session blocks our setup.
        expected = setup.login_values(ctx.home, ctx.environment)
        current = setup.launchd_value('CODEX_CLI_PATH')
        return 'conflict' if current and current != expected.get('CODEX_CLI_PATH') else 'missing'
    except Exception:
        return 'unknown'


def _owned_safe(info, uid):
    return info.st_uid == uid and not stat.S_IMODE(info.st_mode) & 0o022


def wrapper_state(ctx, support):
    """ready: the launcher script Codex runs and everything it starts are in place."""
    launcher = support/'start-desktop-cli.sh'
    try:
        info = os.lstat(launcher)
    except FileNotFoundError:
        return 'missing'
    except OSError:
        return 'broken'
    try:
        if (not stat.S_ISREG(info.st_mode) or not _owned_safe(info, ctx.uid) or not info.st_mode & 0o100
                or ctx.setup.MARKER not in launcher.read_text().splitlines()[:3]
                or not (support/'venv/bin/python3').is_file() or not (support/'command.py').is_file()):
            return 'broken'
        for name in ('desktop_cli_wrapper.py', 'unix_ws_stdio.py'):
            compile((ctx.plugin_root/name).read_bytes(), name, 'exec', dont_inherit=True)
    except (OSError, SyntaxError, ValueError, UnicodeError):
        return 'broken'
    return 'ready'


# What the stable copy of the relay must look like (the same rules as relay_install.relay_files_status): a private
# directory, plain files of this user that nobody else can write, an executable launcher, and the end marker that
# only a completely written copy has.
RELAY_FILES = (('relay.mjs', b'// codex-cua relay end'), ('node-repl-relay', b'# codex-cua relay end'))


def relay_files_state(support, uid):
    """ready / missing / invalid for <support>/relay/."""
    directory = support/'relay'
    try:
        info = os.lstat(directory)
    except FileNotFoundError:
        return 'missing'
    except OSError:
        return 'invalid'
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) & 0o077:
        return 'invalid'
    for name, marker in RELAY_FILES:
        path = directory/name
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            return 'missing'
        except OSError:
            return 'invalid'
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) & 0o022:
            return 'invalid'
        if name == 'node-repl-relay' and not stat.S_IMODE(info.st_mode) & stat.S_IXUSR:
            return 'invalid'
        try:
            if not path.read_bytes().rstrip().endswith(marker):
                return 'invalid'
        except OSError:
            return 'invalid'
    return 'ready'


def setup_checks(ctx):
    setup = ctx.setup
    support = setup.support_root(ctx.home)
    # Once the relay is part of this plugin, setup.relay_status is the one source of truth that doctor uses too.
    relay_status = getattr(setup, 'relay_status', None)
    relay = (lambda: relay_status(ctx.home)) if callable(relay_status) else (lambda: relay_files_state(support, ctx.uid))
    return {'command': _guard(lambda: command_state(ctx, support), 'missing'),
            'dependencies': 'ready' if _guard(lambda: setup.venv_ready(support), False) else 'missing',
            'login_environment': login_environment_state(ctx),
            'wrapper': _guard(lambda: wrapper_state(ctx, support), 'broken'),
            'relay_files': _guard(relay, 'invalid')}


# --- working folders --------------------------------------------------------------------------------------

def working_folders(ctx, pids):
    """pid -> working folder through one lsof call; empty when lsof is not available."""
    pids = sorted(set(pids))[:200]
    if not pids:
        return {}
    try:
        result = ctx.run(['/usr/sbin/lsof', '-a', '-d', 'cwd', '-Fpn', '-p', ','.join(str(pid) for pid in pids)],
                         timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        return {}
    found, current = {}, None
    for line in (result.stdout or '').splitlines():
        if line.startswith('p') and line[1:].isdigit():
            current = int(line[1:])
        elif line.startswith('n') and current is not None and os.path.isabs(line[1:]) and len(line) <= 1025:
            found[current] = line[1:]
    return found


# --- the inventory ----------------------------------------------------------------------------------------

UNCHECKED = {'command': 'missing', 'dependencies': 'missing', 'login_environment': 'unknown',
             'wrapper': 'broken', 'relay_files': 'invalid'}


class Inventory:
    def __init__(self, ctx, procs, installation, host, checks):
        self.ctx = ctx
        self.procs = procs
        self.mine = {pid: proc for pid, proc in procs.items() if proc.uid == ctx.uid}
        self.children = {}
        for proc in procs.values():
            self.children.setdefault(proc.ppid, []).append(proc.pid)
        self.installation = installation
        self.app_version = app_version(installation) if installation is not None else None
        self.app_pids = app_pids(procs, installation, ctx.uid)
        self.host = host
        self._checks = checks          # the setup checks, or a Future that still has them to deliver
        self.cua_repl = sorted(pid for pid, proc in self.mine.items() if is_cua_repl(proc.command))
        self.bridges = sorted(pid for pid, proc in self.mine.items() if is_bridge(proc.command, ctx.plugin_root))
        self.app_servers = sorted(pid for pid, proc in self.mine.items() if is_app_server(proc.command))
        modes = {pid: cmux_mode(proc.command) for pid, proc in self.mine.items()}
        self.cmux_daemons = sorted(pid for pid, mode in modes.items() if mode is not None and mode != 'mcp')
        self.cmux_clients = sorted({self.mine[pid].ppid for pid, mode in modes.items() if mode == 'mcp'})
        starts = [proc.start for proc in self.mine.values() if is_chrome_main(proc.command)]
        self.chrome_started = min(starts) if starts else None

    @property
    def checks(self):
        """The setup checks. They run beside the process list and the lsof call, so this may wait for them."""
        if hasattr(self._checks, 'result'):
            try:
                self._checks = self._checks.result()
            except Exception:
                self._checks = UNCHECKED
        return self._checks

    def subtree(self, root):
        """root and every process below it."""
        found, queue = [], [root]
        while queue:
            pid = queue.pop()
            if pid in found or pid not in self.procs:
                continue
            found.append(pid)
            queue.extend(self.children.get(pid, ()))
        return found

    def rss_bytes(self, pids):
        return sum(self.procs[pid].rss_kb for pid in pids if pid in self.procs)*1024

    def ancestors(self, pid, limit=12):
        found = []
        while pid in self.procs and pid > 1 and pid not in found and len(found) < limit:
            found.append(pid)
            pid = self.procs[pid].ppid
        return found

    def protected_pids(self, owners=()):
        """Processes the engine never signals: the Codex app and its servers, the AI clients that own a
        connection, cmux-cua, Chrome, and the engine itself with everything above it."""
        protected = set(self.app_pids) | set(self.app_servers) | set(self.cmux_daemons) | set(self.cmux_clients)
        protected |= {pid for pid, proc in self.mine.items() if cmux_mode(proc.command) is not None}
        protected |= {pid for pid, proc in self.mine.items() if is_chrome_main(proc.command)}
        protected |= set(owners)
        protected |= set(self.ancestors(self.ctx.pid))
        return protected


def collect(ctx, with_checks=True):
    """One consistent look at the machine. The setup checks (a Python start, launchctl) run while the rest is read."""
    checks = UNCHECKED
    if with_checks:
        pool = ThreadPoolExecutor(max_workers=1)
        checks = pool.submit(ctx.checks or setup_checks, ctx)
        pool.shutdown(wait=False)      # the worker ends after this one job; nobody has to wait for it here
    procs = snapshot(ctx)
    return Inventory(ctx, procs, find_installation(ctx), read_host(ctx, procs), checks)
