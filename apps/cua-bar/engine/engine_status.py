"""Connections, leases and the status the menu bar app shows, from the inventory and the records.

A connection is one AI conversation that uses CUA (R8):
  claude  a live bridge record (or an unrecorded bridge process), together with the runtime that serves its
          thread. A relay names the bridge that started its runtime (`owner`); a relay without that name is matched
          through the sessions that relay records and the activity log share with the bridge. A runtime that still
          serves a dead bridge's thread is a claude connection that has ended; stopping it ends the runtime too.
  codex   a live relay record that serves no bridge, or a runtime without any record.
cmux-cua is none of these; it is listed under other_tools. Each of its `cmux-cua mcp` processes (one per AI
conversation) is a CmuxConnection that can be stopped on its own.
A runtime that Codex itself started again for the thread of a bridge that was gone, and that nobody has used, is none
of these either: it is a RevivedRuntime, left out of the connections and only counted in the diagnosis.
The same goes for a runtime that works in the folder of a connection test's thread (`doctor --probe`, engine_core.
is_probe_folder): it is the test's, lives for seconds, and is in no list, no lease and no judgment of the screen. A
targeted release's thread (`release-session`) is one of those too.
"""
import json
import os
from pathlib import Path
import re
import stat

from engine_core import (ACTIVE_SECONDS, ACTIVITY_LIMIT, HOST_STOP_GRACE, IDLE_SECONDS, SCHEMA_VERSION, connection_id,
                         iso, is_probe_folder)
from engine_inventory import (collect, is_app_server, is_cua_repl, mark_live, working_folders)
from engine_records import (WRITER, bridge_name, control_socket, forget_released, load_records, prune, read_activity,
                            read_released, read_settings)
from bridge_records import read_browser_blocked

PRUNE_MIN_AGE = 60
VERSION_NAME = re.compile(r'^[0-9A-Za-z._+-]{1,64}$')     # a Codex version, safe as a folder name
# A Codex that has just opened starts its host a few seconds later; until then it is not one without a host (S9).
HOST_START_GRACE = 30
# A bridge starts its thread, and so the runtime of it, within seconds. A runtime that came up this much later than the
# bridge it names, with the bridge gone, was started again by Codex (S17, S18), not by that conversation. This tells the
# runtimes whose relay did not see the bridge gone as it came up: `owner_running` true (the bridge was there), null (the
# look failed) or missing (a record from before it was written). A relay that says the bridge was not there needs no
# age (S4: a conversation of 18 seconds, whose runtime Codex started again right after it ended).
REVIVED_AFTER = 120


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
        self.runtimes = set()          # (pid, start) of the cua-repl roots that end with a stopped Claude connection
        self.last_call = None
        self.session_id = None
        self.busy = False
        self.record = None
        self.can_release = False
        self.can_stop = True
        self.state = 'active'
        self.idle_seconds = None
        # Whether it holds anything a release could let go of; None where no record tells (see View._holdings).
        self.holds = None

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
                'can_stop': self.can_stop, 'holds': self.holds}


class CmuxConnection:
    """One `cmux-cua mcp` process: what an AI conversation holds open to cmux-cua.

    It is not one of the connections above. It is stopped one at a time, never in a group, and it has nothing to
    release. `pid` is the process that is signalled; `client_pid` is the AI client that started it, which never is.
    When that client is gone (the parent is launchd, or no longer in the process list) there is none: `client_pid`
    and `agent` are None, which is how the contract writes an unknown value."""

    def __init__(self, proc, client):
        self.pid = proc.pid
        self.started = proc.start
        self.client_pid = client.pid if client is not None else None
        self.agent = client_agent(client.command) if client is not None else None
        self.cwd = None
        self.can_stop = False

    @property
    def id(self):
        return connection_id('cmux', self.pid, self.started)

    def to_json(self):
        return {'id': self.id, 'pid': self.client_pid, 'mcp_pid': self.pid, 'agent': self.agent, 'cwd': self.cwd,
                'started_at': iso(self.started), 'can_stop': self.can_stop}


class RevivedRuntime:
    """A runtime that Codex started again by itself for the thread of a bridge that is gone (S17, S18, S4).

    Codex keeps the thread of a bridge for about half an hour after it was last used and, now and then, starts the
    servers of all its threads again; nothing of ours asks for that. The relay of the new runtime still carries the
    old bridge's name. Either it saw that bridge gone as it came up (`owner_running` false), or, when it does not say
    so, it came up more than REVIVED_AFTER after that bridge. It belongs to no conversation and
    holds nothing: nobody ever called it and it has no open scope. It is therefore no connection (not listed, not ended,
    not released or stopped by the app); the diagnosis counts it, and Codex takes it down with the thread. One that was
    used even once stays an ended connection."""

    def __init__(self, relay, pids):
        self.pid = relay.pid
        self.started = relay.started_at
        self.pids = pids
        self.memory_bytes = None


def _owner_alive(inv, owner_pid, child_started):
    """The owner is alive when that pid is a process that started before its child (a reused pid did not)."""
    proc = inv.mine.get(owner_pid) if owner_pid and owner_pid > 1 else None
    return proc is not None and proc.start <= child_started+1


def _bridge_expects_relay(bridge):
    host = bridge.data.get('host')
    return isinstance(host, dict) and host.get('relay') is True


def relay_owner(relay):
    """The name (`bridge-<pid>-<started_at>`) of the bridge that started the relay's runtime, or None."""
    return bridge_name(relay.text('owner'))


def of_a_connection_test(record):
    """Whether a record is the relay's of a runtime that works in the folder of a connection test's thread."""
    return record.kind == 'relay' and is_probe_folder(record.path('cwd'))


def claude_record(record):
    """Whether a record is a Claude conversation's: a bridge's, or a relay's that names the bridge that started its
    runtime (`owner`, the same test `_relay_connections` makes). A relay with no such name serves a Codex thread."""
    return record.kind == 'bridge' or relay_owner(record) is not None


def attribute_runtimes(bridges, relays, relay_sessions):
    """relay writer -> the live bridge whose thread that relay's runtime serves.

    A relay that names its bridge belongs to that bridge, and to no other one when that bridge is gone. The others
    go first by shared sessions (open scopes, and the sessions the activity log shows the relay serving). A relay
    that has not served any call yet has no session; it is paired with the bridge that connected right after the
    relay started, in the same folder and on the same host, but only when that pairing is unique both ways."""
    owner = {}
    by_name = {bridge.writer: bridge for bridge in bridges}
    for relay in relays:
        if relay_owner(relay) in by_name:
            owner[relay.writer] = by_name[relay_owner(relay)]
    relays = [relay for relay in relays if relay_owner(relay) is None]
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
    taken = {bridge.writer for bridge in owner.values()}      # also every bridge that has the runtime it named
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
        # What the relay of a connection test wrote (an older relay logs every call it relays) is nobody's operation, for
        # as long as its record is there, alive or dead.
        tests = {record.writer for record in records if of_a_connection_test(record)}
        activity = [line for line in activity if line['writer'] not in tests]
        self.now = ctx.clock()
        self.connections = []
        self.cmux = []                 # CmuxConnection, one per `cmux-cua mcp` process; not in `connections`
        self.revived = []              # RevivedRuntime: counted in the diagnosis, in no list
        self.maybe_left = []
        self.prunable = []
        self.activity = []
        self.folders = {}
        mark_live(records, inv.mine, ctx.uid)
        self.live = [record for record in records if record.live]
        self.dead = [record for record in records if not record.live]
        self.live_bridges = [record for record in self.live if record.kind == 'bridge']
        self.live_relays = [record for record in self.live if record.kind == 'relay']
        self.dead_bridges = [record for record in self.dead if record.kind == 'bridge']
        self.served = {}               # relay writer -> sessions that the activity log shows it serving
        self.served_last = {}          # relay writer -> the session of its newest activity line that names one
        self.operated = {line['writer'] for line in activity}       # writers with any line in the activity log
        for line in activity:          # oldest first, so the last line seen wins
            if line['session_id']:
                self.served.setdefault(line['writer'], set()).add(line['session_id'])
                self.served_last[line['writer']] = line['session_id']
        self.roots = {relay.writer: self._root_of(relay) for relay in self.live_relays}
        self.attributed = attribute_runtimes(self.live_bridges, self.live_relays, self.relay_sessions)
        self.by_writer = {}            # writer of a live record -> the connection it belongs to
        self.unrecorded = {}           # pid of a bridge process without a live record -> its connection
        self._claude_connections()
        self._relay_connections()
        self._runtime_connections()
        self._cmux_connections()
        self._map_activity(activity)
        self._finish(with_folders)
        self._leases()
        self._holdings()

    # --- connections ---------------------------------------------------------------------------------

    def relay_sessions(self, relay):
        return set(relay.open_sessions) | self.served.get(relay.writer, set())

    def _root_of(self, relay):
        """The cua-repl process the relay runs under, if it can be found."""
        for candidate in (self.inv.procs[relay.pid].ppid, relay.number('root_pid')):
            proc = self.inv.mine.get(candidate)
            if proc is not None and is_cua_repl(proc.command):
                return candidate
        return None

    def _claude_connections(self):
        inv = self.inv
        recorded = set()
        for bridge in self.live_bridges:
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
            conn.can_release = control_socket(bridge, self.ctx.uid) is not None
            self.by_writer[bridge.writer] = conn
            self.connections.append(conn)
        for pid in inv.bridges:
            if pid not in recorded:
                proc = inv.mine[pid]
                conn = Connection('claude', pid, proc.start)
                conn.owner_pid = proc.ppid if proc.ppid > 1 else None
                conn.owner_alive = _owner_alive(inv, conn.owner_pid, proc.start)
                self.unrecorded[pid] = conn
                self.connections.append(conn)

    def _running(self, name):
        """The process of the bridge called `name` while it still runs, else None."""
        match = WRITER.match(name) if name else None
        proc = self.inv.mine.get(int(match.group(2))) if match is not None else None
        return proc if proc is not None and abs(proc.start-int(match.group(3))) <= 1 else None

    def _relay_connections(self):
        """Each live relay either adds its runtime to the bridge it serves or is a connection of its own."""
        inv = self.inv
        for relay in self.live_relays:
            proc, root = inv.procs[relay.pid], self.roots[relay.writer]
            tree = set(inv.subtree(root if root is not None else relay.pid)) | set(inv.subtree(relay.pid))
            runtime = {(root, inv.procs[root].start)} if root is not None else set()
            named = relay_owner(relay)
            running = self._running(named)
            bridge = self.attributed.get(relay.writer)
            conn = self.by_writer[bridge.writer] if bridge is not None else self.unrecorded.get(
                running.pid if running is not None else None)
            if conn is not None:
                conn.memory_pids |= tree
                if named is not None:          # only a runtime that names its bridge is stopped with it
                    conn.runtimes |= runtime
                conn.last_call = _later(conn.last_call, relay.time('last_call_at'))
                conn.busy = conn.busy or relay.data.get('busy') is True
                self.by_writer[relay.writer] = conn
                continue
            sessions = self.relay_sessions(relay)
            if named is not None:
                former = next((record for record in self.dead_bridges if record.writer == named), None)
            else:
                former = next((record for record in self.dead_bridges if sessions & record.sessions()), None)
            if self._brought_back(relay, named, running, former):
                self.revived.append(RevivedRuntime(relay, tree))
                continue
            claude = named is not None or former is not None
            conn = Connection('claude' if claude else 'codex', relay.pid, relay.started_at)
            conn.record = relay
            conn.memory_pids = tree
            repl = inv.procs[root] if root is not None else proc
            # Who started the runtime is what the process list says now; the record's app_server_pid is only
            # what it was when the relay started, and is used when cua-repl cannot be found.
            if root is not None:
                conn.owner_pid = repl.ppid if repl.ppid > 1 else None
            else:
                conn.owner_pid = relay.number('app_server_pid')
            if running is not None:
                # The bridge that started this runtime still runs, without a record the engine could read.
                conn.owner_pid = running.ppid if running.ppid > 1 else None
                conn.owner_alive = _owner_alive(inv, conn.owner_pid, running.start)
            elif claude:
                # The conversation that owned this runtime is gone, and nothing uses its thread again.
                conn.owner_pid = (former.number('owner_pid') if former is not None else None) or conn.owner_pid
                conn.owner_alive = False
                conn.runtimes = runtime
            else:
                conn.owner_alive = _owner_alive(inv, conn.owner_pid, repl.start)
            conn.cwd = relay.path('cwd')
            # A Codex turn that ended normally closes its scope, but the runtime still serves that chat: the activity
            # log names it.
            conn.session_id = self._newest_session(relay) or self.served_last.get(relay.writer)
            conn.last_call = relay.time('last_call_at')
            conn.busy = relay.data.get('busy') is True
            conn.can_release = control_socket(relay, self.ctx.uid) is not None
            self.by_writer[relay.writer] = conn
            self.connections.append(conn)

    def _brought_back(self, relay, named, running, former):
        """Whether the relay is a runtime Codex started again for the thread of a bridge that was gone.

        It names a bridge that no longer runs and has no record, and nothing was ever done with it: no call, no call in
        flight, no open scope, no line in the activity log. A runtime with any of those stays an ended connection,
        whatever its age. Then it is a revival when its relay found that bridge gone as it came up (`owner_running`
        false), at any age. A relay that did not say so (it found the bridge running, could not look, or wrote its
        record before this was known) is told by its age: it came up more than REVIVED_AFTER seconds after the bridge."""
        if named is None or running is not None or former is not None:
            return False
        if relay.data.get('last_call_at') or relay.data.get('busy') is True or relay.data.get('scopes'):
            return False
        if relay.writer in self.operated:
            return False
        if relay.data.get('owner_running') is False:
            return True
        return relay.started_at-int(WRITER.match(named).group(3)) > REVIVED_AFTER

    def _runtime_connections(self):
        """Runtimes that no relay record covers: all that is known is the process."""
        inv = self.inv
        covered = {root for root in self.roots.values() if root is not None}
        for pid in inv.cua_repl:
            if pid not in covered:
                proc = inv.mine[pid]
                conn = Connection('codex', pid, proc.start)
                conn.memory_pids = set(inv.subtree(pid))
                conn.owner_pid = proc.ppid if proc.ppid > 1 else None
                conn.owner_alive = _owner_alive(inv, conn.owner_pid, proc.start)
                self.connections.append(conn)

    def _cmux_connections(self):
        """Every `cmux-cua mcp` process of this user, also one whose AI client is gone: it is listed without a client.

        Ordered by AI client, each client's connections by start; the ones without a client come last."""
        inv = self.inv
        for pid in inv.cmux_mcp:
            proc = inv.mine[pid]
            self.cmux.append(CmuxConnection(proc, inv.procs.get(proc.ppid) if proc.ppid > 1 else None))
        self.cmux.sort(key=lambda conn: (conn.client_pid is None, conn.client_pid or 0, conn.started, conn.pid))

    def _map_activity(self, activity):
        """Which connection each line of the activity log belongs to, and each connection's newest call.

        In this order: a line whose writer is a listed connection takes that connection's id and agent (the app finds
        the line's folder through the id); a bridge's own line is that bridge's; a line that names its bridge (`owner`,
        written by the relay of a Claude conversation) is that bridge's, trusted before any guess from sessions, so it
        stays Claude's when the connection, the relay and the bridge's record are all gone (S23); a session that a
        bridge's record lists points to that bridge; anything else is a Codex runtime's. Lines without a name (an older
        relay's, or Codex's own runtime) are therefore told as they always were."""
        session_bridge = {}
        for record in self.live_bridges + self.dead_bridges:
            for session in record.sessions():
                session_bridge.setdefault(session, record.connection_id)
        self.newest = {}
        for line in activity:
            if line['writer'].startswith('engine-'):
                # The engine's own line (a restart of the computer-use service, F8): no connection's, no call.
                self.activity.append((line, None, 'engine'))
                continue
            conn = self.by_writer.get(line['writer'])
            if conn is not None:
                target, agent = conn.id, conn.agent
            elif line['writer'].startswith('bridge-'):
                target, agent = 'claude-'+line['writer'][len('bridge-'):], 'claude'
            elif line['owner'] is not None:
                target, agent = 'claude-'+line['owner'][len('bridge-'):], 'claude'
            elif line['session_id'] in session_bridge:
                target, agent = session_bridge[line['session_id']], 'claude'
            else:
                target, agent = 'codex-'+line['writer'][len('relay-'):], 'codex'
            if line['tool'] != 'turn_ended':
                # Ending a turn is no use of the screen: the AI's own end, or a release that ends it for the AI.
                self.newest[target] = _later(self.newest.get(target), line['at'])
            self.activity.append((line, target, agent))

    def _finish(self, with_folders):
        inv = self.inv
        for conn in self.connections:
            conn.memory_bytes = inv.rss_bytes(conn.memory_pids)
            conn.last_call = _later(conn.last_call, self.newest.get(conn.id))
            conn.finish(self.now)
        for item in self.revived:
            item.memory_bytes = inv.rss_bytes(item.pids)
        self.connections.sort(key=lambda conn: (conn.agent != 'claude', conn.started, conn.pid))
        protected = self.protected_pids()
        for conn in self.connections:
            conn.can_stop = conn.pid > 1 and conn.pid not in protected     # what stop would refuse is not offered
        protected = self.protected_pids(cmux_connections=True)
        for conn in self.cmux:
            conn.can_stop = conn.pid > 1 and conn.pid not in protected
        if with_folders:
            wanted = [conn.pid for conn in self.connections if conn.cwd is None]
            wanted += [pid for pid in inv.cmux_clients if pid > 1]
            self.folders = working_folders(self.ctx, wanted)
            for conn in self.connections:
                conn.cwd = conn.cwd or self.folders.get(conn.pid)
            for conn in self.cmux:
                conn.cwd = self.folders.get(conn.client_pid)       # None without a client: nothing is looked up for it
        self._leave_out_connection_tests()

    def _leave_out_connection_tests(self):
        """Take out the runtimes of connection tests.

        A test lives for seconds and holds nothing, but while it lives its runtime is a process like any other, and a
        relay in front of it (a host may give the thread one) has a record and a call in flight. None of it is a
        conversation, a busy screen or a connection that has ended (its lines in the activity log are left out at the
        start, by the writer of the record). What is known of the runtime is where it works: only the connections whose
        folder is known can be told, which the status looks up."""
        self.connections = [conn for conn in self.connections if not is_probe_folder(conn.cwd)]

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

    def _leases(self):
        """Sessions whose leases may have been left behind.

        They come from dead records, and from a live bridge's open scopes of sessions it no longer serves: those of a
        host it has left, or of its current thread once that host is gone, which the bridge cannot end any more. A live writer's record is
        never touched, so what the engine has already released is remembered in its own file."""
        inv = self.inv
        listed = set()
        for record in self.live:
            # The engine's own short-lived thread is no owner: a release's holds the very session it releases, which
            # stays releasable meanwhile, and a test's holds none of a conversation.
            if not of_a_connection_test(record):
                listed |= record.live_sessions()
        released = read_released(self.ctx.state_dir, self.ctx.uid)
        found = {}

        def note(record, session):
            if (record.writer, session) in released:
                return
            entry = found.setdefault(session, {'records': [], 'last': None})
            entry['records'].append(record)
            entry['last'] = _later(entry['last'], record.last_scope_time(session))
        for record in self.dead:
            if of_a_connection_test(record):
                continue            # a test holds no lease of a conversation: it only looked at the screen
            for session in record.open_sessions:
                note(record, session)
        for record in self.live_bridges:
            serving = record.live_sessions()
            for session in record.open_sessions:
                if session not in serving:
                    note(record, session)
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
            # A relay that names its bridge belongs to a Claude conversation, whose thread is a bridge's own and can
            # never be resumed, though the record of the relay is all that lists the session (S16, B7).
            claude = any(claude_record(record) for record in records)
            exited = None
            if not primary.live and primary.data.get('cleanup') == 'not_confirmed':
                exited = primary.time('updated_at')
            entries.append({'session_id': session, 'agent': 'claude' if claude else primary.agent,
                            'connection_id': primary.connection_id,
                            'cwd': primary.path('cwd'), 'ended_at': iso(exited),
                            'releasable': ready and session not in listed,
                            'last': entry['last'] or 0,
                            # Only a Claude conversation's thread can never be resumed; a Codex thread can (needs a click).
                            'needs_user': not claude})
        entries.sort(key=lambda item: (-item['last'], item['session_id']))
        self.maybe_left = entries
        for record in self.dead:
            sessions = set(record.open_sessions)
            gone = sessions if of_a_connection_test(record) else {
                session for session in sessions if session in stale or (record.writer, session) in released}
            if sessions <= gone:
                self.prunable.append((record, gone))

    def _holdings(self):
        """Whether each connection holds anything its 탭 풀기 could let go of.

        That is a scope of a session its writer still serves (an AI that called and has not ended its turn yet), or a
        session listed as maybe left with this connection as its holder (a host its bridge has left). A turn the AI
        ended, or a release, closes the scope: the connection then holds nothing, however recently it called. Where no
        record tells (a runtime without a relay, a bridge without a readable record) it is None: not known."""
        left = {item['connection_id'] for item in self.maybe_left}
        for conn in self.connections:
            record = conn.record
            if record is None:
                conn.holds = None
                continue
            serving = record.live_sessions() if record.live else set()
            conn.holds = any(scope.session_id in serving for scope in record.scopes) or conn.id in left

    # --- lookups -------------------------------------------------------------------------------------

    def find(self, wanted):
        """A connection or a cmux-cua connection by id."""
        return next((conn for conn in self.connections + self.cmux if conn.id == wanted), None)

    def protected_pids(self, cmux_connections=False):
        owners = {conn.owner_pid for conn in self.connections if conn.owner_pid}
        return self.inv.protected_pids(owners, cmux_connections=cmux_connections)

    def prune(self):
        """Delete dead records that hold nothing a release could still act on, and forget what was released for
        records that are gone."""
        for record, droppable in self.prunable:
            try:
                prune(self.ctx.state_dir, self.ctx.uid, record, droppable, self.now, PRUNE_MIN_AGE)
            except OSError:
                pass
        try:
            forget_released(self.ctx.state_dir, self.ctx.uid, {record.writer for record in self.records})
        except OSError:
            pass

    # --- the status ----------------------------------------------------------------------------------

    def host_state(self):
        """The host's state, where a Codex that opened moments ago without a host yet is still starting it,
        and one whose host closed moments ago is still quitting (`stopping`)."""
        inv = self.inv
        if inv.host.state in ('closed', 'missing', 'unknown') and inv.app_pids:
            opened = min(inv.procs[pid].start for pid in inv.app_pids)
            if self.now-opened <= HOST_START_GRACE:
                return 'starting'
            # The wrapper writes `closed` as it ends; a Codex opened after that is caught above. A host that is still
            # being ended is `stopping` already (engine_inventory.read_host).
            if inv.host.state == 'closed' and inv.host.since is not None and self.now-inv.host.since <= HOST_STOP_GRACE:
                return 'stopping'
        return inv.host.state

    def host_engine_version(self):
        """The version of the engine whose launcher started the host that runs (or is starting or quitting), as the
        launcher wrote it into the host record. None when there is no such host or the record names no version."""
        host = self.inv.host
        if host.state not in ('ready', 'starting', 'stopping') or not isinstance(host.registry, dict):
            return None
        version = host.registry.get('engine_version')
        return version if isinstance(version, str) and version else None

    def started_before_setup(self):
        """True when the running host was started by a launcher that is not the one of this setup: a restart of Codex
        applies the setup.

        Every launcher since the relay reaches Claude's threads writes `relay_config` (null without a relay), and every
        launcher since the engine copies writes `engine_version`, the manifest version of its engine. A host without
        either, or whose version is not the version of the engine that runs now, was started by an older one, which
        also tells two versions of one line (0.8.x) apart."""
        host = self.inv.host
        if host.state != 'ready' or not isinstance(host.registry, dict):
            return False
        version = self.host_engine_version()
        return 'relay_config' not in host.registry or version is None or version != self.ctx.plugin_version()

    def relay_reason(self):
        """Why the launcher left the relay out when it started the host that runs now (a fixed code word), or None."""
        host = self.inv.host
        return host.relay_reason if host.state == 'ready' and not host.relay else None

    def _launcher_start(self):
        """When the launcher that started the host that runs now began (epoch seconds), or None when it is gone or the
        record names no process."""
        owner = (self.inv.host.registry or {}).get('owner_pid')
        launcher = self.inv.procs.get(owner) if isinstance(owner, int) and not isinstance(owner, bool) else None
        return launcher.start if launcher is not None else None

    def restart_adds_relay(self):
        """True when the host that runs now went without the relay only because Codex's own copy of its computer-use
        plugin was not there yet when the host's launcher looked (`plugin_entry`, `plugin_updating`), and a good copy
        is there now.

        Codex writes that copy for a new version of itself as it starts after an update, a few seconds after the
        launcher has looked. Since 0.8.4 the launcher takes the plugin inside the app while there is no copy, so the
        first start after an update goes without the relay only when that template did not fit, or when the launcher
        that started the host is older, and the next start has it. `plugin_entry` has lasting causes too (a copy
        another user owns or others may write, one of another version, one that says something else than Codex's
        settings), so the copy must look as the launcher wants it, as far as the engine can tell, and have been
        written since the launcher started: a copy that was there before was refused for one of those, and a restart
        would refuse it again. The launcher of the next start is newer than the copy, so this never asks for a second
        restart, whatever the cause.

        `plugin_updating` and `not_bundled` are the other case (see _bundled_with_preload): the launcher read Codex's
        definition of the server before the copy for the new version was written, so it still named the module of the
        version before (`plugin_updating` since 0.8.9; an older launcher said `not_bundled`), or a launcher from before
        0.8.7 did not know the bundled server of Codex 26.1023."""
        inv = self.inv
        if self.relay_reason() in ('not_bundled', 'plugin_updating'):
            return self._bundled_with_preload()
        if self.relay_reason() != 'plugin_entry' or not inv.app_version or not VERSION_NAME.match(inv.app_version):
            return False
        launched = self._launcher_start()
        if launched is None:
            return False
        codex_home = self.ctx.environment.get('CODEX_HOME') or str(self.ctx.home/'.codex')
        plugin = Path(codex_home)/'plugins/cache/openai-bundled/unified-computer-use'/inv.app_version
        try:
            files = [os.lstat(plugin/name) for name in ('.codex-plugin/plugin.json', '.mcp.json')]
            manifest = json.loads((plugin/'.codex-plugin/plugin.json').read_text())
        except (OSError, ValueError):
            return False
        return (all(stat.S_ISREG(info.st_mode) and info.st_uid == self.ctx.uid and not stat.S_IMODE(info.st_mode) & 0o022
                    for info in files)
                and isinstance(manifest, dict) and manifest.get('version') == inv.app_version
                and max(info.st_mtime for info in files) >= launched)

    def _bundled_with_preload(self):
        """True when the host that runs now went without the relay as `not_bundled` or `plugin_updating`, and Codex's
        copy of the plugin for this app version now says what the launcher takes for the bundled server of Codex
        26.1023, which starts node with `--import <require-browser-access.mjs of the plugin> <cua-repl.mjs>`: the next
        start takes that form as the bundled one and has the relay.

        Two ways the host can have missed it. Its launcher is older than this engine and did not know that form
        (started before this setup). Or the launcher read Codex's definition before Codex wrote its copy of the plugin
        for the version it had just been updated to, so the definition still named the module of the version before:
        the copy was written since the launcher started (as for `plugin_entry`), and the next start reads the new one.
        A host started by this engine's launcher with a copy that was there before it is not asked about again (a
        second restart would be refused the same way), and neither is any other form of the server."""
        inv = self.inv
        if inv.installation is None or not inv.app_version or not VERSION_NAME.match(inv.app_version):
            return False
        from relay_install import ENV_RUNTIME_PATH, SERVER, _same_path, plugin_directory, preload_arguments
        cua_root = inv.installation.cua_root
        codex_home = self.ctx.environment.get('CODEX_HOME') or str(self.ctx.home/'.codex')
        plugin = plugin_directory(cua_root, codex_home)
        if plugin is None:
            return False
        try:
            info = os.lstat(plugin/'.mcp.json')
            if not stat.S_ISREG(info.st_mode) or info.st_uid != self.ctx.uid or stat.S_IMODE(info.st_mode) & 0o022:
                return False
            loaded = json.loads((plugin/'.mcp.json').read_text())
        except (OSError, ValueError):
            return False
        if not self.started_before_setup():
            launched = self._launcher_start()
            if launched is None or info.st_mtime < launched:
                return False
        servers = loaded.get('mcpServers', loaded.get('mcp_servers')) if isinstance(loaded, dict) else None
        entry = servers.get(SERVER) if isinstance(servers, dict) else None
        env = entry.get('env') if isinstance(entry, dict) else None
        split = preload_arguments(entry.get('args'), cua_root, plugin) if isinstance(entry, dict) else None
        return (split is not None and bool(split[0]) and isinstance(env, dict)
                and _same_path(entry.get('command'), cua_root/'bin/node')
                and _same_path(env.get(ENV_RUNTIME_PATH), cua_root/'bin/node_repl'))

    def _codex(self):
        inv = self.inv
        installation = inv.installation
        return {'installed': installation is not None,
                'app_path': str(installation.app_path) if installation is not None else None,
                'app_version': inv.app_version, 'running': bool(inv.app_pids), 'pids': list(inv.app_pids)}

    def _setup(self):
        checks, host = self.inv.checks, self.inv.host
        launcher = self.ctx.setup.support_root(self.ctx.home)/'relay'/'node-repl-relay'
        if host.state == 'ready' and host.relay and host.relay_launcher == str(launcher):
            relay = 'active'          # the running host started this plugin's relay
        elif checks.get('relay_files') != 'ready':
            relay = 'unavailable'     # the next start would have no relay: its stable copy is missing or invalid
        else:
            relay = 'inactive'
        return {'command': checks.get('command', 'missing'), 'dependencies': checks.get('dependencies', 'missing'),
                'login_environment': checks.get('login_environment', 'unknown'),
                'shell_environment': checks.get('shell_environment', 'unknown'), 'shell_file': checks.get('shell_file'),
                'wrapper': checks.get('wrapper', 'broken'), 'relay': relay}

    def _other_tools(self):
        inv, ctx = self.inv, self.ctx
        clients = [conn.to_json() for conn in self.cmux]
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
        last = _later(*[conn.last_call for conn in self.connections],
                      *[line['at'] for line, target, _ in self.activity
                        if target is not None and line['tool'] != 'turn_ended'])
        return {'active_connection_id': recent[0][1].id if recent else None, 'last_call_at': iso(last)}

    def _activity(self, error_text=False):
        """The newest lines first. A line's error text only while the person asks for it: turned off, what was kept
        before is no longer shown either."""
        ordered = sorted(enumerate(self.activity), key=lambda item: (item[1][0]['at'], item[0]), reverse=True)
        return [{'at': iso(line['at']), 'connection_id': target, 'agent': agent, 'tool': line['tool'],
                 'ok': line['ok'], 'ms': line['ms'], 'cwd': line.get('cwd'), 'error': line.get('error'),
                 'error_text': line.get('error_text') if error_text else None}
                for _, (line, target, agent) in ordered[:ACTIVITY_LIMIT]]

    def release_blocked(self):
        """True when the Codex app that is installed now is the version that refused the browser to a thread of the
        engine (a release ended in browser_blocked, or a bridge saw the refusal): a release by session id cannot work
        until Codex changes. Another version, or none known, is tried again as before."""
        blocked = read_browser_blocked(self.ctx.state_dir, self.ctx.uid)
        version = self.inv.app_version
        return blocked is not None and version is not None and blocked['app_version'] == version

    def maybe_left_json(self):
        return [{key: item[key] for key in ('session_id', 'agent', 'connection_id', 'cwd', 'ended_at', 'releasable')}
                for item in self.maybe_left]

    def status_json(self):
        host = self.inv.host
        settings = read_settings(self.ctx.state_dir, self.ctx.uid)
        return {'schema_version': SCHEMA_VERSION, 'generated_at': iso(self.now),
                'plugin': {'version': self.ctx.plugin_version()},
                'engine': {'version': self.ctx.plugin_version(), 'root': str(self.ctx.plugin_root),
                           'launcher': self.ctx.engine_launcher()},
                'codex': self._codex(),
                'host': {'state': self.host_state(), 'since': iso(host.since),
                         'started_before_setup': self.started_before_setup(),
                         'engine_version': self.host_engine_version(),
                         'relay_reason': self.relay_reason(),
                         'restart_adds_relay': self.restart_adds_relay()},
                'setup': self._setup(),
                'connections': [conn.to_json() for conn in self.connections],
                'leases': {'readable': False, 'items': [], 'maybe_left': self.maybe_left_json(),
                           'release_blocked': self.release_blocked()},
                'other_tools': self._other_tools(),
                'screen': self._screen(),
                'settings': settings,
                'activity': self._activity(settings['error_text'])}


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
