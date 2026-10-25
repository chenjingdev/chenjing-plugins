import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../scripts/spec.mjs', import.meta.url));
const made = [];
after(() => made.forEach(p => rmSync(p, { recursive: true, force: true })));

test('set-status cannot bypass verification and mark an unchecked spec done', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pact-complete-cli-')); made.push(dir);
  const file = path.join(dir, 'spec.md');
  const original = '---\npact: 1\nstatus: draft\n---\n# 아직 검수하지 않음\n';
  writeFileSync(file, original);
  const result = spawnSync(process.execPath, [CLI, 'set-status', file, 'done'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /verification\.mjs.*finish/);
  assert.equal(readFileSync(file, 'utf8'), original);
});
