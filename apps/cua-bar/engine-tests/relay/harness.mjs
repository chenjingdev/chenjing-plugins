// Shared helpers of the relay tests: a fake node_repl, a client for the relay's stdio, and a control-socket client.
// Everything runs on temporary directories and fake programs; no Codex, no Chrome, no real CUA runtime.
import {execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Whatever a test forgets to inject lands in a throw-away home, and the run fails if anything shows up there.
export const DEFAULT_HOME = fs.mkdtempSync('/tmp/crh-');
process.env.HOME = DEFAULT_HOME;

// A child that is given an environment without HOME would find the real home through the account database, and an
// overwrite inside an existing file changes no name. So the real support folders are fingerprinted (read only: lstat
// and readdir) when the tests start and again when they end, and any difference fails the run. apps/cua-bar/engine-tests/guard.py
// does the same for the Python tests, with the same exit codes: 1 for a failing test or a stray in the throw-away
// home, 2 for a change in the real folders. A run that saw such a change proves nothing, so 2 wins over 1; the
// changed paths are printed with their new modification time in local time. `node --test` reports every failing
// file as 1 itself, the 2 is the exit code of the test process: run `node apps/cua-bar/engine-tests/relay` to see it.
export const WATCHED = ['.local/share/codex-cua', '.local/bin/codex-cua', 'Library/Caches/codex-cua',
  'Library/Caches/codex-host-cua'];
// Shared folders, of which only the entries with our own prefix count: other tools change their own entries all
// the time (the login agents of this plugin are com.chenjingdev.codex-cua.*).
export const PREFIXED = [['Library/LaunchAgents', 'com.chenjingdev.']];
export const REAL_HOME = os.userInfo().homedir;       // from the account database, not from HOME

export function fingerprint(home, watched = WATCHED, prefixed = PREFIXED) {
  const seen = new Map();
  const kind = BigInt(fs.constants.S_IFMT);
  const directory = BigInt(fs.constants.S_IFDIR);
  const visit = (full, relative) => {
    let info;
    try {info = fs.lstatSync(full, {bigint: true});} catch {seen.set(relative, null); return;}
    seen.set(relative, [info.mode & kind, info.size, info.mtimeNs, info.ino].join(':'));
    if ((info.mode & kind) === directory) {
      let names = [];
      try {names = fs.readdirSync(full);} catch {/* not for us to look at */}
      for (const name of names) visit(path.join(full, name), relative + '/' + name);
    }
  };
  for (const name of watched) visit(path.join(home, name), name);
  for (const [name, prefix] of prefixed) {
    let names = [];
    try {names = fs.readdirSync(path.join(home, name));} catch {/* absent */}
    for (const entry of names) if (entry.startsWith(prefix)) visit(path.join(home, name, entry), name + '/' + entry);
  }
  return seen;
}

export function changes(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter(key => before.get(key) !== after.get(key)).sort();
}

// A modification time (in nanoseconds) in the local time zone, to the second and with its offset:
// 2026-10-19 00:12:34 +0900.
export function localTime(ns) {
  const date = new Date(Number(BigInt(ns) / 1000000n));
  const two = value => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const zone = (offset < 0 ? '-' : '+') + two(Math.floor(Math.abs(offset) / 60)) + two(Math.abs(offset) % 60);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} `
    + `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())} ${zone}`;
}

// One line per changed path: what happened to it and, for what is still there, its new modification time.
export function describe(before, after) {
  const absent = value => value === null || value === undefined;
  return changes(before, after).map(key => {
    const now = after.get(key);
    if (absent(now)) return `${key}  removed`;
    return `${key}  ${absent(before.get(key)) ? 'new' : 'changed'}, modified ${localTime(now.split(':')[2])}`;
  });
}

export const EXIT_GUARD = 2;
const SHOWN = 30;                       // changed paths that are printed; the rest is only counted
const MOVED = 'The real support folders changed while the tests ran. The tests only read them, so most likely '
  + 'something else did: using CUA, starting Codex or installing the plugin during the run. Run the tests again while '
  + 'CUA is not in use; if it repeats with everything idle, a test writes there. New modification time, local time:';

// Fingerprint the watched folders of `home` now and, when the process ends, fail it with EXIT_GUARD if anything
// differs.
export function watchHome(home) {
  const before = fingerprint(home);
  process.on('exit', () => {
    const moved = describe(before, fingerprint(home));
    if (moved.length === 0) return;
    const more = moved.length > SHOWN ? [`... and ${moved.length - SHOWN} more`] : [];
    process.stderr.write(MOVED + '\n  ' + [...moved.slice(0, SHOWN), ...more].join('\n  ') + '\n');
    process.exitCode = EXIT_GUARD;
  });
}

watchHome(REAL_HOME);
process.on('exit', () => {
  let strays = [];
  try {strays = fs.readdirSync(DEFAULT_HOME, {recursive: true});} catch {/* gone */}
  fs.rmSync(DEFAULT_HOME, {recursive: true, force: true});
  if (strays.length > 0) {
    process.stderr.write('Tests wrote into the default home instead of an injected one:\n  ' + strays.join('\n  ') + '\n');
    if (process.exitCode !== EXIT_GUARD) process.exitCode = 1;
  }
});

// RELAY_DIR_UNDER_TEST points the tests at a modified copy of the relay (mutation checks of these tests).
export const RELAY_DIR = process.env.RELAY_DIR_UNDER_TEST
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../engine/relay');
export const RELAY_MJS = path.join(RELAY_DIR, 'relay.mjs');
export const LAUNCHER = path.join(RELAY_DIR, 'node-repl-relay');

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function until(check, timeout = 6000, label = 'condition') {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try {value = await check();} catch {value = undefined;}
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label);
    await sleep(20);
  }
}

// A runtime that speaks just enough MCP. Its behaviour is chosen by the code of a js call or by FAKE_* variables.
const FAKE_RUNTIME = String.raw`
import fs from 'node:fs';
import path from 'node:path';
const log = process.env.FAKE_LOG;
// How many scopes the relay had written down when this runtime saw a call.
function recordedScopes() {
  try {
    const base = path.join(process.env.FAKE_STATE, 'relays');
    for (const name of fs.readdirSync(base)) return JSON.parse(fs.readFileSync(path.join(base, name, 'relay.json'), 'utf8')).scopes.length;
  } catch {/* no record */}
  return null;
}
const append = (kind, value) => fs.appendFileSync(log, JSON.stringify({kind, ...value}) + '\n');
const out = object => process.stdout.write(JSON.stringify(object) + '\n');
const text = value => ({content: [{type: 'text', text: value}]});
append('start', {pid: process.pid, argv: process.argv.slice(2), env: {
  native: process.env.CODEX_CUA_NATIVE_RUNTIME ?? null, relayNode: process.env.CODEX_CUA_RELAY_NODE ?? null,
  state: process.env.CODEX_CUA_STATE_DIR ?? null, runtimePath: process.env.CUA_REPL_NODE_REPL_PATH ?? null,
  marker: process.env.FAKE_MARKER ?? null, owner: process.env.CODEX_CUA_OWNER ?? null}});
const ended = new Set();
let buffer = Buffer.alloc(0);
function handle(line) {
  append('line', {b64: line.toString('base64')});
  let m;
  try {m = JSON.parse(line.toString('utf8'));} catch {return;}
  if (!m || typeof m !== 'object') return;
  if (m.method === undefined) {append('client-response', {id: m.id}); return;}
  if (m.id === undefined) {append('notification', {method: m.method}); return;}
  const reply = result => out({jsonrpc: '2.0', id: m.id, result});
  if (m.method === 'initialize') return reply({protocolVersion: '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'fake', version: '0'}});
  if (m.method === 'tools/list') {
    const tools = process.env.FAKE_NO_TURN_ENDED === '1' ? [{name: 'js', inputSchema: {type: 'object'}}]
      : [{name: 'js', inputSchema: {type: 'object'}}, {name: 'js_reset', inputSchema: {type: 'object'}},
        {name: 'turn_ended', inputSchema: {type: 'object', required: ['hook_event_name', 'session_id', 'turn_id']}}];
    if (process.env.FAKE_HANG_LIST === '1') return;
    if (process.env.FAKE_SLOW_LIST) return void setTimeout(() => {reply({tools}); append('answered', {to: 'tools/list'});}, Number(process.env.FAKE_SLOW_LIST));
    return reply({tools});
  }
  if (m.method !== 'tools/call') return out({jsonrpc: '2.0', id: m.id, error: {code: -32601, message: 'no such method'}});
  const name = m.params?.name;
  const a = m.params?.arguments ?? {};
  if (name === 'turn_ended') {
    const key = a.session_id + '/' + a.turn_id;
    append('turn_ended', {hook: a.hook_event_name, session_id: a.session_id, turn_id: a.turn_id, meta: m.params?._meta ?? null, repeated: ended.has(key)});
    ended.add(key);
    if (process.env.FAKE_REFUSE_TURN_ENDED === '1' || a.hook_event_name === 'Refuse' || String(a.turn_id).startsWith('refuse')) return reply({content: [], isError: true});
    if (a.hook_event_name === 'RpcError') return out({jsonrpc: '2.0', id: m.id, error: {code: -32000, message: 'boom'}});
    if (process.env.FAKE_HANG_TURN_ENDED === '1') return;
    if (process.env.FAKE_SLOW_TURN_ENDED) return void setTimeout(() => {reply({content: []}); append('answered', {to: 'turn_ended'});}, Number(process.env.FAKE_SLOW_TURN_ENDED));
    return reply({content: []});
  }
  const code = String(a.code ?? '');
  append('call', {name, code_length: code.length, recorded: recordedScopes()});
  if (code.startsWith('sleep:')) return void setTimeout(() => reply(text('slept')), Number(code.slice(6)));
  if (code === 'hang') return;
  if (code === 'fail') return reply({content: [{type: 'text', text: 'failed'}], isError: true});
  if (code.startsWith('fail-after:')) return void setTimeout(() => reply({content: [{type: 'text', text: 'timed out'}], isError: true}), Number(code.slice(11)));
  // As the computer-use service refuses while the Mac is locked.
  if (code === 'locked') return reply({content: [{type: 'text', text: 'SkyComputerUseError: The Mac is locked. Unlock it before reading accessibility text.'}], isError: true});
  if (code === 'locked-rpc') return out({jsonrpc: '2.0', id: m.id, error: {code: -10020, message: 'The Mac is locked. Ask the user to unlock it.'}});
  if (code === 'rpc-error') return out({jsonrpc: '2.0', id: m.id, error: {code: -32000, message: 'boom'}});
  // An error of several lines, then the script's console line and the guidance Codex adds to a thread's first answer.
  if (code.startsWith('fail-lines:')) return reply({content: [{type: 'image', data: 'x'}, {type: 'text', text: ' \n'},
    {type: 'text', text: 'first line\n  second\tline ' + 'y'.repeat(Number(code.slice(11)))}, {type: 'text', text: 'a console line'},
    {type: 'text', text: '## Computer Use\n\nControl native apps'}], isError: true});
  if (code.startsWith('big:')) return reply(text('x'.repeat(Number(code.slice(4)))));
  if (code.startsWith('emit:')) return void process.stdout.write(Buffer.from(code.slice(5), 'base64'));
  if (code === 'ask') {out({jsonrpc: '2.0', id: 'server-1', method: 'elicitation/create', params: {message: 'ok?'}}); return reply(text('asked'));}
  reply(text('echo:' + code));
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  let end;
  while ((end = buffer.indexOf(10)) >= 0) {
    const line = buffer.subarray(0, end + 1);
    buffer = buffer.subarray(end + 1);
    handle(line);
  }
});
process.stdin.on('end', () => {
  append('stdin-end', {rest: buffer.length});
  if (process.env.FAKE_IGNORE_EOF === '1') {setInterval(() => {}, 1000); return;}
  // Leave only after everything written has gone out, as a real runtime does.
  process.stdout.write('', () => process.exit(Number(process.env.FAKE_EXIT_CODE ?? 0)));
});
process.on('SIGTERM', () => {
  append('sigterm', {});
  if (process.env.FAKE_IGNORE_TERM !== '1') process.exit(Number(process.env.FAKE_EXIT_CODE ?? 0));
});
process.on('SIGHUP', () => {append('sighup', {}); process.exit(0);});
process.on('SIGINT', () => {append('sigint', {}); process.exit(0);});
`;

export function makeFixture() {
  // Unix socket paths are limited to about 100 bytes, so the root has to be short.
  const dir = fs.mkdtempSync('/tmp/crl-');
  const fake = path.join(dir, 'fake-runtime.mjs');
  fs.writeFileSync(fake, FAKE_RUNTIME);
  const native = path.join(dir, 'node_repl');
  fs.writeFileSync(native, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, {mode: 0o755});
  const fixture = {
    dir, native, log: path.join(dir, 'fake.log'), state: path.join(dir, 'state'), clients: [],
    events(kind) {
      let text = '';
      try {text = fs.readFileSync(fixture.log, 'utf8');} catch {return [];}
      return text.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => !kind || event.kind === kind);
    },
    // Stop what the test started and wait until nothing is left that could still write into the folder (the relay
    // and the fake runtime behind it leave a moment after the kill), then remove the folder.
    async cleanup() {
      for (const client of fixture.clients) client.kill();
      const pids = fixture.events('start').map(event => event.pid);
      await Promise.race([Promise.all(fixture.clients.map(client => client.exit)), sleep(3000)]);
      const gone = pid => {try {process.kill(pid, 0); return false;} catch (error) {return error.code === 'ESRCH';}};
      const deadline = Date.now() + 3000;
      while (pids.some(pid => !gone(pid)) && Date.now() < deadline) await sleep(20);
      fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
    },
  };
  return fixture;
}

export class Client {
  constructor(child) {
    this.child = child;
    this.chunks = [];
    this.errors = [];
    this.seq = 0;
    this.exit = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
    child.stdout.on('data', chunk => this.chunks.push(chunk));
    child.stderr.on('data', chunk => this.errors.push(chunk));
    child.stdin.on('error', () => {});
  }
  get raw() {return Buffer.concat(this.chunks);}
  get stderr() {return Buffer.concat(this.errors).toString('utf8');}
  get lines() {
    const lines = [];
    let rest = this.raw;
    let end;
    while ((end = rest.indexOf(10)) >= 0) {lines.push(rest.subarray(0, end)); rest = rest.subarray(end + 1);}
    return lines;
  }
  get messages() {
    return this.lines.map(line => {try {return JSON.parse(line.toString('utf8'));} catch {return null;}}).filter(Boolean);
  }
  send(object) {this.child.stdin.write(JSON.stringify(object) + '\n');}
  sendRaw(buffer) {this.child.stdin.write(buffer);}
  end() {this.child.stdin.end();}
  kill(signal = 'SIGKILL') {try {this.child.kill(signal);} catch {/* gone */}}
  async request(method, params, timeout = 8000) {
    const id = ++this.seq;
    this.send({jsonrpc: '2.0', id, method, params});
    return until(() => this.messages.find(m => m.id === id && m.method === undefined), timeout, method + ' response');
  }
  call(code, meta, extra = {}) {
    const params = {name: 'js', arguments: {code}, ...extra};
    if (meta !== undefined) params._meta = {'x-codex-turn-metadata': meta};
    return this.request('tools/call', params);
  }
}

export function startRelay(fixture, {via = 'node', env = {}, args = [], stateDir = fixture.state, launcher = LAUNCHER, cwd} = {}) {
  const environment = {...process.env, HOME: path.join(fixture.dir, 'home'), CODEX_CUA_NATIVE_RUNTIME: fixture.native,
    CODEX_CUA_STATE_DIR: stateDir, CODEX_CUA_RELAY_NODE: process.execPath, CUA_REPL_NODE_REPL_PATH: launcher,
    FAKE_LOG: fixture.log, FAKE_STATE: stateDir, ...env};
  for (const key of Object.keys(environment)) if (environment[key] === undefined) delete environment[key];
  const options = {env: environment, stdio: ['pipe', 'pipe', 'pipe'], ...(cwd ? {cwd} : {})};
  const child = via === 'launcher'
    ? spawn(launcher, args, options)
    : spawn(process.execPath, [RELAY_MJS, ...args], options);
  const client = new Client(child);
  fixture.clients.push(client);
  return client;
}

export function relayDirs(fixture) {
  const base = path.join(fixture.state, 'relays');
  try {return fs.readdirSync(base).filter(name => name.startsWith('relay-')).map(name => path.join(base, name));} catch {return [];}
}

export async function readRecord(fixture, predicate = () => true, timeout = 6000) {
  return until(() => {
    const [dir] = relayDirs(fixture);
    if (!dir) return null;
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'relay.json'), 'utf8'));
    return predicate(record) ? {...record, dir} : null;
  }, timeout, 'relay record');
}

// One JSON line in, one JSON line out. null: the relay closed the socket without an answer.
export function control(socketPath, request, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const chunks = [];
    const timer = setTimeout(() => {socket.destroy(); reject(new Error('control timeout'));}, timeout);
    socket.on('connect', () => socket.write(typeof request === 'string' ? request : JSON.stringify(request) + '\n'));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', error => {
      clearTimeout(timer);
      // A relay that drops a request may reset the connection while it is still being written.
      if (error.code === 'ECONNRESET' || error.code === 'EPIPE') resolve(null); else reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8').trim();
      resolve(text ? JSON.parse(text) : null);
    });
  });
}

export const identity = record => ({pid: record.pid, started_at: record.started_at});

// An independent reading of a process start time, in epoch seconds, for checking what the relay recorded.
export function startedAtOf(pid) {
  const output = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {encoding: 'utf8', env: {...process.env, LC_ALL: 'C'}}).trim();
  return Math.floor(new Date(output).getTime() / 1000);
}

export function parentOf(pid) {
  return Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], {encoding: 'utf8'}).trim());
}

export const turn = (session, id, extra = {}) => ({session_id: session, turn_id: id, ...extra});
