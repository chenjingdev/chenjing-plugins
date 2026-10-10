#!/usr/bin/env node
// verify 단계의 검수 보고서. 사용자가 먼저 봐야 할 것(실패·의심)을 위에, 통과는 접어서 아래에 둔다.
// 모든 시나리오는 단계마다 스크린샷(또는 명령 출력)을 남기므로, 빠진 스크린샷은 숨기지 않고 표시한다.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LABEL = { pass: '통과', fail: '실패', doubt: '의심' };
const KIND = { spec: '명세', case: '케이스', newcomer: '처음 쓰는 사람' };
const resultOf = (s) => (s.result === 'pass' || s.result === 'fail' ? s.result : 'doubt');

function renderStep(step, runDir) {
  const parts = [`<li><p>${esc(step.action)}</p>`];
  if (step.shot) {
    parts.push(
      existsSync(path.resolve(runDir, step.shot))
        ? `<img src="${esc(step.shot)}" alt="${esc(step.action)}" loading="lazy">`
        : `<p class="missing">스크린샷 없음 (${esc(step.shot)})</p>`,
    );
  } else if (step.output == null) {
    parts.push('<p class="missing">스크린샷 없음</p>');
  }
  if (step.output != null) parts.push(`<pre>${esc(step.output)}</pre>`);
  parts.push('</li>');
  return parts.join('');
}

function renderScenario(s, runDir) {
  const r = resultOf(s);
  const items = (s.items ?? []).length ? ` · ${esc(s.items.join(', '))}` : '';
  return `<article class="sc ${r}">
<h3><span class="badge">${LABEL[r]}</span> ${esc(s.id)} ${esc(s.title)}</h3>
<p class="meta">${esc(KIND[s.kind] ?? s.kind)}${items}</p>
${s.note ? `<p>${esc(s.note)}</p>` : ''}
<ol>${(s.steps ?? []).map((st) => renderStep(st, runDir)).join('\n')}</ol>
</article>`;
}

const list = (xs) => ((xs ?? []).length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>없음</p>');

export function renderReport(results, { runDir }) {
  const scenarios = results?.scenarios ?? [];
  const count = { pass: 0, fail: 0, doubt: 0 };
  for (const s of scenarios) count[resultOf(s)]++;
  const summary = `통과 ${count.pass} · 실패 ${count.fail} · 의심 ${count.doubt}`;
  const problems = scenarios.filter((s) => resultOf(s) !== 'pass');
  const passed = scenarios.filter((s) => resultOf(s) === 'pass');
  const check = results?.specCheck ?? {};
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>검수 보고서</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 960px; margin: 24px auto; padding: 0 16px; color: #222; background: #fff; }
  .summary { font-size: 20px; font-weight: 600; }
  .sc { border: 1px solid #ddd; border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
  .sc.fail { border-color: #d33; } .sc.doubt { border-color: #d90; }
  .badge { font-size: 13px; padding: 2px 8px; border-radius: 10px; background: #eee; }
  .fail .badge { background: #fdd; } .doubt .badge { background: #fec; } .pass .badge { background: #dfd; }
  .meta { color: #666; font-size: 13px; margin: 0; }
  img { max-width: 100%; border: 1px solid #ccc; border-radius: 4px; }
  pre { background: #f5f5f5; padding: 8px; overflow-x: auto; }
  .missing { color: #a15c00; }
</style></head><body>
<h1>검수 보고서</h1>
<p>명세: ${esc(results?.spec)}</p>
<p class="summary">${summary}</p>
<h2>실패·의심</h2>
${problems.length ? problems.map((s) => renderScenario(s, runDir)).join('\n') : '<p>없음</p>'}
<h2>명세 대조</h2>
<h3>빠진 것</h3>${list(check.missing)}
<h3>명세에 없는데 더한 것</h3>${list(check.extra)}
<h3>다르게 이해한 것</h3>${list(check.misunderstood)}
<h2>결정 기록</h2>
${list(results?.rulings)}
<h2>통과</h2>
${passed.length ? `<details><summary>통과한 시나리오 ${passed.length}개 펼치기</summary>\n${passed.map((s) => renderScenario(s, runDir)).join('\n')}\n</details>` : '<p>없음</p>'}
</body></html>
`;
  return { html, summary };
}

function main([runDir]) {
  if (!runDir) {
    console.error('사용법: report.mjs <run-dir>   (<run-dir>/results.json을 읽어 report.html을 만듦)');
    return 2;
  }
  const results = JSON.parse(readFileSync(path.join(runDir, 'results.json'), 'utf8'));
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
