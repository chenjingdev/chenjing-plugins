// The relay between cua-repl and the original runtime: transparency, scopes, records, activity lines.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {makeFixture, startRelay, readRecord, relayDirs, startedAtOf, parentOf, until, sleep, turn, control, identity, DEFAULT_HOME} from './harness.mjs';

async function boot(t, options) {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());
  const client = startRelay(fixture, options);
  await client.request('initialize', {});
  return {fixture, client};
}

const sha = buffer => createHash('sha256').update(buffer).digest('hex');

test('every byte reaches the runtime unchanged, whatever the line looks like', async t => {
  const {fixture, client} = await boot(t);
  const lines = [
    Buffer.from('{ "params" : {"arguments":{"code":"\ud55c\uad6d\uc5b4 \\u00e9 \\/ done"},"name":"js"} ,"method":"tools/call", "id" : 10 , "jsonrpc":"2.0"}\n'),
    Buffer.concat([Buffer.from('{"bad":"'), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from('"}\n')]),
    Buffer.from('this is not json at all\n'),
    Buffer.from('\n'),
    Buffer.from('{"jsonrpc":"2.0","method":"notifications/initialized"}\r\n'),
    Buffer.from('[{"jsonrpc":"2.0","id":11,"method":"ping"}]\n'),
  ];
  for (const line of lines) client.sendRaw(line);
  const partial = Buffer.from('{"jsonrpc":"2.0","method":"notifications/unfinished"');
  client.sendRaw(partial);
  await until(() => fixture.events('line').length >= 1 + lines.length, 6000, 'lines at the runtime');
  client.end();
  await client.exit;
  const received = fixture.events('line').map(event => Buffer.from(event.b64, 'base64'));
  // The first received line is the initialize request of boot().
  assert.deepEqual(received.slice(1).map(sha), lines.map(sha));
  assert.equal(fixture.events('stdin-end')[0].rest, partial.length, 'a last line without newline is passed on too');
});

test('every byte reaches the client unchanged, including lines that are not JSON', async t => {
  const {client} = await boot(t);
  const payload = Buffer.concat([
    Buffer.from('{"jsonrpc":"2.0","method":"notifications/message","params":{"x":"y","z":1}}\n'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(' not json \n')]),
    Buffer.from('{"jsonrpc":"2.0",  "method":"notifications/message", "params":{"k":"\\u00e9"}}\r\n'),
    Buffer.from('{"jsonrpc":"2.0","id":"server-9","method":"ping"}\n'),
    Buffer.from('{"unfinished":true'),
  ]);
  const before = client.raw.length;
  client.send({jsonrpc: '2.0', id: 50, method: 'tools/call', params: {name: 'js', arguments: {code: 'emit:' + payload.toString('base64')}}});
  await until(() => client.raw.length >= before + payload.length - 18, 6000, 'raw output');
  client.end();                                             // the runtime leaves, the relay flushes the unfinished line
  await client.exit;
  assert.equal(sha(client.raw.subarray(before)), sha(payload));
  assert.equal(client.stderr, '');
});

test('large messages travel both ways intact', async t => {
  const {fixture, client} = await boot(t);
  const code = 'q'.repeat(3 * 1024 * 1024);
  const answer = await client.call(code, turn('s-big', 't-big'));
  assert.equal(answer.result.content[0].text, 'echo:' + code);
  const big = await client.call('big:' + 4 * 1024 * 1024);
  assert.equal(big.result.content[0].text.length, 4 * 1024 * 1024);
  const sent = fixture.events('line').map(event => Buffer.from(event.b64, 'base64')).find(line => line.length > 3 * 1024 * 1024);
  assert.equal(JSON.parse(sent.toString('utf8')).params.arguments.code, code);
});

test('the runtime gets its arguments and the environment it would have had without the relay', async t => {
  const {fixture, client} = await boot(t, {args: ['one two', '', '--flag'], env: {FAKE_MARKER: 'kept'}});
  const [start] = fixture.events('start');
  assert.deepEqual(start.argv, ['one two', '', '--flag']);
  assert.deepEqual(start.env, {native: null, relayNode: null, state: null, runtimePath: fixture.native, marker: 'kept',
    owner: null});
  assert.equal(client.stderr, '');
});

test('a bridge that names itself is the owner in the record, and the runtime never sees the name', async t => {
  const {fixture} = await boot(t, {env: {CODEX_CUA_OWNER: 'bridge-4242-1792345678'}});
  const record = await readRecord(fixture);
  assert.equal(record.owner, 'bridge-4242-1792345678');
  assert.equal(fixture.events('start')[0].env.owner, null);
});

test('an owner that is not a bridge name is not written down', async t => {
  for (const value of ['', 'relay-1-2', 'bridge-1-2; rm', 'bridge-' + '9'.repeat(11) + '-1']) {
    const {fixture} = await boot(t, {env: {CODEX_CUA_OWNER: value}});
    assert.equal((await readRecord(fixture)).owner, null, value);
  }
});

// A bridge is running when its pid is a process that started when its name says (within a second), the engine's own test.
const bridgeName = (pid, startedAt) => `bridge-${pid}-${startedAt}`;

// A process that has run and is gone: nobody has its pid (a pid is not given out again within the moments of a test).
function endedProcess() {
  const started = Math.floor(Date.now() / 1000);
  return {pid: spawnSync(process.execPath, ['-e', '']).pid, started};
}

test('a relay whose bridge is running says so in its record: that pid, started when its name says, a second either way', async t => {
  const started = startedAtOf(process.pid);       // this test run stands in for the bridge
  for (const shift of [0, -1, 1]) {
    const {fixture} = await boot(t, {env: {CODEX_CUA_OWNER: bridgeName(process.pid, started + shift)}});
    const record = await readRecord(fixture);
    assert.equal(record.owner_running, true, 'shift ' + shift);
  }
});

test('a relay whose bridge is gone says so: no such process, or another one that has its pid now', async t => {
  const started = startedAtOf(process.pid);
  const ended = endedProcess();
  for (const [label, name] of [
    ['a bridge that has ended', bridgeName(ended.pid, ended.started)],
    ['the pid of a process that started 100 seconds after the name says', bridgeName(process.pid, started - 100)],
    ['... 100 seconds before', bridgeName(process.pid, started + 100)],
    ['... 2 seconds after', bridgeName(process.pid, started - 2)],
    ['... 2 seconds before', bridgeName(process.pid, started + 2)],
  ]) {
    const {fixture, client} = await boot(t, {env: {CODEX_CUA_OWNER: name}});
    const record = await readRecord(fixture);
    assert.equal(record.owner, name, label);
    assert.equal(record.owner_running, false, label);
    assert.equal((await client.call('still relayed', turn('s-gone', 't1'))).result.content[0].text, 'echo:still relayed', label);
  }
});

test('a pid ps will not look up is no answer, not a bridge that is gone: ps said why, and none of it reaches stderr', async t => {
  const name = bridgeName(9999999999, startedAtOf(process.pid));   // a bridge name, but too large for a pid
  const {fixture, client} = await boot(t, {env: {CODEX_CUA_OWNER: name}});
  const record = await readRecord(fixture);
  assert.equal(record.owner, name);
  assert.equal(record.owner_running, null);
  assert.equal((await client.call('still relayed', turn('s-nopid', 't1'))).result.content[0].text, 'echo:still relayed');
  assert.equal(client.stderr, '');
});

test('a relay nobody named, or named by something that is not a bridge, has no owner_running at all', async t => {
  for (const value of [undefined, '', 'relay-1-2', 'bridge-1-2; rm', 'bridge-' + '9'.repeat(11) + '-1']) {
    const {fixture} = await boot(t, {env: {CODEX_CUA_OWNER: value}});
    const record = await readRecord(fixture);
    assert.equal('owner_running' in record, false, String(value));
    assert.equal(record.owner, null, String(value));
  }
});

test('a look at the bridge that fails costs neither the record nor the relaying, and the record says it could not look', async t => {
  const owner = bridgeName(process.pid, startedAtOf(process.pid));
  const {fixture, client} = await boot(t, {env: {CODEX_CUA_OWNER: owner, CODEX_CUA_RELAY_TEST_FAIL: 'owner-check'}});
  const record = await readRecord(fixture);
  assert.equal(record.owner, owner);
  assert.equal(record.owner_running, null);
  assert.equal(record.pid, client.child.pid);
  assert.equal(record.root_pid, process.pid, 'the identity of the relay is read as ever');
  assert.equal((await client.call('relayed', turn('s-look', 't1'))).result.content[0].text, 'echo:relayed');
  const settled = await readRecord(fixture, r => r.scopes.length === 1);
  assert.deepEqual(settled.scopes.map(s => s.session_id), ['s-look']);
  assert.equal(activityLines(fixture)[0].owner, owner);
  assert.equal(client.stderr, '');
});

test('the bridge is looked at once, as the relay comes up: a bridge that ends later changes nothing in the record', async t => {
  // A stand-in bridge that ends when the test closes its input, without any signal.
  const bridge = spawn(process.execPath, ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
    {stdio: ['pipe', 'ignore', 'ignore']});
  const ended = new Promise(resolve => bridge.once('exit', resolve));
  t.after(() => bridge.stdin.destroy());
  const {fixture, client} = await boot(t, {env: {CODEX_CUA_OWNER: bridgeName(bridge.pid, startedAtOf(bridge.pid))}});
  assert.equal((await readRecord(fixture)).owner_running, true);
  bridge.stdin.end();
  await ended;
  await client.call('later', turn('s-later', 't1'));
  const record = await readRecord(fixture, r => r.scopes.length === 1);
  assert.equal(record.owner_running, true, 'what the relay saw when it came up, not what is so now');
});

test('scopes come from the host-supplied context and from nowhere else', async t => {
  const {fixture, client} = await boot(t);
  await client.call('one', turn('s-main', 't1'));
  await client.request('tools/call', {name: 'js_reset', arguments: {},
    _meta: {'x-codex-turn-metadata': JSON.stringify(turn('s-main', 't2'))}});                  // as a JSON string, other tool
  await client.call('three', turn('ignored-parent', 'tt', {thread_source: 'subagent', thread_id: 'child-9'}));
  for (const meta of [undefined, turn('s-x', ''), {session_id: 's-x'}, {turn_id: 't'}, ['s', 't'], 'not json', 42,
    turn(7, 't'), turn('s-y', 't', {thread_source: 'subagent'})]) {
    await client.call('none', meta);
  }
  // The code of a call is never taken as scope, and neither is the context of a turn_ended call.
  await client.call(JSON.stringify(turn('s-code', 't-code')));
  await client.request('tools/call', {name: 'turn_ended', arguments: {hook_event_name: 'Refuse', session_id: 's-z', turn_id: 'tz'},
    _meta: {'x-codex-turn-metadata': turn('s-z', 'tz')}});
  const record = await readRecord(fixture, r => r.scopes.length >= 3);
  await sleep(300);
  const settled = await readRecord(fixture);
  assert.deepEqual(settled.scopes.map(({session_id, turn_id, subagent}) => ({session_id, turn_id, subagent})), [
    {session_id: 's-main', turn_id: 't1', subagent: false},
    {session_id: 's-main', turn_id: 't2', subagent: false},
    {session_id: 'child-9', turn_id: 'tt', subagent: true},
  ]);
  for (const scope of record.scopes) {
    assert.match(scope.first_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.match(scope.last_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  }
  assert.equal(settled.cleanup, 'open');
});

test('every open scope is kept; a passing turn_ended closes exactly its own pair', async t => {
  const {fixture, client} = await boot(t);
  await client.call('a', turn('s-main', 't1'));
  await client.call('b', turn('s-main', 't2'));
  await client.call('c', turn('s-other', 't5'));
  await client.call('d', turn('s-main', 't1'));                       // the same pair again changes nothing
  let record = await readRecord(fixture, r => r.scopes.length === 3);
  assert.deepEqual(record.scopes.map(s => s.session_id + '/' + s.turn_id), ['s-main/t1', 's-main/t2', 's-other/t5']);
  const end = (session, id, hook = 'Stop') => client.request('tools/call', {name: 'turn_ended',
    arguments: {hook_event_name: hook, session_id: session, turn_id: id}});
  await end('s-main', 't1');
  record = await readRecord(fixture, r => r.scopes.length === 2);
  assert.deepEqual(record.scopes.map(s => s.session_id + '/' + s.turn_id), ['s-main/t2', 's-other/t5']);
  await end('s-main', 't2', 'Refuse');                                 // refused by the runtime: still open
  await end('s-other', 't2');                                          // a pair nobody opened
  await end('s-main', 't5');                                           // right turn, wrong session
  await end('s-other', 't5', 'RpcError');                              // a JSON-RPC error is no confirmation either
  await sleep(300);
  record = await readRecord(fixture);
  assert.deepEqual(record.scopes.map(s => s.session_id + '/' + s.turn_id), ['s-main/t2', 's-other/t5']);
  await end('s-other', 't5');
  record = await readRecord(fixture, r => r.scopes.length === 1);
  assert.equal(record.scopes[0].turn_id, 't2');
  await end('s-main', 't2');
  record = await readRecord(fixture, r => r.scopes.length === 0);
  assert.equal(record.cleanup, 'none');
});

test('the record describes the relay, its runtime and its place in the process tree', async t => {
  const {fixture, client} = await boot(t);
  const record = await readRecord(fixture);
  await until(() => fs.existsSync(record.control_path), 5000, 'control socket');
  const [start] = fixture.events('start');
  assert.equal(record.schema_version, 1);
  assert.equal(record.kind, 'relay');
  assert.equal(record.pid, client.child.pid);
  assert.equal(record.started_at, startedAtOf(client.child.pid));
  assert.equal(record.runtime_pid, start.pid);
  assert.equal(record.root_pid, process.pid);
  assert.equal(record.app_server_pid, parentOf(process.pid));
  assert.equal(record.cwd, process.cwd());
  assert.equal(record.owner, null);
  assert.equal(record.control_path, path.join(record.dir, 'control.sock'));
  assert.equal(record.busy, false);
  assert.equal(record.cleanup, 'none');
  assert.deepEqual(record.scopes, []);
  assert.match(record.updated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const mode = file => fs.statSync(file).mode & 0o777;
  assert.equal(mode(fixture.state), 0o700);
  assert.equal(mode(path.join(fixture.state, 'relays')), 0o700);
  assert.equal(mode(record.dir), 0o700);
  assert.equal(mode(path.join(record.dir, 'relay.json')), 0o600);
  assert.equal(mode(record.control_path), 0o600);
  assert.ok(fs.statSync(record.control_path).isSocket());
  assert.deepEqual(fs.readdirSync(record.dir).sort(), ['control.sock', 'relay.json']);
});

test('busy and last_call_at follow the calls that are running', async t => {
  const {fixture, client} = await boot(t);
  client.send({jsonrpc: '2.0', id: 90, method: 'tools/call', params: {name: 'js', arguments: {code: 'sleep:600'},
    _meta: {'x-codex-turn-metadata': turn('s-busy', 't1')}}});
  let record = await readRecord(fixture, r => r.busy === true);
  assert.match(record.last_call_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(await control(record.control_path, {action: 'status', ...identity(record)}), {ok: true, busy: true, open_scopes: 1});
  await until(() => client.messages.find(m => m.id === 90), 4000, 'answer');
  record = await readRecord(fixture, r => r.busy === false);
  assert.deepEqual(await control(record.control_path, {action: 'status', ...identity(record)}), {ok: true, busy: false, open_scopes: 1});
});

test('the end of a turn that no call opened here leaves last_call_at alone', async t => {
  const {fixture, client} = await boot(t);
  await client.request('tools/call', {name: 'turn_ended', arguments: {hook_event_name: 'Stop', session_id: 's-chat', turn_id: 't1'}});
  await sleep(300);
  assert.equal((await readRecord(fixture)).last_call_at, null);
  await client.call('a', turn('s-chat', 't2'));
  const opened = (await readRecord(fixture, r => r.last_call_at !== null)).last_call_at;
  assert.match(opened, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test('a cancelled call no longer counts as running', async t => {
  const {fixture, client} = await boot(t);
  client.send({jsonrpc: '2.0', id: 91, method: 'tools/call', params: {name: 'js', arguments: {code: 'hang'}}});
  await readRecord(fixture, r => r.busy === true);
  client.send({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 91}});
  const record = await readRecord(fixture, r => r.busy === false);
  assert.deepEqual(await control(record.control_path, {action: 'status', ...identity(record)}), {ok: true, busy: false, open_scopes: 0});
});

test('the relay forgets the oldest scopes beyond a generous limit instead of growing without end', async t => {
  const {fixture, client} = await boot(t);
  for (let i = 0; i < 520; i++) {
    client.send({jsonrpc: '2.0', id: 1000 + i, method: 'tools/call', params: {name: 'js', arguments: {code: 'n'},
      _meta: {'x-codex-turn-metadata': turn('s-many', 't' + i)}}});
  }
  await until(() => client.messages.filter(m => m.id >= 1000).length === 520, 10000, 'answers');
  const record = await readRecord(fixture, r => r.scopes.length === 500);
  assert.equal(record.scopes[0].turn_id, 't20');
  assert.equal(record.scopes[499].turn_id, 't519');
});

test('activity lines hold the tool name, success and duration, and nothing of what was asked or answered', async t => {
  const {fixture, client} = await boot(t);
  await client.call('SECRET-CODE-1', turn('s-act', 't1'), {arguments: {code: 'SECRET-CODE-1', title: 'SECRET-TITLE'}});
  await client.call('fail', turn('s-act', 't1'));
  await client.call('rpc-error', turn('s-act', 't1'));
  await client.call('no scope here');
  await client.request('tools/call', {name: 'js_reset', arguments: {}});
  await client.request('tools/call', {name: 'turn_ended', arguments: {hook_event_name: 'Stop', session_id: 's-act', turn_id: 't1'}});
  // The Codex app's turn_ended at the end of a turn without CUA: no line, and no call either.
  await client.request('tools/call', {name: 'turn_ended', arguments: {hook_event_name: 'Stop', session_id: 's-chat', turn_id: 't9'}});
  await client.request('tools/call', {name: 'weird name with spaces!', arguments: {}});
  await client.request('tools/list', {});
  const file = path.join(fixture.state, 'activity.jsonl');
  const [dir] = relayDirs(fixture);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'relay.json'), 'utf8'));
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(lines.length, 7, 'one line per tools/call, none for tools/list or the end of a turn nobody opened');
  const writer = 'relay-' + record.pid + '-' + record.started_at;
  for (const line of lines) {
    assert.deepEqual(Object.keys(line), ['at', 'writer', 'session_id', 'tool', 'ok', 'ms']);
    assert.match(line.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(line.writer, writer);
    assert.equal(typeof line.ok, 'boolean');
    assert.ok(Number.isInteger(line.ms) && line.ms >= 0);
  }
  assert.deepEqual(lines.map(l => [l.tool, l.session_id, l.ok]), [
    ['js', 's-act', true], ['js', 's-act', false], ['js', 's-act', false], ['js', null, true],
    ['js_reset', null, true], ['turn_ended', 's-act', true], ['unknown', null, true]]);
  const everything = fs.readFileSync(file, 'utf8') + fs.readdirSync(fixture.state, {recursive: true}).join('\n')
    + fs.readFileSync(path.join(dir, 'relay.json'), 'utf8');
  for (const secret of ['SECRET-CODE-1', 'SECRET-TITLE', 'echo:', 'no scope here']) assert.ok(!everything.includes(secret), secret);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(client.stderr, '');
});

const activityLines = fixture => fs.readFileSync(path.join(fixture.state, 'activity.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line));

test('every activity line of a runtime that a bridge started carries the bridge\'s name, as the record does', async t => {
  const owner = 'bridge-4242-1792345678';
  const {fixture, client} = await boot(t, {env: {CODEX_CUA_OWNER: owner}});
  await client.call('one', turn('s-own', 't1'));
  await client.call('fail', turn('s-own', 't1'));
  await client.request('tools/call', {name: 'js_reset', arguments: {}});
  await client.request('tools/call', {name: 'turn_ended', arguments: {hook_event_name: 'Stop', session_id: 's-own', turn_id: 't1'}});
  const lines = activityLines(fixture);
  assert.deepEqual(lines.map(line => [line.tool, line.session_id, line.ok]), [
    ['js', 's-own', true], ['js', 's-own', false], ['js_reset', null, true], ['turn_ended', 's-own', true]]);
  for (const line of lines) {
    assert.deepEqual(Object.keys(line), ['at', 'writer', 'session_id', 'tool', 'ok', 'ms', 'owner']);
    assert.equal(line.owner, owner);
  }
  assert.equal((await readRecord(fixture)).owner, owner, 'the same name as in the record');
  assert.equal(fixture.events('start')[0].env.owner, null, 'the runtime still never sees the name');
});

test('a runtime nobody named, or named by something that is not a bridge, writes lines without an owner', async t => {
  for (const value of [undefined, '', 'relay-1-2', 'bridge-1-2; rm', 'bridge-' + '9'.repeat(11) + '-1']) {
    const {fixture, client} = await boot(t, {env: {CODEX_CUA_OWNER: value}});
    await client.call('one', turn('s-none', 't1'));
    const [line, ...others] = activityLines(fixture);
    assert.deepEqual(others, [], String(value));
    assert.deepEqual(Object.keys(line), ['at', 'writer', 'session_id', 'tool', 'ok', 'ms'], String(value));
  }
});

const PROBE_TITLE = 'Read-only Codex CUA inventory check';

test('a runtime that works in the folder of a connection test leaves no line and no last call, and is relayed as ever', async t => {
  // `codex-cua doctor --probe` opens a thread of its own in a new folder named like this; nobody made its calls.
  const folder = fs.mkdtempSync('/tmp/codex-cua-probe-');
  t.after(() => fs.rmSync(folder, {recursive: true, force: true}));
  const {fixture, client} = await boot(t, {cwd: folder});
  const answer = await client.call('await cua.getState();', turn('s-probe', 't1'),
    {arguments: {code: 'await cua.getState();', title: PROBE_TITLE}});
  assert.equal(answer.result.content[0].text, 'echo:await cua.getState();');
  assert.equal(fixture.events('call').length, 1, 'the runtime got the call');
  let record = await readRecord(fixture, r => r.scopes.length === 1 && r.busy === false);
  assert.equal(record.cwd, fs.realpathSync(folder));
  assert.equal(record.last_call_at, null);
  const ended = await client.request('tools/call', {name: 'turn_ended', arguments: {hook_event_name: 'Stop', session_id: 's-probe', turn_id: 't1'}});
  assert.equal(ended.result.isError, undefined);
  record = await readRecord(fixture, r => r.scopes.length === 0);
  assert.equal(record.last_call_at, null);
  assert.equal(record.cleanup, 'none');
  assert.equal(fs.existsSync(path.join(fixture.state, 'activity.jsonl')), false, 'no line, not even for the end of its turn');
  assert.equal(client.stderr, '');
});

test('a runtime that works in the folder of a targeted release leaves no line and no last call either', async t => {
  // `release-session` opens a thread of its own in a folder named like this, under the session it releases: the calls
  // are the engine's, not the conversation's whose session it is.
  const folder = fs.mkdtempSync('/tmp/codex-cua-release-');
  t.after(() => fs.rmSync(folder, {recursive: true, force: true}));
  const {fixture, client} = await boot(t, {cwd: folder});
  await client.call('count tabs', turn('s-gone', 't9'));
  let record = await readRecord(fixture, r => r.scopes.length === 1 && r.busy === false);
  assert.equal(record.last_call_at, null);
  const ended = await client.request('tools/call', {name: 'turn_ended', arguments: {hook_event_name: 'Stop', session_id: 's-gone', turn_id: 't9'}});
  assert.equal(ended.result.isError, undefined);
  record = await readRecord(fixture, r => r.scopes.length === 0);
  assert.equal(record.last_call_at, null);
  assert.equal(fs.existsSync(path.join(fixture.state, 'activity.jsonl')), false);
});

test('ending a turn is a line in the activity log but no last call: whoever ended it, the screen was not used', async t => {
  // A release through a Claude bridge ends the pair with the same turn_ended the AI sends: the relay cannot tell them
  // apart, and neither is a use of the screen. Taking one for a call made a connection just released look busy.
  const {fixture, client} = await boot(t);
  await client.call('one', turn('s-chat', 't1'));
  const before = (await readRecord(fixture, r => r.scopes.length === 1 && r.busy === false)).last_call_at;
  assert.match(before, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  await sleep(1100);
  await client.request('tools/call', {name: 'turn_ended', arguments: {hook_event_name: 'Stop', session_id: 's-chat', turn_id: 't1'}});
  const after = await readRecord(fixture, r => r.scopes.length === 0 && r.busy === false);
  assert.equal(after.last_call_at, before);
  assert.deepEqual(activityLines(fixture).map(line => line.tool), ['js', 'turn_ended']);
});

test('a relay that can no longer read its folder still records the one it started in', async t => {
  // The test removes its folder as soon as it is done, while its relay may still be ending. Where reading the working
  // folder of a removed folder fails, the dead record would lose the name that tells it is a test's; the preload below
  // makes that happen here, from the moment the flag file is there.
  const folder = fs.mkdtempSync('/tmp/codex-cua-probe-');
  const base = fs.mkdtempSync('/tmp/crp-');
  t.after(() => {fs.rmSync(folder, {recursive: true, force: true}); fs.rmSync(base, {recursive: true, force: true});});
  const flag = path.join(base, 'folder-is-gone');
  fs.writeFileSync(path.join(base, 'preload.mjs'), `import fs from 'node:fs';
const read = process.cwd;
process.cwd = () => {
  if (fs.existsSync(${JSON.stringify(flag)})) throw Object.assign(new Error('ENOENT: no such file or directory, uv_cwd'), {code: 'ENOENT'});
  return read.call(process);
};
`);
  const {fixture, client} = await boot(t, {cwd: folder, env: {NODE_OPTIONS: '--import=' + path.join(base, 'preload.mjs')}});
  await client.call('await cua.getState();', turn('s-probe', 't1'), {arguments: {code: 'await cua.getState();', title: PROBE_TITLE}});
  const open = await readRecord(fixture, r => r.scopes.length === 1 && r.busy === false);
  assert.equal(open.cwd, fs.realpathSync(folder));
  fs.writeFileSync(flag, '');
  process.kill(fixture.events('start')[0].pid, 'SIGKILL');          // the runtime goes while a scope is open
  await client.exit;
  const [dir] = relayDirs(fixture);
  const dead = JSON.parse(fs.readFileSync(path.join(dir, 'relay.json'), 'utf8'));
  assert.equal(dead.cleanup, 'not_confirmed');
  assert.equal(dead.cwd, open.cwd, 'the folder it started in, not null');
});

test('a folder that only looks like the one of a connection test is a conversation\'s, and its calls are written down', async t => {
  const base = fs.mkdtempSync('/tmp/crp-');
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  for (const name of ['codex-cua-probe', 'codex-cua-probe-ab', 'my-codex-cua-probe-abcdef', 'codex-cua-releases-abcdef', 'codex-cua-probe-abcdef.old']) {
    const folder = path.join(base, name);
    fs.mkdirSync(folder);
    const {fixture, client} = await boot(t, {cwd: folder});
    await client.call('one', turn('s-chat', 't1'), {arguments: {code: 'one', title: PROBE_TITLE}});
    const [line, ...others] = activityLines(fixture);
    assert.deepEqual(others, [], name);
    assert.deepEqual([line.tool, line.session_id, line.ok], ['js', 's-chat', true], name);
    assert.match((await readRecord(fixture)).last_call_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, name);
  }
});

test('a big activity file is cut to the newest 200 lines, unless somebody else is already cutting', async t => {
  const {fixture, client} = await boot(t);
  const file = path.join(fixture.state, 'activity.jsonl');
  const fill = count => fs.writeFileSync(file, Array.from({length: count}, (_, i) =>
    JSON.stringify({at: '2026-10-18T00:00:00Z', writer: 'bridge-1-1', session_id: null, tool: 'js', ok: true, ms: i, pad: 'p'.repeat(80)})).join('\n') + '\n', {mode: 0o600});
  fill(3000);
  assert.ok(fs.statSync(file).size > 256 * 1024);
  // The lock is busy: the line is only appended.
  const holder = fs.openSync(path.join(fixture.state, 'activity.lock'),
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | 0x20, 0o600);
  await client.call('x', turn('s-rot', 't1'));
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 3001);
  fs.closeSync(holder);
  await client.call('y', turn('s-rot', 't1'));
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 200);
  assert.equal(JSON.parse(lines.at(-1)).tool, 'js');
  assert.equal(JSON.parse(lines.at(-1)).writer.startsWith('relay-'), true);
  assert.equal(JSON.parse(lines[0]).ms, 2802, 'the newest lines survive');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(fixture.state).filter(name => name.endsWith('.tmp')), []);
});

test('an unusable state directory only means no records; the runtime is relayed as ever', async t => {
  for (const [label, prepare] of [
    ['group-readable directory', state => fs.mkdirSync(state, {mode: 0o755})],
    ['a plain file', state => fs.writeFileSync(state, 'x')],
    ['a symbolic link', (state, fixture) => {fs.mkdirSync(path.join(fixture.dir, 'real'), {mode: 0o700}); fs.symlinkSync(path.join(fixture.dir, 'real'), state);}],
  ]) {
    await t.test(label, async inner => {
      const fixture = makeFixture();
      inner.after(() => fixture.cleanup());
      prepare(fixture.state, fixture);
      if (label === 'group-readable directory') fs.chmodSync(fixture.state, 0o755);
      const client = startRelay(fixture);
      await client.request('initialize', {});
      const answer = await client.call('still works', turn('s-1', 't-1'));
      assert.equal(answer.result.content[0].text, 'echo:still works');
      assert.deepEqual(relayDirs(fixture), []);
      assert.equal(client.stderr, '');
      client.end();
      assert.equal((await client.exit).code, 0);
      assert.equal(fs.existsSync(path.join(fixture.dir, 'real', 'relays')), false);
    });
  }
});

test('without CODEX_CUA_STATE_DIR the records go to the user cache directory', async t => {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());
  const client = startRelay(fixture, {env: {CODEX_CUA_STATE_DIR: undefined}});
  await client.request('initialize', {});
  const home = path.join(fixture.dir, 'home', 'Library', 'Caches', 'codex-cua');
  await until(() => fs.existsSync(path.join(home, 'relays')) && fs.readdirSync(path.join(home, 'relays')).length === 1, 5000, 'default state directory');
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  client.end();
  await client.exit;
});

test('the exit code of the runtime is the exit code of the relay', async t => {
  const {client} = await boot(t, {env: {FAKE_EXIT_CODE: '7'}});
  client.end();
  assert.equal((await client.exit).code, 7);
});

test('a runtime that is gone with open scopes leaves a dead record behind, marked as not confirmed', async t => {
  const {fixture, client} = await boot(t);
  await client.call('a', turn('s-gone', 't1'));
  const before = await readRecord(fixture, r => r.scopes.length === 1);
  process.kill(fixture.events('start')[0].pid, 'SIGKILL');          // the fake runtime this test started
  await client.exit;
  const [dir] = relayDirs(fixture);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'relay.json'), 'utf8'));
  assert.equal(after.cleanup, 'not_confirmed');
  assert.deepEqual(after.scopes.map(s => s.turn_id), ['t1']);
  assert.equal(after.pid, before.pid);
  assert.equal(fs.existsSync(path.join(dir, 'control.sock')), false);
});

test('the runtime ends when the relay itself is killed', async t => {
  const {fixture, client} = await boot(t);
  const [start] = fixture.events('start');
  client.kill('SIGKILL');
  await client.exit;
  await until(() => {
    try {process.kill(start.pid, 0); return false;} catch (error) {return error.code === 'ESRCH';}
  }, 5000, 'runtime to end');
  assert.ok(fixture.events('stdin-end').length >= 1);
});

test('a scope is on disk before the runtime sees the call that opens it', async t => {
  const {fixture, client} = await boot(t);
  await client.call('first', turn('s-1', 't-1'));
  await client.call('again', turn('s-1', 't-1'));
  await client.call('second', turn('s-1', 't-2'));
  assert.deepEqual(fixture.events('call').map(event => event.recorded), [1, 1, 2]);
});

test('output that is still on its way when the runtime ends is not lost', async t => {
  const {client} = await boot(t);
  client.child.stdout.pause();                                  // a client that reads slowly
  client.send({jsonrpc: '2.0', id: 77, method: 'tools/call', params: {name: 'js', arguments: {code: 'big:' + 6 * 1024 * 1024}}});
  client.end();                                                 // the runtime leaves right after its answer
  await sleep(700);
  client.child.stdout.resume();
  assert.equal((await client.exit).code, 0);
  const answer = client.messages.find(message => message.id === 77);
  assert.equal(answer.result.content[0].text.length, 6 * 1024 * 1024);
});

test('the tests run with a throw-away home, and a relay with a state directory never goes near the home it has', async t => {
  assert.equal(process.env.HOME, DEFAULT_HOME);
  const {client} = await boot(t, {env: {HOME: DEFAULT_HOME}});
  await client.call('x', turn('s-home', 't-home'));
  client.end();
  await client.exit;
  assert.deepEqual(fs.readdirSync(DEFAULT_HOME), []);
});
