// Selective bridge cancellation: no UI, real Codex, process reset or caller-authored native request ids.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {makeFixture, startRelay, readRecord, until, sleep, control, identity, turn} from './harness.mjs';

const OWNER = 'bridge-4242-1700000000';
const TOKEN_A = '11111111-1111-4111-8111-111111111111';
const TOKEN_B = '22222222-2222-4222-8222-222222222222';
const META = 'cuabar/request-token';

async function boot(t, owner = OWNER) {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());
  const client = startRelay(fixture, {env: {CODEX_CUA_OWNER: owner ?? undefined}});
  await client.request('initialize', {});
  return {fixture, client};
}

function request(id, token, {name = 'js', code = 'hang', scope = true} = {}) {
  return {jsonrpc: '2.0', id, method: 'tools/call', params: {name, arguments: {code},
    _meta: {[META]: token, ...(scope ? {'x-codex-turn-metadata': turn('session', 'turn')} : {})}}};
}

async function active(fixture, count = 1) {
  await until(() => fixture.events('call').length === count, 5000, 'native calls');
  const record = await readRecord(fixture, r => r.busy);
  await until(() => fs.existsSync(record.control_path), 5000, 'control socket');
  assert.equal(record.cancel_by_request_token, true);
  return record;
}

const cancel = (record, token, extra = {}) => control(record.control_path,
  {action: 'cancel', ...identity(record), owner: OWNER, request_token: token, ...extra});
const cancellations = fixture => fixture.events('line').map(event => JSON.parse(Buffer.from(event.b64, 'base64').toString()))
  .filter(message => message.method === 'notifications/cancelled');

test('a bridge cancel maps its token to exactly one native call and keeps unrelated calls intact', async t => {
  const {fixture, client} = await boot(t);
  const first = Buffer.from(' { "jsonrpc":"2.0", "id":"native-1", "method":"tools/call", "params":'
    + JSON.stringify(request('native-1', TOKEN_A).params) + '}\r\n');
  client.sendRaw(first);
  client.send(request(902, TOKEN_B, {code: 'sleep:350'}));
  const record = await active(fixture, 2);
  assert.deepEqual(await cancel(record, TOKEN_A, {requestId: 902}), {cancelled: true, reason: null});
  await until(() => cancellations(fixture).length === 1);
  assert.deepEqual(cancellations(fixture), [{jsonrpc: '2.0', method: 'notifications/cancelled',
    params: {requestId: 'native-1', reason: 'Client canceled request'}}]);
  assert.ok(fixture.events('line').some(event => Buffer.from(event.b64, 'base64').equals(first)),
    'the request, including whitespace, is forwarded unchanged');
  const second = await until(() => client.messages.find(message => message.id === 902));
  assert.equal(second.result.content[0].text, 'slept');
  assert.equal((await readRecord(fixture)).busy, true, 'sent cancellation is not proof a native operation stopped');
  assert.equal(fixture.events('turn_ended').length, 0, 'cancellation is not a turn release or runtime reset');
  assert.equal(fixture.events('call').length, 2, 'no original operation is replayed');
  assert.equal(fs.readFileSync(path.join(record.dir, 'relay.json'), 'utf8').includes(TOKEN_A), false);
  const activity = path.join(fixture.state, 'activity.jsonl');
  assert.equal(fs.existsSync(activity) && fs.readFileSync(activity, 'utf8').includes(TOKEN_B), false,
    'correlation tokens are never persisted in activity');
});

test('cancel refuses missing ownership, wrong ownership, unknown tokens and invalid tokens', async t => {
  const {fixture, client} = await boot(t);
  client.send(request(401, TOKEN_A));
  const record = await active(fixture);
  for (const [token, extra, reason] of [
    [TOKEN_A, {owner: 'bridge-9999-1700000000'}, 'not_owned'],
    [TOKEN_A, {owner: undefined}, 'not_owned'],
    [TOKEN_B, {}, 'not_found'],
    ['caller-chosen-id', {}, 'invalid_request'],
    [null, {}, 'invalid_request'],
  ]) assert.deepEqual(await cancel(record, token, extra), {cancelled: false, reason});
  assert.deepEqual(cancellations(fixture), []);
  assert.equal((await readRecord(fixture)).busy, true);
});

test('a relay without a bridge owner never accepts a token cancellation', async t => {
  const {fixture, client} = await boot(t, null);
  client.send(request(402, TOKEN_A));
  const record = await active(fixture);
  assert.equal(record.owner, null);
  assert.deepEqual(await cancel(record, TOKEN_A), {cancelled: false, reason: 'not_owned'});
  assert.deepEqual(cancellations(fixture), []);
});

test('only a js call with host scope and a unique bridge token is eligible', async t => {
  const {fixture, client} = await boot(t);
  client.send(request(501, TOKEN_A, {name: 'js_reset'}));
  client.send(request(502, TOKEN_B, {scope: false}));
  const record = await active(fixture, 2);
  assert.deepEqual(await cancel(record, TOKEN_A), {cancelled: false, reason: 'not_found'});
  assert.deepEqual(await cancel(record, TOKEN_B), {cancelled: false, reason: 'not_found'});
  assert.deepEqual(cancellations(fixture), []);
});

test('duplicate tokens are rejected instead of guessing which pending operation to cancel', async t => {
  const {fixture, client} = await boot(t);
  client.send(request(601, TOKEN_A));
  client.send(request(602, TOKEN_A));
  const record = await active(fixture, 2);
  assert.deepEqual(await cancel(record, TOKEN_A), {cancelled: false, reason: 'ambiguous_request'});
  assert.deepEqual(cancellations(fixture), []);
});

test('a cancellation is sent once and a completed request cannot be cancelled afterward', async t => {
  const {fixture, client} = await boot(t);
  client.send(request(701, TOKEN_A, {code: 'sleep:450'}));
  const record = await active(fixture);
  assert.deepEqual(await cancel(record, TOKEN_A), {cancelled: true, reason: null});
  assert.deepEqual(await cancel(record, TOKEN_A), {cancelled: false, reason: 'already_cancelled'});
  await until(() => client.messages.some(message => message.id === 701));
  assert.deepEqual(await cancel(record, TOKEN_A), {cancelled: false, reason: 'not_found'});
  assert.equal(cancellations(fixture).length, 1);
  assert.equal(client.messages.filter(message => message.id === 701).length, 1,
    'the native response still reaches its original requester exactly once');
});

test('cancel checks relay process identity and does not queue behind a release', async t => {
  const {fixture, client} = await boot(t);
  client.send(request(801, TOKEN_A));
  const record = await active(fixture);
  assert.equal(await cancel(record, TOKEN_A, {pid: record.pid + 1}), null);
  assert.equal(await cancel(record, TOKEN_A, {started_at: record.started_at + 1}), null);
  assert.equal(await cancel(record, TOKEN_A, {pid: String(record.pid)}), null);
  assert.deepEqual(cancellations(fixture), []);
  const release = control(record.control_path, {action: 'release', ...identity(record)});
  await sleep(40);
  const began = Date.now();
  assert.deepEqual(await cancel(record, TOKEN_A), {cancelled: true, reason: null});
  assert.ok(Date.now() - began < 1000, 'cancel must not wait for the running call or the release queue');
  assert.deepEqual(await release, {released: false, reason: 'request_in_flight', scope_count: 0});
});
