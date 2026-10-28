#!/usr/bin/env node
// pact 명세 파일을 읽고 검사하고 상태를 바꾼다. 사람이 손으로 고친 명세도 받아야 하므로
// 파서는 관대하게, 검사는 문제를 한국어 한 줄씩 돌려준다.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { ensureRunDir, isMainModule } from './paths.mjs';

export const STATUSES = ['draft', 'approved', 'building', 'verifying', 'done'];
const TAGS = ['사용자', 'AI 가정'];
const ITEM_SECTIONS = ['기능', '공통 규칙'];
const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'pact', 'spec-template.md');

function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { raw: null, body: text, end: 0 };
  return { raw: m[1], body: text.slice(m[0].length), end: m[0].length };
}

// 줄 끝의 [..] 묶음. 태그([사용자]·[AI 가정])와 위험 표시([위험: 지우기|공개|비용])가 여기에 온다.
const TRAILING_GROUP = /\s*\[([^\]]*)\]$/;
// 위험 표시로 읽는 묶음: `[위험` 바로 뒤에 한글이 아닌 글자(또는 묶음의 끝)가 오는 것. 표준은 `[위험: 지우기]`지만 `[위험]`, `[위험：공개]`,
// 콜론을 빠뜨린 `[위험 지우기]`·`[위험-지우기]`도 표시로 읽는다. 표시를 잘못 적었다고 위험이 안 보이면 위임이 조용히 지나간다(낱말 검사는 하지 않는다).
// `[위험성 높음]`·`[위험한 작업]`처럼 한글이 이어지면 표시가 아니라 다른 말이다.
const RISK_GROUP = /^\s*위험(?![가-힣])/;
// 줄 어디에 있든 위험 표시로 읽는 것
const HAS_RISK_MARK = /\[\s*위험(?![가-힣])[^\]]*\]/;
// 표시 안의 값: 앞의 `위험`과 구분 글자(콜론·공백·하이픈 …)를 뺀 것
const riskValue = (group) => group.replace(/^\s*위험[\s:：\-–—_/,]*/, '').trim();

// 항목 줄의 `<글> [위험: …] [태그]`를 뒤에서부터 떼어 낸다. 태그는 맨 뒤(또는 위험 표시 뒤)의 [..] 하나이고, 위험 표시는 태그 앞뒤 어디든 읽는다.
// 표시가 태그로 읽히면 안 된다: `[위험: 지우기] [사용자]`의 태그는 사용자이고, 표시만 있으면 태그가 없는 줄이다.
// 그 밖의 [..]는 글로 둔다(`목록 [초안] 보기 [사용자]`).
function splitTrailing(rest) {
  let text = rest;
  let rawTag = null;
  const risks = [];
  for (;;) {
    const m = TRAILING_GROUP.exec(text);
    if (!m) break;
    if (RISK_GROUP.test(m[1])) risks.unshift(riskValue(m[1]));
    else if (rawTag === null) rawTag = m[1];
    else break;
    text = text.slice(0, m.index);
  }
  return { text: text.trim(), rawTag, risk: risks.length ? risks.join(', ') : null };
}

// 태그 글(`[..]` 안의 글)을 이름과 콜론 뒤의 글로 나눈다: `사용자: 검수 1` → { name: '사용자', rest: '검수 1' }. 태그가 없으면 name이 null이다.
// 이름은 첫 반각 콜론(:) 앞이다. lint가 태그를 읽는 규칙 그대로라서 전각 콜론(：)으로 쓴 `사용자： 검수 1`은 이름이 `사용자： 검수 1`이 되어 알 수 없는 태그다.
// 검수 번호의 짝(reviewMarks)과 [사용자] 줄(userLinesOf)도 이 함수로 읽는다 — lint와 다르게 읽는 태그가 생기면 F5가 짝으로 센 줄을 F3가 지키지 못한다.
function tagParts(rawTag) {
  if (rawTag === null || rawTag === undefined) return { name: null, rest: '' };
  const colon = rawTag.indexOf(':');
  return colon < 0 ? { name: rawTag.trim(), rest: '' } : { name: rawTag.slice(0, colon).trim(), rest: rawTag.slice(colon + 1).trim() };
}

// 줄 끝의 태그: { raw, name, rest }. 위험 표시는 건너뛴다. lint가 항목 줄에서 읽는 것과 같고, 케이스 줄에도 같은 규칙을 쓴다.
const lineTag = (line) => {
  const raw = splitTrailing(String(line).trim()).rawTag;
  return { raw, ...tagParts(raw) };
};

export function parseSpec(text) {
  const { raw, body } = splitFrontmatter(String(text ?? ''));
  const frontmatter = {};
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m) frontmatter[m[1]] = m[2].trim();
  }
  const sections = {};
  const items = [];
  const unnumbered = [];
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = h[1];
      sections[current] = '';
      continue;
    }
    if (current === null) continue;
    sections[current] += (sections[current] ? '\n' : '') + line;
    if (!ITEM_SECTIONS.includes(current)) continue;
    const it = /^-\s+([FR]\d+)\b\s*(.*?)\s*$/.exec(line);
    if (!it) {
      if (/^-\s+\S/.test(line)) unnumbered.push(line.replace(/^-\s+/, '').trim());
      continue;
    }
    const { text, rawTag, risk } = splitTrailing(it[2]);
    // [사용자: 10/8 회의]·[사용자: 검수 1]·[AI 가정: 검수 2 맡김]처럼 콜론 뒤에 출처나 번호를 붙여도 된다.
    const baseTag = tagParts(rawTag).name;
    items.push({
      id: it[1],
      text,
      tag: TAGS.includes(baseTag) ? baseTag : null,
      rawTag,
      risk,
      section: current,
    });
  }
  return { frontmatter, sections, items, unnumbered };
}

export function lintSpec(text) {
  const problems = [];
  const spec = parseSpec(text);
  const status = spec.frontmatter.status;
  if (!status) problems.push('status가 없습니다');
  else if (!STATUSES.includes(status)) problems.push(`status 값이 잘못됐습니다: ${status}`);
  for (const section of ITEM_SECTIONS) {
    if (!(section in spec.sections)) problems.push(`## ${section} 섹션이 없습니다`);
  }
  const seen = new Set();
  for (const item of spec.items) {
    if (seen.has(item.id)) problems.push(`${item.id}: 번호가 겹칩니다`);
    seen.add(item.id);
    if (item.rawTag === null) problems.push(`${item.id}: 태그가 없습니다 ([사용자] 또는 [AI 가정])`);
    else if (item.tag === null) problems.push(`${item.id}: 알 수 없는 태그 [${item.rawTag}]`);
    if (PLACEHOLDER.test(item.text)) problems.push(`아직 틀 그대로입니다: ${item.id}`);
  }
  for (const line of spec.unnumbered) problems.push(`번호가 없는 항목: ${line} (F<n> 또는 R<n>을 붙이세요)`);
  return problems;
}

// spec-template.md의 <기능 한 줄> 같은 자리표시자가 남은 항목
const PLACEHOLDER = /<[^>]+>/;

// 기능 항목이 하나도 채워지지 않은 명세: probe를 시작만 하고 버린 초안이다.
export function isTemplate(text) {
  const features = parseSpec(text).items.filter((i) => i.section === '기능');
  return features.length > 0 && features.every((i) => PLACEHOLDER.test(i.text));
}

// `## 결정 기록`의 Ruling 줄들. 줄 앞의 `- `를 뗀 `Ruling: …` 글이다. 보고서(report.mjs)가 읽는다(명세 R13).
export function decisionRulings(text) {
  const section = parseSpec(text).sections['결정 기록'] ?? '';
  return section.split('\n').map((line) => /^\s*[-*]\s+(Ruling:.*\S)\s*$/.exec(line)?.[1]).filter(Boolean);
}

// ---------- 항목 단위 읽기: 위험 표시(명세 R10), [사용자] 줄(R12), 검수 번호의 짝(R11) ----------
// 보는 곳은 F·R 줄과 그 케이스(접힌 칸 포함)다. 목적·범위·하지 않는 것은 보지 않는다.

// F·R 항목 하나(줄과 그 아래 들여쓴 케이스 줄들)마다: { id, lines, tag } — tag는 `사용자`·`AI 가정` 또는 null
function itemUnits(text) {
  const { body } = splitFrontmatter(String(text ?? ''));
  const units = [];
  let section = null;
  let unit = null;
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      section = h[1];
      unit = null;
      continue;
    }
    if (!ITEM_SECTIONS.includes(section)) continue;
    const head = /^-\s+([FR]\d+)\b\s*(.*?)\s*$/.exec(line);
    if (head) {
      const { name } = lineTag(head[2]);
      unit = { id: head[1], lines: [line], tag: TAGS.includes(name) ? name : null };
      units.push(unit);
    } else if (unit && /^\s+\S/.test(line)) unit.lines.push(line); // 들여쓴 줄은 앞 항목의 케이스
    else if (line.trim()) unit = null; // <details> 같은 항목이 아닌 줄에서 끊는다. 빈 줄에서는 끊지 않는다(접힌 칸 안)
  }
  return units;
}

// 위험 항목 후보마다: { id, lines, marked }
//   marked  그 항목의 어느 줄에든 위험 표시가 있음
// 표시가 있으면 위임으로는 만들기를 시작하지 않는다(approval.mjs). 표시가 빠졌는지는 낱말로 찾지 않는다(진짜 명세 17개 모두에 걸려 위임이 늘 멈춘다).
// spec-checker가 뜻으로 보고 알린다.
export function riskUnits(text) {
  return itemUnits(text).map(({ id, lines }) => ({ id, lines, marked: lines.some((line) => HAS_RISK_MARK.test(line)) }));
}

// 줄 비교용 꼴: 공백은 하나로, 앞뒤는 뺀다(들여쓰기·줄 끝 공백만 바뀐 것은 바뀐 것이 아니다)
const squash = (line) => String(line).replace(/\s+/g, ' ').trim();

// 승인 뒤 바뀌면 다시 승인을 받아야 하는 [사용자] 줄들 (명세 F3, R12): { <키>: [줄, …] }. 승인을 기록할 때 이것을 남기고, 뒤에 지금 명세와 견준다.
//   머리 줄이 [사용자]나 [사용자: …]인 F·R 항목은 항목 하나가 통째로 한 키다: `F2` → [항목 줄, 케이스 줄, …]
//   머리 줄이 [사용자]가 아닌 항목(`[AI 가정]`)은 머리 줄과 AI의 케이스 줄을 담지 않고, 케이스 줄 가운데 [사용자] 태그가 붙은 줄만 그 줄 하나씩 담는다:
//     `F3/1` → [그 케이스 줄]. 숫자는 그 항목의 [사용자] 케이스 줄 가운데 몇 번째인지다(줄 위치가 아니다 — AI가 앞에 케이스 줄을 더해도 키가 밀리지 않게).
//     검수 질문에 사용자가 답한 케이스는 대개 이 꼴이고, 머리 줄은 AI가 알아서 고쳐도 되지만 사용자가 답한 케이스 줄은 묻지 않고 바뀌면 안 된다.
// 같은 번호가 또 나오면(lint가 잡는 오류) `F1#2`처럼 이어 붙여 하나도 빠뜨리지 않는다. 태그는 lint와 같은 규칙으로 읽는다(줄 끝의 [..], 반각 콜론).
export function userLinesOf(text) {
  const out = {};
  const seen = new Map();
  for (const unit of itemUnits(text)) {
    const times = (seen.get(unit.id) ?? 0) + 1;
    seen.set(unit.id, times);
    const key = times === 1 ? unit.id : `${unit.id}#${times}`;
    if (unit.tag === '사용자') {
      out[key] = unit.lines.map(squash);
      continue;
    }
    let n = 0;
    for (const line of unit.lines.slice(1)) if (lineTag(line).name === '사용자') out[`${key}/${++n}`] = [squash(line)];
  }
  return out;
}

// 검수 번호의 짝을 명세에서 읽는다 (명세 R11): spec-checker가 '사용자만 답할 수 있음'으로 짚은 `검수 n`마다 아래 셋 중 하나가 있어야 한다.
//   answered   [사용자: 검수 n]  물어서 답을 받은 줄
//   delegated  [AI 가정: 검수 n 맡김]  사용자가 맡긴 줄('맡김'이 없는 [AI 가정: 검수 n]은 AI가 알아서 정한 것이라 짝이 아니다)
//   notAsked   `## 확인 필요`의 `- 검수 n: 안 물은 까닭` (까닭이 비면 짝이 아니다)  → Map(번호 → 까닭)
// 태그는 기능·공통 규칙 항목의 줄(머리 줄과 케이스 줄, 접힌 칸 포함) 끝에 단 것만 센다. 목적·범위 칸의 태그와 줄 가운데의 태그는 세지 않는다.
// lint가 태그로 읽는 것과 같은 규칙이다(tagParts): 그래야 F5가 짝으로 센 줄을 F3(userLinesOf)가 지킨다. 한 태그에 번호 여럿도 된다: [사용자: 검수 1, 3].
// fullwidth는 전각 콜론(`[사용자： 검수 n]`)으로 쓴 태그의 번호다: 짝이 아니고(lint도 알 수 없는 태그로 알린다) 거절 문구가 그렇다고 알리는 데 쓴다.
const REVIEW_LIST = String.raw`검수\s*(\d+(?:\s*[,，、·/]\s*\d+)*)`;
const reviewNumbers = (text) => [...String(text).matchAll(new RegExp(REVIEW_LIST, 'gu'))].flatMap((m) => m[1].split(/\D+/).filter(Boolean).map(Number));
const CONFIRM_LINE = new RegExp(String.raw`^\s*[-*]\s*${REVIEW_LIST}\s*[:：]\s*(\S.*?)\s*$`, 'u');
const FULLWIDTH_TAG = /^\s*(?:사용자|AI 가정)\s*：(.*)$/u;
export function reviewMarks(text) {
  const { body } = splitFrontmatter(String(text ?? ''));
  const answered = new Set();
  const delegated = new Set();
  const notAsked = new Map();
  const fullwidth = new Set();
  for (const unit of itemUnits(text)) {
    for (const line of unit.lines) {
      const { raw, name, rest } = lineTag(line);
      if (name === '사용자') reviewNumbers(rest).forEach((n) => answered.add(n));
      else if (name === 'AI 가정' && rest.includes('맡김')) reviewNumbers(rest).forEach((n) => delegated.add(n));
      else if (raw !== null && FULLWIDTH_TAG.test(raw)) reviewNumbers(FULLWIDTH_TAG.exec(raw)[1]).forEach((n) => fullwidth.add(n));
    }
  }
  let section = null;
  for (const raw of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(raw);
    if (h) {
      section = h[1];
      continue;
    }
    if (section !== '확인 필요') continue;
    const m = CONFIRM_LINE.exec(raw);
    if (m) for (const n of reviewNumbers(`검수 ${m[1]}`)) if (!notAsked.has(n)) notAsked.set(n, m[2]);
  }
  return { answered, delegated, notAsked, fullwidth };
}

export function setStatus(text, status) {
  if (!STATUSES.includes(status)) {
    throw new Error(`status 값이 잘못됐습니다: ${status} (가능한 값: ${STATUSES.join(', ')})`);
  }
  const { raw, end } = splitFrontmatter(text);
  if (raw === null) throw new Error('명세 맨 위에 frontmatter(---)가 없습니다');
  const head = text.slice(0, end);
  const next = /^status:.*$/m.test(raw)
    ? head.replace(/^status:.*$/m, `status: ${status}`)
    : head.replace(/\r?\n---\r?\n?$/, (close) => `\nstatus: ${status}${close}`);
  return next + text.slice(end);
}

export function slugify(topic) {
  return String(topic)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join('-');
}

export function newSpecPath(projectDir, topic, date) {
  const dir = path.join(projectDir, 'docs', 'pact');
  const base = `${date}-${slugify(topic) || 'spec'}`;
  let file = path.join(dir, `${base}.md`);
  for (let n = 2; existsSync(file); n++) file = path.join(dir, `${base}-${n}.md`);
  return file;
}

// 명세의 날짜와 중복 번호까지 실행 ID에 남겨 서로 다른 명세의 산출물을 분리한다.
export function specRunDir(specFile) {
  const projectDir = path.resolve(path.dirname(specFile), '..', '..');
  const runId = path.basename(specFile, '.md');
  const legacySlug = runId.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const legacyWorktree = path.join(projectDir, '.pact', legacySlug, 'wt');
  if (legacySlug !== runId && existsSync(legacyWorktree)) {
    throw new Error(`기존 pact 작업 공간을 자동으로 이어 할 수 없습니다: ${legacyWorktree}. 원래 명세를 확인한 뒤 별도로 복구하세요.`);
  }
  return ensureRunDir(projectDir, runId);
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const USAGE = `사용법:
  spec.mjs new <projectDir> <주제>      명세 파일을 만들고 경로를 출력
  spec.mjs status <명세>                status 값을 출력
  spec.mjs approve <명세> -             사용자가 승인한 말을 표준 입력으로 받아 이 대화 기록에서 찾아 맞춰 보고, 맞으면 승인 기록을 남기고 status를 draft에서 approved로 바꿈
  spec.mjs delegate <명세> -            승인까지 맡긴다는 말을 같은 방식으로 기록. 위험 표시가 있으면 거절
    말은 따옴표 붙인 heredoc으로 넘긴다: spec.mjs approve <명세> - <<'EOF' (다음 줄에 말, 그다음 줄 맨 앞에 EOF).
    말 속의 백틱·$·따옴표가 셸에서 풀리지 않는다. 말을 인자로 줄 수도 있지만 그러면 셸이 말 속의 백틱·$를 먼저 푼다.
  spec.mjs set-status <명세> <값>       status를 바꿈 (${STATUSES.join(', ')}). approved·building은 승인 기록이 있어야 함
  spec.mjs lint <명세>                  형식 문제를 줄마다 출력, 있으면 종료 코드 1
  spec.mjs run-dir <명세>               실행 산출물 폴더 .pact/<명세 파일명(확장자 제외)>/를 만들고 경로를 출력`;

// 거절은 한 줄이다: 까닭과 대신 할 일(R6). 종료 코드 1.
async function refuse(verdict) {
  const { refusalLine } = await import('./approval.mjs');
  console.error(refusalLine(verdict));
  return 1;
}

// 표준 입력 전체. 터미널이거나 막혀 있거나 닫혀 있으면 빈 글이다(터미널에서 사람이 치기를 기다리며 멈추지 않는다).
function readStdin() {
  if (isatty(0)) return '';
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// 파일을 못 읽거나 쓸 때 나오는 Node 오류 글(`ENOENT: no such file or directory, open '…'`)에 까닭과 대신 할 일을 한 줄로 붙인다(R6).
// 그 밖의 오류는 글 그대로다.
export function explainError(error) {
  const message = String(error?.message ?? error);
  const where = error?.path ? `(${error.path})` : '';
  switch (error?.code) {
    case 'ENOENT':
      return `${message} — 파일이나 폴더가 없다${where}. 경로를 확인한다. 명세가 아직 없으면 spec.mjs new <프로젝트> <주제>로 만든다.`;
    case 'EISDIR':
    case 'ENOTDIR':
      return `${message} — 파일이어야 할 자리에 폴더가 있거나 폴더여야 할 자리에 파일이 있다${where}. 명세 경로가 맞는지 본다. 승인 기록(approvals.jsonl)·log/ 자리면 손대지 말고 사용자에게 알린다.`;
    case 'EACCES':
    case 'EPERM':
      return `${message} — 읽거나 쓸 권한이 없다${where}. 사용자에게 알린다.`;
    default:
      return message;
  }
}

async function main([cmd, ...args]) {
  if (cmd === 'new' && args.length >= 2) {
    const [projectDir, ...words] = args;
    const topic = words.join(' ');
    const date = today();
    const file = newSpecPath(projectDir, topic, date);
    mkdirSync(path.dirname(file), { recursive: true });
    const body = readFileSync(TEMPLATE, 'utf8').replaceAll('<주제>', topic).replaceAll('<YYYY-MM-DD>', date);
    writeFileSync(file, body);
    console.log(file);
    return 0;
  }
  if (cmd === 'status' && args[0]) {
    const status = parseSpec(readFileSync(args[0], 'utf8')).frontmatter.status;
    if (!status) {
      console.error('status가 없습니다');
      return 1;
    }
    console.log(status);
    return 0;
  }
  if ((cmd === 'approve' || cmd === 'delegate') && args[0]) {
    const rest = args.slice(1);
    // 사용자 말은 인자로(따옴표 없이 여러 낱말이어도 한 줄로 잇는다), 또는 `-`로 표준 입력에서 받는다.
    // 인자는 셸 따옴표 안에서 말 속의 백틱·$가 풀리므로, 안전한 길은 따옴표 붙인 heredoc이다(probe.md 6).
    const fromStdin = rest.length === 1 && rest[0] === '-';
    const said = fromStdin ? readStdin() : rest.join(' ');
    if (fromStdin && !said.trim()) {
      return refuse({
        reason: '표준 입력으로 받은 사용자 말이 비어 있다.',
        instead: `spec.mjs ${cmd} <명세> - <<'EOF' 다음 줄에 사용자 말을, 그다음 줄에 EOF를 적는다.`,
      });
    }
    const { recordApproval } = await import('./approval.mjs');
    const result = recordApproval(args[0], said, cmd);
    if (!result.ok) return refuse(result);
    console.log(result.message);
    return 0;
  }
  if (cmd === 'set-status' && args[1]) {
    if (args[1] === 'done') {
      console.error('done은 verification.mjs finish <명세> <프로젝트>가 완료 검사를 통과한 뒤에 바꿉니다. 여기서는 바꾸지 않습니다.');
      return 1;
    }
    if (args[1] === 'approved' || args[1] === 'building') {
      // 만들기는 승인이나 위임 기록이 있어야 시작한다(F2). 옛 명세는 기록 없이 통과하고 그렇다고 알린다(R5).
      const { checkStart } = await import('./approval.mjs');
      const verdict = checkStart({ specFile: args[0], purpose: args[1] });
      if (!verdict.ok) return refuse(verdict);
      if (verdict.note) console.log(verdict.note);
    }
    writeFileSync(args[0], setStatus(readFileSync(args[0], 'utf8'), args[1]));
    return 0;
  }
  if (cmd === 'lint' && args[0]) {
    const text = readFileSync(args[0], 'utf8');
    const problems = lintSpec(text);
    for (const p of problems) console.log(p);
    return problems.length ? 1 : 0;
  }
  if (cmd === 'run-dir' && args[0]) {
    console.log(specRunDir(args[0]));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error(explainError(err));
      process.exitCode = 1;
    },
  );
}
