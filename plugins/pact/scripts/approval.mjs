// 사용자 승인과 위임을 코드로 기록하고, 기록이 없으면 만들기를 시작하지 못하게 하는 도구(명세 F2·F3·F5, R2·R3·R8·R9·R10·R11·R12·R19).
// 이 파일이 하는 일: approve·delegate가 인용한 말을 이 대화 기록에서 찾아 맞춰 보고 기록을 남기는 것(recordApproval),
// 만들기를 시작해도 되는지 보는 것(checkStart: set-status approved·building, pact:worker 부르기 훅, verification.mjs snapshot이 쓴다),
// 완료 검사가 보는 것(completionChecks: 검수 번호의 짝, 승인 뒤 바뀐 [사용자] 줄), 보고서가 보이는 것(approvalOverview).
//
// 승인 기록은 판마다 <run-dir>/approvals.jsonl 한 파일에 한 번 기록할 때 한 줄이다. 덧붙이기만 하므로 이력이 쌓인다.
//   { version, kind: 'approve'|'delegate', quote, message, message_uuid, message_time, answer_question,
//     transcript, session_id, recorded_at, spec, spec_checker_time, user_lines }
//   quote            사용자 말로 넘긴 글(그대로)            message        대화 기록에서 찾은 메시지 전문
//   message_uuid     그 메시지 줄의 uuid                   message_time   그 메시지의 timestamp
//   answer_question  AskUserQuestion의 답이면 그 질문, 아니면 null. 승인(approve)에만 생긴다: 위임은 질문 도구의 답을 받지 않는다(R2).
//                    이 규칙 전에 질문 도구의 답으로 만든 옛 위임 기록은 만들기를 시작할 때 거절한다(checkStart).
//                    슬래시 명령의 인자 글(`/pact:pact 출결 앱 만들어 줘. 끝까지 알아서 해`의 뒤쪽)로 기록하면 message가 그 인자 글이다(R9).
//   transcript       찾은 대화 기록 파일의 경로(만들기를 시작할 때 다시 맞춰 보려고)
//   spec_checker_time  approve일 때 맞춰 본 spec-checker의 끝난 시각(위임은 null)
//   user_lines       그때 명세의 [사용자] 줄들(spec.mjs userLinesOf). 머리 줄이 [사용자]인 항목은 { F2: [항목 줄, 케이스 줄, …] },
//                    [AI 가정] 항목 밑의 [사용자] 케이스 줄은 그 줄 하나씩 { 'F3/1': [케이스 줄] }. 지문 대신 줄 글을 그대로 둔다:
//                    뒤에 지금 명세와 견줘 바뀐 줄을 알리고(F3), 보고서가 앞뒤 글을 보이려고
// 이 폴더의 log/와 함께 훅과 스크립트만 쓴다(R14, scripts/locks.mjs가 건다).
//
// 거절은 { ok: false, reason, instead }다(R6: 까닭과 대신 할 일). 확인을 못 하면 거절한다(R7).
import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseSpec, reviewMarks, riskUnits, setStatus, userLinesOf } from './spec.mjs';
import { ensureRunDir } from './paths.mjs';
import { latestSpecCheckerReply, logFile } from './run-log.mjs';
import { SHORT_MAX, humanMessages, normalizeQuote, quoteMatches, transcriptFiles } from './transcript.mjs';

export const APPROVALS_FILE = 'approvals.jsonl';
// 승인 기록 없이 이어 갈 수 있는 옛 명세(R5, R19): frontmatter가 `pact: 1`이고 status가 이 중 하나. 옛 명세라도 draft면 새 규칙을 따른다.
export const LEGACY_STATUSES = ['approved', 'building', 'verifying', 'done'];
export const LEGACY_NOTE = '참고: 옛 판이라 승인 기록 없음';

export const approvalsFile = (runDir) => path.join(runDir, APPROVALS_FILE);
const oneLine = (text) => String(text ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();

// 기록을 쓴 순서대로. 기록이 없으면 []. 깨진 줄은 건너뛴다. 읽을 수 없으면 던진다.
export function readApprovals(runDir) {
  let raw;
  try {
    raw = readFileSync(approvalsFile(runDir), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && (entry.kind === 'approve' || entry.kind === 'delegate')) entries.push(entry);
    } catch { /* 깨진 줄 */ }
  }
  return entries;
}

// 명세 파일에서 판의 위치. scripts/spec.mjs run-dir과 같다: 프로젝트는 명세 폴더의 두 단계 위, run-id는 파일 이름에서 확장자를 뺀 것. 만들지 않는다.
export function runDirOfSpec(specFile) {
  const spec = path.resolve(specFile);
  const project = path.resolve(path.dirname(spec), '..', '..');
  const runId = path.basename(spec, '.md');
  return { spec, project, runId, runDir: path.join(project, '.pact', runId) };
}

// 프로젝트에서 그 판의 명세 파일. 날짜 없는 옛 실행 폴더(`.pact/<주제>`)의 명세는 날짜가 붙은 이름(`<날짜>-<주제>.md`)이다. 없으면 null.
export function findSpecForRun(project, runId) {
  const dir = path.join(project, 'docs', 'pact');
  const exact = path.join(dir, `${runId}.md`);
  try {
    if (statSync(exact).isFile()) return exact;
  } catch { /* 날짜 붙은 이름을 본다 */ }
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  const dated = names
    .filter((name) => name.endsWith('.md') && /^\d{4}-\d{2}-\d{2}-/.test(name) && name.slice('0000-00-00-'.length, -'.md'.length) === runId)
    .map((name) => path.join(dir, name));
  let best = null;
  let bestTime = -1;
  for (const file of dated) {
    try {
      const mtime = statSync(file).mtimeMs;
      if (mtime > bestTime) { best = file; bestTime = mtime; }
    } catch { /* 사라진 파일 */ }
  }
  return best;
}

const readIfExists = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

// 지금 명세의 위험 항목: `[위험: …]` 표시가 있는 F·R 항목(케이스, 접힌 칸 포함). 위임으로는 시작하지 못한다(R10).
// 표시가 빠졌는지는 낱말로 찾지 않는다. spec-checker가 뜻으로 보고 알린다(작업 4).
export const riskItems = (text) => riskUnits(text).filter((unit) => unit.marked);

function describeRisk(units) {
  const ids = units.map((u) => u.id);
  return `${ids.length > 4 ? `${ids.slice(0, 4).join(', ')} 외 ${ids.length - 4}개` : ids.join(', ')}에 [위험: …] 표시가 있다`;
}

// 사용자 말은 표준 입력으로 넘기는 것이 문서의 길이다(probe.md 6): 따옴표 붙인 heredoc이라 말 속의 백틱·$·따옴표가 셸에서 풀리지 않는다.
// 거절 문구는 이 꼴만 알린다. 큰따옴표로 감싼 인자 꼴을 알리면 긴 말 속 백틱이 셸에서 실행될 수 있다.
const HEREDOC_HOW = '다음 줄에 사용자 말을, 그다음 줄 맨 앞에 EOF를 적는다';
const approveCmd = (verb = 'approve') => `spec.mjs ${verb} <명세> - <<'EOF'`;
const ASK_APPROVAL = `명세를 보이고 사용자의 승인을 받아 ${approveCmd()}로 기록한다(${HEREDOC_HOW}).`;

// ---------- 사용자만 답할 수 있음 항목의 짝 (명세 F5, R11) ----------

// spec-checker 답의 '## 사용자만 답할 수 있음' 칸을 읽는다. 항목마다 `검수 n` 번호가 붙어 온다(agents/spec-checker.md).
// 반환: { found, none, items: [{ n, text }] } — found는 칸이 있는지, none은 항목 대신 '없음'이라고 적었는지. 번호는 줄 맨 앞(목록 표시 뒤)에 있는 것만 읽는다.
const REPLY_HEADING = /^\s*(?:#{1,6}\s*)?[*_]*\s*사용자만 답할 수 있음\s*[*_]*\s*[:：]?\s*(.*)$/u;
const REPLY_END = /^\s*(?:#{1,6}\s+\S|[*_]*\s*(?:이미 답이 있음|사소함\s*[—–-]))/u;
const REPLY_ITEM = /^\s*(?:[-*+•]\s*|\d+[.)]\s*)?[*_]*\s*(?:[\[(（【]\s*)?검수\s*(\d+)[*_]*/u;
// '없음' 뒤는 줄 끝·문장부호·괄호일 때만 없음이다('없음에 가깝지만'은 아니다).
const REPLY_NONE = /^\s*(?:[-*+•]\s*)?[*_]*\s*(?:해당\s*)?없(?:음|다|습니다)(?=\s*(?:$|[.,;:!?。…·~)\]）】*_]|[—–-]|[(（\[]))/u;

// 한 칸을 읽는다: start 줄(칸 제목)과 그 줄에 이어 쓴 글(inline), 다음 칸 제목 앞까지의 줄들. { items, none }
function readSection(lines, { start, inline }) {
  const body = inline.trim() ? [inline] : [];
  for (let i = start + 1; i < lines.length && !REPLY_END.test(lines[i]); i++) body.push(lines[i]);
  const items = [];
  const seen = new Set();
  for (const line of body) {
    const m = REPLY_ITEM.exec(line);
    if (!m || seen.has(Number(m[1]))) continue;
    seen.add(Number(m[1]));
    items.push({ n: Number(m[1]), text: line.slice(m[0].length).replace(/^[\s:.)\]）】—–*_-]+/u, '').trim() });
  }
  const first = body.map((line) => line.trim()).find(Boolean) ?? '';
  return { items, none: !items.length && REPLY_NONE.test(first) };
}

// 칸 제목 후보는 '사용자만 답할 수 있음'으로 시작하는 줄 모두다. 답 맨 위의 머리말("사용자만 답할 수 있음 2개를 찾았습니다.")도 후보라서
// 첫 후보만 칸으로 잡으면 뒤의 진짜 칸을 못 읽는다. `#` 제목 줄을 먼저 보고 맨 줄 꼴은 그다음에 보며, 그 가운데 번호나 '없음'을 읽은 첫 후보를 칸으로 고른다.
// 어느 후보에서도 못 읽으면 첫 후보(칸은 있는데 못 읽은 것)를 돌려준다. 보는 후보는 제목 후보가 있으면 제목 후보뿐이다.
export function parseReviewReply(message) {
  const lines = String(message ?? '').split(/\r?\n/);
  const candidates = [];
  lines.forEach((line, start) => {
    const m = REPLY_HEADING.exec(line);
    if (m) candidates.push({ start, inline: m[1], heading: /^\s*#/.test(line) });
  });
  if (!candidates.length) return { found: false, none: false, items: [] };
  // 제목 후보가 하나라도 있으면 제목 후보만 본다. 맨 줄 후보는 제목이 없을 때만 본다(제목 칸을 못 읽었는데 맨 줄의 '없음'으로 통과하지 않게).
  const headings = candidates.filter((c) => c.heading);
  const ordered = headings.length ? headings : candidates;
  for (const candidate of ordered) {
    const read = readSection(lines, candidate);
    if (read.items.length || read.none) return { found: true, ...read };
  }
  return { found: true, ...readSection(lines, ordered[0]) };
}

const clip = (text, max) => {
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
};
// 항목 글에서 질문만: `<질문> (기본안: …) — <달라지는 것>`의 앞부분
export const questionOf = (text) => String(text ?? '').split(/\s*\(기본안/u)[0].trim();
const FIX_REPLY = 'pact:spec-checker를 다시 불러 "## 사용자만 답할 수 있음" 칸에 항목마다 "검수 n" 번호를 붙여(없으면 "없음") 받는다.';

// 가장 최근 spec-checker 답의 검수 번호마다 명세에 짝이 있는지 본다. 없으면 { reason, instead }, 모두 있으면(또는 '없음'이면) null.
// 답에서 번호도 '없음'도 못 읽으면 확인하지 못한 것이라 거절한다(R7). afterwards는 그 경우 대신 할 일 뒤에 붙는 말이다(승인은 검수가 끝난 뒤에 다시 받는다 등).
export function pairingProblem(specText, record, afterwards = '') {
  const reply = parseReviewReply(record?.message);
  const when = record?.time ? ` (${record.time})` : '';
  const fix = afterwards ? `${FIX_REPLY} ${afterwards}` : FIX_REPLY;
  if (!reply.found) return { reason: `spec-checker의 답${when}에 '사용자만 답할 수 있음' 칸이 없어 검수 번호를 읽지 못했다.`, instead: fix };
  if (!reply.items.length && !reply.none) {
    return { reason: `spec-checker의 답${when}의 '사용자만 답할 수 있음' 칸에서 검수 번호(검수 1, 검수 2 …)도 '없음'도 읽지 못했다.`, instead: fix };
  }
  const marks = reviewMarks(specText);
  const gaps = reply.items.filter(({ n }) => !marks.answered.has(n) && !marks.delegated.has(n) && !marks.notAsked.has(n));
  if (!gaps.length) return null;
  const list = gaps.map(({ n, text }) => (questionOf(text) ? `검수 ${n}("${clip(questionOf(text), 30)}")` : `검수 ${n}`)).join(', ');
  // 전각 콜론(：)으로 쓴 태그는 lint가 알 수 없는 태그로 알리는데 approve는 lint를 돌리지 않는다. 짝이 없다고만 하면 태그를 단 사람이 영문을 모르니 그렇다고 알린다.
  const wide = gaps.filter(({ n }) => marks.fullwidth.has(n)).map(({ n }) => `검수 ${n}`);
  const trailing = gaps.filter(({ n }) => marks.afterText.has(n)).map(({ n }) => `검수 ${n}`);
  const hint = (wide.length ? `${wide.join(', ')}의 태그는 콜론이 전각(：)이라 읽히지 않는다. 반각 콜론(:)으로 고친다. ` : '')
    + (trailing.length ? `${trailing.join(', ')}의 태그 뒤에 글자(마침표 등)가 있어 읽히지 않는다. 태그 뒤에 글자를 두지 않는다. ` : '');
  return {
    reason: `spec-checker가 '사용자만 답할 수 있음'으로 짚은 ${list}에 명세의 짝이 없다.`,
    instead: `${hint}물어서 답을 받은 줄에는 [사용자: 검수 n], 사용자가 맡긴 줄에는 [AI 가정: 검수 n 맡김]을 기능·규칙 줄이나 그 케이스 줄의 끝에 달고(한 줄에 태그는 하나다. 번호가 여럿이면 \`[사용자: 검수 n, m]\`처럼 한 태그에 쓴다), 묻지 않은 것은 ## 확인 필요에 "- 검수 n: 안 물은 까닭"으로 적는다`
      + "(위임 중이면 까닭은 '위임이라 기본안으로 정함'). 아직 안 물었고 물어야 하는 것이면 먼저 묻는다.",
  };
}

// ---------- 승인 뒤 바뀐 [사용자] 줄 (명세 F3, R12) ----------

const isLines = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value).every((lines) => Array.isArray(lines) && lines.every((line) => typeof line === 'string'));

// 키가 [AI 가정] 항목 밑 [사용자] 케이스 줄 하나(`F3/1`, `F1#2/1`)를 가리키는가. 아니면 항목 하나(`F2`, `F1#2`)다.
export const isLineKey = (id) => /\/\d+$/.test(id);
// 바뀐 줄을 가리키는 말: 항목은 번호 그대로, 케이스 줄은 `F3의 [사용자] 줄`
export const changeLabel = (change) => (isLineKey(change.id) ? `${change.id.replace(/(?:#\d+)?\/\d+$/, '')}의 [사용자] 줄` : change.id);

// 두 [사용자] 줄 묶음({ <키>: [줄…] })의 다른 점: [{ id, kind: 'changed'|'removed'|'added', before, after }]
export function diffUserLines(before, after) {
  const changes = [];
  for (const [id, lines] of Object.entries(before)) {
    if (!Object.hasOwn(after, id)) changes.push({ id, kind: 'removed', before: lines, after: [] });
    else if (JSON.stringify(after[id]) !== JSON.stringify(lines)) changes.push({ id, kind: 'changed', before: lines, after: after[id] });
  }
  for (const [id, lines] of Object.entries(after)) if (!Object.hasOwn(before, id)) changes.push({ id, kind: 'added', before: [], after: lines });
  return changes;
}

// 그 기록 뒤로 지금 명세의 [사용자] 줄이 어떻게 달라졌는가. 반환: null(같다) | { unknown: true }(기록에 줄이 없어 견줄 수 없다) | { changes }
// 지금 명세에 번호는 있는데 [사용자] 태그가 아니게 된 항목은 'removed'가 아니라 'retagged'(태그가 바뀜)다.
export function userLineDrift(specText, entry) {
  if (!isLines(entry?.user_lines)) return { unknown: true };
  const changes = diffUserLines(entry.user_lines, userLinesOf(specText));
  if (!changes.length) return null;
  const items = parseSpec(specText).items;
  for (const change of changes) {
    if (change.kind !== 'removed' || isLineKey(change.id)) continue;
    const item = items.find((it) => it.id === change.id.replace(/#\d+$/, ''));
    if (item && item.tag !== '사용자') Object.assign(change, { kind: 'retagged', tag: item.rawTag });
  }
  return { changes };
}

// 줄 글을 사람이 읽기 쉽게: 항목 줄의 `- F1 `과 케이스 줄의 `- `를 떼고 ` / `로 잇는다
// head가 true면 첫 줄이 항목 줄(`- F1 …`)이다. [AI 가정] 항목 밑 케이스 줄 하나를 담은 키(`F3/1`)는 항목 줄이 없어 head를 false로 부른다.
const plainLine = (line, head) => String(line).replace(head ? /^-\s+[FR]\d+\s*/ : /^-\s+/, '');
export const plainLines = (lines, { head = true } = {}) => lines.map((line, i) => plainLine(line, head && i === 0)).join(' / ');

// 한 항목의 줄 가운데 처음으로 달라진 곳: 항목 줄이 바뀌었으면 그 줄, 케이스만 바뀌었으면 그 케이스 줄
function firstDifference(before, after, head) {
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    if (before[i] !== after[i]) return { from: before[i] === undefined ? null : plainLine(before[i], head && i === 0), to: after[i] === undefined ? null : plainLine(after[i], head && i === 0) };
  }
  return { from: null, to: null };
}

export function describeChange(change) {
  const quoted = (text) => `"${clip(text, 40)}"`;
  const label = changeLabel(change);
  const head = !isLineKey(change.id);
  switch (change.kind) {
    case 'changed': {
      const { from, to } = firstDifference(change.before, change.after, head);
      if (from === null) return `${label} 바뀜(줄이 더해짐 ${quoted(to)})`;
      if (to === null) return `${label} 바뀜(줄이 빠짐 ${quoted(from)})`;
      return `${label} 바뀜(${quoted(from)} → ${quoted(to)})`;
    }
    case 'retagged': return `${label} 태그가 바뀜(${change.tag ? `[${change.tag}]` : '태그 없음'})`;
    case 'removed': return head ? `${label} 빠짐` : `${label} 빠짐(${quoted(plainLines(change.before, { head }))})`;
    default: return `${label} 더해짐(${quoted(plainLines(change.after, { head }))})`;
  }
}
const describeChanges = (changes, limit = 4) => `${changes.slice(0, limit).map(describeChange).join(', ')}${changes.length > limit ? ` 외 ${changes.length - limit}개` : ''}`;

const kindLabel = (entry) => (entry?.kind === 'delegate' ? '위임' : '승인');

// ---------- 질문 도구의 답은 위임이 아니다 (명세 R2) ----------

// 질문 도구(AskUserQuestion)의 답이라서 위임으로 받지 않을 때의 거절. "알아서"·"ㄱㄱ"가 질문의 답으로 오면 그 질문만 맡긴 것이다.
// 이것까지 위임으로 치면 승인 묻기가 사라진다. 대신 할 일은 두 갈래다: 승인 질문의 답이면 approve로 기록하고, 위임은 사용자가 직접 쓴 말을 인용한다.
// recorded: 지금 인용하는 말이 아니라 이미 남은 위임 기록(규칙이 생기기 전의 것)을 만들기를 시작할 때 거절하는 경우. 그 기록에 쓴 메시지는
// 다시 기록할 때 쓸 수 없으니(앞 기록보다 새 말이어야 한다) 사용자에게 새로 받게 한다.
const answerQuestion = (question) => (question ? `(질문: "${clip(question, 40)}")` : '');
function answerRefusal(said, question, { recorded = false } = {}) {
  return recorded
    ? {
      reason: `위임 기록의 인용이 질문 도구(AskUserQuestion)의 답이다: "${said}"${answerQuestion(question)}. 질문의 답은 그 질문만 맡긴 것이라 위임이 아니다.`,
      instead: `사용자에게 승인을 다시 받아 ${approveCmd()}로 기록한다(${HEREDOC_HOW}). 위임이면 사용자가 직접 쓴 새 말을 인용해 ${approveCmd('delegate')}로 다시 기록한다.`,
    }
    : {
      reason: `위임으로 인용한 말이 질문 도구(AskUserQuestion)의 답이다: "${said}"${answerQuestion(question)}. 질문의 답은 그 질문만 맡긴 것이라 위임으로 기록하지 않는다.`,
      instead: `승인 질문의 답이면 ${approveCmd()}로 기록한다(${HEREDOC_HOW}). 위임은 사용자가 직접 쓴 말을 인용해 ${approveCmd('delegate')}로 기록한다.`,
    };
}
// 기록이 질문 도구의 답으로 만든 것인가. answer_question은 빈 글('')일 수도 있어 null·undefined만 아닌지 본다.
const madeFromAnswer = (entry) => entry?.answer_question !== null && entry?.answer_question !== undefined;

// 슬래시 명령의 인자로 위임할 때만 짧은 말이 인자 안의 문장 하나와 같아도 맞는다(transcript.mjs quoteMatches의 sentences).
// 승인은 늘 메시지 전체와 같아야 한다: 승인은 검수 뒤에 받는 답이지 처음 부탁 속에 섞인 말이 아니다(R9).
const matchOptions = (kind, message) => ({ sentences: kind === 'delegate' && message.via === 'command' });

const AGAIN = `바꿔 달라고 한 사용자 말을 인용해 ${approveCmd()}로 다시 기록한다(${HEREDOC_HOW}). 사용자가 파일을 직접 고쳤으면 한 번 묻고 그 답을 인용한다.`;

// 승인 뒤 [사용자] 줄이 바뀌었는가. 바뀌었으면(또는 견줄 수 없으면) { reason, instead }, 같으면 null.
export function driftProblem(specText, entry) {
  const drift = userLineDrift(specText, entry);
  if (!drift) return null;
  const label = kindLabel(entry);
  if (drift.unknown) {
    return { reason: `가장 최근 ${label} 기록에 [사용자] 줄이 없어 승인 뒤 바뀐 줄이 있는지 확인하지 못한다.`, instead: AGAIN };
  }
  return { reason: `승인 뒤 [사용자] 줄이 바뀌었다(가장 최근 ${label} 기록 ${entry.recorded_at ?? '시각 모름'}): ${describeChanges(drift.changes)}.`, instead: AGAIN };
}

// ---------- 기록하기 ----------

// approve·delegate. quote는 사용자가 한 말이다. 맞으면 기록을 덧붙이고, status가 draft면 approved로 바꾼다(building·verifying이면 그대로 둔다).
// 기록 전에 보는 것: 위임이면 위험 표시, 승인이면 spec-checker가 끝난 뒤의 말인지, 둘 다 가장 최근 spec-checker 답의 검수 번호에 명세의 짝이 있는지(F5),
// 앞 기록이 있으면 인용한 말이 앞 기록들의 어떤 메시지보다 새것인지(승인도 위임도 — 위임 중에 [사용자] 줄을 바꾸고 옛 위임 말로 다시 기록해 F3를 비켜 가지 못하게).
// 인용을 맞춰 보는 말: 승인은 사용자가 친 말, 일하는 도중에 친 말, 질문 도구의 답, 슬래시 명령의 인자 글이다.
// 위임은 질문 도구의 답만 뺀 나머지다(R2: 질문의 답은 그 질문만 맡긴 것). 위임만 슬래시 명령의 인자에서 짧은 말을 문장 하나로 맞춰 볼 수 있다(matchOptions).
// 반환: { ok: true, entry, runDir, message } | { ok: false, reason, instead }. 읽지 못하면 던진다(부르는 쪽이 거절로 보인다).
export function recordApproval(specFile, quote, kind, { env = process.env, now = new Date() } = {}) {
  const verb = kind === 'delegate' ? 'delegate' : 'approve';
  const label = kind === 'delegate' ? '위임' : '승인';
  const refuse = (reason, instead) => ({ ok: false, reason, instead });
  const { spec, project, runId, runDir } = runDirOfSpec(specFile);
  const text = readFileSync(spec, 'utf8');
  const said = String(quote ?? '').trim();
  if (!normalizeQuote(said)) return refuse('인용한 사용자 말이 비어 있다.', `사용자가 한 말을 그대로 넣는다: ${approveCmd(verb)} (${HEREDOC_HOW}).`);

  // 위임은 위험 항목이 없을 때만: 지우기·외부 공개·돈 드는 일은 사용자가 승인을 말해야 한다(F2 케이스)
  if (kind === 'delegate') {
    const risks = riskItems(text);
    if (risks.length) return refuse(`위험 항목이 있어 위임으로 기록하지 않는다: ${describeRisk(risks)}.`, ASK_APPROVAL);
  }

  // 승인은 spec-checker가 끝난 뒤의 말이어야 한다(R9): 검수 전에 받은 '좋아'를 승인으로 쓰지 않게
  const checker = latestSpecCheckerReply(runDir);
  let checkerMs = null;
  if (kind === 'approve') {
    if (!checker) {
      return refuse(
        `이 명세의 spec-checker 기록이 없다 (${logFile(runDir)}).`,
        'pact:spec-checker로 명세를 검수한 뒤, 결과를 반영한 명세로 사용자의 승인을 받아 다시 실행한다. '
          + '이미 검수했는데도 기록이 없으면 훅이 돌지 않는 것이다. 플러그인 데이터 폴더의 hook-error.log를 보고 사용자에게 알린다(log/에 직접 쓰지 않는다).',
      );
    }
    checkerMs = Date.parse(checker.time);
    if (!Number.isFinite(checkerMs)) return refuse(`spec-checker 기록의 시각을 읽지 못했다 (${checker.time}).`, 'pact:spec-checker를 다시 불러 검수한 뒤 승인을 받는다.');
  }
  // spec-checker가 '사용자만 답할 수 있음'으로 짚은 검수 번호마다 명세에 짝이 있어야 한다(F5). 위임은 검수 기록이 아직 없을 수 있어 있을 때만 본다(완료 검사가 기록을 요구한다).
  const gap = checker ? pairingProblem(text, checker, kind === 'approve' ? '승인은 그 검수가 끝난 뒤에 다시 받는다.' : '그다음 delegate를 다시 실행한다.') : null;
  if (gap) return refuse(gap.reason, gap.instead);

  const found = transcriptFiles(env);
  if (found.error) return refuse(`${found.error}.`, '이 대화의 셸(CLAUDE_CODE_SESSION_ID가 있는 곳)에서 실행한다. 대화 기록을 확인하지 못하면 기록하지 않는다.');
  const messages = [];
  const seen = new Set();
  for (const file of found.files) {
    for (const message of humanMessages(file)) {
      const key = `${message.uuid}\0${message.question ?? ''}`;
      if (seen.has(key)) continue; // 같은 대화를 다른 폴더에서 이어 열어 두 파일에 같은 줄이 있을 수 있다
      seen.add(key);
      messages.push({ ...message, file });
    }
  }

  // 위임은 사용자가 직접 쓴 말만 받는다: 질문 도구의 답은 그 질문만 맡긴 것이다(R2). 승인은 질문의 답도 받는다.
  const pool = kind === 'delegate' ? messages.filter((message) => message.via !== 'answer') : messages;
  const matches = pool.filter((message) => quoteMatches(said, message.text, matchOptions(kind, message)));
  if (!matches.length) {
    // 직접 쓴 말에는 없고 질문 도구의 답으로만 있으면 까닭을 따로 알린다(그냥 '메시지에 없다'고 하면 왜 안 되는지 알 수 없다)
    const answered = kind === 'delegate' ? messages.find((message) => message.via === 'answer' && quoteMatches(said, message.text)) : null;
    if (answered) {
      const refusal = answerRefusal(said, answered.question);
      return refuse(refusal.reason, refusal.instead);
    }
    const q = normalizeQuote(said);
    const inside = Array.from(q).length <= SHORT_MAX && pool.some((message) => normalizeQuote(message.text).includes(q));
    return inside
      ? refuse(`"${said}"은 짧은 말이라 사용자 메시지 전체와 같아야 하는데, 더 긴 메시지의 일부로만 있다.`, `메시지 전체를 그대로 인용한다(정리해서 ${SHORT_MAX}자를 넘는 말이면 일부만 인용해도 된다).`)
      : refuse(`인용한 말이 이 대화의 사용자 메시지에 없다: "${said}".`, '사용자가 실제로 한 말을 그대로 넣는다. 아직 사용자에게 묻지 않았으면 먼저 묻는다.');
  }

  const ms = (message) => Date.parse(message.time ?? '');
  let candidates = matches;
  // 다시 기록할 때: 앞 기록에 쓴 어떤 메시지보다도 새 말이어야 한다. 같은 말을 다시 쓰면 '이미 승인받았다'는 믿음이 된다.
  // 위임도 같다: 위임 중에 [사용자] 줄을 바꾸고 옛 위임 말로 다시 기록하면 F3를 비켜 간다.
  const previous = readApprovals(runDir).map((entry) => Date.parse(entry.message_time)).filter(Number.isFinite);
  if ((kind === 'approve' || previous.length) && !candidates.some((message) => Number.isFinite(ms(message)))) {
    return refuse('인용한 메시지의 시각을 대화 기록에서 읽지 못했다.', '대화 기록에 시각이 있는 사용자 말을 인용한다.');
  }
  if (kind === 'approve') {
    candidates = candidates.filter((message) => Number.isFinite(ms(message)) && ms(message) > checkerMs);
    if (!candidates.length) return refuse(`그 말은 spec-checker가 끝난 뒤(${checker.time})의 말이 아니다.`, '검수 결과를 반영한 명세로 승인을 다시 묻고, 그 답을 인용한다.');
  }
  if (previous.length) {
    const latestUsed = Math.max(...previous);
    candidates = candidates.filter((message) => Number.isFinite(ms(message)) && ms(message) > latestUsed);
    if (!candidates.length) return refuse(`그 말은 앞 승인 기록에 쓴 메시지(${new Date(latestUsed).toISOString()})와 같거나 더 오래됐다.`, '명세가 바뀌어 다시 승인을 받는 것이면 사용자의 새 말을 인용한다.');
  }
  // 맞는 말이 여럿이면 가장 최근 것
  const chosen = candidates.reduce((best, message) => {
    const a = Number.isFinite(ms(message)) ? ms(message) : -Infinity;
    const b = Number.isFinite(ms(best)) ? ms(best) : -Infinity;
    return a > b || (a === b && message.line > best.line) ? message : best;
  });

  // 바꿀 명세 글을 먼저 만든다: frontmatter가 없는 명세처럼 status를 못 바꾸는 경우에 기록만 남기지 않으려고(던진다).
  const current = readFileSync(spec, 'utf8');
  const approved = setStatus(current, 'approved');
  const entry = {
    version: 1,
    kind,
    quote: said,
    message: chosen.text,
    message_uuid: chosen.uuid,
    message_time: chosen.time,
    answer_question: chosen.via === 'answer' ? chosen.question : null,
    transcript: chosen.file,
    session_id: found.sessionId,
    recorded_at: now.toISOString(),
    spec,
    spec_checker_time: kind === 'approve' ? checker.time : null,
    user_lines: userLinesOf(current), // 이 승인이 덮는 [사용자] 줄들(F3): 뒤에 바뀌면 다시 승인을 받는다
  };
  // status는 draft(이미 approved면 그대로)일 때만 approved로 바꾼다. 만드는 중(building)·검수 중(verifying)에 다시 승인하거나 위임을 적어도
  // 진행 중인 status를 되돌리지 않는다: 기록만 더한다(다시 승인한 뒤 이어 가는 길은 build.md의 "[사용자] 항목을 바꿀 때"가 말한다).
  const status = parseSpec(current).frontmatter.status;
  const moves = status === 'draft' || status === 'approved';
  ensureRunDir(project, runId);
  appendFileSync(approvalsFile(runDir), `${JSON.stringify(entry)}\n`);
  // 기록이 먼저다. status만 바뀌고 기록이 없는 일은 없다(기록은 남았는데 status 쓰기가 실패하면 set-status <명세> approved로 이어 간다).
  if (moves) writeFileSync(spec, approved);
  const when = chosen.time ? ` (메시지 ${chosen.time})` : '';
  const after = moves ? 'status approved' : `status는 ${status ?? '없음'} 그대로`;
  return { ok: true, entry, runDir, message: `${label}을 기록했다: "${said}"${when} → ${after}` };
}

// ---------- 다시 맞춰 보기 ----------

// 기록한 인용이 기록한 대화 기록에 지금도 있는지: 메시지 uuid로 찾아 글이 같고 인용이 그 글과 맞는지. 위임 기록을 만들기를 시작할 때 본다.
export function recheckEntry(entry) {
  const file = typeof entry?.transcript === 'string' ? entry.transcript : '';
  if (!file) return { ok: false, reason: '기록에 대화 기록 경로가 없다' };
  let messages;
  try {
    messages = humanMessages(file);
  } catch (error) {
    return { ok: false, reason: `기록한 대화 기록을 읽지 못했다 (${file}: ${error.code ?? error.message})` };
  }
  const hit = messages.find((message) => message.uuid === entry.message_uuid && (message.question ?? null) === (entry.answer_question ?? null));
  if (!hit) return { ok: false, reason: `대화 기록에서 기록한 메시지(${entry.message_uuid})를 다시 찾지 못했다 (${file})` };
  if (hit.text !== entry.message) return { ok: false, reason: '대화 기록의 그 메시지 글이 기록한 글과 다르다' };
  if (!quoteMatches(entry.quote, hit.text, matchOptions(entry.kind, hit))) return { ok: false, reason: '기록한 인용이 그 메시지와 맞지 않는다' };
  return { ok: true };
}

// ---------- 시작해도 되는지 ----------

// purpose: 'approved'(set-status approved) | 'building'(set-status building) | 'worker'(pact:worker 부르기) | 'snapshot'(verification.mjs snapshot)
// 명세는 specFile로, 또는 훅처럼 프로젝트와 run-id로 가리킨다.
//   기록이 있으면 통과. 없으면 옛 명세(R5, R19)만 통과하고 note를 준다.
//   만들기를 시작할 때(building, worker) 마지막 기록이 위임이면 지금 명세를 다시 본다: 질문 도구의 답으로 만든 위임이면 거절하고(R2, 규칙이 생기기 전의 옛 기록),
//   위험 항목이 생겼으면 거절하고, 인용도 다시 맞춰 본다.
//   pact:worker를 부를 때와 검수를 시작할 때(worker, snapshot)는 가장 최근 기록 뒤로 [사용자] 줄이 바뀌었는지도 본다(F3): 바뀌었으면 거절하고 다시 승인을 받게 한다.
// 반환: { ok: true, mode: 'record'|'legacy', note?, kind?, entry? } | { ok: false, reason, instead }
// 승인 기록을 읽지 못하면 던진다(스크립트는 거절로 보이고, 훅은 오류로 기록하고 통과시킨다 — R7).
export function checkStart({ specFile, project, runId, purpose }) {
  const ref = specFile
    ? runDirOfSpec(specFile)
    : { project, runId, runDir: path.join(project, '.pact', runId), spec: findSpecForRun(project, runId) };
  const entries = readApprovals(ref.runDir);
  if (!entries.length) {
    const text = ref.spec ? readIfExists(ref.spec) : null;
    if (text !== null) {
      const fm = parseSpec(text).frontmatter;
      if (fm.pact === '1' && LEGACY_STATUSES.includes(fm.status)) return { ok: true, mode: 'legacy', note: LEGACY_NOTE };
    }
    const where = text === null ? `이 판(${ref.runId})의 명세를 찾지 못하고 승인 기록도 없다` : `승인 기록이 없다 (${approvalsFile(ref.runDir)})`;
    return {
      ok: false,
      reason: `${where}.`,
      instead: `사용자가 승인한 말을 그대로 넣어 ${approveCmd()}로 먼저 기록한다(${HEREDOC_HOW}. 승인까지 맡긴다고 한 말이면 delegate).`,
    };
  }
  const last = entries[entries.length - 1];
  let text; // 지금 명세 글. 위임을 다시 볼 때와 [사용자] 줄을 견줄 때 쓰고, 한 번만 읽는다.
  const specText = () => {
    if (text === undefined) text = ref.spec ? readIfExists(ref.spec) : null;
    return text;
  };
  if (last.kind === 'delegate' && (purpose === 'building' || purpose === 'worker')) {
    // 질문 도구의 답으로 만든 위임은 위임이 아니다(R2). 이 규칙 전에 남은 옛 기록이 여기서 걸린다. 명세도 대화 기록도 읽지 않고 기록만 보고 안다.
    if (madeFromAnswer(last)) return { ok: false, ...answerRefusal(last.quote, last.answer_question, { recorded: true }) };
    const now = specText();
    if (now === null) return { ok: false, reason: `위임 기록을 다시 확인하려는데 명세를 찾지 못했다 (판 ${ref.runId}).`, instead: '맥락 칸의 run-dir이 맞는지 확인하고, 명세를 보이고 승인을 받아 spec.mjs approve로 기록한다.' };
    const risks = riskItems(now);
    if (risks.length) return { ok: false, reason: `위임으로 시작하려는데 지금 명세에 위험 항목이 있다: ${describeRisk(risks)}.`, instead: ASK_APPROVAL };
    const again = recheckEntry(last);
    if (!again.ok) return { ok: false, reason: `위임 기록의 인용을 다시 맞춰 보지 못했다: ${again.reason}.`, instead: `사용자에게 승인을 다시 받아 ${approveCmd()}로 기록한다(${HEREDOC_HOW}).` };
  }
  if (purpose === 'worker' || purpose === 'snapshot') {
    const now = specText();
    if (now === null) return { ok: false, reason: `승인 뒤 [사용자] 줄이 바뀌었는지 확인하려는데 명세를 찾지 못했다 (판 ${ref.runId}).`, instead: '맥락 칸의 run-dir이 맞는지 확인한다.' };
    const drift = driftProblem(now, last);
    if (drift) return { ok: false, ...drift };
  }
  return { ok: true, mode: 'record', kind: last.kind, entry: last };
}

// ---------- 완료 검사가 보는 것 ----------

const SPEC_CHECKER_MISSING = 'pact:spec-checker로 명세를 검수하고 결과를 명세에 반영한다. 이미 검수했는데도 기록이 없으면 훅이 돌지 않는 것이니 플러그인 데이터 폴더의 hook-error.log를 보고 사용자에게 알린다(log/에 직접 쓰지 않는다).';

// verification.mjs의 checkVerification(check·보고서·finish)이 부른다. 문제를 한 줄씩 돌려준다. []이면 통과.
// 옛 판(승인 기록 없는 pact: 1 명세)은 건너뛴다(R5). 새 명세는 승인 기록이 있어야 하고(없으면 견줄 것이 없다),
// spec-checker가 끝난 기록이 있어야 하며, 그 답의 검수 번호마다 명세에 짝이 있어야 하고(F5), 승인 뒤 [사용자] 줄이 바뀌지 않았어야 한다(F3).
// 기록을 읽지 못하면 던진다(거절로 끝난다 — R7).
export function completionChecks(specFile, text) {
  const { runDir } = runDirOfSpec(specFile);
  const gate = checkStart({ specFile, purpose: 'finish' });
  if (!gate.ok) return [refusalLine(gate)];
  if (gate.mode === 'legacy') return [];
  const issues = [];
  const checker = latestSpecCheckerReply(runDir);
  if (!checker) issues.push(refusalLine({ reason: `이 판에 spec-checker가 끝난 기록이 없다 (${logFile(runDir)}).`, instead: SPEC_CHECKER_MISSING }));
  else {
    const gap = pairingProblem(text, checker);
    if (gap) issues.push(refusalLine(gap));
  }
  const drift = driftProblem(text, gate.entry);
  if (drift) issues.push(refusalLine(drift));
  return issues;
}

// ---------- 보고서가 보이는 것 ----------

// 승인 기록의 현황 (명세 R5, R8, R12). 읽는 데 실패해도 던지지 않는다: 보고서 만들기는 멈추지 않는다.
//   state  'recorded' 기록이 있다 | 'legacy' 옛 판이라 승인 기록 없음(R5) | 'missing' 새 명세인데 기록이 없다 | 'unreadable' 기록을 못 읽었다 | 'unknown' 기록도 명세도 없다
//   rows   기록마다 { entry, label('승인'|'위임'), changes } — changes는 앞 기록 뒤로 바뀐 [사용자] 줄들(첫 기록은 [], 견줄 줄이 없으면 null)
//   pending  가장 최근 기록 뒤로 지금 명세에서 바뀐 줄이 아직 다시 승인되지 않은 것 (userLineDrift의 반환: null이면 없음)
export function approvalOverview(specText, runDir) {
  let entries;
  try {
    entries = readApprovals(runDir);
  } catch (error) {
    return { state: 'unreadable', reason: error.code ?? error.message };
  }
  if (!entries.length) {
    if (specText === null) return { state: 'unknown' };
    const fm = parseSpec(specText).frontmatter;
    return { state: fm.pact === '1' && LEGACY_STATUSES.includes(fm.status) ? 'legacy' : 'missing' };
  }
  const rows = entries.map((entry, i) => ({
    entry,
    label: kindLabel(entry),
    changes: i === 0 ? [] : isLines(entries[i - 1].user_lines) && isLines(entry.user_lines) ? diffUserLines(entries[i - 1].user_lines, entry.user_lines) : null,
  }));
  return { state: 'recorded', rows, pending: specText === null ? null : userLineDrift(specText, entries[entries.length - 1]) };
}

// `## 확인 필요`의 `- 검수 n: 안 물은 까닭` 항목. 보고서의 할 일에 저절로 올라간다(명세 R11): 사용자가 묻지 않고 정한 것을 알아보게.
// 반환: [{ n, reason, question }] — question은 spec-checker 답의 그 번호 질문(못 읽으면 null)
export function notAskedItems(specText, runDir) {
  const { notAsked } = reviewMarks(specText);
  if (!notAsked.size) return [];
  const questions = new Map();
  try {
    const checker = latestSpecCheckerReply(runDir);
    if (checker) for (const item of parseReviewReply(checker.message).items) questions.set(item.n, questionOf(item.text));
  } catch { /* 질문 글이 없어도 까닭은 보인다 */ }
  return [...notAsked].sort((a, b) => a[0] - b[0]).map(([n, reason]) => ({ n, reason, question: questions.get(n) || null }));
}

// 거절을 한 줄로 (R6)
export const refusalLine = (verdict) => [verdict.reason, verdict.instead].map(oneLine).filter(Boolean).join(' ');
