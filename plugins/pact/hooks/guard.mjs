#!/usr/bin/env node
// pact 훅 — PreToolUse와 SubagentStop에 거는 스크립트 하나. 플러그인 훅은 pact를 쓰지 않는 대화에서도 도구를 부를 때마다 돈다.
// 그래서 첫 일은 pact와 상관있는지 싸게 가르는 것이다(도구 이름, agent_type, 문자열에 `.pact/`·`docs/pact/`·pact 에이전트 이름이 있는지).
// 상관없으면 파일을 읽지도 쓰지도 않고, 아무것도 출력하지 않고, 종료 코드 0으로 끝난다(명세 R1).
//
//   PreToolUse   — 아직 아무것도 막지 않는다. 승인 관문·결과 잠금·걱정 붙이기는 handlePreToolUse에 더한다.
//   SubagentStop — pact:spec-checker·reviewer·worker·verifier가 멈추면 마지막 답을 그 판의 <run-dir>/log/에 덧붙여 남기고,
//                  verifier는 그때의 results.json 지문(sha256)도 남긴다(F4, R14, R15). scripts/run-log.mjs가 한다.
//
// 훅이 고장나도 대화는 멈추지 않는다(R7): 어떤 오류도 잡아 ${CLAUDE_PLUGIN_DATA}/hook-error.log에 한 줄 남기고 종료 코드 0으로 끝난다.
// SubagentStop은 막는 출력을 낼 길이 아예 없다 — 막으면 하위 에이전트가 멈추지 못한다.
// 이 파일은 node 내장 모듈만 정적으로 불러온다. pact 모듈은 필요할 때 불러와서, 모듈이 깨져도 위 약속은 지켜진다.
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/run-log.mjs의 LOGGED_AGENTS와 같아야 한다(시험이 맞춰 본다). 여기서 따로 두는 것은 상관없는 호출이 모듈을 불러오지 않게 하려는 것이다.
// `pact:` 앞머리까지 맞춘다. `tiers:worker`가 걸리면 안 된다.
export const PACT_AGENTS = new Set(['pact:spec-checker', 'pact:reviewer', 'pact:worker', 'pact:verifier']);
const PACT_TEXT = /\.pact\/|docs\/pact\/|\bpact:(?:spec-checker|reviewer|worker|verifier)\b|\bscripts\/(?:spec|verification|report|checklist|gallery|git-state)\.mjs\b/;
const ERROR_LOG = 'hook-error.log';

// Claude Code가 플러그인에 주는 데이터 폴더. 훅 환경에 안 오면 설치된 플러그인이 받는 이름(<플러그인>-<마켓플레이스>)과 같은 곳으로 떨어진다.
export function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'plugins', 'data', 'pact-chenjing-plugins');
}

const oneLine = (value, max = 2000) => String(value instanceof Error ? value.stack || value.message : value)
  .trim().replace(/\s*\r?\n\s*/g, ' | ').slice(0, max);

// 오류 기록 한 줄. 기록하다 실패해도 던지지 않는다.
export function logError(where, error) {
  try {
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(path.join(dataDir(), ERROR_LOG), `${new Date().toISOString()} [${where}] ${oneLine(error)}\n`);
  } catch { /* 오류를 기록하다 또 실패해도 대화를 막지 않는다 */ }
}

// ---------- 막는 출력 모양(PreToolUse 전용) ----------
// R6: 막을 때는 까닭과 대신 할 일을 한 줄로 알린다. 까닭 없이 막으면 AI가 다른 길로 돌아간다.
export function denyOutput(reason, instead) {
  const line = [reason, instead].map((part) => String(part ?? '').replace(/\s*\r?\n\s*/g, ' ').trim()).filter(Boolean).join(' ');
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[pact] ${line}` } };
}
// 호출을 막지 않고 입력만 바꿔 통과시킨다(worker 걱정 붙이기).
export function allowOutput(updatedInput) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } };
}
const emit = (output) => new Promise((resolve) => process.stdout.write(JSON.stringify(output), () => resolve()));

// ---------- 싼 검사 ----------
// 이 호출이 pact가 걸린 것인가: pact 에이전트를 부르거나, `.pact/`·`docs/pact/`를 쓰거나, pact 스크립트를 돌리는가.
// 도구가 만지는 곳(경로, 명령, 에이전트 종류)만 본다. 쓰는 파일의 내용이나 에이전트에게 준 지시문은 보지 않는다 — 크기가 크고 무관하다.
export function touchesPact(input) {
  const ti = input && typeof input.tool_input === 'object' && input.tool_input ? input.tool_input : {};
  switch (input && input.tool_name) {
    case 'Agent': return PACT_AGENTS.has(String(ti.subagent_type ?? ''));
    case 'Bash': return PACT_TEXT.test(String(ti.command ?? ''));
    case 'Edit':
    case 'Write':
    case 'MultiEdit': return PACT_TEXT.test(String(ti.file_path ?? ''));
    case 'NotebookEdit': return PACT_TEXT.test(String(ti.notebook_path ?? ''));
    // 받는 쪽이 pact 에이전트인지는 id로는 모른다. 보내는 글에 pact 흔적이 있는지만 본다.
    case 'SendMessage': return PACT_TEXT.test(JSON.stringify(ti));
    default: return false;
  }
}

// ---------- PreToolUse ----------
// 돌려주는 값: 막거나 입력을 바꾸는 출력(denyOutput, allowOutput) 또는 null(그냥 통과).
// 이번 판은 아무것도 막지 않는다. 2~5번 작업이 pact가 걸린 호출에 한해 여기에 규칙을 더한다.
export async function handlePreToolUse(input) {
  if (!touchesPact(input)) return null; // R1: 상관없는 호출은 파일을 읽지 않고 바로 통과
  return null;
}

// ---------- SubagentStop ----------
// 출력이 없다. 어떤 경우에도 막지 않는다.
export async function handleSubagentStop(input) {
  const type = String(input.agent_type ?? '');
  if (!PACT_AGENTS.has(type)) return; // 다른 플러그인의 에이전트나 내장 에이전트: 아무것도 읽지 않는다
  const { recordStop } = await import('../scripts/run-log.mjs');
  const result = recordStop(input);
  for (const problem of result?.problems ?? []) logError(`SubagentStop ${type}`, problem);
}

// ---------- main ----------
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let where = 'stdin';
  try {
    const raw = await readStdin();
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      logError(where, raw.trim() ? `입력이 JSON이 아니다: ${oneLine(raw, 80)}` : '입력이 비어 있다');
      return;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      logError(where, `입력이 JSON 객체가 아니다: ${oneLine(raw, 80)}`);
      return;
    }
    const event = input.hook_event_name;
    where = [event, input.agent_type].filter((x) => typeof x === 'string' && x).join(' ') || where;
    if (event === 'PreToolUse') {
      const output = await handlePreToolUse(input);
      if (output) await emit(output);
    } else if (event === 'SubagentStop') {
      await handleSubagentStop(input);
    }
  } catch (error) {
    logError(where, error); // R7: 오류로 죽으면 막지 않고 통과시키고 기록한다
  }
}

// 직접 실행인지는 실제 경로끼리 비교한다. import.meta.url은 심볼릭 링크를 푼 경로인데 process.argv[1]은 풀지 않아서,
// 플러그인 폴더가 링크로 걸려 있으면 URL끼리 비교하는 검사는 늘 거짓이 되고 훅이 아무 소리 없이 아무것도 하지 않는다.
function isMain() {
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}

if (isMain()) {
  process.on('uncaughtException', (error) => { logError('uncaughtException', error); process.exit(0); });
  process.on('unhandledRejection', (error) => { logError('unhandledRejection', error); process.exit(0); });
  main().finally(() => process.exit(0));
}
