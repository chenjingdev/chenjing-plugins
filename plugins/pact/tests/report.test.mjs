import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderReport } from '../scripts/report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'scripts', 'report.mjs');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'pact-report-'));

const scenario = (id, result, steps, title = `${id} 제목`) => ({
  id, title, kind: 'spec', items: ['F1'], result, note: `${id} 메모`, steps,
});

const RESULTS = {
  spec: 'docs/pact/2026-10-10-x.md',
  scenarios: [
    scenario('S1', 'pass', [{ action: '목록 열기', shot: 'shots/S1-1.png', output: null }]),
    scenario('S2', 'fail', [{ action: '빈 수업', shot: 'shots/S2-1.png', output: null }]),
    scenario('S3', 'pass', [{ action: 'CLI 실행', shot: null, output: 'exit 0' }]),
  ],
  specCheck: { missing: ['F2 <내보내기> 없음'], extra: [], misunderstood: [] },
  rulings: ['Ruling: 빈 상태 문구 <기본> — 명세에 없음 — 문구 수정'],
};

test('summary counts results and failures come before passes, which are folded', () => {
  const dir = tmp();
  const { html, summary } = renderReport(RESULTS, { runDir: dir });
  assert.equal(summary, '통과 2 · 실패 1 · 의심 0');
  assert.ok(html.includes(summary));
  const fail = html.indexOf('S2 제목');
  const pass = html.indexOf('S1 제목');
  assert.ok(fail > 0 && pass > fail, `fail at ${fail}, pass at ${pass}`);
  const details = html.indexOf('<details');
  assert.ok(details > fail && details < pass);
});

test('missing screenshots are marked, existing ones are linked relative to the run dir', () => {
  const dir = tmp();
  mkdirSync(path.join(dir, 'shots'));
  writeFileSync(path.join(dir, 'shots', 'S1-1.png'), 'png');
  const { html } = renderReport(RESULTS, { runDir: dir });
  assert.match(html, /<img src="shots\/S1-1\.png"/);
  assert.doesNotMatch(html, /<img src="shots\/S2-1\.png"/);
  assert.match(html, /스크린샷 없음/);
});

test('command output goes into <pre>', () => {
  const { html } = renderReport(RESULTS, { runDir: tmp() });
  assert.match(html, /<pre>exit 0<\/pre>/);
});

test('an empty result still renders', () => {
  const { html, summary } = renderReport({ spec: 'x', scenarios: [] }, { runDir: tmp() });
  assert.equal(summary, '통과 0 · 실패 0 · 의심 0');
  assert.match(html, /<html/);
});

test('specCheck and rulings text is escaped', () => {
  const { html } = renderReport(RESULTS, { runDir: tmp() });
  assert.match(html, /F2 &lt;내보내기&gt; 없음/);
  assert.match(html, /빈 상태 문구 &lt;기본&gt;/);
  assert.doesNotMatch(html, /<내보내기>/);
});

test('CLI writes report.html and prints the summary and path', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'results.json'), JSON.stringify(RESULTS));
  const r = spawnSync('node', [CLI, dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /통과 2 · 실패 1 · 의심 0/);
  assert.match(r.stdout, /report\.html/);
  assert.match(readFileSync(path.join(dir, 'report.html'), 'utf8'), /S2 제목/);
});

test('CLI explains a missing or broken results.json in Korean', () => {
  const dir = tmp();
  let r = spawnSync('node', [CLI, dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /results\.json이 없습니다/);
  assert.doesNotMatch(r.stderr, /ENOENT/);
  writeFileSync(path.join(dir, 'results.json'), '{ 깨짐');
  r = spawnSync('node', [CLI, dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /results\.json을 읽지 못했습니다/);
});
