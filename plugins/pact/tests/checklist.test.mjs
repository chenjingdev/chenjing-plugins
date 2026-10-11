import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderChecklist } from '../scripts/checklist.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'scripts', 'checklist.mjs');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'pact-checklist-'));

const INPUT = {
  title: '출결 대시보드',
  items: [
    { label: '오늘 출석 현황', note: '수업별 출석률' },
    { label: '<b>엑셀</b> 내보내기', suggested: true, reason: '학사팀이 매주 따로 집계한다' },
  ],
};

test('renderChecklist checks inferred items and leaves suggestions unchecked with a reason', () => {
  const html = renderChecklist(INPUT);
  const boxes = html.match(/<input type="checkbox"[^>]*>/g);
  assert.equal(boxes.length, 2);
  assert.match(boxes[0], /checked/);
  assert.doesNotMatch(boxes[1], /checked/);
  assert.match(html, /\(제안\)/);
  assert.match(html, /학사팀이 매주 따로 집계한다/);
  assert.match(html, /'기능: '/);
  assert.match(html, /fetch\('\/submit'/);
  assert.match(html, /id="fallback"/);
  assert.doesNotMatch(html, /(src|href)="http/);
  assert.match(html, /&lt;b&gt;엑셀/);
  assert.doesNotMatch(html, /<b>엑셀/);
});

test('renderChecklist groups items under their map branch, in first-seen order', () => {
  const html = renderChecklist({
    title: '회의 일정',
    items: [
      { group: '시간 모으기', label: '되는 시간 고르기' },
      { group: '알림', label: '확정 알림', suggested: true, reason: '확정을 놓치기 쉽다' },
      { group: '시간 모으기', label: '시간대 자동 맞춤' },
      { group: '<i>공유</i>', label: '링크 공유' },
    ],
  });
  const heads = [...html.matchAll(/<h2>(.*?)<\/h2>/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['시간 모으기', '알림', '&lt;i&gt;공유&lt;/i&gt;']);
  const at = (s) => html.indexOf(s);
  assert.ok(at('시간대 자동 맞춤') < at('<h2>알림</h2>'), 'same branch stays together');
  assert.equal(html.match(/<input type="checkbox"/g).length, 4);
});

test('renderChecklist without groups renders no branch headings', () => {
  assert.doesNotMatch(renderChecklist(INPUT), /<h2>/);
});

test('render CLI writes checklist.html into the run dir', () => {
  const dir = tmp();
  const input = path.join(dir, 'in.json');
  writeFileSync(input, JSON.stringify(INPUT));
  const r = spawnSync('node', [CLI, 'render', input, dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(path.join(dir, 'checklist.html')));
});

function startServe(dir, env = {}) {
  const child = spawn('node', [CLI, 'serve', dir], { env: { ...process.env, ...env } });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (err += c));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve({ code, out, err })));
  const url = new Promise((resolve, reject) => {
    child.stdout.on('data', () => {
      const m = /페이지: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (m) resolve(m[1]);
    });
    child.on('exit', () => reject(new Error(`serve exited early: ${err}`)));
  });
  return { url, exited };
}

test('serve answers GET, writes the first POST /submit and exits 0', async () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'checklist.html'), renderChecklist(INPUT));
  const { url, exited } = startServe(dir);
  const base = await url;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /출결 대시보드/);
  const post = await fetch(base + 'submit', { method: 'POST', body: '기능: a, b' });
  assert.equal(post.status, 200);
  const { code, out } = await exited;
  assert.equal(code, 0);
  assert.equal(readFileSync(path.join(dir, 'checklist.txt'), 'utf8'), '기능: a, b');
  assert.match(out, /기능: a, b/);
});

test('serve gives up after PACT_CHECKLIST_TIMEOUT_MS and asks for the chat instead', async () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'checklist.html'), renderChecklist(INPUT));
  const { url, exited } = startServe(dir, { PACT_CHECKLIST_TIMEOUT_MS: '200' });
  url.catch(() => {});
  const { code, err } = await exited;
  assert.equal(code, 1);
  assert.match(err, /시간 초과 — 채팅으로 기능 범위를 알려 주세요/);
});
