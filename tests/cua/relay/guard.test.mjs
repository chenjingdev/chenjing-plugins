// The fingerprint that guards the real support folders sees what a list of names could not.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fingerprint, changes, REAL_HOME, DEFAULT_HOME, sleep} from './harness.mjs';

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
