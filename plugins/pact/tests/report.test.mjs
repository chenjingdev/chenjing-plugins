import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderReport } from '../scripts/report.mjs';
import { appendRecord } from '../scripts/run-log.mjs';
import { userLinesOf } from '../scripts/spec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'scripts', 'report.mjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=', 'base64');
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pact-report-'));
  mkdirSync(path.join(dir, 'shots'), { recursive: true });
  writeFileSync(path.join(dir, 'shots', 'S1-1.png'), png);
  return dir;
};

const scenario = (id, result, steps, title = `${id} 제목`) => ({
  id, title, kind: 'spec', items: ['F1'], result, note: `${id} 메모`, steps,
});

const RESULTS = {
  spec: 'docs/pact/2026-10-10-x.md',
  scenarios: [
    scenario('S1', 'pass', [{ action: '목록 열기', shot: 'shots/S1-1.png', output: null }]),
    scenario('S2', 'fail', [{ action: '빈 수업', shot: 'shots/S2-1.png', output: null }]),
    scenario('S3', 'pass', [{ action: 'CLI 실행', shot: null, output: 'exit 0', exitCode: 0 }]),
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
    { ...scenario('S1', 'pass', [{ action: '목록 열기', shot: null, output: 'ok', exitCode: 0 }]), summary: '목록이 열린다' },
    { ...scenario('D1', 'doubt', [{ action: '새로고침', shot: null, output: 'ok', exitCode: 0 }], '새로고침하면 입력이 사라짐'), summary: '쓰던 출결이 지워진다', decision: '그대로 둡니다. 저장 버튼이 있어서요.' },
    { ...scenario('S2', 'fail', [{ action: '빈 수업', shot: null, output: 'ok', exitCode: 0 }]), summary: '빈 수업에서 화면이 멈춘다', note: 'TypeError at render()' },
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
  mkdirSync(path.join(dir, 'shots'), { recursive: true });
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

test('a declared pass without its screenshot is counted as unverified', () => {
  const dir = tmp();
  const { html, summary } = renderReport({
    surface: 'ui',
    scenarios: [scenario('S9', 'pass', [{ action: '저장 누름', shot: 'shots/not-created.png', output: null }])],
  }, { runDir: dir });
  assert.match(summary, /통과 0/);
  assert.match(summary, /미검증 1/);
  assert.match(html, /미검증/);
});

test('HTTP output alone cannot turn an unobserved UI step into a pass', () => {
  const { summary } = renderReport({
    surface: 'ui',
    scenarios: [scenario('S9', 'pass', [{ action: '저장 화면 확인', shot: null, output: 'HTTP 200', exitCode: 0 }])],
  }, { runDir: tmp() });
  assert.match(summary, /통과 0/);
  assert.match(summary, /미검증 1/);
});

test('an empty report explicitly says that verification was not performed', () => {
  const { html } = renderReport({ scenarios: [] }, { runDir: tmp() });
  assert.match(html, /검수한 시나리오가 없습니다/);
});

test('an old result cannot appear passed under a new capture id', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'verification.json'), JSON.stringify({ verification_id: 'new-capture', surface: 'ui' }));
  const { html, summary } = renderReport({
    verification_id: 'old-capture',
    scenarios: [{ ...scenario('S1', 'pass', [{ action: '화면 확인', shot: 'shots/S1-1.png' }]), verification_id: 'old-capture' }],
  }, { runDir: dir });
  assert.match(summary, /통과 0/);
  assert.match(summary, /미검증 1/);
  assert.match(html, /이어지지 않는 결과/);
});

test('scenario receipts must match even when the result-level receipt is current', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'verification.json'), JSON.stringify({ verification_id: 'current', surface: 'ui' }));
  const data = { verification_id: 'current', scenarios: [{ ...scenario('S1', 'pass', [{ action: '화면 확인', shot: 'shots/S1-1.png' }]), verification_id: 'older' }] };
  assert.match(renderReport(data, { runDir: dir }).summary, /미검증 1/);
  data.scenarios[0].verification_id = 'current';
  assert.equal(renderReport(data, { runDir: dir }).summary, '통과 1 · 실패 0 · 의심 0');
});

test('results from an earlier round of the same verification still count and are marked', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'verification.json'), JSON.stringify({ verification_id: 'round2', history: ['round1'], surface: 'ui' }));
  const data = { verification_id: 'round2', scenarios: [{ ...scenario('S1', 'pass', [{ action: '화면 확인', shot: 'shots/S1-1.png' }]), verification_id: 'round1' }] };
  const { html, summary } = renderReport(data, { runDir: dir });
  assert.equal(summary, '통과 1 · 실패 0 · 의심 0');
  assert.match(html, /앞 판에서 확인/);
  data.scenarios[0].verification_id = 'round0';
  assert.match(renderReport(data, { runDir: dir }).summary, /미검증 1/);
});

// ---------- 보고 칸은 summary.json에서, rulings는 명세 결정 기록에서 온다(명세 R13) ----------

const SPEC_PATH = 'docs/pact/2026-10-10-x.md';
const bullets = (lines) => lines.map((line) => `- ${line}\n`).join('');
const specWith = (log) => `---\npact: 2\ntopic: 출결 관리\nstatus: verifying\n---\n# 출결 관리\n## 기능\n- F1 목록 [사용자]\n## 공통 규칙\n## 결정 기록\n${log}`;
// 프로젝트 하나와 그 안의 실행 폴더(명세가 있는). 결정 기록은 줄 목록(rulings)이나 글 그대로(log)로 준다.
function project({ rulings = [], log = bullets(rulings) } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pact-report-project-'));
  mkdirSync(path.join(root, 'docs', 'pact'), { recursive: true });
  writeFileSync(path.join(root, SPEC_PATH), specWith(log));
  const run = path.join(root, '.pact', 'x');
  mkdirSync(path.join(run, 'shots'), { recursive: true });
  writeFileSync(path.join(run, 'shots', 'S1-1.png'), png);
  return { root, run };
}
const writeSummary = (run, summary) => writeFileSync(path.join(run, 'summary.json'), JSON.stringify(summary));

const RULING_LINES = ['Ruling: 빈 상태 문구는 "수업 없음" — 짧아서 — 문구만 바뀜', 'Ruling: 결석 사유는 선생님만 본다 <기본> — 명세에 없음 — 화면이 달라짐'];

test('(g) summary.json and the spec\'s decision log fill the report exactly where results.json\'s own fields used to: the page is the same', () => {
  // 0.5.0 꼴: 메인이 results.json에 headline·todo·changes·decision·rulings를 썼다
  const old = project();
  const oldResults = { ...FILLED, spec: SPEC_PATH, rulings: RULING_LINES };
  oldResults.scenarios = oldResults.scenarios.map((sc) => ({ ...sc, steps: sc.steps.map((st) => ({ ...st })) }));
  const oldHtml = renderReport(oldResults, { runDir: old.run }).html;
  // 0.6.0 꼴: results.json에는 verifier 칸만, 보고 칸은 summary.json, rulings는 명세
  const fresh = project({ rulings: RULING_LINES });
  const { headline, todo, changes, rulings: _ignored, ...rest } = oldResults;
  const decision = Object.fromEntries(oldResults.scenarios.filter((sc) => sc.decision).map((sc) => [sc.id, sc.decision]));
  const newResults = { ...rest, scenarios: rest.scenarios.map(({ decision: _d, ...sc }) => sc) };
  writeSummary(fresh.run, { headline, todo, changes, decision });
  const newHtml = renderReport(newResults, { runDir: fresh.run }).html;
  assert.equal(newHtml, oldHtml);
  // 그리고 칸이 실제로 나와 있다
  assert.match(newHtml, /<p class="headline">출결 앱을 다 만들었고 명세대로 됩니다\.<\/p>/);
  assert.match(newHtml, /<h2>할 일<\/h2><ul><li>빈 수업 화면 문구를 정해 주세요<\/li><\/ul>/);
  assert.match(newHtml, /<span class="tag">바꿈<\/span>결석 사유는 선생님만 봅니다/);
  assert.match(newHtml, /<p class="decision">그대로 둡니다\. 저장 버튼이 있어서요\.<\/p>/);
  assert.match(newHtml, /<details><summary>결정 기록 2개<\/summary>/);
  assert.match(newHtml, /<li>Ruling: 결석 사유는 선생님만 본다 &lt;기본&gt; — 명세에 없음 — 화면이 달라짐<\/li>/);
});

test('(g) the decision of a scenario comes by its id from summary.json, and results.json\'s own decision still shows when summary.json has none for it', () => {
  const { run } = project();
  const results = { ...RESULTS, spec: SPEC_PATH, rulings: undefined, scenarios: [
    scenario('A', 'fail', [{ action: '실행', shot: null, output: 'x', exitCode: 1 }]),
    { ...scenario('B', 'doubt', [{ action: '실행', shot: null, output: 'x', exitCode: 0 }]), decision: 'B의 옛 이유' },
    scenario('C', 'doubt', [{ action: '실행', shot: null, output: 'x', exitCode: 0 }]),
  ] };
  writeSummary(run, { decision: { A: 'A는 고친다', C: 'C는 그대로 둔다' } });
  const { html } = renderReport(results, { runDir: run });
  assert.match(html, /<p class="decision">A는 고친다<\/p>/);
  assert.match(html, /<p class="decision">B의 옛 이유<\/p>/);
  assert.match(html, /<p class="decision">C는 그대로 둔다<\/p>/);
  // summary.json이 같은 id를 가지고 있으면 그것이 이긴다
  writeSummary(run, { decision: { B: 'B의 새 이유' } });
  const again = renderReport(results, { runDir: run }).html;
  assert.match(again, /<p class="decision">B의 새 이유<\/p>/);
  assert.doesNotMatch(again, /B의 옛 이유/);
});

test('(g) field by field, summary.json first and results.json second: an old run with fields in results.json still shows them', () => {
  const { run } = project();
  const results = { ...FILLED, spec: SPEC_PATH };
  // summary.json이 없다: results.json의 칸이 그대로 나온다
  const noSummary = renderReport(results, { runDir: run }).html;
  assert.match(noSummary, /출결 앱을 다 만들었고/);
  assert.match(noSummary, /빈 수업 화면 문구를 정해 주세요/);
  assert.match(noSummary, /결석 사유는 선생님만 봅니다/);
  // headline만 summary.json에 있으면 headline만 바뀌고 todo·changes는 results.json 것이다
  writeSummary(run, { headline: '새 결론이다.' });
  const mixed = renderReport(results, { runDir: run }).html;
  assert.match(mixed, /<p class="headline">새 결론이다\.<\/p>/);
  assert.doesNotMatch(mixed, /출결 앱을 다 만들었고/);
  assert.match(mixed, /빈 수업 화면 문구를 정해 주세요/);
  assert.match(mixed, /결석 사유는 선생님만 봅니다/);
  // 빈 배열도 값이다: todo가 []이면 "없음"이고 results.json의 옛 todo는 쓰지 않는다
  writeSummary(run, { todo: [], changes: [] });
  const emptied = renderReport(results, { runDir: run }).html;
  assert.match(emptied, /<h2>할 일<\/h2><p>없음<\/p>/);
  assert.doesNotMatch(emptied, /빈 수업 화면 문구를 정해 주세요/);
  assert.doesNotMatch(emptied, /결석 사유는 선생님만 봅니다/);
  // 칸이 없는 결과에는 빈 상자도 없다
  rmSync(path.join(run, 'summary.json'));
  assert.doesNotMatch(renderReport({ ...RESULTS, spec: SPEC_PATH }, { runDir: run }).html, /<h2>할 일<\/h2>/);
});

test('(g) rulings are the Ruling lines of the spec\'s decision log; a spec with none falls back to results.json\'s rulings, and a spec that cannot be read does too', () => {
  const fromSpec = project({ log: '- Ruling: 명세에서 온 것 — 이유 — 잃는 것\n- 사용자가 말했다 (Ruling 줄이 아니다)\n  - Ruling: 들여쓴 것도 읽는다 — 이유 — 잃는 것\n\n정리하는 글\n' });
  const results = { ...RESULTS, spec: SPEC_PATH, rulings: ['Ruling: results.json의 옛 것 — 이유 — 잃는 것'] };
  const html = renderReport(results, { runDir: fromSpec.run }).html;
  assert.match(html, /<summary>결정 기록 2개<\/summary>/);
  assert.match(html, /<li>Ruling: 명세에서 온 것 — 이유 — 잃는 것<\/li>/);
  assert.match(html, /<li>Ruling: 들여쓴 것도 읽는다 — 이유 — 잃는 것<\/li>/);
  assert.doesNotMatch(html, /results\.json의 옛 것/);
  assert.doesNotMatch(html, /Ruling 줄이 아니다/);
  // 명세에 Ruling 줄이 없다
  const none = project();
  assert.match(renderReport(results, { runDir: none.run }).html, /<summary>결정 기록 1개<\/summary>[\s\S]*results\.json의 옛 것/);
  // 명세 경로가 틀렸거나 results.json에 spec이 없다
  const gone = renderReport({ ...results, spec: 'docs/pact/없음.md' }, { runDir: fromSpec.run }).html;
  assert.match(gone, /results\.json의 옛 것/);
  const noSpec = renderReport({ ...RESULTS, spec: undefined, rulings: undefined }, { runDir: fromSpec.run }).html;
  assert.match(noSpec, /<title>검수 보고서<\/title>/, 'results.json에 spec이 없으면 명세를 찾지 않는다');
  assert.doesNotMatch(noSpec, /결정 기록/);
  assert.doesNotMatch(renderReport({ ...RESULTS, spec: SPEC_PATH, rulings: undefined }, { runDir: none.run }).html, /결정 기록/);
});

test('(g) a summary.json that cannot be read or has the wrong shape does not break the page: the fields it could not give fall back to results.json', () => {
  const { run } = project();
  const results = { ...FILLED, spec: SPEC_PATH };
  for (const text of ['{ 깨짐', '[1]', 'null', JSON.stringify({ headline: 3, todo: '하나', changes: { a: 1 }, decision: ['S1'] })]) {
    writeFileSync(path.join(run, 'summary.json'), text);
    const { html } = renderReport(results, { runDir: run });
    assert.match(html, /출결 앱을 다 만들었고/, text);
    assert.match(html, /빈 수업 화면 문구를 정해 주세요/, text);
    assert.match(html, /그대로 둡니다\. 저장 버튼이 있어서요\./, text);
  }
  rmSync(path.join(run, 'summary.json'));
  mkdirSync(path.join(run, 'summary.json')); // 파일 자리에 폴더
  assert.match(renderReport(results, { runDir: run }).html, /출결 앱을 다 만들었고/);
});

test('(g) CLI: the report built from results.json, summary.json and the spec shows all three; the output lines are the same as before', () => {
  const { root, run } = project({ rulings: RULING_LINES });
  writeFileSync(path.join(run, 'results.json'), JSON.stringify({ ...RESULTS, spec: SPEC_PATH, rulings: undefined }));
  writeSummary(run, { headline: '요약 칸은 summary.json에서 왔다.', todo: ['할 일 하나'], changes: [], decision: {} });
  const r = spawnSync('node', [CLI, run], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['통과 2 · 실패 1 · 의심 0', path.join(run, 'report.html')]);
  const html = readFileSync(path.join(run, 'report.html'), 'utf8');
  assert.match(html, /요약 칸은 summary\.json에서 왔다\./);
  assert.match(html, /할 일 하나/);
  assert.match(html, /결정 기록 2개/);
  assert.match(html, /<title>출결 관리 검수 보고서<\/title>/);
  assert.ok(root);
});

// ---------- 승인 기록과 참고 줄과 확인 필요의 검수 항목이 보고서에 보인다(명세 R5, R8, R11, R12) ----------

const approvalSpec = ({ pact = 2, status = 'verifying', features = '', confirm = '' } = {}) => `---
pact: ${pact}
topic: 출결 관리
status: ${status}
---
# 출결 관리
## 기능
- F1 목록 [사용자]
${features}## 공통 규칙
- R1 화면 문구는 한국어 — 한국어 사용자라서 [AI 가정]
## 확인 필요
${confirm}## 결정 기록
`;
// 승인 기록 한 줄: 승인할 때의 명세 글에서 [사용자] 줄을 읽어 담는다
const entryFor = (text, over = {}) => ({
  version: 1, kind: 'approve', quote: '승인', message: '승인', message_uuid: 'u1', message_time: '2026-10-29T01:10:00.000Z', answer_question: null,
  transcript: '/t', session_id: 's', recorded_at: '2026-10-29T01:10:05.000Z', spec: SPEC_PATH, spec_checker_time: '2026-10-29T01:05:00.000Z', user_lines: userLinesOf(text), ...over,
});
// 명세(지금 글)와 승인 기록(앞에서부터)을 가진 판. checker가 있으면 spec-checker 기록도 남긴다.
function approvedProject({ spec, entries, checker }) {
  const root = mkdtempSync(path.join(tmpdir(), 'pact-report-approved-'));
  mkdirSync(path.join(root, 'docs', 'pact'), { recursive: true });
  writeFileSync(path.join(root, SPEC_PATH), spec);
  const run = path.join(root, '.pact', 'x');
  mkdirSync(run, { recursive: true });
  if (entries) writeFileSync(path.join(run, 'approvals.jsonl'), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  if (checker) appendRecord(run, { time: '2026-10-29T01:05:00.000Z', agent_type: 'pact:spec-checker', agent_id: 'a', task: null, message: checker });
  return { root, run };
}
const reportOf = (project, extra = {}) => renderReport({ ...RESULTS, spec: SPEC_PATH, rulings: undefined, ...extra }, { runDir: project.run }).html;

test('(g) the report shows each record: approval or delegation, the quoted words, the whole message and the times', () => {
  const spec = approvalSpec();
  const long = '이대로 만들어 주세요\n그리고 <b>굵게</b> 보이게는 하지 말고 "그대로" 두세요';
  const { run } = approvedProject({ spec, entries: [entryFor(spec, { quote: '이대로 만들어 주세요', message: long })] });
  const html = renderReport({ ...RESULTS, spec: SPEC_PATH, rulings: undefined }, { runDir: run }).html;
  assert.match(html, /<h2>승인 기록<\/h2>/);
  assert.match(html, /<strong>승인<\/strong> <span class="meta">기록 2026-10-29T01:10:05\.000Z · 메시지 2026-10-29T01:10:00\.000Z<\/span>/);
  assert.match(html, /<p class="quote">이대로 만들어 주세요<\/p>/);
  assert.match(html, /<details class="more"><summary>메시지 전문<\/summary><pre>이대로 만들어 주세요\n그리고 &lt;b&gt;굵게&lt;\/b&gt; 보이게는 하지 말고 &quot;그대로&quot; 두세요<\/pre><\/details>/);
  assert.doesNotMatch(html, /<b>굵게<\/b>/, '글은 걸러서 낸다');
  assert.doesNotMatch(html, /<strong>다시/, '기록이 하나면 다시 승인이 아니다');
  assert.doesNotMatch(html, /아직 다시 승인되지 않았습니다/);
  // 위임이면 위임이라고 한다. 질문 도구의 답이면 그 질문도 보인다
  const delegated = approvedProject({ spec, entries: [entryFor(spec, { kind: 'delegate', quote: '끝까지 알아서 해', message: '끝까지 알아서 해', answer_question: '승인까지 맡기시겠어요?', spec_checker_time: null })] });
  const dHtml = reportOf(delegated);
  assert.match(dHtml, /<strong>위임<\/strong>/);
  assert.match(dHtml, /<p class="quote">끝까지 알아서 해<\/p>/);
  assert.match(dHtml, /<p class="meta">질문 도구의 답: 승인까지 맡기시겠어요\?<\/p>/);
  assert.doesNotMatch(dHtml, /<strong>승인<\/strong>/);
  // 승인 기록 칸은 명세와 다른 것 뒤, 통과 앞에 있다
  assert.ok(html.indexOf('<h2>승인 기록</h2>') > html.indexOf('<h2>명세와 다른 것</h2>') && html.indexOf('<h2>승인 기록</h2>') < html.indexOf('<h2>통과</h2>'));
});

test('(g) a [사용자] line changed after an approval is shown with the words that approved it again: before and after, next to the quote', () => {
  const v1 = approvalSpec({ features: '- F2 출석은 시작 10분 뒤에 닫는다 [사용자]\n  - 케이스: 10분이 지남 → 닫힘 표시\n' });
  const v2 = v1.replace('시작 10분 뒤에', '시작 15분 뒤에');
  const v3 = v2.replace('- F1 목록 [사용자]\n', '');
  const entries = [
    entryFor(v1),
    entryFor(v2, { kind: 'delegate', quote: '출석은 15분 뒤에 닫는 걸로 바꿔 줘', message: '출석은 15분 뒤에 닫는 걸로 바꿔 줘', message_uuid: 'u2', message_time: '2026-10-29T02:00:00.000Z', recorded_at: '2026-10-29T02:00:03.000Z' }),
    entryFor(v3, { quote: '목록은 필요 없으니 빼 주세요', message: '목록은 필요 없으니 빼 주세요 <지금 바로>', message_uuid: 'u3', message_time: '2026-10-29T03:00:00.000Z', recorded_at: '2026-10-29T03:00:03.000Z' }),
  ];
  const { run } = approvedProject({ spec: v3, entries });
  const html = renderReport({ ...RESULTS, spec: SPEC_PATH, rulings: undefined }, { runDir: run }).html;
  const second = html.indexOf('<strong>다시 위임</strong>');
  const third = html.indexOf('<strong>다시 승인</strong>');
  assert.ok(second > 0 && third > second, '이력이 순서대로 나온다');
  const middle = html.slice(second, third);
  assert.match(middle, /앞 기록 뒤로 바뀐 \[사용자\] 줄 1개/);
  assert.match(middle, /<span class="tag">바뀜<\/span>F2 <del>출석은 시작 10분 뒤에 닫는다 \[사용자\] \/ 케이스: 10분이 지남 → 닫힘 표시<\/del> <ins>출석은 시작 15분 뒤에 닫는다 \[사용자\] \/ 케이스: 10분이 지남 → 닫힘 표시<\/ins>/);
  assert.match(middle, /<p class="quote">출석은 15분 뒤에 닫는 걸로 바꿔 줘<\/p>/, '다시 승인한 인용이 바뀐 줄 옆에 있다');
  const last = html.slice(third, html.indexOf('<h2>통과</h2>'));
  assert.match(last, /<span class="tag">빠짐<\/span>F1 <del>목록 \[사용자\]<\/del>/);
  assert.match(last, /<p class="quote">목록은 필요 없으니 빼 주세요<\/p>/);
  assert.match(last, /<pre>목록은 필요 없으니 빼 주세요 &lt;지금 바로&gt;<\/pre>/);
  assert.doesNotMatch(html, /아직 다시 승인되지 않았습니다/, '지금 명세는 가장 최근 기록과 같다');
  // 더해진 줄과 태그만 바뀐 줄
  const v4 = `${v1}`.replace('- F1 목록 [사용자]\n', '- F1 목록 [사용자]\n- F9 새 기능 [사용자]\n');
  const added = approvedProject({ spec: v4, entries: [entryFor(v1), entryFor(v4, { message_time: '2026-10-29T02:00:00.000Z', message_uuid: 'u2' })] });
  assert.match(reportOf(added), /<span class="tag">더해짐<\/span>F9 <ins>새 기능 \[사용자\]<\/ins>/);
  // 앞 기록에 줄이 없으면 견줄 수 없다고 적는다
  const bare = approvedProject({ spec: v1, entries: [{ ...entryFor(v1), user_lines: undefined }, entryFor(v1, { message_time: '2026-10-29T02:00:00.000Z', message_uuid: 'u2' })] });
  assert.match(reportOf(bare), /앞 기록에 \[사용자\] 줄이 없어 무엇이 바뀌었는지 견주지 못했습니다/);
});

test('(g) everything the person wrote that the page shows is escaped: the quote, the message, the lines before and after a change, the question and the reason', () => {
  const v1 = approvalSpec({ features: '- F2 <script>alert(1)</script> 보기 [사용자]\n', confirm: '- 검수 2: <i>묻지 않았다</i> & 그대로 둔다\n' });
  const v2 = v1.replace('<script>alert(1)</script>', '<img src=x onerror=alert(2)>');
  const entries = [
    entryFor(v1, { quote: '<b>승인</b>', message: '<b>승인</b> & "그대로" 만들어 주세요', answer_question: '<u>승인할까요?</u>' }),
    entryFor(v2, { message_time: '2026-10-29T02:00:00.000Z', message_uuid: 'u2', quote: '<s>바꿔 주세요</s>', message: '<s>바꿔 주세요</s>' }),
  ];
  const { run } = approvedProject({ spec: v2, entries, checker: '## 사용자만 답할 수 있음\n검수 2. <em>질문</em>인가요? (기본안: 예)\n\n질문 라운드는 이것 한 번뿐입니다.' });
  const html = reportOf({ run });
  for (const raw of ['<b>승인</b>', '<s>바꿔 주세요</s>', '<u>승인할까요?</u>', '<script>alert(1)</script>', '<img src=x onerror=alert(2)>', '<i>묻지 않았다</i>', '<em>질문</em>']) {
    assert.ok(!html.includes(raw), `${raw}가 걸러지지 않았다`);
  }
  assert.match(html, /<p class="quote">&lt;b&gt;승인&lt;\/b&gt;<\/p>/);
  assert.match(html, /<pre>&lt;b&gt;승인&lt;\/b&gt; &amp; &quot;그대로&quot; 만들어 주세요<\/pre>/);
  assert.match(html, /질문 도구의 답: &lt;u&gt;승인할까요\?&lt;\/u&gt;/);
  assert.match(html, /<del>&lt;script&gt;alert\(1\)&lt;\/script&gt; 보기 \[사용자\]<\/del> <ins>&lt;img src=x onerror=alert\(2\)&gt; 보기 \[사용자\]<\/ins>/);
  assert.match(html, /<li>검수 2: &lt;i&gt;묻지 않았다&lt;\/i&gt; &amp; 그대로 둔다 \(질문: &lt;em&gt;질문&lt;\/em&gt;인가요\?\)<\/li>/);
});

test('(g) a [사용자] line that changed and has not been approved again is warned about at the top and listed in the records; an [AI 가정] change is not', () => {
  const v1 = approvalSpec();
  const entries = [entryFor(v1)];
  const changed = approvedProject({ spec: v1.replace('- F1 목록 [사용자]', '- F1 목록과 검색 [사용자]'), entries });
  const html = reportOf(changed);
  const top = html.slice(html.indexOf('<section class="top">'), html.indexOf('</section>'));
  assert.match(top, /<p class="missing">승인 뒤 바뀐 \[사용자\] 줄이 아직 다시 승인되지 않았습니다\. 아래 승인 기록에 있습니다\.<\/p>/);
  const records = html.slice(html.indexOf('<h2>승인 기록</h2>'));
  assert.match(records, /<p class="missing">승인 뒤 바뀐 \[사용자\] 줄이 아직 다시 승인되지 않았습니다\.<\/p><ul class="changes"><li><span class="tag">바뀜<\/span>F1 <del>목록 \[사용자\]<\/del> <ins>목록과 검색 \[사용자\]<\/ins>/);
  // [AI 가정]만 바뀐 것은 알리지 않는다
  const ai = approvedProject({ spec: v1.replace('화면 문구는 한국어', '화면 문구는 영어'), entries });
  assert.doesNotMatch(reportOf(ai), /아직 다시 승인되지 않았습니다/);
  // 줄이 없는 옛 기록은 견줄 수 없다고 알린다: 바뀐 줄이 승인되지 않았다는 말과 다르다
  const unknown = approvedProject({ spec: v1, entries: [{ ...entryFor(v1), user_lines: undefined }] });
  const uHtml = reportOf(unknown);
  assert.match(uHtml, /가장 최근 기록에 \[사용자\] 줄이 없어 승인 뒤 바뀐 줄이 있는지 확인하지 못했습니다/);
  const uTop = uHtml.slice(uHtml.indexOf('<section class="top">'), uHtml.indexOf('</section>'));
  assert.match(uTop, /<p class="missing">가장 최근 승인 기록에 \[사용자\] 줄이 없어 승인 뒤 바뀐 줄이 있는지 확인하지 못했습니다\. 아래 승인 기록에 있습니다\.<\/p>/);
  assert.doesNotMatch(uTop, /아직 다시 승인되지 않았습니다/, '견줄 수 없는 것과 바뀐 줄이 승인되지 않은 것은 다른 말이다');
  assert.doesNotMatch(uHtml, /아직 다시 승인되지 않았습니다/);
  // 바뀐 줄이 있을 때의 맨 위 문구는 그대로다
  const changedTop = html.slice(html.indexOf('<section class="top">'), html.indexOf('</section>'));
  assert.doesNotMatch(changedTop, /확인하지 못했습니다/);
});

test('(g) a change to the [사용자] case line of an [AI 가정] item is shown as that item\'s [사용자] line, before and after, and the AI head line is not mentioned', () => {
  const v1 = approvalSpec({ features: '- F3 결석 사유 보기 — 기본은 선생님만 [AI 가정]\n  - 케이스: 학생이 봄 → 안 보임 [사용자: 검수 2]\n' });
  const v2 = v1.replace('→ 안 보임', '→ 이름만 보임').replace('기본은 선생님만', '기본은 담임만');
  const entries = [
    entryFor(v1),
    entryFor(v2, { quote: '학생에게는 이름만 보이게 바꿔 주세요', message: '학생에게는 이름만 보이게 바꿔 주세요', message_uuid: 'u2', message_time: '2026-10-29T02:00:00.000Z' }),
  ];
  const { run } = approvedProject({ spec: v2, entries });
  const html = reportOf({ run });
  const second = html.slice(html.indexOf('<strong>다시 승인</strong>'), html.indexOf('<h2>통과</h2>'));
  assert.match(second, /<span class="tag">바뀜<\/span>F3의 \[사용자\] 줄 <del>케이스: 학생이 봄 → 안 보임 \[사용자: 검수 2\]<\/del> <ins>케이스: 학생이 봄 → 이름만 보임 \[사용자: 검수 2\]<\/ins>/);
  assert.match(second, /<p class="quote">학생에게는 이름만 보이게 바꿔 주세요<\/p>/, '다시 승인한 인용이 바뀐 줄 옆에 있다');
  assert.ok(!/기본은 (선생님|담임)만/.test(second), '[AI 가정] 머리 줄의 글은 바뀐 줄에 나오지 않는다');
  assert.doesNotMatch(html, /아직 다시 승인되지 않았습니다/);
  // 아직 다시 승인하지 않았으면 맨 위에서도 알린다
  const pending = approvedProject({ spec: v2, entries: [entries[0]] });
  const pHtml = reportOf(pending);
  assert.match(pHtml.slice(pHtml.indexOf('<section class="top">'), pHtml.indexOf('</section>')), /승인 뒤 바뀐 \[사용자\] 줄이 아직 다시 승인되지 않았습니다/);
  assert.match(pHtml, /<span class="tag">바뀜<\/span>F3의 \[사용자\] 줄 <del>/);
  // 줄이 빠지거나 더해진 것도 케이스 줄로 알린다
  const gone = approvedProject({ spec: v1.replace('  - 케이스: 학생이 봄 → 안 보임 [사용자: 검수 2]\n', ''), entries: [entries[0]] });
  assert.match(reportOf(gone), /<span class="tag">빠짐<\/span>F3의 \[사용자\] 줄 <del>케이스: 학생이 봄 → 안 보임 \[사용자: 검수 2\]<\/del>/);
  const added = approvedProject({ spec: v1, entries: [entryFor(v1.replace('  - 케이스: 학생이 봄 → 안 보임 [사용자: 검수 2]\n', ''))] });
  assert.match(reportOf(added), /<span class="tag">더해짐<\/span>F3의 \[사용자\] 줄 <ins>케이스: 학생이 봄 → 안 보임 \[사용자: 검수 2\]<\/ins>/);
});

test('(g) an old spec says "옛 판이라 승인 기록 없음"; a new spec with no record, an unreadable record and no spec at all each say what they can', () => {
  const old = approvedProject({ spec: approvalSpec({ pact: 1, status: 'verifying' }) });
  assert.match(reportOf(old), /<h2>승인 기록<\/h2>\n<p class="missing">옛 판이라 승인 기록 없음<\/p>/);
  // 옛 명세라도 draft였던 것은 옛 판이 아니다
  assert.match(reportOf(approvedProject({ spec: approvalSpec({ pact: 1, status: 'draft' }) })), /<p class="missing">승인 기록이 없습니다\.<\/p>/);
  assert.match(reportOf(approvedProject({ spec: approvalSpec() })), /<p class="missing">승인 기록이 없습니다\.<\/p>/);
  // 기록 자리가 폴더라 못 읽는다: 보고서는 그래도 만들어진다
  const broken = approvedProject({ spec: approvalSpec() });
  mkdirSync(path.join(broken.run, 'approvals.jsonl'));
  assert.match(reportOf(broken), /<p class="missing">승인 기록을 읽지 못했습니다\(EISDIR\)\.<\/p>/);
  // 명세도 기록도 없으면 말할 것이 없다: 칸도 없다
  const { html } = renderReport(RESULTS, { runDir: tmp() });
  assert.doesNotMatch(html, /승인 기록/);
  // 명세를 못 읽어도 기록이 있으면 기록은 보인다(바뀐 줄은 모른다)
  const lost = approvedProject({ spec: approvalSpec(), entries: [entryFor(approvalSpec())] });
  const lostHtml = renderReport({ ...RESULTS, spec: 'docs/pact/없음.md', rulings: undefined }, { runDir: lost.run }).html;
  assert.match(lostHtml, /<strong>승인<\/strong>/);
  assert.doesNotMatch(lostHtml, /아직 다시 승인되지 않았습니다/);
});

test('(g) an old spec (pact: 1, no record) says so in the box at the top whatever the summary says; a new spec never does', () => {
  const LEGACY = '<p class="missing">옛 판이라 승인 기록 없음</p>';
  const topOf = (html) => html.slice(html.indexOf('<section class="top">'), html.indexOf('</section>'));
  const count = (html, text) => html.split(text).length - 1;
  const old = approvedProject({ spec: approvalSpec({ pact: 1, status: 'verifying' }) });
  // summary.json이 없어도 맨 위 상자에 있다. 승인 기록 칸에도 그대로 있다(두 군데)
  const bare = reportOf(old);
  assert.equal(count(topOf(bare), LEGACY), 1);
  assert.equal(count(bare, LEGACY), 2);
  assert.ok(bare.indexOf(LEGACY) < bare.indexOf('<h2>실패·의심'), '맨 위 상자의 줄이 먼저다');
  // 메인이 headline·todo를 어떻게 썼든 스크립트가 붙인다: 결론이 옛 판을 말하지 않아도, 결론이 한껏 좋아도 있다
  writeSummary(old.run, { headline: '출결 앱을 다 만들었고 명세대로 됩니다.', todo: ['빈 수업 화면 문구를 정해 주세요'], changes: [] });
  const filled = reportOf(old);
  const top = topOf(filled);
  assert.equal(count(top, LEGACY), 1);
  assert.ok(top.includes('<p class="headline">출결 앱을 다 만들었고 명세대로 됩니다.</p>'), '결론도 그대로 있다');
  assert.ok(top.indexOf(LEGACY) < top.indexOf('<p class="headline">'), '결론 위에 있다');
  writeSummary(old.run, { headline: '옛 판이라는 말은 한마디도 없는 결론', todo: [] });
  assert.equal(count(topOf(reportOf(old)), LEGACY), 1);
  // 새 판에는 없다: 기록이 있는 새 명세, 기록이 없는 새 명세, 옛 명세라도 draft였던 것, 그 뒤에 승인 기록이 생긴 옛 명세
  const fresh = approvalSpec();
  const olds = approvalSpec({ pact: 1, status: 'verifying' });
  const without = [
    ['기록이 있는 새 명세', approvedProject({ spec: fresh, entries: [entryFor(fresh)] })],
    ['기록이 없는 새 명세', approvedProject({ spec: fresh })],
    ['draft였던 옛 명세', approvedProject({ spec: approvalSpec({ pact: 1, status: 'draft' }) })],
    ['승인 기록이 생긴 옛 명세', approvedProject({ spec: olds, entries: [entryFor(olds)] })],
  ];
  const broken = approvedProject({ spec: fresh });
  mkdirSync(path.join(broken.run, 'approvals.jsonl')); // 기록을 읽지 못한 판
  without.push(['승인 기록을 못 읽은 판', broken]);
  for (const [label, project] of without) {
    writeSummary(project.run, { headline: '결론이다', todo: [] });
    const html = reportOf(project);
    assert.ok(!html.includes('옛 판이라'), `${label}: 옛 판이라는 말이 어디에도 없다`);
  }
  // 명세도 기록도 없는 판은 말할 것이 없다
  assert.ok(!renderReport(RESULTS, { runDir: tmp() }).html.includes('옛 판이라'));
  // 명령줄(report.mjs)로 만든 보고서도 같다
  writeFileSync(path.join(old.run, 'results.json'), JSON.stringify({ ...RESULTS, spec: SPEC_PATH, rulings: undefined }));
  const r = spawnSync('node', [CLI, old.run], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(topOf(readFileSync(path.join(old.run, 'report.html'), 'utf8')), LEGACY), 1);
});

test('(g) the 참고 lines of the completion check (notes) are in the report, escaped', () => {
  const { run } = approvedProject({ spec: approvalSpec(), entries: [entryFor(approvalSpec())] });
  const notes = ['참고: 옛 판이고 verifier 기록이 없어 results.json이 verifier가 쓴 그대로인지는 확인하지 않았다', '참고: <b>둘째</b> 줄'];
  const { html } = renderReport({ ...RESULTS, spec: SPEC_PATH, rulings: undefined }, { runDir: run, notes });
  const top = html.slice(html.indexOf('<section class="top">'), html.indexOf('</section>'));
  assert.match(top, /<p class="meta">참고: 옛 판이고 verifier 기록이 없어 results\.json이 verifier가 쓴 그대로인지는 확인하지 않았다<\/p>/);
  assert.match(top, /<p class="meta">참고: &lt;b&gt;둘째&lt;\/b&gt; 줄<\/p>/);
  assert.doesNotMatch(html, /<b>둘째<\/b>/);
  assert.ok(top.indexOf('시나리오 3개') < top.indexOf('참고: 옛 판'), '개수 줄 아래에 있다');
  assert.doesNotMatch(renderReport(RESULTS, { runDir: tmp() }).html, /class="meta">참고/, '참고 줄이 없으면 칸도 없다');
});

test('(g) the 검수 items in ## 확인 필요 go to the 할 일 list by themselves, with the checker\'s question, and are not repeated when the summary already names them', () => {
  const spec = approvalSpec({ confirm: '- 검수 2: 위임이라 기본안으로 정함\n- 검수 3: 사용자가 바빠서 묻지 못함\n- 검수 4: 질문 글이 없는 번호\n' });
  const checker = ['## 사용자만 답할 수 있음', '검수 2. 결석 사유를 학생도 볼 수 있나요? (기본안: 선생님만) — 화면이 달라진다', '검수 3. ' + '길'.repeat(80) + ' (기본안: 하나)', '', '질문 라운드는 이것 한 번뿐입니다.'].join('\n');
  const { run } = approvedProject({ spec, entries: [entryFor(spec)], checker });
  // summary.json이 없어도 할 일 칸이 생긴다
  const html = reportOf({ run });
  assert.match(html, /<h2>할 일<\/h2><ul><li>검수 2: 위임이라 기본안으로 정함 \(질문: 결석 사유를 학생도 볼 수 있나요\?\)<\/li><li>검수 3: 사용자가 바빠서 묻지 못함 \(질문: 길{60}…\)<\/li><li>검수 4: 질문 글이 없는 번호<\/li><\/ul>/);
  // 메인이 쓴 할 일 뒤에 붙는다. 이미 번호를 적은 것은 되풀이하지 않는다
  writeSummary(run, { todo: ['빈 수업 화면 문구를 정해 주세요', '검수 3은 다음에 꼭 묻는다'] });
  const merged = reportOf({ run });
  assert.match(merged, /<ul><li>빈 수업 화면 문구를 정해 주세요<\/li><li>검수 3은 다음에 꼭 묻는다<\/li><li>검수 2: 위임이라/);
  assert.equal(merged.split('검수 3').length - 1, 1, '검수 3은 한 번만 나온다');
  assert.match(merged, /<li>검수 4: 질문 글이 없는 번호<\/li>/);
  // 메인의 todo가 빈 배열이어도 검수 항목은 올라온다
  writeSummary(run, { todo: [] });
  assert.match(reportOf({ run }), /<h2>할 일<\/h2><ul><li>검수 2:/);
  // 번호가 10 이상이어도 번호가 겹치지 않게 본다: 검수 12를 적었다고 검수 1이 적힌 것이 아니다
  const ten = approvedProject({ spec: approvalSpec({ confirm: '- 검수 1: 묻지 못함\n' }), entries: [] });
  writeSummary(ten.run, { todo: ['검수 12는 나중에'] });
  assert.match(reportOf(ten), /<li>검수 1: 묻지 못함<\/li>/);
  // 항목이 없으면 달라지는 것이 없다: todo가 []이면 "없음", 칸이 없으면 칸도 없다
  const plain = approvedProject({ spec: approvalSpec(), entries: [entryFor(approvalSpec())] });
  assert.doesNotMatch(reportOf(plain), /<h2>할 일<\/h2>/);
  writeSummary(plain.run, { todo: [] });
  assert.match(reportOf(plain), /<h2>할 일<\/h2><p>없음<\/p>/);
});

test('(g) CLI: the report written next to results.json shows the approval records, and the 참고 lines the completion check prints are in the page too', () => {
  const spec = approvalSpec({ confirm: '- 검수 2: 위임이라 기본안으로 정함\n' });
  const { run } = approvedProject({ spec, entries: [entryFor(spec, { kind: 'delegate', quote: '끝까지 알아서 해', message: '끝까지 알아서 해', spec_checker_time: null })] });
  writeFileSync(path.join(run, 'results.json'), JSON.stringify({ ...RESULTS, spec: SPEC_PATH, rulings: undefined }));
  const r = spawnSync('node', [CLI, run], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // 검수 기록(verification.json)이 없으면 완료 검사 줄도 없다: 출력은 전과 같다(요약 줄과 보고서 경로)
  const out = r.stdout.trim().split('\n');
  assert.equal(out.length, 2, r.stdout);
  assert.match(out[0], /^통과 \d+ · 실패 1 · 의심 0/);
  assert.equal(out[1], path.join(run, 'report.html'));
  const html = readFileSync(path.join(run, 'report.html'), 'utf8');
  assert.match(html, /<strong>위임<\/strong>/);
  assert.match(html, /<p class="quote">끝까지 알아서 해<\/p>/);
  assert.match(html, /<li>검수 2: 위임이라 기본안으로 정함<\/li>/);
});
