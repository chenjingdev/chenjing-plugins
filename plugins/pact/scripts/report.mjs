#!/usr/bin/env node
// verify 단계의 검수 보고서. 명세를 승인한 사람이 맨 위만 읽고 끝낼 수 있게 결론·할 일·실패와 의심·명세와 다른 것을 위에 두고,
// 근거(단계별 출력, 작업 기록, 통과한 시나리오, 결정 기록)는 접어 둔다.
// 승인 기록(승인인지 위임인지, 인용한 말과 메시지, 승인 뒤 바뀐 [사용자] 줄과 다시 승인한 인용, 옛 판 표시)과 완료 검사의 참고 줄도 보인다(명세 R5, R8, R12).
// 명세 `## 확인 필요`의 `- 검수 n: 안 물은 까닭`은 할 일 칸에 저절로 올라간다(R11).
// 모든 시나리오는 단계마다 스크린샷(또는 명령 출력)을 남기므로, 빠진 스크린샷은 숨기지 않고 센다.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { decisionRulings, parseSpec } from './spec.mjs';
import { effectiveResult } from './evidence.mjs';
import { checkVerification } from './verification.mjs';
import { isMainModule } from './paths.mjs';
import { decisionOf, readSummary, reportFields } from './summary.mjs';
import { approvalOverview, changeLabel, isLineKey, notAskedItems, plainLines } from './approval.mjs';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LABEL = { pass: '통과', fail: '실패', doubt: '의심', unverified: '미검증' };
const KIND = { spec: '명세', case: '케이스', newcomer: '처음 쓰는 사람' };
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
  const meta = [KIND[s.kind] ?? s.kind, s.id, ...(s.items ?? []), s.carried ? '앞 판에서 확인' : null].filter(Boolean).join(' · ');
  return [
    lead ? `<p>${esc(lead)}</p>` : '',
    s.result === 'unverified' ? '<p class="missing">확인할 화면이나 실행 기록이 충분하지 않아 미검증으로 남겼습니다.</p>' : '',
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
  const r = s.result;
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

// 승인 기록 칸(명세 R5, R8, R12). 기록마다 종류(승인·위임)와 인용한 말, 메시지 전문, 시각을 보이고, 앞 기록 뒤로 바뀐 [사용자] 줄은 다시 승인한 인용 옆에 둔다.
// 지금 명세에서 바뀌었는데 아직 다시 승인하지 않은 줄은 따로 알린다. 옛 판은 승인 기록이 없다고 알린다. 아무것도 모르면(기록도 명세도 없다) 칸을 만들지 않는다.
const CHANGE = { changed: '바뀜', removed: '빠짐', added: '더해짐', retagged: '태그 바뀜' };
const renderChange = (c) => {
  const head = !isLineKey(c.id); // F3/1처럼 [AI 가정] 항목 밑 케이스 줄 하나를 가리키는 키는 항목 줄이 없다
  return `<li><span class="tag">${CHANGE[c.kind]}</span>${esc(changeLabel(c))}${c.kind === 'retagged' ? ` ${c.tag ? esc(`[${c.tag}]`) : '태그 없음'}` : ''}${c.before.length ? ` <del>${esc(plainLines(c.before, { head }))}</del>` : ''}${c.after.length ? ` <ins>${esc(plainLines(c.after, { head }))}</ins>` : ''}</li>`;
};
const renderChanges = (changes) => `<ul class="changes">${changes.map(renderChange).join('')}</ul>`;

function renderApproval(approval) {
  const head = '<h2>승인 기록</h2>';
  switch (approval.state) {
    case 'legacy': return `${head}\n<p class="missing">옛 판이라 승인 기록 없음</p>`;
    case 'missing': return `${head}\n<p class="missing">승인 기록이 없습니다.</p>`;
    case 'unreadable': return `${head}\n<p class="missing">승인 기록을 읽지 못했습니다(${esc(approval.reason)}).</p>`;
    case 'recorded': break;
    default: return '';
  }
  const pending = approval.pending;
  const warn = !pending ? ''
    : pending.unknown ? '<p class="missing">가장 최근 기록에 [사용자] 줄이 없어 승인 뒤 바뀐 줄이 있는지 확인하지 못했습니다.</p>'
      : `<p class="missing">승인 뒤 바뀐 [사용자] 줄이 아직 다시 승인되지 않았습니다.</p>${renderChanges(pending.changes)}`;
  const rows = approval.rows.map(({ entry, label, changes }, i) => {
    const when = [entry.recorded_at ? `기록 ${entry.recorded_at}` : null, entry.message_time ? `메시지 ${entry.message_time}` : null].filter(Boolean).join(' · ');
    return [
      `<li><p><strong>${i > 0 ? `다시 ${label}` : label}</strong>${when ? ` <span class="meta">${esc(when)}</span>` : ''}</p>`,
      i > 0 && changes?.length ? `<p>앞 기록 뒤로 바뀐 [사용자] 줄 ${changes.length}개</p>${renderChanges(changes)}` : '',
      i > 0 && changes === null ? '<p class="meta">앞 기록에 [사용자] 줄이 없어 무엇이 바뀌었는지 견주지 못했습니다.</p>' : '',
      `<p class="quote">${esc(entry.quote)}</p>`,
      entry.answer_question ? `<p class="meta">질문 도구의 답: ${esc(entry.answer_question)}</p>` : '',
      `<details class="more"><summary>메시지 전문</summary><pre>${esc(entry.message)}</pre></details></li>`,
    ].filter(Boolean).join('');
  });
  return `${head}\n${warn}<ol>${rows.join('')}</ol>`;
}

// 명세 글. run-dir은 <프로젝트>/.pact/<slug>이고 results.spec은 프로젝트 기준 경로다. 못 읽으면 null.
function specText(spec, runDir) {
  if (!spec) return null;
  try {
    return readFileSync(path.resolve(runDir, '..', '..', spec), 'utf8');
  } catch {
    return null;
  }
}

// 보고서는 results.json(verifier), summary.json(메인이 쓰는 보고 칸), 명세의 `## 결정 기록`(rulings)을 합쳐 만든다(명세 R13).
// summary.json이 없고 results.json에 그 칸이 있는 옛 판은 results.json의 칸을 그대로 읽는다.
export function renderReport(results, { runDir, notes = [] }) {
  const raw = Array.isArray(results?.scenarios) ? results.scenarios : [];
  const { summary: written } = readSummary(runDir);
  const fields = reportFields(results, written);
  let surface = results?.surface;
  const captureFile = path.join(runDir, 'verification.json');
  let captureId = null;
  const accepted = new Set();
  try {
    const saved = JSON.parse(readFileSync(captureFile, 'utf8'));
    if (['ui', 'command'].includes(saved.surface)) surface = saved.surface;
    if (typeof saved.verification_id === 'string' && saved.verification_id.trim()) captureId = saved.verification_id;
    for (const id of [captureId, ...(Array.isArray(saved.history) ? saved.history : [])]) if (typeof id === 'string' && id.trim()) accepted.add(id);
  } catch { /* 검수 기록이 없는 옛 보고서. 단계마다 증거는 그대로 본다. */ }
  // 검수 기록이 있으면 결과도 그 기록에서(또는 같은 검수의 앞 판에서) 나온 것이어야 한다. 아니면 어느 코드를 본 결과인지 모른다.
  const needsReceipt = existsSync(captureFile) || results?.verification_id !== undefined;
  const scenarios = raw.map(s => {
    const stale = needsReceipt && (!captureId || results?.verification_id !== captureId || !accepted.has(s?.verification_id));
    const carried = !stale && Boolean(captureId) && s?.verification_id !== captureId;
    return { ...s, decision: decisionOf(s, written), stale, carried, result: stale ? 'unverified' : effectiveResult(s, { runDir, surface }) };
  });
  const stale = scenarios.filter(s => s.stale).length;
  const count = { pass: 0, fail: 0, doubt: 0, unverified: 0 };
  for (const s of scenarios) count[s.result]++;
  const summary = `통과 ${count.pass} · 실패 ${count.fail} · 의심 ${count.doubt}${count.unverified ? ` · 미검증 ${count.unverified}` : ''}`;
  const rank = (s) => ({ fail: 0, unverified: 1, doubt: 2 }[s.result] ?? 3);
  const problems = scenarios.filter((s) => s.result !== 'pass').sort((a, b) => rank(a) - rank(b));
  const passed = scenarios.filter((s) => s.result === 'pass');
  const check = results?.specCheck ?? {};
  const diffs = [
    ...(Array.isArray(fields.changes) ? fields.changes : []).map((x) => ['바꿈', x]),
    ...(check.missing ?? []).map((x) => ['빠짐', x]),
    ...(check.extra ?? []).map((x) => ['더함', x]),
    ...(check.misunderstood ?? []).map((x) => ['다르게 동작', x]),
  ];
  const spec = specText(results?.spec, runDir);
  const fromSpec = spec === null ? [] : decisionRulings(spec);
  const rulings = fromSpec.length ? fromSpec : Array.isArray(results?.rulings) ? results.rulings : [];
  const topic = spec === null ? null : parseSpec(spec).frontmatter.topic || null;
  const title = topic ? `${topic} 검수 보고서` : '검수 보고서';
  // 할 일: 메인이 쓴 칸 뒤에 명세 `## 확인 필요`의 검수 항목(묻지 않고 정한 것)을 저절로 올린다. 메인이 이미 그 번호를 적었으면 되풀이하지 않는다.
  const mainTodo = Array.isArray(fields.todo) ? fields.todo : null;
  const asked = (spec === null ? [] : notAskedItems(spec, runDir))
    .filter(({ n }) => !(mainTodo ?? []).some((line) => new RegExp(`검수\\s*${n}(?!\\d)`).test(String(line))))
    .map(({ n, reason, question }) => `검수 ${n}: ${reason}${question ? ` (질문: ${question.length > 60 ? `${question.slice(0, 60)}…` : question})` : ''}`);
  const todo = mainTodo === null && !asked.length ? undefined : [...(mainTodo ?? []), ...asked];
  const overview = approvalOverview(spec, runDir);
  const pending = overview.state === 'recorded' && overview.pending;
  // 맨 위 경고는 두 가지다: 바뀐 줄이 아직 다시 승인되지 않았다 / 기록에 [사용자] 줄이 없어 바뀌었는지 견줄 수 없다
  const pendingNote = !pending ? ''
    : pending.unknown ? '<p class="missing">가장 최근 승인 기록에 [사용자] 줄이 없어 승인 뒤 바뀐 줄이 있는지 확인하지 못했습니다. 아래 승인 기록에 있습니다.</p>'
      : '<p class="missing">승인 뒤 바뀐 [사용자] 줄이 아직 다시 승인되지 않았습니다. 아래 승인 기록에 있습니다.</p>';
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
  .sc.fail { border-color: #d33; } .sc.doubt, .sc.unverified { border-color: #d90; }
  details.sc { padding: 8px 14px; margin: 6px 0; }
  .sc h3 { font-size: 16px; margin: 0 0 6px; }
  .badge { font-size: 13px; font-weight: normal; padding: 2px 8px; border-radius: 10px; background: #eee; }
  .fail .badge { background: #fdd; } .doubt .badge, .unverified .badge { background: #fec; }
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
  .quote { background: #f1f5fb; border-left: 3px solid #69c; padding: 6px 10px; white-space: pre-wrap; }
  .changes { margin: 4px 0 8px; } del { color: #a33; } ins { color: #2a6a2a; text-decoration: none; }
</style></head><body>
<h1>${esc(title)}</h1>
<section class="top">
${scenarios.length === 0 ? '<p class="missing">검수한 시나리오가 없습니다. 완료로 판정할 수 없습니다.</p>' : ''}
${stale ? `<p class="missing">이번 검수 기록과 이어지지 않는 결과 ${stale}개는 미검증으로 두었습니다.</p>` : ''}
${scenarios.length > 0 && !needsReceipt ? '<p class="missing">완료 검사를 두기 전의 옛 보고서입니다. 지금도 그대로인지는 다시 확인해야 합니다.</p>' : ''}
${pendingNote}
${fields.headline ? `<p class="headline">${esc(fields.headline)}</p>` : ''}
${Array.isArray(todo) ? `<h2>할 일</h2>${list(todo)}` : ''}
<p class="counts">시나리오 ${scenarios.length}개 · ${summary}</p>
${notes.map((note) => `<p class="meta">${esc(note)}</p>`).join('\n')}
</section>
<h2>실패·의심${count.unverified ? '·미검증' : ''}</h2>
${problems.length ? problems.map((s) => renderProblem(s, runDir)).join('\n') : '<p>없음</p>'}
<h2>명세와 다른 것</h2>
${diffs.length ? `<ul>${diffs.map(([k, x]) => `<li><span class="tag">${k}</span>${esc(x)}</li>`).join('')}</ul>` : '<p>없음</p>'}
${renderApproval(overview)}
<h2>통과</h2>
${passed.length ? `<details><summary>통과한 시나리오 ${passed.length}개</summary>\n${passed.map((s) => renderPassed(s, runDir)).join('\n')}\n</details>` : '<p>없음</p>'}
${rulings.length ? `<h2>만들면서 정한 것</h2>\n<details><summary>결정 기록 ${rulings.length}개</summary><p class="meta">명세: ${esc(results?.spec)}</p>${list(rulings)}</details>` : ''}
</body></html>
`;
  return { html, summary };
}

// 검수 기록(verification.json)이 있으면 완료 검사를 돌린다. 메인 세션이 check를 따로 돌리지 않아도 되게 결과를 셋째 줄에 쓰고,
// 참고 줄(notes)은 보고서에도 싣는다. 검수 기록이 없으면 null, 검사를 못 했으면 { error }.
function completionCheck(runDir, results) {
  const captureFile = path.join(runDir, 'verification.json');
  if (!existsSync(captureFile)) return null;
  try {
    const saved = JSON.parse(readFileSync(captureFile, 'utf8'));
    const spec = typeof saved.spec === 'string' && existsSync(saved.spec) ? saved.spec : path.resolve(runDir, '..', '..', String(results?.spec ?? ''));
    const target = typeof saved.target_dir === 'string' && existsSync(saved.target_dir) ? saved.target_dir : path.resolve(runDir, '..', '..');
    return { checked: checkVerification(spec, target) };
  } catch (err) {
    return { error: err.message };
  }
}

function printCompletionCheck(check) {
  if (!check) return;
  if (check.error !== undefined) {
    console.log(`완료 검사: 못 함 — ${check.error}`);
    return;
  }
  const { checked } = check;
  console.log(checked.ok ? '완료 검사: 통과' : `완료 검사: 막힘 ${checked.issues.length}개 — ${checked.issues.join(' / ')}`);
  if (checked.warnings.length) console.log(`참고: ${checked.warnings.join(' / ')}`);
  for (const note of checked.notes ?? []) console.log(note);
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
  const check = completionCheck(runDir, results);
  const { html, summary } = renderReport(results, { runDir, notes: check?.checked?.notes ?? [] });
  const out = path.join(runDir, 'report.html');
  writeFileSync(out, html);
  console.log(summary);
  console.log(out);
  printCompletionCheck(check);
  return 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
