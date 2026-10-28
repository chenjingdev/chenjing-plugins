// 사용자 승인과 위임을 코드로 기록하고, 기록이 없으면 만들기를 시작하지 못하게 하는 도구(명세 F2, R2·R3·R8·R9·R10·R19).
// 이 파일이 하는 일: approve·delegate가 인용한 말을 이 대화 기록에서 찾아 맞춰 보고 기록을 남기는 것(recordApproval),
// 만들기를 시작해도 되는지 보는 것(checkStart: set-status approved·building, pact:worker 부르기 훅, verification.mjs snapshot이 쓴다).
//
// 승인 기록은 판마다 <run-dir>/approvals.jsonl 한 파일에 한 번 기록할 때 한 줄이다. 덧붙이기만 하므로 이력이 쌓인다.
//   { version, kind: 'approve'|'delegate', quote, message, message_uuid, message_time, answer_question,
//     transcript, session_id, recorded_at, spec, spec_checker_time }
//   quote            사용자 말로 넘긴 글(그대로)            message        대화 기록에서 찾은 메시지 전문
//   message_uuid     그 메시지 줄의 uuid                   message_time   그 메시지의 timestamp
//   answer_question  AskUserQuestion의 답이면 그 질문, 아니면 null
//   transcript       찾은 대화 기록 파일의 경로(만들기를 시작할 때 다시 맞춰 보려고)
//   spec_checker_time  approve일 때 맞춰 본 spec-checker의 끝난 시각(위임은 null)
// 이 폴더의 log/와 함께 훅과 스크립트만 쓴다(R14의 잠금은 뒤 작업이 건다). 보고서 표시와 [사용자] 줄 지문도 뒤 작업이 이 기록에 더한다.
//
// 거절은 { ok: false, reason, instead }다(R6: 까닭과 대신 할 일). 확인을 못 하면 거절한다(R7).
import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseSpec, riskUnits, setStatus } from './spec.mjs';
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

// 지금 명세의 위험 항목: 위험 표시가 있거나, 표시 없이도 위험 낱말이 있는 F·R 항목. 위임으로는 시작하지 못한다(R10).
export const riskItems = (text) => riskUnits(text).filter((unit) => unit.marked || unit.words.length);

function describeRisk(units) {
  const parts = units.map((u) => `${u.id}(${u.marked ? '위험 표시' : `낱말 ${u.words.join('·')}`})`);
  return parts.length > 4 ? `${parts.slice(0, 4).join(', ')} 외 ${parts.length - 4}개` : parts.join(', ');
}
const ASK_APPROVAL = '명세를 보이고 사용자의 승인을 받아 spec.mjs approve <명세> "<사용자 말>"로 기록한다.';

// ---------- 기록하기 ----------

// approve·delegate. quote는 사용자가 한 말이다. 맞으면 기록을 덧붙이고 명세의 status를 approved로 바꾼다.
// 반환: { ok: true, entry, runDir, message } | { ok: false, reason, instead }. 읽지 못하면 던진다(부르는 쪽이 거절로 보인다).
export function recordApproval(specFile, quote, kind, { env = process.env, now = new Date() } = {}) {
  const verb = kind === 'delegate' ? 'delegate' : 'approve';
  const label = kind === 'delegate' ? '위임' : '승인';
  const refuse = (reason, instead) => ({ ok: false, reason, instead });
  const { spec, project, runId, runDir } = runDirOfSpec(specFile);
  const text = readFileSync(spec, 'utf8');
  const said = String(quote ?? '').trim();
  if (!normalizeQuote(said)) return refuse('인용한 사용자 말이 비어 있다.', `사용자가 한 말을 그대로 넣는다: spec.mjs ${verb} <명세> "<사용자 말>"`);

  // 위임은 위험 항목이 없을 때만: 지우기·외부 공개·돈 드는 일은 사용자가 승인을 말해야 한다(F2 케이스)
  if (kind === 'delegate') {
    const risks = riskItems(text);
    if (risks.length) return refuse(`위험 항목이 있어 위임으로 기록하지 않는다: ${describeRisk(risks)}.`, ASK_APPROVAL);
  }

  // 승인은 spec-checker가 끝난 뒤의 말이어야 한다(R9): 검수 전에 받은 '좋아'를 승인으로 쓰지 않게
  let checker = null;
  let checkerMs = null;
  if (kind === 'approve') {
    checker = latestSpecCheckerReply(runDir);
    if (!checker) return refuse(`이 명세의 spec-checker 기록이 없다 (${logFile(runDir)}).`, 'pact:spec-checker로 명세를 검수한 뒤, 결과를 반영한 명세로 사용자의 승인을 받아 다시 실행한다.');
    checkerMs = Date.parse(checker.time);
    if (!Number.isFinite(checkerMs)) return refuse(`spec-checker 기록의 시각을 읽지 못했다 (${checker.time}).`, 'pact:spec-checker를 다시 불러 검수한 뒤 승인을 받는다.');
  }

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

  const matches = messages.filter((message) => quoteMatches(said, message.text));
  if (!matches.length) {
    const q = normalizeQuote(said);
    const inside = Array.from(q).length <= SHORT_MAX && messages.some((message) => normalizeQuote(message.text).includes(q));
    return inside
      ? refuse(`"${said}"은 짧은 말이라 사용자 메시지 전체와 같아야 하는데, 더 긴 메시지의 일부로만 있다.`, `메시지 전체를 그대로 인용한다(정리해서 ${SHORT_MAX}자를 넘는 말이면 일부만 인용해도 된다).`)
      : refuse(`인용한 말이 이 대화의 사용자 메시지에 없다: "${said}".`, '사용자가 실제로 한 말을 그대로 넣는다. 아직 사용자에게 묻지 않았으면 먼저 묻는다.');
  }

  const ms = (message) => Date.parse(message.time ?? '');
  let candidates = matches;
  if (kind === 'approve') {
    if (!candidates.some((message) => Number.isFinite(ms(message)))) return refuse('인용한 메시지의 시각을 대화 기록에서 읽지 못했다.', '대화 기록에 시각이 있는 사용자 말을 인용한다.');
    candidates = candidates.filter((message) => Number.isFinite(ms(message)) && ms(message) > checkerMs);
    if (!candidates.length) return refuse(`그 말은 spec-checker가 끝난 뒤(${checker.time})의 말이 아니다.`, '검수 결과를 반영한 명세로 승인을 다시 묻고, 그 답을 인용한다.');
    // 다시 승인할 때: 앞 기록에 쓴 어떤 메시지보다도 새 말이어야 한다. 같은 말을 다시 쓰면 '이미 승인받았다'는 믿음이 된다.
    const previous = readApprovals(runDir).map((entry) => Date.parse(entry.message_time)).filter(Number.isFinite);
    if (previous.length) {
      const latestUsed = Math.max(...previous);
      candidates = candidates.filter((message) => ms(message) > latestUsed);
      if (!candidates.length) return refuse(`그 말은 앞 승인 기록에 쓴 메시지(${new Date(latestUsed).toISOString()})와 같거나 더 오래됐다.`, '명세가 바뀌어 다시 승인을 받는 것이면 사용자의 새 말을 인용한다.');
    }
  }
  // 맞는 말이 여럿이면 가장 최근 것
  const chosen = candidates.reduce((best, message) => {
    const a = Number.isFinite(ms(message)) ? ms(message) : -Infinity;
    const b = Number.isFinite(ms(best)) ? ms(best) : -Infinity;
    return a > b || (a === b && message.line > best.line) ? message : best;
  });

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
    spec_checker_time: checker ? checker.time : null,
  };
  // 바꿀 명세 글을 먼저 만든다: frontmatter가 없는 명세처럼 status를 못 바꾸는 경우에 기록만 남기지 않으려고(던진다).
  const approved = setStatus(readFileSync(spec, 'utf8'), 'approved');
  ensureRunDir(project, runId);
  appendFileSync(approvalsFile(runDir), `${JSON.stringify(entry)}\n`);
  // 기록이 먼저다. status만 바뀌고 기록이 없는 일은 없다(기록은 남았는데 status 쓰기가 실패하면 set-status <명세> approved로 이어 간다).
  writeFileSync(spec, approved);
  const when = chosen.time ? ` (메시지 ${chosen.time})` : '';
  return { ok: true, entry, runDir, message: `${label}을 기록했다: "${said}"${when} → status approved` };
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
  if (!quoteMatches(entry.quote, hit.text)) return { ok: false, reason: '기록한 인용이 그 메시지와 맞지 않는다' };
  return { ok: true };
}

// ---------- 시작해도 되는지 ----------

// purpose: 'approved'(set-status approved) | 'building'(set-status building) | 'worker'(pact:worker 부르기) | 'snapshot'(verification.mjs snapshot)
// 명세는 specFile로, 또는 훅처럼 프로젝트와 run-id로 가리킨다.
//   기록이 있으면 통과. 없으면 옛 명세(R5, R19)만 통과하고 note를 준다.
//   만들기를 시작할 때(building, worker) 마지막 기록이 위임이면 지금 명세를 다시 본다: 위험 항목이 생겼으면 거절하고, 인용도 다시 맞춰 본다.
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
      instead: '사용자가 승인한 말을 그대로 넣어 spec.mjs approve <명세> "<사용자 말>"을 먼저 실행한다(승인까지 맡긴다고 한 말이면 delegate).',
    };
  }
  const last = entries[entries.length - 1];
  if (last.kind === 'delegate' && (purpose === 'building' || purpose === 'worker')) {
    const text = ref.spec ? readIfExists(ref.spec) : null;
    if (text === null) return { ok: false, reason: `위임 기록을 다시 확인하려는데 명세를 찾지 못했다 (판 ${ref.runId}).`, instead: '맥락 칸의 run-dir이 맞는지 확인하고, 명세를 보이고 승인을 받아 spec.mjs approve로 기록한다.' };
    const risks = riskItems(text);
    if (risks.length) return { ok: false, reason: `위임으로 시작하려는데 지금 명세에 위험 항목이 있다: ${describeRisk(risks)}.`, instead: ASK_APPROVAL };
    const again = recheckEntry(last);
    if (!again.ok) return { ok: false, reason: `위임 기록의 인용을 다시 맞춰 보지 못했다: ${again.reason}.`, instead: '사용자에게 승인을 다시 받아 spec.mjs approve <명세> "<사용자 말>"로 기록한다.' };
  }
  return { ok: true, mode: 'record', kind: last.kind, entry: last };
}

// 거절을 한 줄로 (R6)
export const refusalLine = (verdict) => [verdict.reason, verdict.instead].map(oneLine).filter(Boolean).join(' ');
