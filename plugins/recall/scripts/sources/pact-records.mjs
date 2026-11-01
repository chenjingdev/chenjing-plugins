import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { overlapOf } from './words.mjs';

export const name = 'pact 기록';

const MAX_DEPTH = 4;
const EXCLUDED = ['/wt/', '/scratch/', 'node_modules', 'testbed', '/tmp/', '-wt-'];
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const excluded = (rel) => {
  const p = `/${rel}/`;
  return EXCLUDED.some((x) => p.includes(x));
};
const isFile = (file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const inside = (dir, parent) => dir === parent || dir.startsWith(parent + path.sep);

function readDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function findRecords(root) {
  const found = [];
  const visit = (dir, depth) => {
    for (const e of readDir(dir)) {
      if (!e.isDirectory() || e.name === '.git' || e.name === 'node_modules') continue;
      const child = path.join(dir, e.name);
      if (excluded(path.relative(root, child))) continue;
      if (e.name === '.pact') {
        for (const run of readDir(child)) {
          const file = path.join(child, run.name, 'spec.md');
          if (run.isDirectory() && isFile(file) && !excluded(path.relative(root, file))) found.push({ repoRoot: dir, file, base: run.name, legacy: false });
        }
      } else if (e.name === 'pact' && path.basename(dir) === 'docs') {
        for (const doc of readDir(child)) {
          if (doc.isFile() && doc.name.endsWith('.md')) found.push({ repoRoot: path.dirname(dir), file: path.join(child, doc.name), base: doc.name.slice(0, -3), legacy: true });
        }
      } else if (!e.name.startsWith('.') && depth < MAX_DEPTH) {
        visit(child, depth + 1);
      }
    }
  };
  visit(root, 1);
  return found;
}

function dedupe(records) {
  const rank = (r) => (r.legacy ? 0 : DATE_PREFIX.test(r.base) ? 2 : 1);
  const best = new Map();
  for (const r of records) {
    r.slug = r.base.replace(DATE_PREFIX, '');
    const key = `${r.repoRoot}\0${r.slug}`;
    const cur = best.get(key);
    if (!cur || rank(r) > rank(cur) || (rank(r) === rank(cur) && r.base > cur.base)) best.set(key, r);
  }
  return [...best.values()];
}

function parseSpec(text) {
  const fm = {};
  let body = text;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const k = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (k) fm[k[1]] = k[2].trim();
    }
    body = text.slice(m[0].length);
  }
  const sections = {};
  let cur = null;
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      cur = h[1];
      sections[cur] = [];
    } else if (cur) sections[cur].push(line);
  }
  return { fm, sections };
}

const bullets = (lines = []) => lines.map((l) => /^-\s+(.*\S)\s*$/.exec(l)?.[1]).filter(Boolean);

function nextVersionIdeas(lines = []) {
  const ideas = [];
  for (const line of lines) {
    const m = /다음 판 후보\s*[:：]\s*(.*)$/.exec(line);
    if (!m) continue;
    let depth = 0;
    let piece = '';
    const pieces = [];
    for (const ch of m[1]) {
      if ('(（'.includes(ch)) depth++;
      else if (')）'.includes(ch)) depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) {
        pieces.push(piece);
        piece = '';
      } else piece += ch;
    }
    pieces.push(piece);
    for (const p of pieces) {
      const idea = oneLine(p).replace(/[.。]+$/, '');
      if (idea) ideas.push(idea);
    }
  }
  return ideas;
}

function readJson(dirs, file) {
  for (const dir of dirs) {
    try {
      return JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    } catch {}
  }
  return null;
}
const EXCLUDED_LINE = /^기록에서 뺌\s*[:：]\s*(.+?)\s*\(((?:\d{4}\/)?\d{1,2}\/\d{1,2})\)$/;
const excludedOf = (record, sections) =>
  bullets(sections['하지 않는 것']).flatMap((b) => {
    const m = EXCLUDED_LINE.exec(b);
    return m ? [{ text: oneLine(m[1]), date: m[2], path: record.file }] : [];
  });
const textList = (v) => (Array.isArray(v) ? v : [v]).map(oneLine).filter(Boolean);

function dateOf(record, fm) {
  if (DATE_ONLY.test(fm.created ?? '')) return fm.created;
  if (DATE_PREFIX.test(record.base)) return record.base.slice(0, 10);
  const d = statSync(record.file).mtime;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function itemsOf(record, { fm, sections }, overlap, sameRepo) {
  const head = { overlap, same_repo: sameRepo, date: dateOf(record, fm), source: 'pact', repo: path.basename(record.repoRoot), path: record.file };
  const make = (bucket, text) => ({ bucket, ...head, text });
  const runDirs = [...new Set([record.legacy ? null : path.dirname(record.file), path.join(record.repoRoot, '.pact', record.base), path.join(record.repoRoot, '.pact', record.slug)].filter(Boolean))];
  const summary = readJson(runDirs, 'summary.json');
  const results = readJson(runDirs, 'results.json');

  const needs = bullets(sections['확인 필요']).filter((n) => !n.startsWith('확인함'));
  const headline = oneLine(summary?.headline) || oneLine(results?.headline);
  const rulings = bullets(sections['결정 기록']).filter((r) => r.startsWith('Ruling:')).length;
  const status = fm.status || '없음';
  const end = [
    status === 'done' ? '완료' : `멈춘 채 남음(status ${status})`,
    rulings ? `결정 ${rulings}건` : '',
    headline || (needs.length ? `확인 필요: ${oneLine(needs[0])}` : ''),
  ].filter(Boolean).join(' · ');
  const purpose = oneLine(sections['목적']?.find((l) => l.trim()));
  const items = [make('attempts', `${fm.topic || record.slug} — ${end}${purpose ? ` — ${purpose}` : ''}`)];

  for (const s of Array.isArray(results?.scenarios) ? results.scenarios : []) {
    if (s?.result !== 'fail' && s?.result !== 'doubt') continue;
    const detail = oneLine(s.summary) || oneLine(s.decision);
    items.push(make('failures', `${s.result === 'fail' ? '실패' : '의심'}: ${oneLine(s.title)}${detail ? ` — ${detail}` : ''}`));
  }
  for (const n of needs) items.push(make('failures', `확인 필요: ${oneLine(n)}`));
  for (const t of textList(summary?.todo ?? results?.todo)) items.push(make('failures', `남은 할 일: ${t}`));
  for (const idea of nextVersionIdeas(sections['하지 않는 것'])) items.push(make('ideas', idea));
  return items;
}

export async function collect({ topicWords, project, env }) {
  const roots = (env.RECALL_ROOTS || path.join(os.homedir(), 'dev')).split(':').filter(Boolean);
  const readable = roots.filter((r) => {
    try {
      return statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
  if (!readable.length) throw new Error(`RECALL_ROOTS를 읽을 수 없음: ${roots.join(':')}`);

  const projectDir = path.resolve(project);
  const items = [];
  const excluded = [];
  for (const record of dedupe(readable.flatMap(findRecords))) {
    const spec = parseSpec(readFileSync(record.file, 'utf8'));
    excluded.push(...excludedOf(record, spec.sections));
    const haystack = [spec.fm.topic, spec.sections['목적']?.find((l) => l.trim()), ...bullets(spec.sections['기능']).filter((b) => /^F\d+\b/.test(b))].join('\n');
    const overlap = overlapOf(topicWords, haystack);
    if (overlap) items.push(...itemsOf(record, spec, overlap, inside(projectDir, record.repoRoot)));
  }
  return { items, excluded };
}
