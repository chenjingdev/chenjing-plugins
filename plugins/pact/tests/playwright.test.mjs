import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePlaywright, PLAYWRIGHT_VERSION } from '../scripts/playwright.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'scripts', 'playwright.mjs');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'pact-pw-'));
const fakePlaywright = (root, version = PLAYWRIGHT_VERSION) => {
  const dir = path.join(root, 'node_modules', 'playwright');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'playwright', version }));
  return dir;
};

test("the project's own playwright wins", () => {
  const project = tmp();
  const data = tmp();
  const dir = fakePlaywright(project);
  fakePlaywright(path.join(data, 'playwright'));
  assert.deepEqual(resolvePlaywright(project, data), { source: 'project', modulePath: dir });
});

test("pact's own copy is used when the project has none", () => {
  const data = tmp();
  const dir = fakePlaywright(path.join(data, 'playwright'));
  assert.deepEqual(resolvePlaywright(tmp(), data), { source: 'pact', modulePath: dir });
});

test('nothing found gives null', () => {
  assert.equal(resolvePlaywright(tmp(), tmp()), null);
});

test('ensure with PACT_NO_INSTALL=1 and nothing installed exits 2 without installing', () => {
  const r = spawnSync('node', [CLI, 'ensure', tmp()], {
    encoding: 'utf8',
    env: { ...process.env, PACT_NO_INSTALL: '1', CLAUDE_PLUGIN_DATA: tmp() },
  });
  assert.equal(r.status, 2, r.stderr);
});

test('ensure prints JSON when playwright is already there', () => {
  const project = tmp();
  fakePlaywright(project);
  const r = spawnSync('node', [CLI, 'ensure', project], {
    encoding: 'utf8',
    env: { ...process.env, PACT_NO_INSTALL: '1', CLAUDE_PLUGIN_DATA: tmp() },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).source, 'project');
});

test("an outdated pact-owned copy counts as missing so ensure reinstalls it; a project's own version is respected", () => {
  const data = tmp();
  fakePlaywright(path.join(data, 'playwright'), '1.0.0');
  assert.equal(resolvePlaywright(tmp(), data), null);
  const project = tmp();
  const dir = fakePlaywright(project, '1.0.0');
  assert.deepEqual(resolvePlaywright(project, data), { source: 'project', modulePath: dir });
});
