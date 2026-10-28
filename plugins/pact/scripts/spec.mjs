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
// 기능·규칙 줄의 태그 앞에 `[위험: 지우기|공개|비용]`으로 표시한다. 표시가 있으면 위임으로는 만들기를 시작하지 않는다(approval.mjs).
// 표시가 빠졌는지는 낱말로 찾지 않는다(진짜 명세 17개 모두에 걸려 위임이 늘 멈춘다). spec-checker가 뜻으로 보고 알린다(작업 4).
// 보는 곳은 F·R 줄과 그 케이스(접힌 칸 포함)다. 목적·범위·하지 않는 것은 보지 않는다.

// F·R 항목 하나(줄과 그 아래 들여쓴 케이스 줄들)마다: { id, lines, marked }
//   marked  그 항목의 어느 줄에든 위험 표시가 있음
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
      unit = { id: head[1], lines: [line], marked: false };
      units.push(unit);
    } else if (unit && /^\s+\S/.test(line)) unit.lines.push(line); // 들여쓴 줄은 앞 항목의 케이스
    else if (line.trim()) unit = null; // <details> 같은 항목이 아닌 줄에서 끊는다. 빈 줄에서는 끊지 않는다(접힌 칸 안)
  }
  for (const u of units) u.marked = u.lines.some((line) => HAS_RISK_MARK.test(line));
  return units;
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
  spec.mjs approve <명세> "<사용자 말>"  사용자가 승인한 말을 이 대화 기록에서 찾아 맞춰 보고, 맞으면 승인 기록을 남기고 status를 draft에서 approved로 바꿈
  spec.mjs delegate <명세> "<사용자 말>" 승인까지 맡긴다는 말을 같은 방식으로 기록. 위험 표시가 있으면 거절
    사용자 말은 따옴표 대신 표준 입력으로 받을 수도 있다: spec.mjs approve <명세> - <<'EOF' (다음 줄에 말, 그다음 줄에 EOF).
    따옴표 붙인 heredoc이면 말 속의 백틱·$·따옴표가 셸에서 풀리지 않는다.
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
