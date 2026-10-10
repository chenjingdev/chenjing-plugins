import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderGallery } from '../scripts/gallery.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'scripts', 'gallery.mjs');

const INPUT = {
  title: '출결 대시보드',
  axis: '목록 중심 vs 달력 중심',
  sketches: [
    { key: 'A', caption: '수업 목록이 먼저', html: '<h1>A</h1><script>document.title="x"</script>' },
    { key: 'B', caption: '달력이 먼저', html: '<h1>B</h1>' },
  ],
};

test('renderGallery puts each sketch in a sandboxed iframe filled by script', () => {
  const html = renderGallery(INPUT);
  assert.match(html, /id="frame-A"/);
  assert.match(html, /id="frame-B"/);
  assert.match(html, /sandbox="allow-scripts"/);
  assert.doesNotMatch(html, /allow-same-origin/);
  assert.match(html, /기능은 같고 구조만 다릅니다 — 목록 중심 vs 달력 중심/);
  assert.match(html, /수업 목록이 먼저/);
  assert.match(html, /달력이 먼저/);
});

test('a </script> inside a sketch stays inside the JS string', () => {
  const html = renderGallery(INPUT);
  const opens = html.match(/<script\b/g).length;
  const closes = html.match(/<\/script>/g).length;
  assert.equal(closes, opens);
  assert.match(html, /\\u003c\/script>/);
});

test('CLI reads sketches.json, inlines the files and writes gallery.html', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pact-gallery-'));
  writeFileSync(path.join(dir, 'a.html'), '<h1>A 본문</h1>');
  writeFileSync(path.join(dir, 'b.html'), '<h1>B 본문</h1>');
  writeFileSync(
    path.join(dir, 'sketches.json'),
    JSON.stringify({
      title: 't',
      axis: 'x',
      sketches: [
        { key: 'A', caption: 'a', file: 'a.html' },
        { key: 'B', caption: 'b', file: 'b.html' },
      ],
    }),
  );
  const r = spawnSync('node', [CLI, dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = path.join(dir, 'gallery.html');
  assert.equal(r.stdout.trim(), out);
  assert.ok(existsSync(out));
  assert.match(readFileSync(out, 'utf8'), /A 본문/);
});
