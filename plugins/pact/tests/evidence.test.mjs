import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evidenceIssues, effectiveResult } from '../scripts/evidence.mjs';

const made = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=', 'base64');
const tmp = () => { const p = mkdtempSync(path.join(tmpdir(), 'pact-evidence-')); made.push(p); return p; };
after(() => made.forEach(p => rmSync(p, { recursive: true, force: true })));

test('every UI step requires an existing image, even when HTTP output is present', () => {
  const runDir = tmp();
  const step = { action: '저장 화면', shot: null, output: 'HTTP 200', exitCode: 0 };
  assert.ok(evidenceIssues(step, { runDir, surface: 'ui' }).length);
  mkdirSync(path.join(runDir, 'shots'));
  writeFileSync(path.join(runDir, 'shots/a.jpg'), png);
  assert.deepEqual(evidenceIssues({ ...step, shot: 'shots/a.jpg' }, { runDir, surface: 'ui' }), []);
  assert.equal(effectiveResult({ result: 'pass', steps: [{ ...step, shot: 'shots/a.jpg' }, step] }, { runDir, surface: 'ui' }), 'unverified');
});

test('empty and non-image files do not prove a UI step', () => {
  const runDir = tmp();
  for (const bytes of [Buffer.alloc(0), Buffer.from('not a screenshot')]) {
    writeFileSync(path.join(runDir, 'a.png'), bytes);
    assert.ok(evidenceIssues({ action: '보기', shot: 'a.png' }, { runDir, surface: 'ui' }).length);
  }
});

test('truncated image headers, corrupt PNG chunks and JPEG signatures alone are not screenshots', () => {
  const runDir = tmp();
  const truncated = Buffer.alloc(24);
  png.copy(truncated, 0, 0, 24);
  const corrupt = Buffer.from(png); corrupt[45] ^= 1;
  const jpegOnly = Buffer.alloc(24); jpegOnly[0] = 255; jpegOnly[1] = 216; jpegOnly[22] = 255; jpegOnly[23] = 217;
  for (const bytes of [truncated, corrupt, jpegOnly, png.subarray(0, png.length - 1)]) {
    writeFileSync(path.join(runDir, 'broken.png'), bytes);
    assert.ok(evidenceIssues({ action: '화면 확인', shot: 'broken.png' }, { runDir, surface: 'ui' }).length);
  }
});

test('a codec-generated JPEG is accepted but truncated and zero-width frames are rejected', () => {
  const runDir = tmp();
  const jpeg = readFileSync(new URL('./fixtures/evidence-white.jpg', import.meta.url));
  const check = bytes => {
    writeFileSync(path.join(runDir, 'screen.jpg'), bytes);
    return evidenceIssues({ action: '화면 확인', shot: 'screen.jpg' }, { runDir, surface: 'ui' });
  };
  assert.deepEqual(check(jpeg), []);
  assert.ok(check(jpeg.subarray(0, jpeg.length - 1)).length);
  const zeroWidth = Buffer.from(jpeg);
  const frame = zeroWidth.indexOf(Buffer.from([255, 192]));
  assert.ok(frame > 0);
  zeroWidth.writeUInt16BE(0, frame + 7);
  assert.ok(check(zeroWidth).length);
});

test('absolute paths, traversal and symlink escape cannot supply screenshot evidence', () => {
  const runDir = tmp(), other = tmp();
  const file = path.join(other, 'outside.png'); writeFileSync(file, png);
  symlinkSync(file, path.join(runDir, 'link.png'));
  for (const shot of [file, path.relative(runDir, file), 'link.png']) {
    assert.ok(evidenceIssues({ action: '보기', shot }, { runDir, surface: 'ui' }).length, shot);
  }
});

test('commands need recorded output and an integer exit code; a non-zero code is still evidence', () => {
  const runDir = tmp(), step = { action: '명령 실행', shot: null, output: '', exitCode: 0 };
  assert.deepEqual(evidenceIssues(step, { runDir, surface: 'command' }), []);
  assert.deepEqual(evidenceIssues({ ...step, exitCode: 1 }, { runDir, surface: 'command' }), []);
  for (const changed of [{ output: null }, { exitCode: undefined }, { exitCode: '0' }]) {
    assert.ok(evidenceIssues({ ...step, ...changed }, { runDir, surface: 'command' }).length);
  }
});

test('missing steps and unknown declarations are unverified, while a declared failure stays failed', () => {
  const options = { runDir: tmp(), surface: 'command' };
  assert.equal(effectiveResult({ result: 'pass', steps: [] }, options), 'unverified');
  assert.equal(effectiveResult({ result: 'anything', steps: [] }, options), 'unverified');
  assert.equal(effectiveResult({ result: 'fail', steps: [] }, options), 'fail');
});
