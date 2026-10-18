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
  const folded = html.indexOf('<details><summary>통과한 시나리오 2개</summary>');
  assert.ok(folded > fail && folded < pass, `passes are folded: fold at ${folded}`);
});

// 사람이 읽는 칸까지 채운 결과. 메인 세션이 headline·todo·changes·decision을, verifier가 summary를 쓴다.
const FILLED = {
  ...RESULTS,
  headline: '출결 앱을 다 만들었고 명세대로 됩니다.',
  todo: ['빈 수업 화면 문구를 정해 주세요'],
  changes: ['결석 사유는 선생님만 봅니다'],
  scenarios: [
    { ...scenario('S1', 'pass', [{ action: '목록 열기', shot: null, output: 'ok' }]), summary: '목록이 열린다' },
    { ...scenario('D1', 'doubt', [{ action: '새로고침', shot: null, output: 'ok' }], '새로고침하면 입력이 사라짐'), summary: '쓰던 출결이 지워진다', decision: '그대로 둡니다. 저장 버튼이 있어서요.' },
    { ...scenario('S2', 'fail', [{ action: '빈 수업', shot: null, output: 'ok' }]), summary: '빈 수업에서 화면이 멈춘다', note: 'TypeError at render()' },
  ],
};

test('the top holds the headline, what to do and the counts, before any scenario', () => {
  const { html } = renderReport(FILLED, { runDir: tmp() });
  const top = html.indexOf('출결 앱을 다 만들었고');
  assert.ok(top > 0);
  assert.ok(html.indexOf('<h2>할 일</h2>') > top);
  assert.ok(html.indexOf('빈 수업 화면 문구를 정해 주세요') > top);
  assert.ok(html.indexOf('시나리오 3개 · 통과 1 · 실패 1 · 의심 1') > top);
  assert.ok(html.indexOf('<h2>실패·의심</h2>') > html.indexOf('시나리오 3개'));
  assert.match(renderReport({ ...FILLED, todo: [] }, { runDir: tmp() }).html, /<h2>할 일<\/h2><p>없음<\/p>/);
  assert.doesNotMatch(renderReport(RESULTS, { runDir: tmp() }).html, /할 일/, 'old results without todo show no empty box');
});

test('a problem shows its plain summary and decision, and folds the working note; failures come before doubts', () => {
  const { html } = renderReport(FILLED, { runDir: tmp() });
  const fail = html.indexOf('빈 수업에서 화면이 멈춘다');
  const doubt = html.indexOf('쓰던 출결이 지워진다');
  assert.ok(fail > 0 && doubt > fail, 'fail before doubt');
  assert.ok(html.indexOf('그대로 둡니다. 저장 버튼이 있어서요.') > doubt);
  const note = html.indexOf('TypeError at render()');
  const more = html.lastIndexOf('<summary>자세히</summary>', note);
  assert.ok(more > fail && note > more, 'the note sits inside 자세히');
  assert.match(renderReport(RESULTS, { runDir: tmp() }).html, /<p>S2 메모<\/p>/, 'without summary the note leads');
});

test('spec differences and changes share one list; rulings are folded at the bottom with a count', () => {
  const { html } = renderReport(FILLED, { runDir: tmp() });
  const diff = html.indexOf('<h2>명세와 다른 것</h2>');
  assert.ok(html.indexOf('결석 사유는 선생님만 봅니다') > diff);
  assert.match(html, /<span class="tag">빠짐<\/span>F2 &lt;내보내기&gt; 없음/);
  const rulings = html.indexOf('<details><summary>결정 기록 1개</summary>');
  assert.ok(rulings > html.indexOf('<h2>통과</h2>'));
  assert.doesNotMatch(renderReport({ ...FILLED, rulings: [] }, { runDir: tmp() }).html, /결정 기록/);
});

test('the title names the topic from the spec next to the run dir', () => {
  const project = tmp();
  mkdirSync(path.join(project, 'docs', 'pact'), { recursive: true });
  writeFileSync(path.join(project, 'docs', 'pact', '2026-10-10-x.md'), '---\npact: 1\ntopic: 출결 관리\nstatus: verifying\n---\n# 출결 관리\n');
  const runDir = path.join(project, '.pact', 'x');
  mkdirSync(runDir, { recursive: true });
  assert.match(renderReport(RESULTS, { runDir }).html, /<title>출결 관리 검수 보고서<\/title>/);
  assert.match(renderReport(RESULTS, { runDir: tmp() }).html, /<title>검수 보고서<\/title>/);
});

test('missing screenshots are marked, existing ones are linked relative to the run dir', () => {
  const dir = tmp();
  mkdirSync(path.join(dir, 'shots'));
  writeFileSync(path.join(dir, 'shots', 'S1-1.png'), 'png');
  const { html } = renderReport(RESULTS, { runDir: dir });
  assert.match(html, /<a href="shots\/S1-1\.png" target="_blank"><img src="shots\/S1-1\.png"/);
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
