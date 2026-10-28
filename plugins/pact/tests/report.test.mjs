import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderReport } from '../scripts/report.mjs';

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
