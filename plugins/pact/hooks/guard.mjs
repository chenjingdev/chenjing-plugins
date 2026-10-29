#!/usr/bin/env node
// pact 훅 — PreToolUse와 SubagentStop에 거는 스크립트 하나. 플러그인 훅은 pact를 쓰지 않는 대화에서도 도구를 부를 때마다 돈다.
// 그래서 첫 일은 pact와 상관있는지 싸게 가르는 것이다(도구 이름, agent_type, 문자열에 `.pact/`·`docs/pact/`·pact 에이전트 이름이 있는지).
// 상관없으면 파일을 읽지도 쓰지도 않고, 아무것도 출력하지 않고, 종료 코드 0으로 끝난다(명세 R1).
//
//   PreToolUse   — 승인 관문(F2·F3, 명세 R8·R9·R10·R12): 메인 세션이 pact:worker를 부를 때 그 판에 승인·위임 기록이 없거나
//                  승인 뒤 [사용자] 줄이 바뀌었으면 막고(바뀐 줄을 알리고 새 인용으로 다시 approve하게 한다),
//                  하위 에이전트가 Bash로 spec.mjs approve·delegate·set-status를 부르거나 메인 세션이 approve·delegate 앞에 환경 변수를
//                  덮어쓰면 막는다.
//                  결과 잠금(F1, R14): 실행 폴더 바로 밑의 results*.json은 pact:verifier만, verification.json·approvals.jsonl·log/는
//                  아무도(훅과 pact 스크립트만) 쓰지 못하게 Edit·Write·MultiEdit·NotebookEdit와 Bash의 쓰기 꼴을 막는다. scripts/locks.mjs가 한다.
//                  worker 걱정 붙이기(F6, R16): 메인 세션이 pact:reviewer를 부르면 지시문의 판과 작업 번호로 log/에서 그 작업의 가장 최근 worker 답을 찾아
//                  `## 걱정·위험` 칸을 지시 끝에 `## worker 걱정`으로 붙이고 통과시킨다(updatedInput). 같은 reviewer에 SendMessage로 보내는 글에도 붙인다 —
//                  받는 쪽이 reviewer인지와 작업 번호는 log/의 reviewer 기록(agent_id, task)으로 안다. 붙일 것이 없으면 그냥 통과한다. scripts/concerns.mjs가 글을 다룬다.
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
const PACT_TEXT = /\.pact\/|docs\/pact\/|\bpact:(?:spec-checker|reviewer|worker|verifier)\b|\bscripts\/(?:spec|verification|report|checklist|gallery|git-state)\.mjs\b/i; // 대소문자를 가리지 않는다: 이 컴퓨터의 파일 시스템이 가리지 않아 `.PACT/`도 실제 `.pact/`다
const ERROR_LOG = 'hook-error.log';
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Bash의 cwd가 실행 폴더(<프로젝트>/.pact/<run-id>) 안이면 명령에 `.pact/`가 없어도 pact 호출이다: `echo x > results.json`
const RUN_CWD = /\/\.pact\/[^/]/i;

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
    // (메인 세션이 reviewer에게 보내는 글은 handlePreToolUse가 log/로 따로 본다: 글에 pact 흔적이 없어도 id로 알 수 있어서다.)
    case 'SendMessage': return PACT_TEXT.test(JSON.stringify(ti));
    default: return false;
  }
}

// ---------- 승인 관문 ----------
// `spec.mjs approve|delegate|set-status`를 부르는 명령. 호출로 읽는 꼴은 둘이다: node(·bun·deno)가 spec.mjs를 실행하는 것,
// 명령 맨 앞(`;`·`&&`·`|` 뒤 포함, 앞에 환경 변수 지정이 와도 된다)이 spec.mjs인 것. scripts/ 없이 spec.mjs만 불러도 잡으려고 PACT_TEXT와 따로 본다.
// 글 속에서 이름만 언급한 것(커밋 메시지, grep, echo)은 호출이 아니다 — 하위 에이전트가 이 플러그인을 고치며 커밋 메시지에 쓰는 말이 막히면 안 된다.
const SPEC_VIA_NODE = /\b(?:node|nodejs|bun|deno)\b[^\n;&|]*?(?<![\w.-])spec\.mjs["']?\s+(approve|delegate|set-status)(?![\w-])/g;
const SPEC_DIRECT = /(?:^|[\n;&|(`])\s*(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)*["']?(?:[^\s"'|;&()]*\/)?spec\.mjs["']?\s+(approve|delegate|set-status)(?![\w-])/g;
// 승인·위임 스크립트가 대화 기록을 찾는 데 쓰는 환경(HOME → ~/.claude, CLAUDE_CONFIG_DIR, CLAUDE_CODE_SESSION_ID)과, 스크립트 실행을 바꿀 수 있는 환경
const PROTECTED_ENV = /^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|XDG_\w+|CLAUDE_\w+|NODE_\w+|DYLD_\w+|LD_\w+|PATH|TMPDIR|PACT_\w+)$/;
// 명령 앞의 `NAME=값`(HOME=/x node …), export·declare, env 명령 뒤의 지정. 따옴표 안의 `bash -c 'HOME=/x …'`도 본다.
const ASSIGNMENT = /(?:^|[\s;&|(){}`'"])(?:(?:export|declare|typeset|readonly|local)\s+(?:-\w+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)\+?=/g;

const bashCommand = (input) => (input && input.tool_name === 'Bash' && input.tool_input && typeof input.tool_input === 'object' ? String(input.tool_input.command ?? '') : '');

// 명령 안의 spec.mjs 호출들: [{ sub, end }] — end는 그 호출이 끝나는 자리(앞의 환경 변수 지정까지 포함해 거기까지의 글을 본다)
function specCalls(command) {
  if (!command.includes('spec.mjs')) return []; // 싼 거름: 대부분의 명령은 여기서 끝난다
  const calls = [];
  for (const re of [SPEC_VIA_NODE, SPEC_DIRECT]) for (const m of command.matchAll(re)) calls.push({ sub: m[1], end: m.index + m[0].length });
  return calls.sort((a, b) => a.end - b.end);
}

function overriddenEnv(before) {
  const names = [];
  for (const m of before.matchAll(ASSIGNMENT)) if (PROTECTED_ENV.test(m[1]) && !names.includes(m[1])) names.push(m[1]);
  return names;
}

// Bash 명령 하나. 하위 에이전트는 approve·delegate·set-status를 못 부르고, 메인 세션도 approve·delegate 앞에 환경 변수를 덮어쓸 수 없다.
// 승인은 사용자 말을 이 대화 기록에서 찾아 맞춰 보는 일이라, 하위 에이전트나 덮어쓴 환경은 가짜 근거를 만들 수 있다(R14: 셸로 돌아가는 길을 다 막지는 못한다).
function gateSpecCommand(calls, command, subAgent) {
  if (!calls.length) return null;
  if (subAgent) {
    return denyOutput(
      `하위 에이전트는 승인·위임 기록과 status를 바꾸지 않는다 (spec.mjs ${calls[0].sub}).`,
      '승인과 status는 메인 세션이 사용자 말을 받아 처리한다. 바꿔야 할 것이 있으면 답장에 적어 메인 세션에 넘긴다.',
    );
  }
  for (const call of calls) {
    if (call.sub === 'set-status') continue;
    const names = overriddenEnv(command.slice(0, call.end));
    if (names.length) {
      return denyOutput(
        `${call.sub}는 이 대화의 기록에서 사용자 말을 찾아 맞춰 보는데, 환경 변수(${names.join(', ')})를 바꾸면 다른 기록을 가리킬 수 있다.`,
        `환경 변수 없이 spec.mjs ${call.sub}를 다시 실행한다.`,
      );
    }
  }
  return null;
}

// 메인 세션이 pact:worker를 부를 때: 작업 지시의 판(findRunDir)에 승인이나 위임 기록이 있어야 하고, 가장 최근 기록 뒤로 [사용자] 줄이 바뀌지 않았어야 한다
// (checkStart가 본다). 옛 판(pact: 1)은 기록 없이 통과한다.
// 판은 지시문에 든 경로로만 찾는다. cwd로 짐작한 판의 기록을 보면 지시문이 가리키는 다른 판이 승인 없이 지나간다.
async function gateWorker(input, toolInput) {
  const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
  const { findRunDir } = await import('../scripts/run-dir.mjs');
  const found = findRunDir({ text: prompt, cwd: typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd() });
  if (!found || found.via !== 'prompt') {
    return denyOutput('작업 지시에서 어느 pact 판인지 찾지 못해 승인 기록을 확인할 수 없다.', '맥락 칸에 run-dir과 작업 번호를 넣는다.');
  }
  const { checkStart } = await import('../scripts/approval.mjs');
  const verdict = checkStart({ project: found.project, runId: found.runId, purpose: 'worker' });
  return verdict.ok ? null : denyOutput(verdict.reason, verdict.instead);
}

// 실행 폴더 바로 밑의 결과·기록 파일을 정해진 쪽만 쓰게 한다. verifier는 results*.json을 쓸 수 있다(그 밖의 잠긴 파일은 verifier도 못 쓴다).
// 이 파일은 node 내장 모듈만 불러오므로 규칙(scripts/locks.mjs)은 필요할 때 불러온다.
async function gateLocks(input) {
  const { checkLocks, VERIFIER } = await import('../scripts/locks.mjs');
  const verdict = checkLocks(input, { verifier: input.agent_type === VERIFIER });
  return verdict ? denyOutput(verdict.reason, verdict.instead) : null;
}

// ---------- worker 걱정 붙이기 (F6, R16) ----------
// worker가 마지막 답의 `## 걱정·위험`에 쓴 것을 reviewer가 받는 글 끝에 `## worker 걱정`으로 붙인다. 붙일 것이 없으면 null: 막지 않고 그대로 통과한다
// (걱정이 '없음'이거나 비었다, 작업 번호나 그 번호의 worker 기록을 못 찾았다, 이미 붙어 있다).
// 걱정은 worker 보고 파일이 아니라 log/의 worker 답에서 가져온다(R16). 훅이 남긴 기록이라 worker가 나중에 고칠 수 없다.
// SendMessage의 to가 id 꼴인가. 공백이나 `[ref]`가 든 주소와 빈 값은 아니다. 이름(`reviewer`)도 이 꼴이라 걸러지지 않는다 — log/에 그 id의 reviewer 기록이 있는지가 가른다.
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const cwdOf = (input) => (typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd());

// 그 판의 작업 n의 가장 최근 worker 답의 걱정 글, 없으면 null
async function latestConcerns(runDir, task) {
  const { latestWorkerReply } = await import('../scripts/run-log.mjs');
  const { concernsOf } = await import('../scripts/concerns.mjs');
  const reply = latestWorkerReply(runDir, task);
  return reply ? concernsOf(reply.message) : null;
}

// 메인 세션이 pact:reviewer를 부를 때: 지시문의 판(findRunDir)과 작업 번호(taskNumber)로 그 작업의 worker 걱정을 찾아 prompt 끝에 붙인다.
// 판은 지시문에 든 경로로만 찾는다(gateWorker와 같다). cwd로 짐작한 판의 기록을 붙이면 다른 판의 걱정이 섞인다. 작업 번호가 null이면 '못 찾음'이다.
async function attachToBrief(input, toolInput) {
  const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
  if (!prompt) return null;
  const { hasConcernsSection, withConcerns } = await import('../scripts/concerns.mjs');
  if (hasConcernsSection(prompt)) return null;
  const { findRunDir, taskNumber } = await import('../scripts/run-dir.mjs');
  const found = findRunDir({ text: prompt, cwd: cwdOf(input) });
  if (!found || found.via !== 'prompt') return null;
  const task = taskNumber({ prompt });
  if (task === null) return null;
  const concerns = await latestConcerns(found.runDir, task);
  return concerns ? allowOutput({ ...toolInput, prompt: withConcerns(prompt, concerns) }) : null;
}

// 메인 세션이 SendMessage로 글을 보낼 때: 받는 쪽(to)이 log/에 pact:reviewer로 남은 agent_id이면, 그 기록의 작업 번호로
// 그 작업의 가장 최근 worker 답(고친 뒤의 답)의 걱정을 message 끝에 붙인다. to가 id가 아니거나 log/에서 못 찾으면 그대로 통과한다.
// 글이 reviewer 기록과 다른 작업 번호를 말하면 그것도 못 찾음처럼 통과한다(reviewer를 다른 작업에 다시 쓰는 경우).
// reviewer가 어느 판에 있는지는 id로만 안다. 글이 가리키는 프로젝트와 cwd 프로젝트의 판들을 본다.
async function attachToMessage(input, toolInput) {
  const { to, message } = toolInput;
  // 글이 없거나 글이 아니면(알림만 신청하는 호출) 붙이지 않는다. 붙이면 알림 신청이 reviewer에게 가는 글이 된다.
  if (typeof to !== 'string' || !AGENT_ID.test(to) || typeof message !== 'string' || !message.trim()) return null;
  const { hasConcernsSection, withConcerns } = await import('../scripts/concerns.mjs');
  if (hasConcernsSection(message)) return null;
  const { projectOfCwd, runDirCandidates, taskNumber } = await import('../scripts/run-dir.mjs');
  const { findAgentRecord, AGENT } = await import('../scripts/run-log.mjs');
  const cwd = cwdOf(input);
  const projects = [...new Set([...runDirCandidates(message, cwd).map((c) => c.project), projectOfCwd(cwd)].filter(Boolean))];
  for (const project of projects) {
    const hit = findAgentRecord(project, to, AGENT.reviewer);
    if (!hit) continue;
    if (typeof hit.record.task !== 'number') return null; // 작업 번호를 모르면 어느 worker 답인지 모른다
    const named = taskNumber({ prompt: message });
    if (named !== null && named !== hit.record.task) return null; // 글이 다른 작업을 말한다: reviewer를 다른 작업에 다시 쓰는 것이면 첫 작업의 걱정을 붙이지 않는다
    const concerns = await latestConcerns(hit.runDir, hit.record.task);
    return concerns ? allowOutput({ ...toolInput, message: withConcerns(message, concerns) }) : null;
  }
  return null;
}

// ---------- PreToolUse ----------
// 돌려주는 값: 막거나 입력을 바꾸는 출력(denyOutput, allowOutput) 또는 null(그냥 통과).
export async function handlePreToolUse(input) {
  const command = bashCommand(input);
  const calls = specCalls(command);
  const inRun = input && input.tool_name === 'Bash' && typeof input.cwd === 'string' && RUN_CWD.test(input.cwd);
  const subAgent = Boolean(input) && typeof input.agent_id === 'string' && input.agent_id !== ''; // agent_id가 없으면 메인 세션
  const toolInput = input && input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  // 메인 세션의 SendMessage는 싼 검사 앞에서 본다. 받는 쪽이 reviewer인지는 글에 pact 흔적이 없어도 log/로 알 수 있다.
  // to가 id 꼴이고 글이 있을 때만 파일을 읽고(cwd 프로젝트의 .pact/ 밑 기록), 그 밖에는 아무것도 읽지 않는다.
  if (input && input.tool_name === 'SendMessage' && !subAgent) return attachToMessage(input, toolInput);
  if (!touchesPact(input) && !calls.length && !inRun) return null; // R1: 상관없는 호출은 파일을 읽지 않고 바로 통과
  if (input.tool_name === 'Bash') return gateSpecCommand(calls, command, subAgent) ?? gateLocks(input);
  if (FILE_TOOLS.has(input.tool_name)) return gateLocks(input);
  if (input.tool_name === 'Agent' && !subAgent) {
    if (toolInput.subagent_type === 'pact:worker') return gateWorker(input, toolInput);
    if (toolInput.subagent_type === 'pact:reviewer') return attachToBrief(input, toolInput);
  }
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
