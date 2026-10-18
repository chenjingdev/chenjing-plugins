// The runtime must always start: node-repl-relay and relay.mjs both fall back to the original runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {makeFixture, startRelay, readRecord, relayDirs, until, turn, RELAY_DIR, RELAY_MJS} from './harness.mjs';

const ARGS = ['one two', '', '--flag'];
const UNAVAILABLE = 'codex-cua relay: the original runtime is unavailable\n';

// A private copy of the relay files that a test may damage.
function copyRelay(fixture, name = 'relay') {
  const dir = path.join(fixture.dir, name);
  fs.mkdirSync(dir);
  for (const file of ['relay.mjs', 'node-repl-relay']) fs.copyFileSync(path.join(RELAY_DIR, file), path.join(dir, file));
  fs.chmodSync(path.join(dir, 'node-repl-relay'), 0o755);
  return {dir, launcher: path.join(dir, 'node-repl-relay'), script: path.join(dir, 'relay.mjs')};
}

async function runtimeStartedDirectly(t, fixture, client) {
  const answer = await client.request('initialize', {});
  assert.equal(answer.result.serverInfo.name, 'fake');
  const [start] = fixture.events('start');
  assert.deepEqual(start.argv, ARGS);
  // The runtime started directly has the environment it would have had without the relay.
  assert.deepEqual({...start.env, marker: null}, {native: null, relayNode: null, state: null, runtimePath: fixture.native, marker: null});
  assert.deepEqual(relayDirs(fixture), [], 'no relay was involved');
  const call = await client.call('plain', turn('s-1', 't-1'));
  assert.equal(call.result.content[0].text, 'echo:plain');
  client.end();
  assert.equal((await client.exit).code, 7);
}

test('the launcher runs the relay when node and relay.mjs are in order', async t => {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());
  const client = startRelay(fixture, {via: 'launcher', args: ARGS});
  await client.request('initialize', {});
  const record = await readRecord(fixture);
  assert.equal(record.root_pid, process.pid, 'exec replaced the shell');
  assert.equal(record.pid, client.child.pid);
  assert.deepEqual(fixture.events('start')[0].argv, ARGS);
  assert.equal(client.stderr, '');
});

const damage = {
  'node does not exist': (copy, env) => {env.CODEX_CUA_RELAY_NODE = path.join(copy.dir, 'no-such-node');},
  'node is not executable': (copy, env) => {
    const file = path.join(copy.dir, 'node-without-x');
    fs.writeFileSync(file, '#!/bin/sh\nexit 99\n', {mode: 0o644});
    env.CODEX_CUA_RELAY_NODE = file;
  },
  'node is a directory': (copy, env) => {env.CODEX_CUA_RELAY_NODE = copy.dir;},
  'node is not named at all': (copy, env) => {env.CODEX_CUA_RELAY_NODE = undefined;},
  'node cannot even check a script': (copy, env) => {
    const file = path.join(copy.dir, 'broken-node');
    fs.writeFileSync(file, '#!/bin/sh\nexit 3\n', {mode: 0o755});
    env.CODEX_CUA_RELAY_NODE = file;
  },
  'relay.mjs is missing': copy => fs.rmSync(copy.script),
  'relay.mjs is unreadable': copy => fs.chmodSync(copy.script, 0o000),
  'relay.mjs is a directory': copy => {fs.rmSync(copy.script); fs.mkdirSync(copy.script);},
  'relay.mjs does not parse': copy => fs.writeFileSync(copy.script, 'import {{{ nonsense'),
  'relay.mjs is cut off': copy => fs.writeFileSync(copy.script, fs.readFileSync(copy.script, 'utf8').slice(0, 900)),
};

for (const [label, apply] of Object.entries(damage)) {
  test('the launcher starts the original runtime when ' + label, async t => {
    const fixture = makeFixture();
    t.after(() => fixture.cleanup());
    const copy = copyRelay(fixture);
    const env = {FAKE_EXIT_CODE: '7'};
    apply(copy, env);
    const client = startRelay(fixture, {via: 'launcher', launcher: copy.launcher, args: ARGS, env});
    await runtimeStartedDirectly(t, fixture, client);
    assert.equal(client.stderr, '');
  });
}

test('without a usable original runtime the launcher says so in one fixed line and fails', async t => {
  for (const [label, native] of [['missing', 'no/such/runtime'], ['a directory', '.'], ['not executable', 'plain.txt'], ['unset', undefined]]) {
    await t.test(label, async () => {
      const fixture = makeFixture();
      try {
        fs.writeFileSync(path.join(fixture.dir, 'plain.txt'), 'x', {mode: 0o644});
        const copy = copyRelay(fixture);
        const resolved = native === undefined ? undefined : path.resolve(fixture.dir, native);
        // One run with a relay that cannot be used, one with a relay in order.
        for (const node of [path.join(fixture.dir, 'no-such-node'), process.execPath]) {
          const client = startRelay(fixture, {via: 'launcher', launcher: copy.launcher, env: {CODEX_CUA_NATIVE_RUNTIME: resolved, CODEX_CUA_RELAY_NODE: node}});
          const result = await client.exit;
          assert.equal(result.code, 127);
          assert.equal(client.stderr, UNAVAILABLE);
        }
      } finally {await fixture.cleanup();}
    });
  }
});

test('the original runtime is never the launcher or the relay itself', async t => {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());
  const copy = copyRelay(fixture);
  fs.symlinkSync(copy.launcher, path.join(fixture.dir, 'alias'));
  for (const native of [copy.launcher, path.join(fixture.dir, 'alias')]) {
    for (const node of [path.join(fixture.dir, 'no-such-node'), process.execPath]) {
      const client = startRelay(fixture, {via: 'launcher', launcher: copy.launcher, env: {CODEX_CUA_NATIVE_RUNTIME: native, CODEX_CUA_RELAY_NODE: node}});
      assert.equal((await client.exit).code, 127);
      assert.equal(client.stderr, UNAVAILABLE);
    }
  }
});

for (const via of ['node', 'launcher']) {
  test('relay.mjs starts the original runtime directly when its own setup fails (' + via + ')', async t => {
    const fixture = makeFixture();
    t.after(() => fixture.cleanup());
    const client = startRelay(fixture, {via, args: ARGS, env: {CODEX_CUA_RELAY_TEST_FAIL: 'before-spawn', FAKE_EXIT_CODE: '7', FAKE_MARKER: 'm'}});
    await runtimeStartedDirectly(t, fixture, client);
    const [start] = fixture.events('start');
    assert.deepEqual(start.env, {native: null, relayNode: null, state: null, runtimePath: fixture.native, marker: 'm'});
    assert.equal(client.stderr, 'codex-cua relay: relay setup failed; starting the original runtime directly\n');
  });
}

test('after a failed setup a signal still reaches the runtime', async t => {
  const fixture = makeFixture();
  t.after(() => fixture.cleanup());
  const client = startRelay(fixture, {env: {CODEX_CUA_RELAY_TEST_FAIL: 'before-spawn'}});
  await client.request('initialize', {});
  client.kill('SIGTERM');
  assert.equal((await client.exit).code, 0);
  assert.equal(fixture.events('sigterm').length, 1);
});

test('relay.mjs without an original runtime fails with one fixed line and writes no record', async t => {
  for (const native of [undefined, 'relative/runtime', '/no/such/runtime']) {
    const fixture = makeFixture();
    try {
      const client = startRelay(fixture, {env: {CODEX_CUA_NATIVE_RUNTIME: native}});
      const result = await client.exit;
      assert.equal(result.code, 127);
      assert.equal(client.stderr, UNAVAILABLE);
      assert.deepEqual(relayDirs(fixture), []);
    } finally {await fixture.cleanup();}
  }
});

test('the files the launcher and the relay rely on end with their completeness marker', () => {
  assert.ok(fs.readFileSync(RELAY_MJS, 'utf8').trimEnd().endsWith('// codex-cua relay end'));
  assert.ok(fs.readFileSync(path.join(RELAY_DIR, 'node-repl-relay'), 'utf8').trimEnd().endsWith('# codex-cua relay end'));
  assert.equal(fs.statSync(path.join(RELAY_DIR, 'node-repl-relay')).mode & 0o111, 0o111, 'the launcher is executable');
});
