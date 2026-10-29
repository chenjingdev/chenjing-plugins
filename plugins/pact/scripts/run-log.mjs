// 하위 에이전트(spec-checker·reviewer·worker·verifier)가 멈출 때마다 마지막 답을 그 판의 실행 폴더 log/에 덧붙여 남기고,
// 뒤 검사가 그 기록을 읽는 도구. 쓰기는 훅(hooks/guard.mjs)이 하고 읽기는 훅과 스크립트가 한다. 이 폴더는 훅과 스크립트만 쓴다(명세 R14).
//
// 기록은 판마다 `<run-dir>/log/subagents.jsonl` 한 파일에 멈춤 하나당 한 줄이다.
//   { time, agent_type, agent_id, task, message }          — time은 ISO 8601 UTC, task는 worker·reviewer의 작업 번호(모르면 null)
//   verifier 줄에는 results_sha256이 더 든다: 그때 <run-dir>/results.json의 sha256(파일이 없으면 null)
import { closeSync, appendFileSync, mkdirSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ensureRunDir } from './paths.mjs';
import { findRunDir, taskNumber } from './run-dir.mjs';
import { withoutConcerns } from './concerns.mjs';

export const AGENT = {
  specChecker: 'pact:spec-checker',
  reviewer: 'pact:reviewer',
  worker: 'pact:worker',
  verifier: 'pact:verifier',
};
// `pact:` 앞머리까지 맞춘다. `tiers:worker` 같은 다른 플러그인의 에이전트가 걸리면 안 된다.
export const LOGGED_AGENTS = Object.values(AGENT);

export const logFile = (runDir) => path.join(runDir, 'log', 'subagents.jsonl');

// ---------- 쓰기 ----------

// 기록 한 줄을 덧붙인다. log/가 없으면 만든다. 있는 기록은 덮어쓰지 않는다.
export function appendRecord(runDir, record) {
  mkdirSync(path.join(runDir, 'log'), { recursive: true });
  appendFileSync(logFile(runDir), `${JSON.stringify(record)}\n`);
}

// <run-dir>/results.json의 sha256(16진수). 파일이 없으면 null, 읽을 수 없으면 던진다.
// finish가 지금 파일과 verifier가 끝날 때 남긴 지문을 비교할 때도 이 함수를 쓴다.
export function resultsSha256(runDir) {
  try {
    return createHash('sha256').update(readFileSync(path.join(runDir, 'results.json'))).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// 파일을 줄 단위로 읽는다. 멈추면 파일도 닫힌다. 하위 에이전트의 대화 기록은 수십 MB일 수 있어 첫 줄만 읽고 끝내려는 것이다.
// scripts/transcript.mjs도 메인 대화 기록(수십 MB)을 읽을 때 쓴다.
export function* fileLines(file) {
  const fd = openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(1 << 16);
    let rest = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      rest = Buffer.concat([rest, chunk.subarray(0, n)]);
      for (let i = rest.indexOf(10); i !== -1; i = rest.indexOf(10)) {
        yield rest.subarray(0, i).toString('utf8');
        rest = rest.subarray(i + 1);
      }
    }
    if (rest.length) yield rest.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// 하위 에이전트의 첫 지시: 대화 기록(JSONL)의 첫 사람 메시지. 문자열이거나 text 블록 배열이다.
// 못 읽으면 { text: null, error }로 까닭을 돌려준다. 던지지 않는다.
export function firstUserPrompt(transcriptPath, { maxLines = 50 } = {}) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return { text: null, error: 'agent_transcript_path가 없다' };
  try {
    let n = 0;
    for (const line of fileLines(transcriptPath)) {
      if (++n > maxLines) break;
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec?.type !== 'user' || !rec.message) continue;
      const content = rec.message.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.filter((x) => x?.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n') : '';
      if (text) return { text };
    }
    return { text: null, error: `대화 기록에서 첫 지시를 찾지 못했다 (${transcriptPath})` };
  } catch (error) {
    return { text: null, error: `대화 기록을 읽지 못했다 (${transcriptPath}): ${error.code ?? error.message}` };
  }
}

// SubagentStop 입력 하나를 기록한다. 실행 폴더는 하위 에이전트의 첫 지시에 든 경로로, 없으면 cwd 프로젝트의 진행 중 명세로 찾는다.
// 폴더가 없으면 만들고 기록은 덧붙인다. 못 찾으면 쓰지 않고 problems에 까닭을 돌려준다(훅이 오류 기록에 남긴다).
// 쓰다가 실패하면 던진다. 반환: null(기록 대상 에이전트가 아님) | { runDir, record, problems }
export function recordStop(input, { now = new Date() } = {}) {
  const agentType = String(input?.agent_type ?? '');
  if (!LOGGED_AGENTS.includes(agentType)) return null;
  const problems = [];
  const { text: prompt, error } = firstUserPrompt(input.agent_transcript_path);
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  // reviewer의 첫 지시 끝에는 훅이 붙인 `## worker 걱정` 칸이 있을 수 있다. 걱정 글 속의 `작업 번호 3`이나 다른 판·보고서 경로가
  // 지시 본문의 것으로 읽히지 않게 그 앞까지만 읽는다(판과 작업 번호 둘 다). worker의 첫 지시는 훅이 건드리지 않아 그대로 읽는다.
  const brief = agentType === AGENT.reviewer ? withoutConcerns(prompt ?? '') : prompt ?? '';
  const found = findRunDir({ text: brief, cwd });
  if (!found) {
    const why = error ? `; ${error}` : '';
    // 어느 하위 에이전트의 멈춤이었는지 따라갈 수 있게 id와 대화 기록 경로도 남긴다(없으면 '없음').
    const given = (value) => (typeof value === 'string' && value ? value : '없음');
    const who = `agent_id: ${given(input.agent_id)}; agent_transcript_path: ${given(input.agent_transcript_path)}`;
    return { runDir: null, record: null, problems: [`실행 폴더를 찾지 못해 ${agentType} 답을 log/에 남기지 못했다 (cwd: ${cwd}${why}; ${who})`] };
  }
  if (error) problems.push(error);
  const message = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  if (!message) problems.push(`${agentType}의 last_assistant_message가 비어 있다`);
  const record = {
    time: now.toISOString(),
    agent_type: agentType,
    agent_id: typeof input.agent_id === 'string' ? input.agent_id : null,
    task: agentType === AGENT.worker || agentType === AGENT.reviewer ? taskNumber({ prompt: brief, reply: message }) : null,
    message,
  };
  if (agentType === AGENT.verifier) {
    try {
      record.results_sha256 = resultsSha256(found.runDir);
    } catch (e) {
      record.results_sha256 = null;
      problems.push(`results.json의 지문을 만들지 못했다: ${e.code ?? e.message}`);
    }
  }
  ensureRunDir(found.project, found.runId); // 실행 폴더가 없으면 만들고, .pact/.gitignore가 없으면 만든다
  appendRecord(found.runDir, record);
  return { runDir: found.runDir, record, problems };
}

// ---------- 읽기 (뒤 작업의 검사가 쓴다) ----------

// 기록 파일의 글을 기록 목록으로. 깨진 줄(쓰다 끊긴 줄)과 객체가 아닌 줄은 건너뛴다.
function parseRecords(raw) {
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object' && !Array.isArray(rec)) records.push(rec);
    } catch { /* 깨진 줄 */ }
  }
  return records;
}

// 기록을 쓴 순서대로. 기록이 없으면 []. 깨진 줄은 건너뛴다(마지막 줄이 쓰다 끊겨도 앞 기록은 읽힌다).
export function readRecords(runDir) {
  let raw;
  try {
    raw = readFileSync(logFile(runDir), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return parseRecords(raw);
}

// 그 에이전트의 가장 최근 기록. task를 주면 그 작업 번호의 것만 본다. 없으면 null.
export function latestRecord(runDir, agentType, { task } = {}) {
  const records = readRecords(runDir);
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (rec.agent_type !== agentType) continue;
    if (task !== undefined && rec.task !== Number(task)) continue;
    return rec;
  }
  return null;
}

// 가장 최근 spec-checker 답과 끝난 시각: { time, message, ... } | null
export const latestSpecCheckerReply = (runDir) => latestRecord(runDir, AGENT.specChecker);
// 작업 n의 가장 최근 worker 답: { time, message, task, ... } | null
export const latestWorkerReply = (runDir, task) => latestRecord(runDir, AGENT.worker, { task });
// 가장 최근 verifier가 끝날 때의 지문: { time, results_sha256, ... } | null. results_sha256이 null이면 그때 results.json이 없었다.
export const latestVerifierFingerprint = (runDir) => latestRecord(runDir, AGENT.verifier);

// 프로젝트의 판들(<프로젝트>/.pact/<run-id>/) 가운데 agent_id가 agentId인 agentType 에이전트의 가장 최근 기록과 그 판: { runDir, record } | null
// SendMessage의 받는 쪽(agent id)이 어느 판의 reviewer인지 알려고 쓴다. id는 호출마다 달라서 맞으면 그 판이다.
// 판이 많아도 싸게: 기록 파일에 id 글자가 없으면 줄을 읽지 않는다. 읽지 못하는 기록은 '없음'이 아니라 던진다(readRecords와 같다).
export function findAgentRecord(project, agentId, agentType) {
  if (typeof project !== 'string' || !project || typeof agentId !== 'string' || !agentId || typeof agentType !== 'string' || !agentType) return null;
  const base = path.join(project, '.pact');
  let names;
  try {
    names = readdirSync(base);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  for (const name of names.sort().reverse()) { // 날짜가 앞에 붙는 run-id라 새 판부터
    if (name.startsWith('.')) continue; // `.gitignore` 같은 것은 판이 아니다
    const runDir = path.join(base, name);
    let raw;
    try {
      raw = readFileSync(logFile(runDir), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; // log/가 없는 판, 폴더가 아닌 파일
      throw error;
    }
    if (!raw.includes(agentId)) continue;
    const records = parseRecords(raw);
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].agent_type === agentType && records[i].agent_id === agentId) return { runDir, record: records[i] };
    }
  }
  return null;
}
