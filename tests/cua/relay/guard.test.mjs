// The fingerprint that guards the real support folders sees what a list of names could not, and the run says so with
// an exit code of its own.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fingerprint, changes, describe, localTime, REAL_HOME, DEFAULT_HOME, sleep} from './harness.mjs';

const TIME = '\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d [+-]\\d{4}';
const FIXED_NS = 1792332000n * 1000000000n;                     // 2026-10-18 14:00:00 UTC

function fakeHome(t) {
  const home = fs.mkdtempSync('/tmp/grd-');
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const put = (relative, text = 'x') => {
    fs.mkdirSync(path.dirname(path.join(home, relative)), {recursive: true});
    fs.writeFileSync(path.join(home, relative), text);
  };
  put('.local/share/codex-cua/relay/relay.mjs', '// one\n');
  put('.local/share/codex-cua/command.py');
  put('.local/bin/codex-cua', '#!/bin/sh\n');
  put('Library/LaunchAgents/other.plist', '<plist/>');
  put('Library/LaunchAgents/com.chenjingdev.codex-cua.env.plist', '<plist/>');
  fs.mkdirSync(path.join(home, 'Library/Caches/codex-host-cua'), {recursive: true});
  return {home, put, before: fingerprint(home)};
}

test('nothing changed, nothing reported; an absent folder is part of the picture', t => {
  const {home, before} = fakeHome(t);
  assert.deepEqual(changes(before, fingerprint(home)), []);
  assert.ok(before.has('.local/share/codex-cua/relay/relay.mjs'));
  assert.equal(before.get('Library/Caches/codex-cua'), null);
});

test('an overwrite inside an existing file shows although no name changes', async t => {
  const {home, put, before} = fakeHome(t);
  await sleep(10);
  put('.local/share/codex-cua/relay/relay.mjs', '// two\n');                      // same size, same name
  assert.ok(changes(before, fingerprint(home)).includes('.local/share/codex-cua/relay/relay.mjs'));
});

test('an atomic replace shows too', t => {
  const {home, put, before} = fakeHome(t);
  put('.local/share/codex-cua/relay/.tmp', '// one\n');
  fs.renameSync(path.join(home, '.local/share/codex-cua/relay/.tmp'), path.join(home, '.local/share/codex-cua/relay/relay.mjs'));
  assert.ok(changes(before, fingerprint(home)).includes('.local/share/codex-cua/relay/relay.mjs'));
});

test('new, removed and changed entries in every watched place show', t => {
  const {home, put, before} = fakeHome(t);
  fs.mkdirSync(path.join(home, 'Library/Caches/codex-cua'));
  put('Library/Caches/codex-host-cua/host.json', '{}');
  fs.rmSync(path.join(home, 'Library/LaunchAgents/com.chenjingdev.codex-cua.env.plist'));
  fs.chmodSync(path.join(home, '.local/bin/codex-cua'), 0o755);
  fs.rmSync(path.join(home, '.local/share/codex-cua/command.py'));
  const moved = changes(before, fingerprint(home));
  for (const name of ['Library/Caches/codex-cua', 'Library/Caches/codex-host-cua/host.json',
    'Library/LaunchAgents/com.chenjingdev.codex-cua.env.plist', '.local/share/codex-cua/command.py',
    '.local/share/codex-cua']) assert.ok(moved.includes(name), name);
});

test('a login agent of ours is watched and the agents of other tools are not', t => {
  const {home, put, before} = fakeHome(t);
  put('Library/LaunchAgents/other.plist', '<plist>changed</plist>');
  put('Library/LaunchAgents/org.example.new.plist');
  fs.rmSync(path.join(home, 'Library/LaunchAgents/other.plist'));
  assert.deepEqual(changes(before, fingerprint(home)), [], 'what other tools do in the shared folder is not our business');
  put('Library/LaunchAgents/com.chenjingdev.codex-cua.env.plist', '<plist>rewritten</plist>');
  assert.ok(changes(before, fingerprint(home)).includes('Library/LaunchAgents/com.chenjingdev.codex-cua.env.plist'));
  put('Library/LaunchAgents/com.chenjingdev.codex-cua.other.plist');
  assert.ok(changes(before, fingerprint(home)).includes('Library/LaunchAgents/com.chenjingdev.codex-cua.other.plist'));
});

test('a link is described, not followed', t => {
  const {home, put} = fakeHome(t);
  put('elsewhere/file');
  fs.symlinkSync(path.join(home, 'elsewhere'), path.join(home, '.local/share/codex-cua/link'));
  const after = fingerprint(home);
  assert.ok(after.has('.local/share/codex-cua/link'));
  assert.ok(!after.has('.local/share/codex-cua/link/file'));
});

test('the real home is the one of the account, not the one HOME says', () => {
  assert.equal(REAL_HOME, os.userInfo().homedir);
  assert.notEqual(process.env.HOME, REAL_HOME);
  assert.equal(process.env.HOME, DEFAULT_HOME);
});

test('every change is listed with what happened and its new modification time', t => {
  const {home, put, before} = fakeHome(t);
  put('.local/share/codex-cua/command.py', 'a longer content');
  fs.utimesSync(path.join(home, '.local/share/codex-cua/command.py'), new Date(1792332000000), new Date(1792332000000));
  fs.mkdirSync(path.join(home, 'Library/Caches/codex-cua'));
  fs.rmSync(path.join(home, '.local/share/codex-cua/relay/relay.mjs'));
  const lines = describe(before, fingerprint(home));
  // The new time of the file, not the old one, and no time for what is gone.
  assert.ok(lines.includes('.local/share/codex-cua/command.py  changed, modified ' + localTime(FIXED_NS)), lines.join('\n'));
  assert.ok(lines.includes('.local/share/codex-cua/relay/relay.mjs  removed'), lines.join('\n'));
  const folder = lines.filter(line => line.startsWith('Library/Caches/codex-cua  '));
  assert.equal(folder.length, 1);
  assert.match(folder[0], new RegExp('^Library/Caches/codex-cua  new, modified ' + TIME + '$'));
  assert.equal(lines.length, changes(before, fingerprint(home)).length, 'one line per path');
  assert.deepEqual(describe(before, before), []);
});

test('a modification time is shown in the local time zone with its offset', t => {
  const saved = process.env.TZ;
  t.after(() => {if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;});
  for (const [zone, shown] of [['Asia/Seoul', '2026-10-18 23:00:00 +0900'], ['America/New_York', '2026-10-18 10:00:00 -0400'],
    ['UTC', '2026-10-18 14:00:00 +0000']]) {
    process.env.TZ = zone;
    assert.equal(localTime(FIXED_NS), shown, zone);
  }
});

// A test process of its own, on a stand-in home: the exit code says which kind of trouble it is.
const STAND_IN = `
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {watchHome} from ${JSON.stringify(new URL('./harness.mjs', import.meta.url).href)};
const home = process.env.STAND_IN_HOME;
watchHome(home);
test('stand-in', () => {
  const does = process.env.STAND_IN_DOES;
  if (does.includes('change')) fs.writeFileSync(path.join(home, '.local/share/codex-cua/command.py'), 'a longer content');
  if (does.includes('stray')) fs.writeFileSync(path.join(process.env.HOME, 'stray.txt'), 'x');
  if (does.includes('fail')) throw new Error('on purpose');
});
`;

function runStandIn(t, does) {
  const dir = fs.mkdtempSync('/tmp/grd-');
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.local/share/codex-cua'), {recursive: true});
  fs.writeFileSync(path.join(home, '.local/share/codex-cua/command.py'), 'x');
  fs.writeFileSync(path.join(dir, 'stand-in.mjs'), STAND_IN);
  const env = {...process.env, STAND_IN_HOME: home, STAND_IN_DOES: does};
  delete env.NODE_TEST_CONTEXT;                 // else the child takes itself for a file of the runner that started us
  return spawnSync(process.execPath, [path.join(dir, 'stand-in.mjs')], {env, encoding: 'utf8', timeout: 60000});
}

test('a clean run exits 0 and says nothing about the guard', t => {
  const done = runStandIn(t, 'nothing');
  assert.equal(done.status, 0, done.stderr);
  assert.ok(!done.stderr.includes('changed while the tests ran'), done.stderr);
});

test('a failing test exits 1', t => {
  const done = runStandIn(t, 'fail');
  assert.equal(done.status, 1, done.stderr);
  assert.ok(!done.stderr.includes('changed while the tests ran'), done.stderr);
});

test('a change in the real support folders exits 2 although every test passed', t => {
  const done = runStandIn(t, 'change');
  assert.equal(done.status, 2, done.stderr);
  assert.match(done.stdout, /\bpass 1\b/);
  assert.match(done.stderr, /The real support folders changed while the tests ran/);
  assert.match(done.stderr, new RegExp('\\n  \\.local/share/codex-cua/command\\.py  changed, modified ' + TIME + '\\n'));
});

test('the guard wins over a failing test', t => {
  const done = runStandIn(t, 'fail change');
  assert.equal(done.status, 2, done.stderr);
  assert.match(done.stdout, /\bfail 1\b/, 'the test results are still printed');
  assert.match(done.stderr, /command\.py {2}changed, modified /);
});

test('a stray in the throw-away home is a failure of the tests, not a change of the real folders', t => {
  const done = runStandIn(t, 'stray');
  assert.equal(done.status, 1, done.stderr);
  assert.ok(done.stderr.includes('Tests wrote into the default home instead of an injected one:\n  stray.txt'), done.stderr);
  assert.ok(!done.stderr.includes('changed while the tests ran'), done.stderr);
});
