import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitState } from '../scripts/git-state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'scripts', 'git-state.mjs');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'pact-git-'));
const git = (cwd, ...args) =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd });

test('a plain folder is not a repo', () => {
  assert.deepEqual(gitState(tmp()), { repo: false, branch: null, dirty: false, changed: [], untracked: [] });
});

test('a fresh commit is clean, an edit makes it dirty', () => {
  const d = tmp();
  git(d, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(d, 'a.txt'), '1');
  git(d, 'add', '.');
  git(d, 'commit', '-q', '-m', 'init');
  assert.deepEqual(gitState(d), { repo: true, branch: 'main', dirty: false, changed: [], untracked: [] });
  writeFileSync(path.join(d, 'a.txt'), '2');
  assert.equal(gitState(d).dirty, true);
  assert.deepEqual(gitState(d).changed, ['a.txt']);
});

test('untracked files are listed but do not make the tree dirty', () => {
  const d = tmp();
  git(d, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(d, 'a.txt'), '1');
  git(d, 'add', '.');
  git(d, 'commit', '-q', '-m', 'init');
  writeFileSync(path.join(d, '.env'), 'X=1');
  writeFileSync(path.join(d, '메모 1.txt'), 'x');
  const s = gitState(d);
  assert.equal(s.dirty, false);
  assert.deepEqual(s.changed, []);
  assert.deepEqual(s.untracked.sort(), ['.env', '메모 1.txt']);
});

test('CLI prints the state as JSON', () => {
  const r = spawnSync('node', [CLI, tmp()], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { repo: false, branch: null, dirty: false, changed: [], untracked: [] });
});
