// Releasing scopes: the control socket, running calls, and what happens when the relay is stopped.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import {makeFixture, startRelay, readRecord, relayDirs, until, sleep, turn, control, identity} from './harness.mjs';

async function boot(t, options) {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());
  const client = startRelay(fixture, options);
  await client.request('initialize', {});
  return {fixture, client};
}

async function open(fixture, client, ...scopes) {
  for (const [session, id, extra] of scopes) await client.call('work', turn(session, id, extra));
  const record = await readRecord(fixture, r => r.scopes.length === scopes.length);
  await until(() => fs.existsSync(record.control_path), 5000, 'control socket');
  return record;
}

const ask = (record, action, extra = {}) => control(record.control_path, {action, ...identity(record), ...extra});
const open_scopes = record => record.scopes.map(s => s.session_id + '/' + s.turn_id);

test('the control socket answers only the process it belongs to', async t => {
  const {fixture, client} = await boot(t);
  const record = await open(fixture, client, ['s-1', 't-1']);
  const wrong = [
    {action: 'status', pid: record.pid + 1, started_at: record.started_at},
    {action: 'status', pid: record.pid, started_at: record.started_at + 1},
    {action: 'status', pid: record.pid},
    {action: 'status', started_at: record.started_at},
    {action: 'status', pid: String(record.pid), started_at: record.started_at},
    {action: 'status', pid: record.pid, started_at: String(record.started_at)},
    {action: 'release', pid: record.pid + 1, started_at: record.started_at},
    {action: 'release-session', session_id: 's-1', pid: record.pid, started_at: record.started_at + 5},
    {action: 'unknown', ...identity(record)},
    {...identity(record)},
    'not json at all\n',
    '[1,2,3]\n',
    'null\n',
  ];
  for (const request of wrong) assert.equal(await control(record.control_path, request), null, JSON.stringify(request));
  assert.equal(await control(record.control_path, JSON.stringify({action: 'status', ...identity(record), pad: 'x'.repeat(2048)}) + '\n'), null,
    'a request over 1 KB is dropped');
  assert.deepEqual(await ask(record, 'status'), {ok: true, busy: false, open_scopes: 1});
  assert.equal(open_scopes(await readRecord(fixture)).length, 1, 'nothing was released by any of them');
  assert.equal(fixture.events('turn_ended').length, 0);
  const answer = await client.call('after', turn('s-1', 't-1'));
  assert.equal(answer.result.content[0].text, 'echo:after');
});

test('a connection that never finishes its request is dropped after about two seconds', async t => {
  const {fixture, client} = await boot(t);
  const record = await open(fixture, client, ['s-1', 't-1']);
  const started = Date.now();
  await new Promise((resolve, reject) => {
    const socket = net.connect(record.control_path);
    socket.on('connect', () => socket.write('{"action":"status"'));          // no newline, ever
    socket.on('close', resolve);
    socket.on('error', reject);
    setTimeout(() => {socket.destroy(); reject(new Error('still open'));}, 6000);
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1800 && elapsed < 3500, 'dropped after ' + elapsed + ' ms');
  assert.deepEqual(await ask(record, 'status'), {ok: true, busy: false, open_scopes: 1});
});

test('release and release-session end the open scopes through turn_ended, and the relay keeps relaying', async t => {
  const {fixture, client} = await boot(t);
  const record = await open(fixture, client, ['s-a', 't1'], ['s-a', 't2'], ['s-b', 't1']);
  assert.deepEqual(await ask(record, 'release-session', {session_id: 'nobody'}), {released: false, reason: 'no_trusted_scope', scope_count: 0});
  assert.deepEqual(await ask(record, 'release-session'), {released: false, reason: 'no_trusted_scope', scope_count: 0});
  assert.equal(fixture.events('turn_ended').length, 0);

  assert.deepEqual(await ask(record, 'release-session', {session_id: 's-a'}), {released: true, reason: null, scope_count: 2});
  assert.deepEqual(fixture.events('turn_ended').map(e => [e.hook, e.session_id, e.turn_id]), [['Stop', 's-a', 't1'], ['Stop', 's-a', 't2']]);
  assert.deepEqual(fixture.events('turn_ended')[0].meta, {'x-codex-turn-metadata': {session_id: 's-a', turn_id: 't1'}});
  let after = await readRecord(fixture, r => r.scopes.length === 1);
  assert.deepEqual(open_scopes(after), ['s-b/t1']);
  assert.equal(after.cleanup, 'open');
  assert.deepEqual(await ask(record, 'release-session', {session_id: 's-a'}), {released: false, reason: 'no_trusted_scope', scope_count: 0});

  // After a release the relay is still a relay: new work opens new scopes, and the next release ends them.
  const answer = await client.call('more', turn('s-a', 't3'));
  assert.equal(answer.result.content[0].text, 'echo:more');
  after = await readRecord(fixture, r => r.scopes.length === 2);
  assert.deepEqual(open_scopes(after), ['s-b/t1', 's-a/t3']);
  assert.deepEqual(await ask(record, 'release'), {released: true, reason: null, scope_count: 2});
  after = await readRecord(fixture, r => r.scopes.length === 0);
  assert.equal(after.cleanup, 'none');
  assert.deepEqual(fixture.events('turn_ended').map(e => e.session_id + '/' + e.turn_id), ['s-a/t1', 's-a/t2', 's-b/t1', 's-a/t3']);
  assert.deepEqual(await ask(record, 'release'), {released: false, reason: 'no_trusted_scope', scope_count: 0});
  assert.ok(fixture.events('turn_ended').every(e => e.repeated === false));
  // Whatever the relay asked the runtime itself never reaches the client.
  assert.ok(client.messages.every(m => !(typeof m.id === 'string' && m.id.startsWith('codex-cua-relay-'))));
  assert.equal(client.stderr, '');
  client.end();
  assert.equal((await client.exit).code, 0);
});

test('a scope of a sub-agent is ended the way a sub-agent ends', async t => {
  const {fixture, client} = await boot(t);
  const record = await open(fixture, client, ['parent', 'tt', {thread_source: 'subagent', thread_id: 'child-9'}], ['s-main', 't1']);
  assert.deepEqual(await ask(record, 'release'), {released: true, reason: null, scope_count: 2});
  assert.deepEqual(fixture.events('turn_ended').map(e => [e.hook, e.session_id, e.turn_id]),
    [['SubagentStop', 'child-9', 'tt'], ['Stop', 's-main', 't1']]);
});

test('a release is only reported when the runtime confirmed every scope', async t => {
  const {fixture, client} = await boot(t);
  const record = await open(fixture, client, ['s-1', 't1'], ['s-1', 'refuse-1'], ['s-2', 't2']);
  assert.deepEqual(await ask(record, 'release'), {released: false, reason: 'cleanup_not_confirmed', scope_count: 2});
  const after = await readRecord(fixture, r => r.scopes.length === 1);
  assert.deepEqual(open_scopes(after), ['s-1/refuse-1']);
  assert.equal(after.cleanup, 'not_confirmed');
  assert.deepEqual(await ask(record, 'status'), {ok: true, busy: false, open_scopes: 1});
});

test('a runtime without the turn_ended tool is not asked to end anything, and the record says it was tried', async t => {
  const {fixture, client} = await boot(t, {env: {FAKE_NO_TURN_ENDED: '1'}});
  const record = await open(fixture, client, ['s-1', 't1']);
  assert.deepEqual(await ask(record, 'release'), {released: false, reason: 'cleanup_tool_unavailable', scope_count: 0});
  assert.equal(fixture.events('turn_ended').length, 0);
  const after = await readRecord(fixture, r => r.cleanup === 'not_confirmed');
  assert.deepEqual(open_scopes(after), ['s-1/t1']);
});

test('a runtime that cannot say which tools it has leaves the scope open and the record not confirmed', async t => {
  const {fixture, client} = await boot(t, {env: {FAKE_HANG_LIST: '1'}});
  const record = await open(fixture, client, ['s-1', 't1']);
  const started = Date.now();
  assert.deepEqual(await ask(record, 'release'), {released: false, reason: 'cleanup_not_confirmed', scope_count: 0});
  assert.ok(Date.now() - started >= 3800, 'the check was given its four seconds');
  assert.equal(fixture.events('turn_ended').length, 0);
  const after = await readRecord(fixture, r => r.cleanup === 'not_confirmed');
  assert.deepEqual(open_scopes(after), ['s-1/t1']);
});

for (const [slow, label] of [['FAKE_SLOW_TURN_ENDED', 'turn_ended'], ['FAKE_SLOW_LIST', 'tools/list']]) {
  test('a late answer to the relay\'s own ' + label + ' never reaches the client', async t => {
    const {fixture, client} = await boot(t, {env: {[slow]: '5000'}});
    const record = await open(fixture, client, ['s-1', 't1']);
    assert.deepEqual(await ask(record, 'release'), {released: false, reason: 'cleanup_not_confirmed', scope_count: 0});
    await until(() => fixture.events('answered').length === 1, 4000, 'the runtime to answer after all');
    await sleep(300);
    assert.deepEqual(client.messages.filter(m => typeof m.id === 'string' && m.id.startsWith('codex-cua-relay-')), [],
      'an answer to a request the client never made must not reach it');
    // The relay gave up on that request, so the late answer does not close the scope either, and relaying goes on.
    assert.deepEqual(await ask(record, 'status'), {ok: true, busy: false, open_scopes: 1});
    assert.equal((await client.call('after', turn('s-1', 't2'))).result.content[0].text, 'echo:after');
    assert.equal(client.stderr, '');
  });
}

test('a release waits for a call that is still running, then ends the scope after it', async t => {
  const {fixture, client} = await boot(t);
  const record = await open(fixture, client, ['s-1', 't1']);
  client.send({jsonrpc: '2.0', id: 200, method: 'tools/call', params: {name: 'js', arguments: {code: 'sleep:900'},
    _meta: {'x-codex-turn-metadata': turn('s-1', 't1')}}});
  await readRecord(fixture, r => r.busy === true);
  const started = Date.now();
  assert.deepEqual(await ask(record, 'release'), {released: true, reason: null, scope_count: 1});
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 500 && elapsed < 2500, 'waited ' + elapsed + ' ms');
  const order = fixture.events().map(e => e.kind).filter(kind => kind === 'turn_ended' || kind === 'call');
  assert.equal(order.at(-1), 'turn_ended');
  assert.ok(client.messages.some(m => m.id === 200), 'the answer of the call reached the client');
});

test('a call that does not finish within 2.5 seconds stops the release: request_in_flight', async t => {
  const {fixture, client} = await boot(t);
  const record = await open(fixture, client, ['s-1', 't1']);
  client.send({jsonrpc: '2.0', id: 201, method: 'tools/call', params: {name: 'js', arguments: {code: 'hang'},
    _meta: {'x-codex-turn-metadata': turn('s-1', 't1')}}});
  await readRecord(fixture, r => r.busy === true);
  assert.deepEqual(await ask(record, 'status'), {ok: true, busy: true, open_scopes: 1});
  const started = Date.now();
  assert.deepEqual(await ask(record, 'release'), {released: false, reason: 'request_in_flight', scope_count: 0});
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 2400 && elapsed < 3600, 'answered after ' + elapsed + ' ms');
  assert.equal(fixture.events('turn_ended').length, 0, 'nothing was ended under a running call');
  assert.deepEqual(open_scopes(await readRecord(fixture)), ['s-1/t1']);
  assert.deepEqual(await ask(record, 'release-session', {session_id: 's-1'}), {released: false, reason: 'request_in_flight', scope_count: 0});
});

test('a runtime that never answers turn_ended is given four seconds', async t => {
  const {fixture, client} = await boot(t, {env: {FAKE_HANG_TURN_ENDED: '1'}});
  const record = await open(fixture, client, ['s-1', 't1']);
  const started = Date.now();
  assert.deepEqual(await ask(record, 'release'), {released: false, reason: 'cleanup_not_confirmed', scope_count: 0});
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 3800 && elapsed < 6000, 'answered after ' + elapsed + ' ms');
  assert.equal((await readRecord(fixture)).cleanup, 'not_confirmed');
});

function order(fixture, ...kinds) {
  return fixture.events().map(e => e.kind).filter(kind => kinds.includes(kind));
}

test('when stdin ends the open scopes are ended first, then the runtime is stopped and the record goes away', async t => {
  const {fixture, client} = await boot(t);
  await open(fixture, client, ['s-1', 't1'], ['s-2', 't2']);
  client.end();
  assert.equal((await client.exit).code, 0);
  assert.deepEqual(fixture.events('turn_ended').map(e => e.session_id + '/' + e.turn_id), ['s-1/t1', 's-2/t2']);
  assert.deepEqual(order(fixture, 'turn_ended', 'stdin-end'), ['turn_ended', 'turn_ended', 'stdin-end']);
  assert.deepEqual(relayDirs(fixture), []);
  assert.equal(client.stderr, '');
});

test('when stdin ends and a scope cannot be ended, the record stays and says so', async t => {
  const {fixture, client} = await boot(t, {env: {FAKE_REFUSE_TURN_ENDED: '1'}});
  await open(fixture, client, ['s-1', 't1']);
  client.end();
  await client.exit;
  const [dir] = relayDirs(fixture);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'relay.json'), 'utf8'));
  assert.equal(record.cleanup, 'not_confirmed');
  assert.deepEqual(open_scopes(record), ['s-1/t1']);
  assert.equal(record.busy, false);
  assert.deepEqual(fs.readdirSync(dir), ['relay.json'], 'the control socket is gone');
  assert.equal(order(fixture, 'stdin-end').length, 1, 'the runtime was stopped all the same');
});

test('with nothing open nothing is asked, and a call that is still running does not delay the end', async t => {
  const {fixture, client} = await boot(t);
  client.end();
  await client.exit;
  assert.equal(fixture.events('turn_ended').length, 0);
  const second = await boot(t);
  await open(second.fixture, second.client, ['s-1', 't1']);
  second.client.send({jsonrpc: '2.0', id: 300, method: 'tools/call', params: {name: 'js', arguments: {code: 'hang'},
    _meta: {'x-codex-turn-metadata': turn('s-1', 't1')}}});
  await readRecord(second.fixture, r => r.busy === true);
  const started = Date.now();
  second.client.end();
  await second.client.exit;
  assert.ok(Date.now() - started < 2400, 'no wait for the running call');
  assert.equal(second.fixture.events('turn_ended').length, 1);
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  test(signal + ' ends the open scopes first, then stops the runtime', async t => {
    const {fixture, client} = await boot(t);
    await open(fixture, client, ['s-1', 't1'], ['s-1', 't2']);
    client.kill(signal);
    const result = await client.exit;
    assert.equal(result.code, 0);
    assert.deepEqual(fixture.events('turn_ended').map(e => e.turn_id), ['t1', 't2']);
    const kinds = order(fixture, 'turn_ended', 'sigterm', 'sigint', 'sighup', 'stdin-end');
    assert.deepEqual(kinds.slice(0, 2), ['turn_ended', 'turn_ended']);
    assert.ok(kinds.length > 2, 'the runtime was stopped');
    assert.deepEqual(relayDirs(fixture), []);
  });
}

test('the same signal twice in a row does not cut the release short', async t => {
  const {fixture, client} = await boot(t, {env: {FAKE_SLOW_TURN_ENDED: '500'}});
  await open(fixture, client, ['s-1', 't1']);
  client.kill('SIGTERM');
  await sleep(100);
  client.kill('SIGTERM');                                        // cua-repl passes on the signal it got
  const result = await client.exit;
  assert.equal(result.code, 0);
  assert.deepEqual(fixture.events('turn_ended').map(e => e.turn_id), ['t1']);
  assert.deepEqual(relayDirs(fixture), [], 'the scope was confirmed, so nothing is left behind');
  const kinds = order(fixture, 'turn_ended', 'sigterm');
  assert.equal(kinds[0], 'turn_ended');
});

test('a stop signal while a release is running waits for it three seconds at most', async t => {
  const {fixture, client} = await boot(t, {env: {FAKE_SLOW_TURN_ENDED: '5000'}});
  const record = await open(fixture, client, ['s-1', 't1']);
  const running = ask(record, 'release').catch(() => null);              // holds the line for four seconds
  await sleep(300);
  const signalled = Date.now();
  client.kill('SIGTERM');
  const result = await client.exit;
  const elapsed = Date.now() - signalled;
  assert.equal(result.code, 0);
  // Three seconds from the signal, not after the four seconds that the running release still has in front of it.
  assert.ok(elapsed >= 2800 && elapsed < 3700, 'stopped after ' + elapsed + ' ms');
  await running;
  const [dir] = relayDirs(fixture);
  const left = JSON.parse(fs.readFileSync(path.join(dir, 'relay.json'), 'utf8'));
  assert.equal(left.cleanup, 'not_confirmed');
  assert.deepEqual(open_scopes(left), ['s-1/t1']);
});

test('a stop signal while a release waits for a running call does not wait with it', async t => {
  const {fixture, client} = await boot(t);
  const record = await open(fixture, client, ['s-1', 't1']);
  client.send({jsonrpc: '2.0', id: 400, method: 'tools/call', params: {name: 'js', arguments: {code: 'hang'},
    _meta: {'x-codex-turn-metadata': turn('s-1', 't1')}}});
  await readRecord(fixture, r => r.busy === true);
  const waiting = ask(record, 'release').catch(() => null);              // would wait 2.5 s for the call
  await sleep(300);
  const signalled = Date.now();
  client.kill('SIGTERM');
  await client.exit;
  assert.ok(Date.now() - signalled < 1500, 'stopped after ' + (Date.now() - signalled) + ' ms');
  assert.deepEqual(fixture.events('turn_ended').map(e => e.turn_id), ['t1'], 'the scope was ended all the same');
  await waiting;
  assert.deepEqual(relayDirs(fixture), []);
});

test('a signal with a scope that cannot be ended leaves the record as not confirmed', async t => {
  const {fixture, client} = await boot(t, {env: {FAKE_REFUSE_TURN_ENDED: '1'}});
  await open(fixture, client, ['s-1', 't1']);
  client.kill('SIGTERM');
  await client.exit;
  const [dir] = relayDirs(fixture);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'relay.json'), 'utf8'));
  assert.equal(record.cleanup, 'not_confirmed');
  assert.deepEqual(open_scopes(record), ['s-1/t1']);
  assert.equal(fs.existsSync(path.join(dir, 'control.sock')), false);
});

test('the automatic release is limited to three seconds', async t => {
  const {fixture, client} = await boot(t, {env: {FAKE_HANG_TURN_ENDED: '1'}});
  await open(fixture, client, ['s-1', 't1']);
  const started = Date.now();
  client.kill('SIGTERM');
  await client.exit;
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 2800 && elapsed < 5000, 'stopped after ' + elapsed + ' ms');
  assert.equal(relayDirs(fixture).length, 1);
});

test('a runtime that does not leave when its stdin ends is asked to, and then forced', async t => {
  const {fixture, client} = await boot(t, {env: {FAKE_IGNORE_EOF: '1'}});
  const started = Date.now();
  client.end();
  const result = await client.exit;
  const elapsed = Date.now() - started;
  assert.equal(result.code, 0);
  assert.ok(elapsed >= 900 && elapsed < 3000, 'asked after ' + elapsed + ' ms');
  assert.equal(order(fixture, 'sigterm').length, 1);
});

test('a runtime that ignores even that is killed after the grace period', async t => {
  const {fixture, client} = await boot(t, {env: {FAKE_IGNORE_EOF: '1', FAKE_IGNORE_TERM: '1'}});
  const started = Date.now();
  client.end();
  const result = await client.exit;
  const elapsed = Date.now() - started;
  assert.equal(result.code, 137);
  assert.ok(elapsed >= 5500 && elapsed < 9000, 'killed after ' + elapsed + ' ms');
  assert.equal(order(fixture, 'sigterm').length, 1);
});
