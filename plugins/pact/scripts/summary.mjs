// 메인 세션이 쓰는 보고 칸(`<run-dir>/summary.json`). results.json은 verifier만 쓰고(훅이 다른 쪽의 쓰기를 막는다)
// 메인이 results.json에 쓰던 칸을 이 파일로 옮겼다(명세 R13). 보고서(report.mjs)와 완료 검사(verification.mjs)가 읽는다.
//
//   {
//     "headline": "다 만들었고 명세대로 된다.",            첫 문장이 결론인 한두 문장
//     "todo": ["…"],                                       사용자가 할 일이나 정할 것
//     "changes": ["…"],                                    승인한 명세와 달라진 것 중 사용자가 알아차릴 것
//     "decision": { "S3": "그대로 둔다. 저장 버튼이 있어서다." }   의심·실패 시나리오 id → 고쳤는지 그대로 두는지와 까닭
//   }
//
// 칸마다 summary.json에 있으면 그것을, 없으면 results.json의 같은 칸을 읽는다(0.5.0까지 메인이 results.json에 쓴 판이 그대로 보이게).
// rulings는 여기에 없다. report.mjs가 명세의 `## 결정 기록`에서 읽는다.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const SUMMARY_FILE = 'summary.json';
export const summaryFile = (runDir) => path.join(runDir, SUMMARY_FILE);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

// summary.json을 읽는다. 반환: { summary, problems }
//   summary   형식이 맞는 칸만 든 객체. 파일이 없거나 읽을 수 없으면 null
//   problems  파일이 있는데 읽지 못했거나 칸의 형식이 틀린 것(완료 검사가 막는다). 파일이 없는 것은 문제가 아니다.
export function readSummary(runDir) {
  let raw;
  try {
    raw = readFileSync(summaryFile(runDir), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { summary: null, problems: [] };
    return { summary: null, problems: [`${SUMMARY_FILE}을 읽지 못했습니다: ${error.code ?? error.message}`] };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return { summary: null, problems: [`${SUMMARY_FILE}을 읽지 못했습니다: ${error.message}`] };
  }
  if (!isObject(data)) return { summary: null, problems: [`${SUMMARY_FILE}은 JSON 객체여야 합니다`] };
  const summary = {};
  const problems = [];
  if (data.headline !== undefined) {
    if (typeof data.headline === 'string') summary.headline = data.headline;
    else problems.push(`${SUMMARY_FILE}의 headline은 글이어야 합니다`);
  }
  for (const key of ['todo', 'changes']) {
    if (data[key] === undefined) continue;
    if (Array.isArray(data[key])) summary[key] = data[key];
    else problems.push(`${SUMMARY_FILE}의 ${key}는 배열이어야 합니다`);
  }
  if (data.decision !== undefined) {
    if (isObject(data.decision)) summary.decision = data.decision;
    else problems.push(`${SUMMARY_FILE}의 decision은 시나리오 id를 키로 하는 객체여야 합니다`);
  }
  return { summary, problems };
}

// 보고서 맨 위 칸들: summary.json의 것, 없으면 results.json의 것
export function reportFields(results, summary) {
  const pick = (key) => summary?.[key] ?? results?.[key];
  return { headline: pick('headline'), todo: pick('todo'), changes: pick('changes') };
}

// 시나리오 하나의 결정 이유: summary.json의 decision[id], 없으면 results.json 시나리오의 decision
export function decisionOf(scenario, summary) {
  const fromSummary = scenario?.id === undefined ? undefined : summary?.decision?.[scenario.id];
  return nonempty(fromSummary) ? fromSummary : scenario?.decision;
}
