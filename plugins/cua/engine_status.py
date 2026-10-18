"""Connections, leases and the status the menu bar app shows, from the inventory and the records.

A connection is one AI conversation that uses CUA (R8):
  claude  a live bridge record (or an unrecorded bridge process), together with the runtime that serves its
          thread. The runtime is found through the sessions that relay records and the activity log share with
          the bridge. A runtime that still serves a dead bridge's thread is a claude connection that has ended.
  codex   a live relay record that serves no bridge, or a runtime without any record.
cmux-cua is never a connection; it is listed under other_tools.
"""
import re

from engine_core import (ACTIVE_SECONDS, ACTIVITY_LIMIT, IDLE_SECONDS, SCHEMA_VERSION, connection_id, iso)
from engine_inventory import (collect, is_app_server, is_cua_repl, mark_live, working_folders)
from engine_records import control_socket, load_records, prune, read_activity

PRUNE_MIN_AGE = 60


def _later(*values):
    values = [value for value in values if value is not None]
    return max(values) if values else None


class Connection:
    def __init__(self, agent, pid, started):
        self.agent = agent
        self.pid = pid
        self.started = started
        self.owner_pid = None
        self.owner_alive = False
        self.cwd = None
        self.memory_pids = {pid}
        self.memory_bytes = None
        self.last_call = None
        self.session_id = None
        self.busy = False
        self.record = None
        self.can_release = False
        self.can_stop = True
        self.state = 'active'
        self.idle_seconds = None

    @property
    def id(self):
        return connection_id(self.agent, self.pid, self.started)

    def finish(self, now):
        if self.last_call is not None:
            self.idle_seconds = max(0, int(now-self.last_call))
        if not self.owner_alive:
            self.state = 'ended'
        elif self.idle_seconds is not None and self.idle_seconds > IDLE_SECONDS:
            self.state = 'idle'
        else:
            self.state = 'active'

    def to_json(self):
        return {'id': self.id, 'agent': self.agent, 'state': self.state, 'pid': self.pid,
                'owner_pid': self.owner_pid, 'owner_alive': self.owner_alive, 'cwd': self.cwd,
                'started_at': iso(self.started), 'memory_bytes': self.memory_bytes,
                'last_call_at': iso(self.last_call), 'idle_seconds': self.idle_seconds,
                'session_id': self.session_id, 'busy': self.busy, 'can_release': self.can_release,
                'can_stop': self.can_stop}


def _owner_alive(inv, owner_pid, child_started):
    """The owner is alive when that pid is a process that started before its child (a reused pid did not)."""
    proc = inv.mine.get(owner_pid) if owner_pid and owner_pid > 1 else None
    return proc is not None and proc.start <= child_started+1


def _bridge_expects_relay(bridge):
    host = bridge.data.get('host')
    return isinstance(host, dict) and host.get('relay') is True


def attribute_runtimes(bridges, relays, relay_sessions):
    """relay writer -> the live bridge whose thread that relay's runtime serves.

    First by shared sessions (open scopes, and the sessions the activity log shows the relay serving). A relay
    that has not served any call yet has no session; it is paired with the bridge that connected right after the
    relay started, in the same folder and on the same host, but only when that pairing is unique both ways."""
    owner = {}
    for relay in relays:
        seen, best = relay_sessions(relay), None
        for bridge in bridges:
            overlap = seen & bridge.sessions()
            if overlap:
                key = (len(overlap), bridge.time('last_call_at') or 0, -bridge.pid)
                if best is None or key > best[0]:
                    best = (key, bridge)
        if best is not None:
            owner[relay.writer] = best[1]
    taken = {bridge.writer for bridge in owner.values()}
    free_relays = [relay for relay in relays if relay.writer not in owner and not relay_sessions(relay)]
    options = {}
    for bridge in bridges:
        connected, folder, host = bridge.time('connected_at'), bridge.path('cwd'), bridge.data.get('host')
        if (bridge.writer in taken or connected is None or folder is None or not _bridge_expects_relay(bridge)):
            continue
        host_pid = host.get('pid')
        options[bridge.writer] = (bridge, [
            relay for relay in free_relays
            if relay.path('cwd') == folder and connected-90 <= relay.started_at <= connected+3
            and relay.number('app_server_pid') in (None, host_pid)])
    for bridge, matching in options.values():
        if len(matching) == 1 and sum(matching[0] in other for _, other in options.values()) == 1:
            owner[matching[0].writer] = bridge
    return owner


class View:
    """Everything the commands need to know, computed once from one look at the machine."""

    def __init__(self, ctx, inv, records, activity, with_folders=True):
        self.ctx = ctx
        self.inv = inv
        self.records = records
        self.now = ctx.clock()
        self.connections = []
        self.maybe_left = []
        self.prunable = []
        self.activity = []
        self._analyze(activity, with_folders)

    # --- connections ---------------------------------------------------------------------------------

    def _analyze(self, activity, with_folders):
        ctx, inv = self.ctx, self.inv
        mark_live(self.records, inv.mine, ctx.uid)
        live = [record for record in self.records if record.live]
        dead = [record for record in self.records if not record.live]
        live_bridges = [record for record in live if record.kind == 'bridge']
        live_relays = [record for record in live if record.kind == 'relay']
        dead_bridges = [record for record in dead if record.kind == 'bridge']

        served = {}
        for line in activity:
            if line['session_id']:
                served.setdefault(line['writer'], set()).add(line['session_id'])

        def relay_sessions(relay):
            return set(relay.open_sessions) | served.get(relay.writer, set())

        def root_of(relay):
            """The cua-repl process the relay runs under, if it can be found."""
            for candidate in (inv.procs[relay.pid].ppid, relay.number('root_pid')):
                proc = inv.mine.get(candidate)
                if proc is not None and is_cua_repl(proc.command):
                    return candidate
            return None

        roots = {relay.writer: root_of(relay) for relay in live_relays}
        attributed = attribute_runtimes(live_bridges, live_relays, relay_sessions)
        by_writer, connections = {}, []

        recorded = set()
        for bridge in live_bridges:
            proc = inv.procs[bridge.pid]
            recorded.add(bridge.pid)
            conn = Connection('claude', bridge.pid, bridge.started_at)
            conn.record = bridge
            conn.owner_pid = bridge.number('owner_pid') or (proc.ppid if proc.ppid > 1 else None)
            conn.owner_alive = _owner_alive(inv, conn.owner_pid, proc.start)
            conn.cwd = bridge.path('cwd')
            conn.session_id = bridge.current_session
            conn.last_call = bridge.time('last_call_at')
            conn.busy = bridge.data.get('busy') is True
            conn.can_release = control_socket(bridge, ctx.uid) is not None
            by_writer[bridge.writer] = conn
            connections.append(conn)
        for pid in inv.bridges:
            if pid in recorded:
                continue
            proc = inv.mine[pid]
            conn = Connection('claude', pid, proc.start)
            conn.owner_pid = proc.ppid if proc.ppid > 1 else None
            conn.owner_alive = _owner_alive(inv, conn.owner_pid, proc.start)
            connections.append(conn)

        for relay in live_relays:
            proc, root = inv.procs[relay.pid], roots[relay.writer]
            tree = set(inv.subtree(root if root is not None else relay.pid)) | set(inv.subtree(relay.pid))
            bridge = attributed.get(relay.writer)
            if bridge is not None:
                conn = by_writer[bridge.writer]
                conn.memory_pids |= tree
                conn.last_call = _later(conn.last_call, relay.time('last_call_at'))
                conn.busy = conn.busy or relay.data.get('busy') is True
                by_writer[relay.writer] = conn
                continue
            former = next((record for record in dead_bridges if relay_sessions(relay) & record.sessions()), None)
            conn = Connection('claude' if former is not None else 'codex', relay.pid, relay.started_at)
            conn.record = relay
            conn.memory_pids = tree
            repl = inv.procs[root] if root is not None else proc
            # Who started the runtime is what the process list says now; the record's app_server_pid is only
            # what it was when the relay started, and is used when cua-repl cannot be found.
            if root is not None:
                conn.owner_pid = repl.ppid if repl.ppid > 1 else None
            else:
                conn.owner_pid = relay.number('app_server_pid')
            if former is not None:
                # The conversation that owned this runtime is gone.
                conn.owner_pid = former.number('owner_pid') or conn.owner_pid
                conn.owner_alive = False
            else:
                conn.owner_alive = _owner_alive(inv, conn.owner_pid, repl.start)
            conn.cwd = relay.path('cwd')
            conn.session_id = self._newest_session(relay)
            conn.last_call = relay.time('last_call_at')
            conn.busy = relay.data.get('busy') is True
            conn.can_release = control_socket(relay, ctx.uid) is not None
            by_writer[relay.writer] = conn
            connections.append(conn)

        covered = {root for root in roots.values() if root is not None}
        for pid in inv.cua_repl:
            if pid in covered:
                continue
            proc = inv.mine[pid]
            conn = Connection('codex', pid, proc.start)
            conn.memory_pids = set(inv.subtree(pid))
            conn.owner_pid = proc.ppid if proc.ppid > 1 else None
            conn.owner_alive = _owner_alive(inv, conn.owner_pid, proc.start)
            connections.append(conn)

        # What the activity log says about each connection, and who each line belongs to.
        session_bridge = {}
        for record in live_bridges + dead_bridges:
            for session in record.sessions():
                session_bridge.setdefault(session, record.connection_id)
        newest, located = {}, []
        for line in activity:
            conn = by_writer.get(line['writer'])
            if conn is not None:
                target, agent = conn.id, conn.agent
            elif line['writer'].startswith('bridge-'):
                target, agent = 'claude-'+line['writer'][len('bridge-'):], 'claude'
            elif line['session_id'] in session_bridge:
                target, agent = session_bridge[line['session_id']], 'claude'
            else:
                target, agent = 'codex-'+line['writer'][len('relay-'):], 'codex'
            newest[target] = _later(newest.get(target), line['at'])
            located.append((line, target, agent))
        self.activity = located

        for conn in connections:
            conn.memory_bytes = inv.rss_bytes(conn.memory_pids)
            conn.last_call = _later(conn.last_call, newest.get(conn.id))
            conn.finish(self.now)
        connections.sort(key=lambda conn: (conn.agent != 'claude', conn.started, conn.pid))
        self.connections = connections

        self.folders = {}
        if with_folders:
            wanted = [conn.pid for conn in connections if conn.cwd is None]
            wanted += [pid for pid in inv.cmux_clients if pid > 1]
            self.folders = working_folders(ctx, wanted)
            for conn in connections:
                conn.cwd = conn.cwd or self.folders.get(conn.pid)
        self._leases(live, dead)

    @staticmethod
    def _newest_session(relay):
        """The session of the relay's newest scope, preferring the main thread over sub-agents."""
        raw = relay.data.get('scopes') if isinstance(relay.data.get('scopes'), list) else []
        best = None
        for item, scope in zip(raw, relay.scopes):
            if isinstance(item, dict) and item.get('session_id') == scope.session_id:
                key = (item.get('subagent') is not True, scope.last or scope.first or 0)
                if best is None or key > best[0]:
                    best = (key, scope.session_id)
        return best[1] if best else None

    # --- leases that may have been left behind --------------------------------------------------------

    def _leases(self, live, dead):
        inv = self.inv
        listed = set()
        for record in live:
            listed |= record.sessions()
        found = {}
        for record in dead:
            for session in record.open_sessions:
                entry = found.setdefault(session, {'records': [], 'last': None})
                entry['records'].append(record)
                entry['last'] = _later(entry['last'], record.last_scope_time(session))
        chrome = inv.chrome_started
        stale = set()
        for session, entry in found.items():
            # Chrome forgets every lease when it restarts, so a session that ended before then is gone.
            if chrome is not None and entry['last'] is not None and entry['last'] < chrome:
                stale.add(session)
        ready = inv.host.state == 'ready'
        entries = []
        for session, entry in found.items():
            if session in stale:
                continue
            records = entry['records']
            primary = max(records, key=lambda record: (record.kind == 'bridge', record.last_scope_time(session) or 0))
            exited = primary.time('updated_at') if primary.data.get('cleanup') == 'not_confirmed' else None
            entries.append({'session_id': session, 'agent': primary.agent, 'connection_id': primary.connection_id,
                            'cwd': primary.path('cwd'), 'ended_at': iso(exited),
                            'releasable': ready and session not in listed,
                            'last': entry['last'] or 0,
                            # Only a bridge's thread can never be resumed; a Codex thread can (needs a click).
                            'needs_user': all(record.kind == 'relay' for record in records)})
        entries.sort(key=lambda item: (-item['last'], item['session_id']))
        self.maybe_left = entries
        for record in dead:
            sessions = set(record.open_sessions)
            if sessions <= stale:
                self.prunable.append((record, stale & sessions))

    # --- lookups -------------------------------------------------------------------------------------

    def find(self, wanted):
        return next((conn for conn in self.connections if conn.id == wanted), None)

    def protected_pids(self):
        owners = {conn.owner_pid for conn in self.connections if conn.owner_pid}
        return self.inv.protected_pids(owners)

    def prune(self):
        """Delete dead records that hold nothing a release could still act on."""
        for record, droppable in self.prunable:
            try:
                prune(self.ctx.state_dir, self.ctx.uid, record, droppable, self.now, PRUNE_MIN_AGE)
            except OSError:
                pass

    # --- the status ----------------------------------------------------------------------------------

    def _codex(self):
        inv = self.inv
        installation = inv.installation
        return {'installed': installation is not None,
                'app_path': str(installation.app_path) if installation is not None else None,
                'app_version': inv.app_version, 'running': bool(inv.app_pids), 'pids': list(inv.app_pids)}

    def _setup(self):
        checks, host = self.inv.checks, self.inv.host
        if host.state == 'ready' and host.relay:
            relay = 'active'          # the running host started the relay
        elif checks.get('relay_files') != 'ready':
            relay = 'unavailable'     # the next start would have no relay: its stable copy is missing or invalid
        else:
            relay = 'inactive'
        return {'command': checks.get('command', 'missing'), 'dependencies': checks.get('dependencies', 'missing'),
                'login_environment': checks.get('login_environment', 'unknown'),
                'wrapper': checks.get('wrapper', 'broken'), 'relay': relay}

    def _other_tools(self):
        inv, ctx = self.inv, self.ctx
        clients = []
        for pid in inv.cmux_clients:
            proc = inv.procs.get(pid)
            if proc is None or pid <= 1:
                continue
            clients.append({'pid': pid, 'agent': client_agent(proc.command), 'cwd': self.folders.get(pid)})
        running = bool(inv.cmux_daemons or clients)
        installed = (ctx.home/'Library/Application Support/cmux/cmux-cua').is_dir()
        if not running and not installed:
            return []
        return [{'name': 'cmux-cua', 'running': running, 'pids': list(inv.cmux_daemons), 'clients': clients}]

    def _screen(self):
        recent = []
        for conn in self.connections:
            if conn.busy:
                recent.append((self.now, conn))
            elif conn.last_call is not None and 0 <= self.now-conn.last_call <= ACTIVE_SECONDS:
                recent.append((conn.last_call, conn))
        recent.sort(key=lambda item: (-item[0], item[1].pid))
        last = _later(*[conn.last_call for conn in self.connections], *[line['at'] for line, _, _ in self.activity])
        return {'active_connection_id': recent[0][1].id if recent else None, 'last_call_at': iso(last)}

    def _activity(self):
        ordered = sorted(enumerate(self.activity), key=lambda item: (item[1][0]['at'], item[0]), reverse=True)
        return [{'at': iso(line['at']), 'connection_id': target, 'agent': agent, 'tool': line['tool'],
                 'ok': line['ok'], 'ms': line['ms']} for _, (line, target, agent) in ordered[:ACTIVITY_LIMIT]]

    def maybe_left_json(self):
        return [{key: item[key] for key in ('session_id', 'agent', 'connection_id', 'cwd', 'ended_at', 'releasable')}
                for item in self.maybe_left]

    def status_json(self):
        host = self.inv.host
        return {'schema_version': SCHEMA_VERSION, 'generated_at': iso(self.now),
                'plugin': {'version': self.ctx.plugin_version()},
                'codex': self._codex(),
                'host': {'state': host.state, 'since': iso(host.since)},
                'setup': self._setup(),
                'connections': [conn.to_json() for conn in self.connections],
                'leases': {'readable': False, 'items': [], 'maybe_left': self.maybe_left_json()},
                'other_tools': self._other_tools(),
                'screen': self._screen(),
                'activity': self._activity()}


def client_agent(command):
    """Which AI uses a tool, judged from the client process that started it."""
    if is_app_server(command) or re.match(r'^/.*?/(?:codex|ChatGPT)(?:\s|$)', command):
        return 'codex'
    if re.match(r'^/.*?/claude(?:\s|$)', command) or '/claude-code/' in command:
        return 'claude'
    return None


def build_view(ctx, with_folders=True, with_checks=True):
    # The records are read before the process list, so that every live writer of a record is in the list.
    records = load_records(ctx.state_dir, ctx.uid)
    activity = read_activity(ctx.state_dir, ctx.uid)
    return View(ctx, collect(ctx, with_checks), records, activity, with_folders)


def status(ctx):
    view = build_view(ctx)
    view.prune()
    return view.status_json()
