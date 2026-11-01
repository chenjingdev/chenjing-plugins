// pact 기록 출처: RECALL_ROOTS(기본 ~/dev) 아래의 .pact/*/spec.md 와 옛 꼴 docs/pact/*.md 를 읽어
// 예전 시도·실패·미룬 아이디어 항목으로 낸다. 주제 낱말이 하나도 안 겹치는 기록은 읽지도 내지도 않는다.
// 항목 꼴과 collect 약속은 recall.mjs 머리말에 있다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'pact 기록';

// .pact 또는 docs/pact 폴더를 root 아래 이 깊이까지 찾는다(root의 자식이 깊이 1).
const MAX_DEPTH = 4;
// 복사본·시험 판이 같은 주제를 여러 번 세지 않게 뺀다. root 기준 상대 경로에 이 글이 들어 있으면 지나간다.
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
const inside = (dir, parent) => dir === parent || dir.startsWith(parent + path.sep);

function readDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// root 아래에서 판 하나하나의 명세 파일을 찾는다. 심볼릭 링크는 isDirectory()가 거짓이라 따라가지 않는다.
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

// 같은 저장소의 같은 슬러그(날짜 앞머리를 뗀 이름)는 한 판이다. 날짜 있는 .pact 판 > 날짜 없는 .pact 판 > 옛 docs/pact 판, 같은 급이면 늦은 날짜.
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

// "다음 판 후보: A, B(c, d), E." 를 괄호 밖 쉼표에서 쪼갠다. 줄 단독이든 문단 끝이든 표지 뒤부터 줄 끝까지다.
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
    } catch {
      // 없거나 깨진 파일은 없는 것으로 본다. 그 때문에 출처 전체를 못 읽은 것으로 하지는 않는다
    }
  }
  return null;
}
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
  // 옛 꼴(docs/pact)의 결과 폴더는 같은 이름 또는 슬러그만 쓴 .pact 폴더다
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

  const words = [...new Set(topicWords.map((w) => w.toLowerCase()))];
  const projectDir = path.resolve(project);
  const items = [];
  for (const record of dedupe(readable.flatMap(findRecords))) {
    let spec;
    try {
      spec = parseSpec(readFileSync(record.file, 'utf8'));
    } catch {
      continue;
    }
    const haystack = [spec.fm.topic, spec.sections['목적']?.find((l) => l.trim()), ...bullets(spec.sections['기능']).filter((b) => /^F\d+\b/.test(b))].join('\n').toLowerCase();
    const overlap = words.filter((w) => haystack.includes(w)).length;
    if (overlap) items.push(...itemsOf(record, spec, overlap, inside(projectDir, record.repoRoot)));
  }
  return { items };
}
