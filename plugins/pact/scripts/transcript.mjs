// 이 대화의 기록(JSONL)에서 사용자가 한 말을 찾는 도구. 승인·위임 기록(approval.mjs)이 인용한 말을 맞춰 볼 때 쓴다. 읽기만 한다.
//
// 대화 기록 위치: <설정 폴더>/projects/<프로젝트 이름>/<세션 id>.jsonl
//   설정 폴더는 CLAUDE_CONFIG_DIR, 없으면 ~/.claude. 세션 id는 Bash 환경의 CLAUDE_CODE_SESSION_ID로, 메인 대화 기록 파일 이름과 같다
//   (하위 에이전트 안에서도 같은 값이다). 프로젝트 이름은 대화를 처음 연 폴더에서 정해져 지금 cwd로는 알 수 없으므로
//   projects/ 밑 폴더를 모두 본다.
//
// 사람 메시지(type이 user인 줄 중에서)는 이렇게 가려낸다. 이 컴퓨터의 진짜 기록 3057개에서 본 모양이다.
//   사람 말   origin.kind가 human(promptSource는 typed·queued·suggestion_accepted·sdk 등 — 사람이 보낸 말이다)이거나, origin 칸이 없는
//             옛 기록·claude -p의 말. 글 문자열이거나 글·그림 블록의 배열(그림이 붙은 말).
//   뺀다      isMeta · isCompactSummary(지난 사용자 말을 인용해 담은 요약) · isSidechain(하위 에이전트 쪽 줄)
//             origin이 task-notification(하위 에이전트가 쓴 글이 그대로 든다) · peer(다른 세션) · plugin 등 human이 아닌 것
//             도구 결과(content가 tool_result 블록 배열), 명령 메시지(<command-name> 같은 태그로 시작), <system-reminder>·<local-command-…>
//   예외      AskUserQuestion의 답은 그 줄의 toolUseResult.answers(질문 → 답)에 있다. 사람이 고른 말이라 인정한다.
import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileLines } from './run-log.mjs';

// 짧은 말 기준: 띄어쓰기·문장부호를 뺀 뒤 이 글자 수 이하면 메시지 전체와 같아야 하고, 넘으면 메시지 안에 들어 있으면 된다.
// "승인"·"ㄱㄱ"처럼 짧은 말은 어떤 긴 메시지에도 들어 있을 수 있어서 안에 있기만으로는 사용자가 그렇게 말한 것이 아니다(R3).
export const SHORT_MAX = 10;

// 맞춰 볼 때 쓰는 꼴: 호환 문자를 하나로(전각·풀어 쓴 한글), 소문자, 공백·문장부호·기호(이모지 포함)·서식 문자를 뺀다.
export function normalizeQuote(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}\p{Cf}]+/gu, '');
}

export function quoteMatches(quote, message) {
  const q = normalizeQuote(quote);
  if (!q) return false;
  const m = normalizeQuote(message);
  return Array.from(q).length <= SHORT_MAX ? m === q : m.includes(q);
}

// ---------- 대화 기록 파일 찾기 ----------

// 이 대화의 기록 파일들. 같은 id의 파일이 여러 폴더에 있으면(다른 폴더에서 이어 연 경우) 모두 돌려준다.
// { files, sessionId, root } 또는 { error }. 던지지 않는다.
export function transcriptFiles(env = process.env) {
  const sessionId = String(env.CLAUDE_CODE_SESSION_ID ?? '').trim();
  if (!sessionId) return { error: 'CLAUDE_CODE_SESSION_ID가 없어 이 대화의 기록 파일을 찾을 수 없다' };
  if (!/^[\w.-]+$/.test(sessionId) || sessionId.includes('..')) return { error: `CLAUDE_CODE_SESSION_ID가 올바르지 않다: ${sessionId}` };
  const config = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(env.HOME || os.homedir(), '.claude');
  const root = path.join(config, 'projects');
  let projects;
  try {
    projects = readdirSync(root);
  } catch (error) {
    return { error: `이 대화의 기록 파일을 찾지 못했다 (${path.join(root, '*', `${sessionId}.jsonl`)}: 폴더를 읽지 못함 ${error.code ?? error.message})` };
  }
  const files = [];
  for (const name of projects) {
    const file = path.join(root, name, `${sessionId}.jsonl`);
    try {
      if (statSync(file).isFile()) files.push(file);
    } catch { /* 이 프로젝트 폴더에는 이 대화의 기록이 없다 */ }
  }
  if (!files.length) return { error: `이 대화의 기록 파일을 찾지 못했다 (${path.join(root, '*', `${sessionId}.jsonl`)})` };
  return { files, sessionId, root };
}

// ---------- 사람 메시지 가려내기 ----------

// 사람이 친 말처럼 보이지 않는 시스템 글의 시작 태그. origin이 human이어도 슬래시 명령은 이런 태그로 온다.
const SYSTEM_TAG = /^\s*<(?:command-[\w-]+|local-command-[\w-]+|bash-[\w-]+|system-reminder|task-notification|artifact-content[\w-]*|earlier_turns|cross-session-message|tools-used-before-summary)\b/;

// 글 문자열이거나 글·그림 블록뿐인 배열이면 그 글. 아니면(도구 결과 등) null.
function plainText(content, allowBlocks) {
  if (typeof content === 'string') return content;
  if (!allowBlocks || !Array.isArray(content) || !content.length) return null;
  if (!content.every((block) => block && (block.type === 'text' || block.type === 'image'))) return null;
  const texts = content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text);
  return texts.length ? texts.join('\n') : null;
}

// 기록 파일에서 사람이 한 말을 쓴 순서대로: [{ uuid, time, text, line, via: 'typed'|'answer', question? }]
// line은 파일 안의 줄 번호(1부터)다. 파일을 읽지 못하면 던진다.
export function humanMessages(file) {
  const out = [];
  let line = 0;
  for (const raw of fileLines(file)) {
    line++;
    if (!raw.includes('"user"')) continue; // type이 user인 줄만 읽는다(수십 MB 기록에서 나머지는 해석하지 않는다)
    let rec;
    try { rec = JSON.parse(raw); } catch { continue; } // 깨진 줄은 건너뛴다
    if (!rec || rec.type !== 'user' || rec.isSidechain === true || rec.isMeta === true || rec.isCompactSummary === true) continue;
    if (rec.promptSource === 'system') continue;
    const base = { uuid: typeof rec.uuid === 'string' && rec.uuid ? rec.uuid : `line-${line}`, time: typeof rec.timestamp === 'string' ? rec.timestamp : null, line };
    const result = rec.toolUseResult;
    if (result && typeof result === 'object' && result.answers && typeof result.answers === 'object' && !Array.isArray(result.answers)) {
      for (const [question, answer] of Object.entries(result.answers)) {
        if (typeof answer === 'string' && answer.trim()) out.push({ ...base, text: answer, via: 'answer', question });
      }
      continue;
    }
    const kind = rec.origin && typeof rec.origin === 'object' ? rec.origin.kind : undefined;
    if (kind !== undefined && kind !== 'human') continue; // task-notification, peer, plugin …
    const text = plainText(rec.message?.content, kind === 'human');
    if (text === null || !text.trim()) continue;
    // origin 칸이 없는 줄(옛 기록, claude -p)은 `<`로 시작하면 시스템 글로 본다. human 줄은 알려진 시스템 태그만 뺀다.
    if (kind === 'human' ? SYSTEM_TAG.test(text) : text.trimStart().startsWith('<')) continue;
    out.push({ ...base, text, via: 'typed' });
  }
  return out;
}
