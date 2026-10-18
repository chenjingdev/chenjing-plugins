"""Fixtures for the engine tests: a fake Mac and the files and sockets that bridges and relays leave behind.

Nothing here touches the machine the tests run on. The process table, the clock, signals and the system tools
(ps, lsof, osascript, open) are replaced; HOME, the state directories and the app are temporary; control sockets
are real Unix sockets in a temporary folder, served by threads of the test.
"""
import asyncio
import calendar
import json
import os
from pathlib import Path
import plistlib
import signal
import socket
import subprocess
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

from engine_core import Context, iso
from test_runtime_paths import fake_app

NOW = calendar.timegm((2026, 10, 18, 12, 0, 0))
UID = os.getuid()
ENGINE_PID = 999001
APP_VERSION = '26.1013.40934'
SESSION_A = '019a0000-0000-7000-8000-00000000000a'
SESSION_B = '019a0000-0000-7000-8000-00000000000b'
SESSION_C = '019a0000-0000-7000-8000-00000000000c'
SESSION_D = '019a0000-0000-7000-8000-00000000000d'
WEEKDAYS = ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')
MONTHS = ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec')


def lstart(epoch):
    """The start time the way `ps -o lstart=` prints it with LC_ALL=C."""
    moment = time.localtime(epoch)
    return '%s %s %2d %02d:%02d:%02d %d' % (WEEKDAYS[moment.tm_wday], MONTHS[moment.tm_mon-1], moment.tm_mday,
                                            moment.tm_hour, moment.tm_min, moment.tm_sec, moment.tm_year)


def at(seconds_ago):
    return NOW-seconds_ago


class Machine:
    """A fake Mac: a process table plus the system tools and signals the engine uses."""

    def __init__(self, now=NOW):
        self.now = float(now)
        self.procs = {}
        self.cwds = {}
        self.signals = []          # (pid, signal) the engine sent
        self.commands = []         # argv of every system tool call
        self.ignore_term = set()   # pids that survive SIGTERM
        self.deny = set()          # pids the engine may not signal
        self.quit_delay = 1.0      # seconds until the app is gone after the quit event; None: it refuses
        self.launch_delay = 1.0    # seconds until the app is running after `open`; None: it never comes back
        self.open_status = 0
        self.app_processes = []    # (pid, command) restored by `open`
        self.timeline = []
        self.lock = threading.RLock()
        self.on_signal = {}        # pid -> callable(sig) run when the engine signals that pid

    # --- the process table ------------------------------------------------------------------------------
    def add(self, pid, ppid, command, start=None, rss_kb=10_000, uid=UID, state='Ss'):
        with self.lock:
            self.procs[pid] = {'ppid': ppid, 'uid': uid, 'state': state, 'start': NOW-3600 if start is None else start,
                               'rss': rss_kb, 'command': command}
        return pid

    def remove(self, pid):
        with self.lock:
            self.procs.pop(pid, None)

    def ps_line(self, pid):
        proc = self.procs[pid]
        return '%5d %5d %5d %-4s %s %7d %s' % (pid, proc['ppid'], proc['uid'], proc['state'], lstart(proc['start']),
                                              proc['rss'], proc['command'])

    # --- time ---------------------------------------------------------------------------------------------
    def clock(self):
        return self.now

    def sleep(self, seconds):
        with self.lock:
            self.now += seconds
            due = [item for item in self.timeline if item[0] <= self.now]
            self.timeline = [item for item in self.timeline if item[0] > self.now]
        for _, action in due:
            action()

    def later(self, seconds, action):
        with self.lock:
            self.timeline.append((self.now+seconds, action))

    # --- the system tools --------------------------------------------------------------------------------
    def run(self, argv, timeout=None, environment=None):
        with self.lock:
            self.commands.append(list(argv))
            tool = argv[0]
            if tool == '/bin/ps':
                assert environment and environment.get('LC_ALL') == 'C', 'ps must run in the C locale'
                if '-p' in argv:
                    pid = int(argv[argv.index('-p')+1])
                    text = self.ps_line(pid)+'\n' if pid in self.procs else ''
                    return types.SimpleNamespace(returncode=0 if text else 1, stdout=text)
                return types.SimpleNamespace(returncode=0, stdout='\n'.join(self.ps_line(pid) for pid in self.procs)+'\n')
            if tool == '/usr/sbin/lsof':
                wanted = [int(item) for item in argv[argv.index('-p')+1].split(',')]
                text = ''.join('p%d\nfcwd\nn%s\n' % (pid, self.cwds[pid]) for pid in wanted if pid in self.cwds)
                return types.SimpleNamespace(returncode=0 if text else 1, stdout=text)
            if tool == '/usr/bin/osascript':
                if self.quit_delay is not None:
                    self.later(self.quit_delay, self.close_app)
                return types.SimpleNamespace(returncode=0, stdout='')
            if tool == '/usr/bin/open':
                if self.open_status == 0 and self.launch_delay is not None:
                    self.later(self.launch_delay, self.open_app)
                return types.SimpleNamespace(returncode=self.open_status, stdout='')
        raise AssertionError('unexpected system tool: '+tool)

    def close_app(self):
        with self.lock:
            for pid, proc in list(self.procs.items()):
                if proc['command'].endswith('/Contents/MacOS/ChatGPT'):
                    self.app_processes.append((pid, proc['command']))
                    del self.procs[pid]

    def open_app(self):
        for pid, command in self.app_processes:
            self.add(pid+1000, 1, command, start=int(self.now))

    def kill(self, pid, number):
        with self.lock:
            self.signals.append((pid, number))
            if pid in self.deny:
                raise PermissionError(pid)
            if pid not in self.procs:
                raise ProcessLookupError(pid)
            if number == signal.SIGTERM and pid in self.ignore_term:
                return
            if pid in self.on_signal:
                self.on_signal[pid](number)
            if number in (signal.SIGTERM, signal.SIGKILL):
                self.procs.pop(pid, None)


class Commands:
    """Command lines of the processes the engine knows how to recognise."""

    def __init__(self, home, app):
        self.app_main = str(app/'Contents/MacOS/ChatGPT')
        native = app/'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
        self.app_server = '%s -c features.code_mode_host=true app-server --analytics-default-enabled' % native
        node = app/'Contents/Resources/cua_node/bin/node'
        self.cua_repl = '%s %s' % (node, app/'Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')
        self.node_repl = str(app/'Contents/Resources/cua_node/bin/node_repl')
        self.relay = '%s %s' % (node, home/'.local/share/codex-cua/relay/relay.mjs')
        self.bridge = '%s %s' % (home/'.local/share/codex-cua/venv/bin/python3',
                                 home/'.claude/plugins/cache/chenjing-plugins/cua/0.7.0/mcp_stdio.py')
        self.old_bridge = '/usr/bin/python3 %s' % (home/'.claude/plugins/cache/chenjing-plugins/cua/0.5.0/mcp_stdio.py')
        self.claude = '%s --settings /fixture/settings.json' % (home/'.local/bin/claude')
        cmux = home/'Library/Application Support/cmux/cmux-cua/helper/com.cmuxterm.app/cmux Computer Use.app/Contents/MacOS/cmux-cua'
        self.cmux_serve = '%s serve --socket /fixture/cmux-cua.sock' % cmux
        self.cmux_mcp = '%s mcp --socket /fixture/cmux-cua.sock' % cmux
        self.chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'


class State:
    """The state directory with bridge and relay records (records.md), all private."""

    def __init__(self, root):
        self.root = Path(root)
        for directory in (self.root, self.root/'bridges', self.root/'relays'):
            directory.mkdir(mode=0o700, exist_ok=True)
            os.chmod(directory, 0o700)

    @staticmethod
    def scope(session, turn='turn-1', first=None, last=None, subagent=None):
        item = {'session_id': session, 'turn_id': turn, 'first_at': iso(at(600) if first is None else first),
                'last_at': iso(at(300) if last is None else last)}
        if subagent is not None:
            item['subagent'] = subagent
        return item

    def _write(self, kind, name, data, age=3600):
        directory = self.root/(kind+'s')/('%s-%s' % (kind, name))
        directory.mkdir(mode=0o700, exist_ok=True)
        path = directory/(kind+'.json')
        path.write_text(json.dumps(data))
        os.chmod(path, 0o600)
        os.utime(path, (NOW-age, NOW-age))
        return directory

    def bridge(self, name, pid, started_at, age=3600, **fields):
        data = {'schema_version': 1, 'kind': 'bridge', 'pid': pid, 'started_at': started_at, 'owner_pid': 500,
                'cwd': '/work/bridge', 'control_path': None, 'host': {'pid': 1100, 'relay': True},
                'session_id': None, 'turn_id': None, 'connected_at': iso(at(900)), 'last_call_at': None,
                'busy': False, 'scopes': [], 'cleanup': 'none', 'updated_at': iso(at(60))}
        data.update(fields)
        return self._write('bridge', name, {key: value for key, value in data.items() if value is not Ellipsis}, age)

    def relay(self, name, pid, started_at, age=3600, **fields):
        data = {'schema_version': 1, 'kind': 'relay', 'pid': pid, 'started_at': started_at, 'runtime_pid': pid+1,
                'root_pid': pid-1, 'app_server_pid': 1100, 'cwd': '/work/relay', 'control_path': None,
                'last_call_at': None, 'busy': False, 'scopes': [], 'cleanup': 'none', 'updated_at': iso(at(60))}
        data.update(fields)
        return self._write('relay', name, {key: value for key, value in data.items() if value is not Ellipsis}, age)

    def activity(self, lines):
        path = self.root/'activity.jsonl'
        path.write_text(''.join(json.dumps(line)+'\n' if isinstance(line, dict) else line for line in lines))
        os.chmod(path, 0o600)

    @staticmethod
    def line(writer, seconds_ago, session=None, tool='js', ok=True, ms=1000):
        return {'at': iso(at(seconds_ago)), 'writer': writer, 'session_id': session, 'tool': tool, 'ok': ok, 'ms': ms}

    def names(self, kind):
        return sorted(item.name for item in (self.root/(kind+'s')).iterdir())

    def read(self, kind, name):
        return json.loads((self.root/(kind+'s')/('%s-%s' % (kind, name))/(kind+'.json')).read_text())


class ControlServer:
    """A bridge's or relay's control socket: one JSON line in, one JSON line out, identity checked like the real ones."""

    def __init__(self, directory, pid, started_at, handler):
        self.path = Path(directory)/'control.sock'
        self.pid, self.started_at, self.handler = pid, started_at, handler
        self.requests = []
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(str(self.path))
        os.chmod(self.path, 0o600)
        self.listener.listen(8)
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        while True:
            try:
                client, _ = self.listener.accept()
            except OSError:
                return
            threading.Thread(target=self.answer, args=(client,), daemon=True).start()

    def answer(self, client):
        try:
            client.settimeout(5)
            data = b''
            while b'\n' not in data:
                chunk = client.recv(1024)
                if not chunk:
                    break
                data += chunk
            request = json.loads(data.decode())
            self.requests.append(request)
            if request.get('pid') != self.pid or request.get('started_at') != self.started_at:
                return
            reply = self.handler(request)
            if reply is not None:
                client.sendall((json.dumps(reply)+'\n').encode())
        except (OSError, ValueError):
            pass
        finally:
            client.close()

    def close(self):
        self.listener.close()
        self.thread.join(2)


TOOLS = {
    'js': {'name': 'js', 'description': 'fixture', 'inputSchema': {'type': 'object', 'properties': {'code': {'type': 'string'}}}},
    'js_reset': {'name': 'js_reset', 'inputSchema': {'type': 'object'}},
    'turn_ended': {'name': 'turn_ended', 'description': 'fixture', 'inputSchema': {'type': 'object', 'properties': {
        'hook_event_name': {'type': 'string'}, 'session_id': {'type': 'string'}, 'turn_id': {'type': 'string'}},
        'required': ['hook_event_name', 'session_id', 'turn_id']}},
}
NATIVE_PLUGIN_ID = 'unified-computer-use@openai-bundled'
OWN_THREAD = 'engine-owned-thread'
# Page text the fake runtime returns around the one line the engine reads. None of it may ever be printed.
DECOY = 'TITLE_SENTINEL https://private.example/secret?token=SECRET_SENTINEL'


class FakeHost:
    """The app-server side of the Unix WebSocket connection (what host_mcp.unix_connect would return)."""

    def __init__(self, tools=None, thread_id=OWN_THREAD, plugin_id=NATIVE_PLUGIN_ID):
        self.incoming = asyncio.Queue()
        self.plugin_id = plugin_id
        self.received = []
        self.calls = []            # params of every mcpServer/tool/call
        self.closed = False
        self.thread_id = thread_id
        self.tasks = set()
        self.tools = tools or {}
        self.hooks = {}            # method -> callable run before the host answers it
        self.hang = set()          # methods the host never answers
        self.errors = {}           # method -> JSON-RPC error the host answers with

    async def send(self, raw):
        if self.closed:
            raise ConnectionError('closed')
        message = json.loads(raw)
        self.received.append(message)
        task = asyncio.create_task(self.answer(message))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        await asyncio.sleep(0)

    def __aiter__(self):
        return self

    async def __anext__(self):
        value = await self.incoming.get()
        if value is None:
            raise StopAsyncIteration
        return value

    def emit(self, message):
        if not self.closed:
            self.incoming.put_nowait(json.dumps(message))

    async def close(self):
        if not self.closed:
            self.closed = True
            self.incoming.put_nowait(None)
            for task in list(self.tasks):
                task.cancel()

    async def answer(self, message):
        method, ident = message.get('method'), message.get('id')
        if method is None or method == 'initialized':
            return
        if method in self.hooks:
            self.hooks[method]()
        if method in self.hang:
            await asyncio.sleep(3600)
        if method in self.errors:
            self.emit({'id': ident, 'error': self.errors[method]})
            return
        if method == 'initialize':
            result = {'userAgent': 'fixture', 'codexHome': '/fixture/codex-home', 'platformFamily': 'unix',
                      'platformOs': 'macos'}
        elif method == 'thread/start':
            result = {'thread': {'id': self.thread_id, 'ephemeral': True}}
        elif method == 'mcpServerStatus/list':
            result = {'data': [{'name': 'cua_repl', 'pluginId': self.plugin_id, 'runtimeStatus': 'connected',
                                'tools': TOOLS, 'toolsError': None}], 'nextCursor': None}
        elif method == 'mcpServer/tool/call':
            params = message['params']
            self.calls.append(params)
            handler = self.tools.get(params['tool'])
            result = await handler(params) if handler else {'content': [{'type': 'text', 'text': '{}'}]}
            if isinstance(result, dict) and '__error__' in result:
                self.emit({'id': ident, 'error': result['__error__']})
                return
        elif method == 'thread/unsubscribe':
            result = {'status': 'unsubscribed'}
        else:
            raise AssertionError('unexpected method '+str(method))
        self.emit({'id': ident, 'result': result})


class EngineCase(unittest.TestCase):
    """A temporary world: HOME, an app, state directories and a fake Mac. Real homes, signals and commands are off limits."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/tmp', prefix='cx-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root/'home'
        self.home.mkdir()
        self.app, self.native, self.cua = fake_app(self.home/'Applications')
        info_path = self.app/'Contents/Info.plist'
        info = plistlib.loads(info_path.read_bytes())
        info['CFBundleShortVersionString'] = APP_VERSION
        info_path.write_bytes(plistlib.dumps(info))
        self.commands = Commands(self.home, self.app)
        self.machine = Machine()
        self.state = State(self.root/'state')
        self.host_dir = self.root/'host'
        self.host_dir.mkdir(mode=0o700)
        self.servers = []
        self.sockets = []
        self.addCleanup(self.close_servers)
        for patcher in (patch.object(Path, 'home', side_effect=AssertionError('the real home must not be used')),
                        patch.object(os, 'kill', side_effect=AssertionError('no real signal')),
                        patch.object(subprocess, 'run', side_effect=AssertionError('no real command')),
                        patch.object(subprocess, 'Popen', side_effect=AssertionError('no real command'))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def close_servers(self):
        for server in self.servers:
            server.close()
        for listener in self.sockets:
            listener.close()

    # --- building the world -------------------------------------------------------------------------------
    def context(self, checks=None, **overrides):
        environment = {'CODEX_CUA_STATE_DIR': str(self.state.root), 'CODEX_HOST_CUA_STATE_DIR': str(self.host_dir)}
        environment.update(overrides.pop('environment', {}))
        import setup
        settings = dict(setup=setup, home=self.home, environment=environment, run=self.machine.run,
                        clock=self.machine.clock, sleep=self.machine.sleep, kill=self.machine.kill,
                        application_roots=[self.home/'Applications'], uid=UID, pid=ENGINE_PID,
                        checks=checks or self.default_checks)
        plugin_root = overrides.pop('plugin_root', Path(__file__).resolve().parents[2]/'plugins/cua')
        settings.update(overrides)
        return Context(plugin_root, **settings)

    @staticmethod
    def default_checks(ctx):
        return {'command': 'ready', 'dependencies': 'ready', 'login_environment': 'ready', 'wrapper': 'ready',
                'relay_files': 'ready'}

    def write_host(self, status='ready', owner=1000, backend=1100, proxy=1200, relay=False, relay_reason=None,
                   socket_path=None, age=300, **extra):
        data = {'schema_version': 1, 'status': status, 'owner_pid': owner, 'backend_pid': backend,
                'desktop_proxy_pid': proxy, 'socket_path': socket_path or str(self.host_dir/'run/rpc.sock'),
                'native_cli': str(self.native), 'mechanism': 'original_app_server_unix_websocket',
                'operational_readiness': 'not_checked', 'relay': relay, 'relay_launcher': None,
                'relay_reason': relay_reason}
        data.update(extra)
        path = self.host_dir/'host.json'
        path.write_text(json.dumps(data))
        os.chmod(path, 0o600)
        os.utime(path, (NOW-age, NOW-age))
        return data

    def start_world(self, host=True, relay=True):
        """The Codex app with its app-server (and a host registry that says ready when asked for)."""
        self.machine.add(1000, 1, self.commands.app_main, start=NOW-7200)
        self.machine.add(1100, 1000, self.commands.app_server, start=NOW-7100)
        if host:
            self.machine.add(1200, 1000, '/usr/bin/python3 unix_ws_stdio.py --socket x', start=NOW-7100)
            self.write_host(relay=relay)

    def add_claude(self, pid=500, start=NOW-8000):
        self.machine.add(pid, 1, self.commands.claude, start=start)
        return pid

    def add_bridge(self, pid, owner=500, start=NOW-900, rss_kb=30_000, command=None):
        self.machine.add(pid, owner, command or self.commands.bridge, start=start, rss_kb=rss_kb)
        return pid

    def add_runtime(self, repl, start, relay=True, rss=(1000, 400, 2000), parent=1100):
        """A CUA runtime under the app-server: cua-repl, then (with a relay) the relay, then the original runtime.

        pids: repl, repl+1 (the relay, or the runtime without a relay), repl+2 (the runtime behind a relay)."""
        self.machine.add(repl, parent, self.commands.cua_repl, start=start, rss_kb=rss[0])
        if relay:
            self.machine.add(repl+1, repl, self.commands.relay, start=start, rss_kb=rss[1])
            self.machine.add(repl+2, repl+1, self.commands.node_repl, start=start, rss_kb=rss[2])
        else:
            self.machine.add(repl+1, repl, self.commands.node_repl, start=start, rss_kb=rss[2])
        return repl

    def serve(self, directory, pid, started_at, handler):
        server = ControlServer(directory, pid, started_at, handler)
        self.servers.append(server)
        return server

    def host_socket(self):
        """A real socket file for the host registry; the connection itself is faked."""
        path = self.host_dir/'run/rpc.sock'
        path.parent.mkdir(mode=0o700, exist_ok=True)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(path))
        os.chmod(path, 0o600)
        self.sockets.append(listener)
        return path

    def chrome_plugin(self, version=APP_VERSION):
        root = self.home/'.codex/plugins/cache/openai-bundled/chrome'/version
        (root/'scripts').mkdir(parents=True)
        script = root/'scripts/browser-client.mjs'
        script.write_text('// fixture')
        os.chmod(script, 0o644)
        return script
