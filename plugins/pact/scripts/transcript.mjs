// 이 대화의 기록(JSONL)에서 사용자가 한 말을 찾는 도구. 승인·위임 기록(approval.mjs)이 인용한 말을 맞춰 볼 때 쓴다. 읽기만 한다.
//
// 대화 기록 위치: <설정 폴더>/projects/<프로젝트 이름>/<세션 id>.jsonl
//   설정 폴더는 CLAUDE_CONFIG_DIR, 없으면 ~/.claude. 세션 id는 Bash 환경의 CLAUDE_CODE_SESSION_ID로, 메인 대화 기록 파일 이름과 같다
//   (하위 에이전트 안에서도 같은 값이다). 프로젝트 이름은 대화를 처음 연 폴더에서 정해져 지금 cwd로는 알 수 없으므로
//   projects/ 밑 폴더를 모두 본다.
//
// 사람 메시지는 이렇게 가려낸다. 이 컴퓨터의 진짜 기록 3057개에서 본 모양이다.
//   type이 user인 줄
//     사람 말   origin.kind가 human(promptSource는 typed·queued·suggestion_accepted·sdk 등 — 사람이 보낸 말이다)이거나, origin 칸이 없는
//               옛 기록·claude -p의 말. 글 문자열이거나 글·그림 블록의 배열(그림이 붙은 말).
//     뺀다      isMeta · isCompactSummary(지난 사용자 말을 인용해 담은 요약) · isSidechain(하위 에이전트 쪽 줄)
//               origin이 task-notification(하위 에이전트가 쓴 글이 그대로 든다) · peer(다른 세션) · plugin 등 human이 아닌 것
//               도구 결과(content가 tool_result 블록 배열), 명령 메시지(<command-name> 같은 태그로 시작), <system-reminder>·<local-command-…>
//     예외      AskUserQuestion의 답은 그 줄의 toolUseResult.answers(질문 → 답)에 있다. 사람이 고른 말이라 인정한다.
//               (승인에는 쓰고 위임에는 쓰지 않는다: 질문의 답은 그 질문만 맡긴 것이다. 거르는 곳은 approval.mjs, 여기서는 via로 알린다.)
//     예외      사람이 친 슬래시 명령(origin이 human)의 줄은 `<command-message>이름</command-message>\n<command-name>/이름</command-name>`에
//               인자가 있으면 `\n<command-args>글</command-args>`가 붙는다. 그 인자 글만 사용자 말이다(명령 이름과 태그는 뺀다).
//               인자가 없거나 비었거나 공백뿐인 명령, origin 칸이 없는 내장 명령(/effort, /mcp …), origin이 human이 아닌 명령은 뺀다.
//               모델이 Skill 도구로 부른 스킬은 assistant의 tool_use로만 남고 <command-name> user 줄이 없으며, 스킬 본문을 펼친 줄은 isMeta라서 섞이지 않는다.
//   type이 attachment인 줄 — 에이전트가 일하는 도중에 사용자가 친 말은 user 줄이 아니라 이 꼴로만 남는다:
//     { type: 'attachment', uuid, timestamp, attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt } }
//     사람 말   attachment.type이 queued_command, commandMode가 prompt, attachment.origin.kind가 human인 것. 글은 attachment.prompt
//               (문자열이거나 글·그림 블록). uuid와 시각은 그 줄의 것이다.
//     뺀다      같은 꼴이어도 commandMode가 task-notification이거나 origin이 task-notification·peer(<agent-message>,
//               <cross-session-message>)인 것, 시스템 태그로 시작하는 글. queued_command가 아닌 attachment(hook_success 등)도 뺀다.
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

// 문장 경계: 줄바꿈, 또는 마침표·느낌표·물음표·말줄임표 바로 뒤의 공백. "v1.2"의 점처럼 뒤에 공백이 없으면 경계가 아니다.
const SENTENCE_BREAK = /\r?\n|(?<=[.!?。！？…])\s+/u;

// sentences: 짧은 말이 메시지 전체가 아니라 그 안의 문장 하나와 같아도 맞는다. 슬래시 명령의 인자로 위임할 때만 켠다(approval.mjs):
// 인자는 부탁 한 덩이를 한 줄에 이어 쓴 글이라 위임하는 말이 그 안의 문장 하나로 들어 있다("출결 앱 만들어 줘. 끝까지 알아서 해").
// 문장 하나 안에 다른 말이 더 있으면("끝까지 알아서 해줘 근데 승인은 내가 할게") 여전히 맞지 않는다.
export function quoteMatches(quote, message, { sentences = false } = {}) {
  const q = normalizeQuote(quote);
  if (!q) return false;
  const m = normalizeQuote(message);
  if (Array.from(q).length > SHORT_MAX) return m.includes(q);
  if (m === q) return true;
  return sentences && String(message ?? '').split(SENTENCE_BREAK).some((part) => normalizeQuote(part) === q);
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
const SYSTEM_TAG = /^\s*<(?:command-[\w-]+|local-command-[\w-]+|bash-[\w-]+|system-reminder|task-notification|artifact-content[\w-]*|earlier_turns|cross-session-message|agent-message|tools-used-before-summary)\b/;

// 글 문자열이거나 글·그림 블록뿐인 배열이면 그 글. 아니면(도구 결과 등) null.
function plainText(content, allowBlocks) {
  if (typeof content === 'string') return content;
  if (!allowBlocks || !Array.isArray(content) || !content.length) return null;
  if (!content.every((block) => block && (block.type === 'text' || block.type === 'image'))) return null;
  const texts = content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text);
  return texts.length ? texts.join('\n') : null;
}

// 사람이 친 슬래시 명령 줄의 글(진짜 기록에서 본 꼴): `<command-message>이름</command-message>`과 `<command-name>/이름</command-name>`이 한 번씩
// (순서는 어느 쪽이든), 인자가 있으면 맨 끝에 `<command-args>글</command-args>`. 인자 글은 끝의 닫는 태그까지 그대로 읽어
// 글 속에 태그 글자가 있어도 잘리지 않는다. 이 꼴이 아니면 null: 명령 줄이 아니거나 모르는 꼴이다(모르는 꼴은 시스템 글로 보고 뺀다).
// 반환: { name, args } — args는 인자가 없으면 ''.
const COMMAND_LINE = /^\s*(?:<command-message>[^<]*<\/command-message>\s*<command-name>([^<]*)<\/command-name>|<command-name>([^<]*)<\/command-name>\s*<command-message>[^<]*<\/command-message>)\s*(?:<command-args>([\s\S]*)<\/command-args>)?\s*$/;
function commandLine(text) {
  const m = COMMAND_LINE.exec(text);
  return m ? { name: (m[1] ?? m[2]).trim(), args: m[3] ?? '' } : null;
}

// 기록 파일에서 사람이 한 말을 쓴 순서대로: [{ uuid, time, text, line, via: 'typed'|'queued'|'answer'|'command', question?, command? }]
// via: typed는 user 줄의 말, queued는 일하는 도중에 친 말(attachment 줄), answer는 AskUserQuestion의 답, command는 사람이 친 슬래시 명령의 인자 글
// (command에는 명령 이름, 예 `/pact:pact`). line은 파일 안의 줄 번호(1부터)다. 파일을 읽지 못하면 던진다.
export function humanMessages(file) {
  const out = [];
  let line = 0;
  for (const raw of fileLines(file)) {
    line++;
    // user 줄과 일하는 도중에 친 말(queued_command)만 읽는다(수십 MB 기록에서 나머지는 해석하지 않는다)
    if (!raw.includes('"user"') && !raw.includes('"queued_command"')) continue;
    let rec;
    try { rec = JSON.parse(raw); } catch { continue; } // 깨진 줄은 건너뛴다
    if (!rec || rec.isSidechain === true || rec.isMeta === true || rec.isCompactSummary === true) continue;
    const base = {
      uuid: typeof rec.uuid === 'string' && rec.uuid ? rec.uuid : `line-${line}`,
      time: typeof rec.timestamp === 'string' ? rec.timestamp : (typeof rec.attachment?.timestamp === 'string' ? rec.attachment.timestamp : null),
      line,
    };

    if (rec.type === 'attachment') {
      const a = rec.attachment;
      if (!a || typeof a !== 'object' || a.type !== 'queued_command' || a.commandMode !== 'prompt') continue;
      if (!(a.origin && typeof a.origin === 'object' && a.origin.kind === 'human')) continue; // task-notification, peer …
      const text = plainText(a.prompt, true);
      if (text === null || !text.trim() || SYSTEM_TAG.test(text)) continue;
      out.push({ ...base, text, via: 'queued' });
      continue;
    }

    if (rec.type !== 'user' || rec.promptSource === 'system') continue;
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
    // 사람이 친 슬래시 명령(origin이 human)은 인자 글만 사용자 말이다. 인자가 없거나 비었으면 말이 아니다.
    // origin 칸이 없는 줄은 여기 오지 않는다: 내장 명령(/effort, /mcp …)과 옛 기록의 명령은 아래에서 시스템 글로 빠진다.
    if (kind === 'human') {
      const command = commandLine(text);
      if (command) {
        if (command.args.trim()) out.push({ ...base, text: command.args, via: 'command', command: command.name });
        continue;
      }
    }
    // origin 칸이 없는 줄(옛 기록, claude -p)은 `<`로 시작하면 시스템 글로 본다. human 줄은 알려진 시스템 태그만 뺀다.
    if (kind === 'human' ? SYSTEM_TAG.test(text) : text.trimStart().startsWith('<')) continue;
    out.push({ ...base, text, via: 'typed' });
  }
  return out;
}
