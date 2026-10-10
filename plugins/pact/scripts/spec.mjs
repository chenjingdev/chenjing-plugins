#!/usr/bin/env node
// pact 명세 파일을 읽고 검사하고 상태를 바꾼다. 사람이 손으로 고친 명세도 받아야 하므로
// 파서는 관대하게, 검사는 문제를 한국어 한 줄씩 돌려준다.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const STATUSES = ['draft', 'approved', 'building', 'verifying', 'done'];
const TAGS = ['사용자', 'AI 가정'];
const ITEM_SECTIONS = ['기능', '공통 규칙'];
const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'pact', 'spec-template.md');

function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { raw: null, body: text, end: 0 };
  return { raw: m[1], body: text.slice(m[0].length), end: m[0].length };
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
    if (!it) continue;
    const t = /\s*\[([^\]]*)\]$/.exec(it[2]);
    const rawTag = t ? t[1] : null;
    items.push({
      id: it[1],
      text: t ? it[2].slice(0, t.index).trim() : it[2],
      tag: TAGS.includes(rawTag) ? rawTag : null,
      rawTag,
      section: current,
    });
  }
  return { frontmatter, sections, items };
}

export function lintSpec(text) {
  const problems = [];
  const spec = parseSpec(text);
  const status = spec.frontmatter.status;
  if (!status) problems.push('status가 없습니다');
  else if (!STATUSES.includes(status)) problems.push(`status 값이 잘못됐습니다: ${status}`);
  if (!('기능' in spec.sections)) problems.push('## 기능 섹션이 없습니다');
  for (const item of spec.items) {
    if (item.rawTag === null) problems.push(`${item.id}: 태그가 없습니다 ([사용자] 또는 [AI 가정])`);
    else if (item.tag === null) problems.push(`${item.id}: 알 수 없는 태그 [${item.rawTag}]`);
  }
  return problems;
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

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const USAGE = `사용법:
  spec.mjs new <projectDir> <주제>     명세 파일을 만들고 경로를 출력
  spec.mjs status <명세>               status 값을 출력
  spec.mjs set-status <명세> <값>      status를 바꿈 (${STATUSES.join(', ')})
  spec.mjs lint <명세>                 형식 문제를 줄마다 출력, 있으면 종료 코드 1`;

function main([cmd, ...args]) {
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
  if (cmd === 'set-status' && args[1]) {
    writeFileSync(args[0], setStatus(readFileSync(args[0], 'utf8'), args[1]));
    return 0;
  }
  if (cmd === 'lint' && args[0]) {
    const problems = lintSpec(readFileSync(args[0], 'utf8'));
    for (const p of problems) console.log(p);
    return problems.length ? 1 : 0;
  }
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
