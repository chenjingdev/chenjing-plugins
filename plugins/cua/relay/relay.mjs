#!/usr/bin/env node
// codex-cua relay: a stdio relay in front of the original CUA runtime (node_repl).
//
// cua-repl starts the file named by CUA_REPL_NODE_REPL_PATH with inherited stdio. When the host launcher put
// node-repl-relay there, this script runs instead, starts the real runtime (CODEX_CUA_NATIVE_RUNTIME) and passes
// the MCP newline-delimited JSON through unchanged in both directions. On the side it
//   - remembers every (session_id, turn_id) scope that tool calls carry in params._meta["x-codex-turn-metadata"],
//   - can end those scopes through the runtime's own turn_ended tool, on request (control socket) and
//     automatically when the runtime is stopped without that clean-up,
//   - keeps a relay record, a control socket and activity lines in the codex-cua state directory. A Claude bridge
//     that starts its thread with this relay names itself in CODEX_CUA_OWNER. The record carries that name, and so
//     does every activity line: it still says whose call it was when the conversation, this relay and the bridge's
//     own record are gone.
// The format of those files is documented in the engine records description of the plugin.
//
// Nothing the user did is written down: no tool arguments or results, no code, titles, URLs, page text or
// environment values. stderr only ever carries fixed strings.
//
// Safety rules: this file must never be the reason the runtime does not start. If anything fails before the
// runtime is spawned, the runtime is started directly instead. If the state directory is unusable the relay runs
// without records. After a release the relay keeps relaying.
import {execFileSync, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ENV_NATIVE = 'CODEX_CUA_NATIVE_RUNTIME';
const ENV_NODE = 'CODEX_CUA_RELAY_NODE';
const ENV_STATE = 'CODEX_CUA_STATE_DIR';
const ENV_RUNTIME_PATH = 'CUA_REPL_NODE_REPL_PATH';
const ENV_OWNER = 'CODEX_CUA_OWNER';
const OWNER = /^bridge-[0-9]{1,10}-[0-9]{1,12}$/;

const IN_FLIGHT_WAIT_MS = 2500;      // how long a release waits for running tool calls
const OWNED_TIMEOUT_MS = 4000;       // one turn_ended of our own
const RELEASE_DEADLINE_MS = 10000;   // a release asked for through the control socket
const EXIT_RELEASE_MS = 3000;        // the automatic release when the runtime is being stopped
const TERM_GRACE_MS = 1000;          // after stdin ended: wait for the runtime to leave on its own
const KILL_GRACE_MS = 5000;          // after SIGTERM: wait, then SIGKILL
const MAX_SCOPES = 500;              // runaway guard: the oldest scopes beyond this are forgotten
const ABANDONED_KEEP = 64;           // ids of our own requests that gave up, remembered to swallow a late answer
const MAX_REQUEST_BYTES = 1024;
const ACTIVITY_LIMIT_BYTES = 256 * 1024;
const ACTIVITY_KEEP_LINES = 200;
const O_EXLOCK = 0x20;               // Darwin: open(2) takes flock(2)'s exclusive lock atomically

const args = process.argv.slice(2);
const native = process.env[ENV_NATIVE];
const owner = OWNER.test(process.env[ENV_OWNER] ?? '') ? process.env[ENV_OWNER] : null;

function say(message) {
  try {fs.writeSync(2, 'codex-cua relay: ' + message + '\n');} catch {/* nowhere to say it */}
}

class NativeUnavailable extends Error {}

function ownLauncher() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'node-repl-relay');
}

function checkNative() {
  if (!native || !path.isAbsolute(native)) throw new NativeUnavailable('absolute path required');
  const info = fs.statSync(native);
  if (!info.isFile()) throw new NativeUnavailable('not a file');
  fs.accessSync(native, fs.constants.X_OK);
  // The relay must never start itself again.
  const real = fs.realpathSync(native);
  for (const own of [process.argv[1], ownLauncher()]) {
    try {
      if (own && fs.realpathSync(own) === real) throw new NativeUnavailable('recursion');
    } catch (error) {
      if (error instanceof NativeUnavailable) throw error;
    }
  }
}

// The runtime gets the environment it would have had without the relay.
function runtimeEnvironment() {
  const env = {...process.env};
  for (const name of [ENV_NATIVE, ENV_NODE, ENV_STATE, ENV_OWNER]) delete env[name];
  env[ENV_RUNTIME_PATH] = native;
  return env;
}

function exitLike(code, signal) {
  const number = signal ? os.constants.signals[signal] : 0;
  process.exit(code ?? (number ? 128 + number : 1));
}

// Used when the relay cannot be set up: the original runtime, directly, with inherited stdio.
function runPlain() {
  let plain;
  try {
    checkNative();
    plain = spawn(native, args, {env: runtimeEnvironment(), stdio: 'inherit'});
  } catch {
    say('the original runtime is unavailable');
    process.exit(127);
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {try {plain.kill(signal);} catch {/* gone */}});
  plain.on('error', () => {say('the original runtime is unavailable'); process.exit(127);});
  plain.on('close', (code, signal) => exitLike(code, signal));
}

function prepare() {
  // Test hook for the safety net below: a failure in this phase must start the original runtime directly.
  if (process.env.CODEX_CUA_RELAY_TEST_FAIL === 'before-spawn') throw new Error('injected');
  checkNative();
  return spawn(native, args, {env: runtimeEnvironment(), stdio: ['pipe', 'pipe', 'inherit']});
}

let runtime = null;
try {
  runtime = prepare();
} catch (error) {
  if (error instanceof NativeUnavailable || (error && error.code === 'ENOENT') || (error && error.code === 'EACCES')) {
    say('the original runtime is unavailable');
    process.exit(127);
  }
  say('relay setup failed; starting the original runtime directly');
  runtime = null;
  runPlain();
}
if (runtime) relay(runtime);

function relay(child) {
  const me = process.pid;
  const rootPid = process.ppid;
  const scopes = new Map();      // "session\0turn" -> {session_id, turn_id, first_at, last_at, subagent}
  const pending = new Map();     // JSON id -> client request waiting for its response
  const owned = new Map();       // our own request ids -> {resolve, reject, timer}
  const abandoned = new Set();   // ids of our own requests that timed out: a late answer must not reach the client
  const ownedPrefix = 'codex-cua-relay-' + randomUUID() + '-';
  let ownedSeq = 0;
  let callsInFlight = 0;
  let lastCallAt = null;
  let turnEndedTool = null;
  let releaseFailed = false;
  let stopping = null;
  let stopSignal = null;
  let stopped = false;
  let exited = false;
  let finalized = false;
  let releaseChain = Promise.resolve();
  let uncaught = 0;

  const iso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const idKey = id => JSON.stringify(id);
  const pairKey = (session, turn) => session + '\u0000' + turn;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200;

  // ---------------------------------------------------------------- records (all optional)
  let records = null;            // {dir, file, socketPath, activity, lock, startedAt, appServerPid, controlPath}
  let persistTimer = null;

  function processInfo(pids) {
    const output = execFileSync('/bin/ps', ['-o', 'pid=,ppid=,lstart=', '-p', pids.join(',')], {
      encoding: 'utf8', env: {...process.env, LC_ALL: 'C'}, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore']});
    const months = {Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11};
    const result = new Map();
    for (const line of output.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+\w{3}\s+(\w{3})\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d{4})\s*$/.exec(line);
      if (!m || !(m[3] in months)) continue;
      const started = new Date(Number(m[8]), months[m[3]], Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]));
      if (Number.isNaN(started.getTime())) continue;
      result.set(Number(m[1]), {ppid: Number(m[2]), startedAt: Math.floor(started.getTime() / 1000)});
    }
    return result;
  }

  function privateDirectory(dir) {
    const info = fs.lstatSync(dir);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error('not private');
  }

  function writeAtomic(file, value) {
    const temporary = file + '.' + me + '.tmp';
    fs.writeFileSync(temporary, value, {mode: 0o600});
    fs.renameSync(temporary, file);
  }

  function openRecords() {
    const info = processInfo([me, rootPid]);
    const mine = info.get(me);
    if (!mine) throw new Error('identity');
    const configured = process.env[ENV_STATE];
    const stateRoot = configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), 'Library', 'Caches', 'codex-cua');
    fs.mkdirSync(stateRoot, {recursive: true, mode: 0o700});
    privateDirectory(stateRoot);
    const relays = path.join(stateRoot, 'relays');
    fs.mkdirSync(relays, {recursive: true, mode: 0o700});
    privateDirectory(relays);
    const dir = fs.mkdtempSync(path.join(relays, 'relay-'));
    fs.chmodSync(dir, 0o700);
    records = {
      dir, file: path.join(dir, 'relay.json'), socketPath: path.join(dir, 'control.sock'), controlPath: path.join(dir, 'control.sock'),
      activity: path.join(stateRoot, 'activity.jsonl'), lock: path.join(stateRoot, 'activity.lock'),
      startedAt: mine.startedAt, appServerPid: info.get(rootPid)?.ppid ?? null,
    };
  }

  function snapshot() {
    let cwd = null;
    try {cwd = process.cwd();} catch {/* removed directory */}
    return {
      schema_version: 1, kind: 'relay', pid: me, started_at: records.startedAt,
      runtime_pid: child.pid ?? null, root_pid: rootPid, app_server_pid: records.appServerPid, cwd, owner,
      control_path: records.controlPath, last_call_at: lastCallAt, busy: callsInFlight > 0,
      scopes: [...scopes.values()].map(s => ({session_id: s.session_id, turn_id: s.turn_id, first_at: s.first_at,
        last_at: s.last_at, subagent: s.subagent})),
      cleanup: scopes.size === 0 ? 'none' : (releaseFailed || exited ? 'not_confirmed' : 'open'),
      updated_at: iso(),
    };
  }

  function persistNow() {
    if (persistTimer) {clearTimeout(persistTimer); persistTimer = null;}
    if (!records) return;
    try {writeAtomic(records.file, JSON.stringify(snapshot()) + '\n');} catch {/* records never get in the way */}
  }

  function schedulePersist() {
    if (!records || persistTimer) return;
    persistTimer = setTimeout(() => {persistTimer = null; persistNow();}, 150);
    persistTimer.unref();
  }

  function rotateActivity() {
    if (process.platform !== 'darwin') return;
    let lock;
    try {
      lock = fs.openSync(records.lock, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | O_EXLOCK, 0o600);
    } catch {return;}                    // busy (EAGAIN) or unusable: just keep appending
    try {
      const info = fs.fstatSync(lock);
      if (!info.isFile() || info.uid !== process.getuid()) return;
      const content = fs.readFileSync(records.activity, 'utf8');
      const lines = content.split('\n');
      if (!content.endsWith('\n')) lines.pop();   // a line that is still being written
      const keep = lines.filter(Boolean).slice(-ACTIVITY_KEEP_LINES);
      writeAtomic(records.activity, keep.join('\n') + '\n');
    } catch {/* the activity log is best effort */} finally {
      try {fs.closeSync(lock);} catch {/* closed */}
    }
  }

  function activity(entry) {
    if (!records) return;
    const tool = typeof entry.tool === 'string' && /^[\w.:-]{1,64}$/.test(entry.tool) ? entry.tool : 'unknown';
    // `owner` is only there when a bridge named itself; without it (Codex's own runtime) the line is what it always was.
    const line = JSON.stringify({at: iso(), writer: 'relay-' + me + '-' + records.startedAt,
      session_id: text(entry.sessionId) ? entry.sessionId : null, tool, ok: entry.ok === true, ms: entry.ms,
      ...(owner ? {owner} : {})}) + '\n';
    let fd;
    try {
      fd = fs.openSync(records.activity, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeSync(fd, line);
      const size = fs.fstatSync(fd).size;
      fs.closeSync(fd);
      fd = undefined;
      if (size > ACTIVITY_LIMIT_BYTES) rotateActivity();
    } catch {
      if (fd !== undefined) try {fs.closeSync(fd);} catch {/* closed */}
    }
  }

  try {openRecords();} catch {records = null;}

  // ---------------------------------------------------------------- scopes
  function scopeOf(message) {
    let meta = message.params?._meta?.['x-codex-turn-metadata'];
    if (typeof meta === 'string') {try {meta = JSON.parse(meta);} catch {return null;}}
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const subagent = meta.thread_source === 'subagent';
    const session = subagent ? meta.thread_id : meta.session_id;
    if (!text(session) || !text(meta.turn_id)) return null;
    return {session_id: session, turn_id: meta.turn_id, subagent};
  }

  function pairOf(argumentsObject) {
    if (!argumentsObject || typeof argumentsObject !== 'object') return null;
    return text(argumentsObject.session_id) && text(argumentsObject.turn_id)
      ? {session_id: argumentsObject.session_id, turn_id: argumentsObject.turn_id} : null;
  }

  function openScope(scope) {
    const key = pairKey(scope.session_id, scope.turn_id);
    const known = scopes.get(key);
    const now = iso();
    if (known) {known.last_at = now; schedulePersist(); return;}
    scopes.set(key, {...scope, first_at: now, last_at: now});
    while (scopes.size > MAX_SCOPES) scopes.delete(scopes.keys().next().value);
    persistNow();                        // on disk before the runtime can see the call
  }

  function closeScope(pair) {
    if (scopes.delete(pairKey(pair.session_id, pair.turn_id))) {
      if (scopes.size === 0) releaseFailed = false;
      persistNow();
    }
  }

  // ---------------------------------------------------------------- the two directions
  function lineSplitter(onLine) {
    let parts = [];
    return {
      push(chunk) {
        let start = 0;
        let end;
        while ((end = chunk.indexOf(0x0a, start)) !== -1) {
          const piece = chunk.subarray(start, end + 1);
          if (parts.length) {parts.push(piece); const whole = Buffer.concat(parts); parts = []; onLine(whole);} else onLine(piece);
          start = end + 1;
        }
        if (start < chunk.length) parts.push(chunk.subarray(start));
      },
      flush() {
        if (!parts.length) return;
        const rest = Buffer.concat(parts);
        parts = [];
        onLine(rest);
      },
    };
  }

  let stdinHeld = false;
  function toRuntime(buffer) {
    if (!child.stdin.writable) return;
    if (!child.stdin.write(buffer) && !stdinHeld) {
      stdinHeld = true;
      process.stdin.pause();
      child.stdin.once('drain', () => {stdinHeld = false; process.stdin.resume();});
    }
  }

  let stdoutHeld = false;
  function toClient(buffer) {
    if (!process.stdout.writable) return;
    if (!process.stdout.write(buffer) && !stdoutHeld) {
      stdoutHeld = true;
      child.stdout.pause();
      process.stdout.once('drain', () => {stdoutHeld = false; child.stdout.resume();});
    }
  }

  function toRuntimeJson(object) {
    if (child.stdin.writable) child.stdin.write(JSON.stringify(object) + '\n');
  }

  function fromClient(line) {
    try {
      const message = JSON.parse(line.toString('utf8'));
      if (message && typeof message === 'object' && !Array.isArray(message) && typeof message.method === 'string') noteRequest(message);
    } catch {/* not JSON, or not ours to understand: still passed on below */}
    toRuntime(line);
  }

  function noteRequest(message) {
    const key = message.id !== undefined && message.id !== null ? idKey(message.id) : null;
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      const isEnd = name === 'turn_ended';
      // Only context supplied by the host counts. Tool code is never accepted as scope.
      const scope = isEnd ? null : scopeOf(message);
      const pair = isEnd ? pairOf(message.params?.arguments) : null;
      // The Codex app ends every turn of its chats with turn_ended, CUA or not. Only the end of a pair that a call
      // opened here is the AI's own: the others are neither a call nor a line in the activity log.
      const routine = isEnd && !(pair && scopes.has(pairKey(pair.session_id, pair.turn_id)));
      if (!routine) lastCallAt = iso();
      if (key !== null) {
        callsInFlight += 1;
        pending.set(key, {kind: 'call', tool: name, sessionId: scope?.session_id ?? pair?.session_id ?? null, pair, routine,
          started: Date.now()});
      }
      if (scope) openScope(scope); else schedulePersist();
    } else if (message.method === 'tools/list') {
      if (key !== null) pending.set(key, {kind: 'list'});
    } else if (message.method === 'notifications/cancelled') {
      const requestId = message.params?.requestId;
      if (requestId !== undefined && requestId !== null) {
        const entry = pending.get(idKey(requestId));
        if (entry) {
          pending.delete(idKey(requestId));
          if (entry.kind === 'call') callsInFlight -= 1;
          schedulePersist();
        }
      }
    }
  }

  const confirmed = response => response.error === undefined && response.result !== undefined && response.result?.isError !== true;

  // True when the line was the answer to a request of our own and must not reach the client.
  function inspectResponse(line) {
    let message = null;
    try {message = JSON.parse(line.toString('utf8'));} catch {return false;}
    const isResponse = message && typeof message === 'object' && !Array.isArray(message)
      && message.method === undefined && message.id !== undefined && message.id !== null;
    if (!isResponse) return false;
    if (typeof message.id === 'string') {
      if (owned.has(message.id)) {
        const waiting = owned.get(message.id);
        owned.delete(message.id);
        clearTimeout(waiting.timer);
        waiting.resolve(message);
        return true;
      }
      if (abandoned.delete(message.id)) return true;   // the late answer to a request of ours that gave up
    }
    const key = idKey(message.id);
    const entry = pending.get(key);
    if (!entry) return false;
    pending.delete(key);
    if (entry.kind === 'call') {
      callsInFlight -= 1;
      const ok = confirmed(message);
      if (!entry.routine) {
        lastCallAt = iso();
        activity({sessionId: entry.sessionId, tool: entry.tool, ok, ms: Date.now() - entry.started});
      }
      if (ok && entry.pair) closeScope(entry.pair);
      schedulePersist();
    } else if (entry.kind === 'list' && Array.isArray(message.result?.tools)) {
      turnEndedTool = message.result.tools.find(tool => tool && tool.name === 'turn_ended') ?? null;
    }
    return false;
  }

  function fromRuntime(line) {
    if (pending.size === 0 && owned.size === 0 && abandoned.size === 0) {toClient(line); return;}
    let swallowed = false;
    try {swallowed = inspectResponse(line);} catch {/* bookkeeping never costs a message */}
    if (!swallowed) toClient(line);
  }

  // ---------------------------------------------------------------- release
  function ownedRequest(method, params, timeout) {
    const id = ownedPrefix + (++ownedSeq);
    return new Promise((resolve, reject) => {
      if (!child.stdin.writable) {reject(new Error('closed')); return;}
      const timer = setTimeout(() => {
        owned.delete(id);
        abandoned.add(id);                                   // the runtime may still answer; the client must never see it
        while (abandoned.size > ABANDONED_KEEP) abandoned.delete(abandoned.values().next().value);
        reject(new Error('deadline'));
      }, timeout);
      owned.set(id, {resolve, reject, timer});
      toRuntimeJson({jsonrpc: '2.0', id, method, params});
    });
  }

  async function cleanupToolUsable(budget) {
    if (!turnEndedTool) {
      const listed = await ownedRequest('tools/list', {}, Math.max(1, Math.min(OWNED_TIMEOUT_MS, budget)));
      turnEndedTool = listed.result?.tools?.find(tool => tool && tool.name === 'turn_ended') ?? null;
    }
    const required = turnEndedTool?.inputSchema?.required;
    return Array.isArray(required) && ['hook_event_name', 'session_id', 'turn_id'].every(field => required.includes(field));
  }

  // `deadline` is an absolute time; without it the release has `limit` milliseconds from the moment it starts.
  async function releaseNow({sessionId = null, waitForCalls = true, limit, deadline = Date.now() + limit}) {
    if (waitForCalls) {
      const until = Date.now() + IN_FLIGHT_WAIT_MS;
      while (callsInFlight > 0 && Date.now() < until && !stopping) await sleep(25);
      if (callsInFlight > 0) return {released: false, reason: 'request_in_flight', scope_count: 0};
    }
    const targets = [...scopes.values()].filter(scope => sessionId === null || scope.session_id === sessionId);
    if (targets.length === 0) return {released: false, reason: 'no_trusted_scope', scope_count: 0};
    const unconfirmed = reason => {releaseFailed = true; persistNow(); return {released: false, reason, scope_count: 0};};
    try {
      if (!await cleanupToolUsable(deadline - Date.now())) return unconfirmed('cleanup_tool_unavailable');
    } catch {
      return unconfirmed('cleanup_not_confirmed');
    }
    let count = 0;
    let failed = false;
    for (const scope of targets) {
      const left = deadline - Date.now();
      if (left <= 0) {failed = true; break;}
      try {
        const pair = {session_id: scope.session_id, turn_id: scope.turn_id};
        const response = await ownedRequest('tools/call', {name: 'turn_ended',
          arguments: {hook_event_name: scope.subagent ? 'SubagentStop' : 'Stop', ...pair},
          _meta: {'x-codex-turn-metadata': pair}}, Math.min(OWNED_TIMEOUT_MS, left));
        if (confirmed(response)) {closeScope(pair); count += 1;} else failed = true;
      } catch {failed = true;}
    }
    if (failed) {releaseFailed = true; persistNow();}
    return failed ? {released: false, reason: 'cleanup_not_confirmed', scope_count: count}
      : {released: true, reason: null, scope_count: count};
  }

  // One release at a time; later ones see what the earlier ones left.
  function release(options) {
    const run = releaseChain.then(() => releaseNow(options));
    releaseChain = run.catch(() => {});
    return run;
  }

  // ---------------------------------------------------------------- control socket
  let server = null;
  function startControl() {
    if (!records) return;
    server = net.createServer(socket => {
      const chunks = [];
      let size = 0;
      let answered = false;
      socket.setTimeout(2000, () => socket.destroy());
      socket.on('error', () => {});
      const handle = async buffer => {
        if (answered) return;
        answered = true;
        socket.setTimeout(0);
        let request;
        try {request = JSON.parse(buffer.toString('utf8'));} catch {socket.destroy(); return;}
        if (!request || typeof request !== 'object' || request.pid !== me || request.started_at !== records.startedAt) {socket.destroy(); return;}
        let reply;
        try {
          if (request.action === 'status') {
            reply = {ok: true, busy: callsInFlight > 0, open_scopes: scopes.size};
          } else if (request.action === 'release') {
            reply = await release({limit: RELEASE_DEADLINE_MS});
          } else if (request.action === 'release-session') {
            reply = text(request.session_id) ? await release({sessionId: request.session_id, limit: RELEASE_DEADLINE_MS})
              : {released: false, reason: 'no_trusted_scope', scope_count: 0};
          } else {socket.destroy(); return;}
        } catch {
          reply = {released: false, reason: 'cleanup_not_confirmed', scope_count: 0};
        }
        socket.end(JSON.stringify(reply) + '\n');
      };
      socket.on('data', chunk => {
        if (answered) return;
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) {answered = true; socket.destroy(); return;}
        chunks.push(chunk);
        const all = Buffer.concat(chunks);
        const end = all.indexOf(0x0a);
        if (end >= 0) void handle(all.subarray(0, end));
      });
      socket.on('end', () => {if (!answered && size > 0) void handle(Buffer.concat(chunks));});
    });
    server.on('error', () => {
      // No usable socket: the relay still relays, and the record says there is nothing to ask.
      records.controlPath = null;
      server = null;
      persistNow();
    });
    server.listen(records.socketPath, () => {
      try {fs.chmodSync(records.socketPath, 0o600);} catch {/* the directory is private anyway */}
    });
  }

  // ---------------------------------------------------------------- stopping
  function finalize(code) {
    if (finalized) return;
    finalized = true;
    exited = true;
    for (const waiting of owned.values()) {clearTimeout(waiting.timer); waiting.reject(new Error('exit'));}
    owned.clear();
    if (server) {try {server.close();} catch {/* closed */}}
    if (records) {
      try {fs.rmSync(records.socketPath, {force: true});} catch {/* gone */}
      try {
        if (scopes.size === 0) {
          if (persistTimer) clearTimeout(persistTimer);
          fs.rmSync(records.dir, {recursive: true, force: true});
        } else {
          callsInFlight = 0;
          persistNow();
        }
      } catch {/* leaving a record behind is fine */}
    }
    // Output that did not fit into the pipe yet has to get out before the process goes.
    if (process.stdout.writable && process.stdout.writableLength > 0) {
      const leave = () => process.exit(code);
      process.stdout.write('', leave);                 // called once everything written before it has gone out
      process.stdout.once('error', leave);
      setTimeout(leave, 3000).unref();
      return;
    }
    process.exit(code);
  }

  function stopRuntime(signal) {
    stopped = true;
    try {child.stdin.end();} catch {/* closed */}
    if (signal) {
      try {child.kill(signal);} catch {/* gone */}
      const kill = setTimeout(() => {try {child.kill('SIGKILL');} catch {/* gone */}}, KILL_GRACE_MS + TERM_GRACE_MS);
      kill.unref();
      return;
    }
    // Stdin ended: a runtime ends itself when its stdin does. Make sure it does.
    const term = setTimeout(() => {
      try {child.kill('SIGTERM');} catch {/* gone */}
      const kill = setTimeout(() => {try {child.kill('SIGKILL');} catch {/* gone */}}, KILL_GRACE_MS);
      kill.unref();
    }, TERM_GRACE_MS);
    term.unref();
  }

  // cua-repl passes on the signal it got, so the same signal usually arrives twice. Neither may cut the release
  // short: a signal that comes while the scopes are being ended is only remembered, and used afterwards.
  function stop(signal) {
    if (stopping) {
      if (signal) {
        stopSignal = stopSignal ?? signal;
        if (stopped) {try {child.kill(signal);} catch {/* gone */}}
      }
      return stopping;
    }
    stopSignal = signal;
    stopping = (async () => {
      if (server) {try {server.close();} catch {/* closed */}}
      if (!exited && scopes.size > 0) {
        // A release asked for through the control socket may be running and ahead in line: the exit path waits
        // three seconds in total, counted from the signal, and then stops the runtime whatever happened.
        let timer;
        const limit = new Promise(resolve => {timer = setTimeout(resolve, EXIT_RELEASE_MS);});
        try {
          await Promise.race([release({waitForCalls: false, deadline: Date.now() + EXIT_RELEASE_MS}), limit]);
        } catch {/* best effort */}
        clearTimeout(timer);
      }
      stopRuntime(stopSignal);
    })();
    return stopping;
  }

  // ---------------------------------------------------------------- wiring
  const fromStdin = lineSplitter(fromClient);
  const fromChild = lineSplitter(fromRuntime);
  process.stdin.on('data', chunk => fromStdin.push(chunk));
  process.stdin.on('end', () => {fromStdin.flush(); void stop(null);});
  process.stdin.on('error', () => {void stop(null);});
  child.stdout.on('data', chunk => fromChild.push(chunk));
  child.stdout.on('end', () => fromChild.flush());
  child.stdin.on('error', () => {});
  process.stdout.on('error', () => {});
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {void stop(signal);});
  process.on('uncaughtException', () => {
    // Bookkeeping must never take the runtime down; a storm of errors is not bookkeeping any more.
    uncaught += 1;
    say('unexpected error');
    if (uncaught > 20) finalize(1);
  });
  child.on('error', () => {
    // 'error' also reports a failed kill or write; only a runtime that never started ends the relay.
    if (child.pid === undefined) {say('the original runtime is unavailable'); finalize(127);}
  });
  let closeTimer = null;
  child.on('exit', (code, signal) => {
    exited = true;
    // Normally 'close' follows at once; do not wait for a stdout that a grandchild keeps open.
    closeTimer = setTimeout(() => finalize(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)), 2000);
  });
  child.on('close', (code, signal) => {
    if (closeTimer) clearTimeout(closeTimer);
    finalize(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1));
  });

  startControl();
  persistNow();
}
// codex-cua relay end
