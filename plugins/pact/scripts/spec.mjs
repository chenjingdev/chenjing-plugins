#!/usr/bin/env node
// pact 명세 파일을 읽고 검사하고 상태를 바꾼다. 사람이 손으로 고친 명세도 받아야 하므로
// 파서는 관대하게, 검사는 문제를 한국어 한 줄씩 돌려준다.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
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
const RISK_GROUP = /^\s*위험\s*(?:[:：]|$)/;
// 줄 어디에 있든 위험 표시로 읽는 것. `[위험: 지우기]`, `[위험：공개]`, `[위험]`
const RISK_MARK = /\[\s*위험\s*(?:[:：][^\]]*)?\]/g;
const HAS_RISK_MARK = new RegExp(RISK_MARK.source); // 전역 정규식의 test()는 위치를 기억해서 따로 둔다

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
    if (RISK_GROUP.test(m[1])) risks.unshift(m[1].replace(/^\s*위험\s*[:：]?\s*/, '').trim());
    else if (rawTag === null) rawTag = m[1];
    else break;
    text = text.slice(0, m.index);
  }
  return { text: text.trim(), rawTag, risk: risks.length ? risks.join(', ') : null };
}

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
    const baseTag = rawTag?.replace(/:.*$/, '').trim() ?? null;
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

// ---------- 위험 항목 (명세 R10) ----------
// 기능·규칙 줄의 태그 앞에 `[위험: 지우기|공개|비용]`으로 표시한다. 표시가 없으면 코드가 위험을 모르므로 낱말로도 찾는다.
// 보는 곳은 F·R 줄과 그 케이스(접힌 칸 포함)다. 목적·범위·하지 않는 것은 보지 않는다.
// 한국어는 어미가 줄기와 합쳐지는 일이 있어(지우+ㄴ다 → 지운다, 지우+어 → 지워) 줄기의 흔한 꼴을 같이 둔다.
export const RISK_WORDS = [
  '지우', '지운', '지워', '지웁', '삭제', '제거', '초기화', '덮어쓰', '덮어쓴', '덮어써',
  '공개', '게시', '배포', 'push', '공유', '결제', '과금', '유료', '비용',
];

// 위험을 찾을 글: 줄에서 위험 표시와 줄 끝의 태그([사용자…]·[AI 가정…])를 뺀 나머지
function riskContent(line) {
  let content = line.replace(RISK_MARK, ' ');
  for (;;) {
    const m = TRAILING_GROUP.exec(content);
    if (!m || !/^\s*(?:사용자|AI 가정)\s*(?:[:：]|$)/.test(m[1])) break;
    content = content.slice(0, m.index);
  }
  return content.toLowerCase();
}

// F·R 항목 하나(줄과 그 아래 들여쓴 케이스 줄들)마다: { id, lines, marked, words }
//   marked  그 항목의 어느 줄에든 위험 표시가 있음
//   words   표시가 아닌 글에 든 위험 낱말(찾은 순서, 중복 없음)
export function riskUnits(text) {
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
    const head = /^-\s+([FR]\d+)\b/.exec(line);
    if (head) {
      unit = { id: head[1], lines: [line], marked: false, words: [] };
      units.push(unit);
    } else if (unit && /^\s+\S/.test(line)) unit.lines.push(line); // 들여쓴 줄은 앞 항목의 케이스
    else if (line.trim()) unit = null; // <details> 같은 항목이 아닌 줄에서 끊는다. 빈 줄에서는 끊지 않는다(접힌 칸 안)
  }
  for (const u of units) {
    u.marked = u.lines.some((line) => HAS_RISK_MARK.test(line));
    const found = [];
    for (const line of u.lines) {
      const content = riskContent(line);
      for (const word of RISK_WORDS) if (content.includes(word) && !found.includes(word)) found.push(word);
    }
    u.words = found;
  }
  return units;
}

// lint가 알리는 참고 줄: 위험 낱말이 있는데 표시가 없는 F·R 항목. 문제가 아니라서 종료 코드를 바꾸지 않는다.
export function lintNotes(text) {
  return riskUnits(text)
    .filter((u) => !u.marked && u.words.length)
    .map((u) => `참고: ${u.id}에 위험 낱말(${u.words.join('·')})이 있는데 [위험: …] 표시가 없다. 정말 위험 항목이면 태그 앞에 [위험: 지우기|공개|비용]을 달고, 아니면 그대로 둔다.`);
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
  spec.mjs approve <명세> "<사용자 말>"  사용자가 승인한 말을 이 대화 기록에서 찾아 맞춰 보고, 맞으면 승인 기록을 남기고 status를 approved로 바꿈
  spec.mjs delegate <명세> "<사용자 말>" 승인까지 맡긴다는 말을 같은 방식으로 기록. 위험 항목이 있으면 거절
  spec.mjs set-status <명세> <값>       status를 바꿈 (${STATUSES.join(', ')}). approved·building은 승인 기록이 있어야 함
  spec.mjs lint <명세>                  형식 문제를 줄마다 출력, 있으면 종료 코드 1. 위험 낱말이 있는데 표시가 없는 줄은 참고로만 알림
  spec.mjs run-dir <명세>               실행 산출물 폴더 .pact/<명세 파일명(확장자 제외)>/를 만들고 경로를 출력`;

// 거절은 한 줄이다: 까닭과 대신 할 일(R6). 종료 코드 1.
async function refuse(verdict) {
  const { refusalLine } = await import('./approval.mjs');
  console.error(refusalLine(verdict));
  return 1;
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
    // 따옴표 없이 여러 낱말로 넘겨도 한 줄로 이어 받는다
    const { recordApproval } = await import('./approval.mjs');
    const result = recordApproval(args[0], args.slice(1).join(' '), cmd);
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
    for (const note of lintNotes(text)) console.log(note); // 참고는 문제가 아니다: 종료 코드를 바꾸지 않는다
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
      console.error(err.message);
      process.exitCode = 1;
    },
  );
}
