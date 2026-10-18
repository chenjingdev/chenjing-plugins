// The relay between cua-repl and the original runtime: transparency, scopes, records, activity lines.
import assert from 'node:assert/strict';
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
  assert.deepEqual(start.env, {native: null, relayNode: null, state: null, runtimePath: fixture.native, marker: 'kept'});
  assert.equal(client.stderr, '');
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
  await client.request('tools/call', {name: 'weird name with spaces!', arguments: {}});
  await client.request('tools/list', {});
  const file = path.join(fixture.state, 'activity.jsonl');
  const [dir] = relayDirs(fixture);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'relay.json'), 'utf8'));
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(lines.length, 7, 'one line per tools/call, none for tools/list');
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
