#!/usr/bin/env node
// verify 단계의 검수 보고서. 명세를 승인한 사람이 맨 위만 읽고 끝낼 수 있게 결론·할 일·실패와 의심·명세와 다른 것을 위에 두고,
// 근거(단계별 출력, 작업 기록, 통과한 시나리오, 결정 기록)는 접어 둔다.
// 모든 시나리오는 단계마다 스크린샷(또는 명령 출력)을 남기므로, 빠진 스크린샷은 숨기지 않고 센다.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSpec } from './spec.mjs';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LABEL = { pass: '통과', fail: '실패', doubt: '의심' };
const KIND = { spec: '명세', case: '케이스', newcomer: '처음 쓰는 사람' };
const resultOf = (s) => (s.result === 'pass' || s.result === 'fail' ? s.result : 'doubt');
const list = (xs) => ((xs ?? []).length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>없음</p>');

const shotExists = (step, runDir) => Boolean(step.shot) && existsSync(path.resolve(runDir, step.shot));
// 증거가 없는 단계: 스크린샷을 적었는데 파일이 없거나, 스크린샷도 명령 출력도 없다.
const shotMissing = (step, runDir) => (step.shot ? !shotExists(step, runDir) : step.output == null);

// 스크린샷은 단계 번호와 동작을 붙여 격자로 보이고, 누르면 원본 크기로 열린다.
function renderShots(steps, runDir) {
  const figures = steps
    .map((step, i) => ({ step, i }))
    .filter(({ step }) => shotExists(step, runDir))
    .map(
      ({ step, i }) =>
        `<figure><a href="${esc(step.shot)}" target="_blank"><img src="${esc(step.shot)}" alt="${esc(step.action)}" loading="lazy"></a><figcaption>${i + 1}. ${esc(step.action)}</figcaption></figure>`,
    );
  return figures.length ? `<div class="shots">${figures.join('')}</div>` : '';
}

function renderStep(step, runDir) {
  const parts = [`<li><p>${esc(step.action)}</p>`];
  if (shotMissing(step, runDir)) parts.push(`<p class="missing">스크린샷 없음${step.shot ? ` (${esc(step.shot)})` : ''}</p>`);
  if (step.output != null) parts.push(`<pre>${esc(step.output)}</pre>`);
  parts.push('</li>');
  return parts.join('');
}

// 사람이 읽는 요약(summary)과 결정(decision), 스크린샷을 먼저 보이고 작업 기록(note)과 단계별 출력은 "자세히"에 접는다.
// summary가 없는 옛 결과는 note를 요약 자리에 둔다.
function scenarioBody(s, runDir) {
  const steps = s.steps ?? [];
  const lead = s.summary ?? s.note;
  const missing = steps.filter((st) => shotMissing(st, runDir)).length;
  const meta = [KIND[s.kind] ?? s.kind, s.id, ...(s.items ?? [])].filter(Boolean).join(' · ');
  return [
    lead ? `<p>${esc(lead)}</p>` : '',
    s.decision ? `<p class="decision">${esc(s.decision)}</p>` : '',
    missing ? `<p class="missing">스크린샷 없는 단계 ${missing}개</p>` : '',
    renderShots(steps, runDir),
    '<details class="more"><summary>자세히</summary>',
    `<p class="meta">${esc(meta)}</p>`,
    s.summary && s.note ? `<p>${esc(s.note)}</p>` : '',
    steps.length ? `<ol>${steps.map((st) => renderStep(st, runDir)).join('\n')}</ol>` : '',
    '</details>',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderProblem(s, runDir) {
  const r = resultOf(s);
  return `<article class="sc ${r}">
<h3><span class="badge">${LABEL[r]}</span> ${esc(s.title)}</h3>
${scenarioBody(s, runDir)}
</article>`;
}

function renderPassed(s, runDir) {
  return `<details class="sc pass"><summary>${esc(s.title)}</summary>
${scenarioBody(s, runDir)}
</details>`;
}

// 제목에 쓸 주제. run-dir은 <프로젝트>/.pact/<slug>이고 results.spec은 프로젝트 기준 경로다.
function topicOf(spec, runDir) {
  if (!spec) return null;
  try {
    return parseSpec(readFileSync(path.resolve(runDir, '..', '..', spec), 'utf8')).frontmatter.topic || null;
  } catch {
    return null;
  }
}

export function renderReport(results, { runDir }) {
  const scenarios = results?.scenarios ?? [];
  const count = { pass: 0, fail: 0, doubt: 0 };
  for (const s of scenarios) count[resultOf(s)]++;
  const summary = `통과 ${count.pass} · 실패 ${count.fail} · 의심 ${count.doubt}`;
  const rank = (s) => (resultOf(s) === 'fail' ? 0 : 1);
  const problems = scenarios.filter((s) => resultOf(s) !== 'pass').sort((a, b) => rank(a) - rank(b));
  const passed = scenarios.filter((s) => resultOf(s) === 'pass');
  const check = results?.specCheck ?? {};
  const diffs = [
    ...(results?.changes ?? []).map((x) => ['바꿈', x]),
    ...(check.missing ?? []).map((x) => ['빠짐', x]),
    ...(check.extra ?? []).map((x) => ['더함', x]),
    ...(check.misunderstood ?? []).map((x) => ['다르게 동작', x]),
  ];
  const rulings = results?.rulings ?? [];
  const topic = topicOf(results?.spec, runDir);
  const title = topic ? `${topic} 검수 보고서` : '검수 보고서';
  const todo = results?.todo;
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 960px; margin: 24px auto; padding: 0 16px; color: #222; background: #fff; }
  h1 { font-size: 24px; margin: 0 0 12px; }
  h2 { font-size: 18px; margin: 28px 0 8px; }
  .top { background: #f6f6f3; border-radius: 10px; padding: 14px 18px; }
  .top h2 { font-size: 15px; margin: 12px 0 2px; }
  .top ul { margin: 0; }
  .headline { font-size: 18px; font-weight: 600; margin: 0; }
  .counts { color: #555; margin: 10px 0 0; }
  .sc { border: 1px solid #ddd; border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
  .sc.fail { border-color: #d33; } .sc.doubt { border-color: #d90; }
  details.sc { padding: 8px 14px; margin: 6px 0; }
  .sc h3 { font-size: 16px; margin: 0 0 6px; }
  .badge { font-size: 13px; font-weight: normal; padding: 2px 8px; border-radius: 10px; background: #eee; }
  .fail .badge { background: #fdd; } .doubt .badge { background: #fec; }
  .decision { background: #f1f5fb; border-left: 3px solid #69c; padding: 6px 10px; }
  .shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; margin: 10px 0; }
  figure { margin: 0; }
  figcaption { font-size: 13px; color: #555; margin-top: 4px; }
  img { width: 100%; border: 1px solid #ccc; border-radius: 4px; }
  summary { cursor: pointer; }
  .more > summary { color: #666; font-size: 14px; }
  .meta { color: #666; font-size: 13px; margin: 6px 0 0; }
  pre { background: #f5f5f5; padding: 8px; white-space: pre-wrap; word-break: break-all; }
  .missing { color: #a15c00; }
  .tag { font-size: 12px; padding: 1px 6px; border-radius: 6px; background: #eee; margin-right: 4px; }
</style></head><body>
<h1>${esc(title)}</h1>
<section class="top">
${results?.headline ? `<p class="headline">${esc(results.headline)}</p>` : ''}
${Array.isArray(todo) ? `<h2>할 일</h2>${list(todo)}` : ''}
<p class="counts">시나리오 ${scenarios.length}개 · ${summary}</p>
</section>
<h2>실패·의심</h2>
${problems.length ? problems.map((s) => renderProblem(s, runDir)).join('\n') : '<p>없음</p>'}
<h2>명세와 다른 것</h2>
${diffs.length ? `<ul>${diffs.map(([k, x]) => `<li><span class="tag">${k}</span>${esc(x)}</li>`).join('')}</ul>` : '<p>없음</p>'}
<h2>통과</h2>
${passed.length ? `<details><summary>통과한 시나리오 ${passed.length}개</summary>\n${passed.map((s) => renderPassed(s, runDir)).join('\n')}\n</details>` : '<p>없음</p>'}
${rulings.length ? `<h2>만들면서 정한 것</h2>\n<details><summary>결정 기록 ${rulings.length}개</summary><p class="meta">명세: ${esc(results?.spec)}</p>${list(rulings)}</details>` : ''}
</body></html>
`;
  return { html, summary };
}

function main([runDir]) {
  if (!runDir) {
    console.error('사용법: report.mjs <run-dir>   (<run-dir>/results.json을 읽어 report.html을 만듦)');
    return 2;
  }
  const file = path.join(runDir, 'results.json');
  if (!existsSync(file)) {
    console.error(`results.json이 없습니다: ${file} — verifier가 결과를 쓰지 않았습니다`);
    return 1;
  }
  let results;
  try {
    results = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`results.json을 읽지 못했습니다: ${err.message}`);
    return 1;
  }
  const { html, summary } = renderReport(results, { runDir });
  const out = path.join(runDir, 'report.html');
  writeFileSync(out, html);
  console.log(summary);
  console.log(out);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
