#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as honcho from './sources/honcho.mjs';
import * as pactRecords from './sources/pact-records.mjs';
import * as memoryFiles from './sources/memory-files.mjs';

export const MAX_LINES = 8;
export const MAX_TEXT = 120;
const SOURCES = [honcho, pactRecords, memoryFiles];
const BUCKETS = [
  ['attempts', '예전 시도와 그 끝'],
  ['failures', '실패와 원인'],
  ['ideas', '미룬 아이디어'],
  ['rules', '지키라는 규칙'],
];

export function parseArgs(argv) {
  let project = process.cwd();
  let json = false;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') json = true;
    else if (argv[i] === '--project') project = argv[++i] ?? project;
    else rest.push(argv[i]);
  }
  const words = [...new Set(rest.join(' ').split(/\s+/).filter((w) => [...w].length >= 2))];
  return { words, project: path.resolve(project), json };
}

const scoreOf = (it) => it.overlap + (it.same_repo ? 2 : 0);
const newestFirst = (a, b) => (b.date > a.date) - (b.date < a.date);

function clip(text) {
  const chars = [...String(text).replace(/\s+/g, ' ').trim()];
  return chars.length > MAX_TEXT ? `${chars.slice(0, MAX_TEXT - 1).join('')}…` : chars.join('');
}

// 기록에서 뺀 요지와 비교할 때는 공백·문장부호를 없앤다(요지가 120자에서 …로 잘려 적혔을 수 있다)
const keyOf = (text) => String(text).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

const shape = (it) => ({
  date: it.date,
  source: it.source,
  repo: it.repo ?? null,
  other_repo: it.repo != null && !it.same_repo,
  similar: scoreOf(it) === 1,
  text: clip(it.text),
  path: it.path,
});

const SHORT_CUT = 8;

export async function run({ words, project, env = process.env, sources = SOURCES }) {
  const started = Date.now();
  const settled = await Promise.allSettled(
    sources.map(async (s) => {
      const { items, excluded = [] } = await s.collect({ topicWords: words, project, env });
      return { items: [...items], excluded };
    }),
  );
  const report = settled.map((r, i) =>
    r.status === 'rejected'
      ? { name: sources[i].name, ok: false, reason: String(r.reason?.message ?? r.reason).split('\n')[0] }
      : { name: sources[i].name, ok: true, reason: null },
  );
  const read = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const cuts = read.flatMap((v) => v.excluded.map((e) => keyOf(e.text))).filter(Boolean);
  const pool = { attempts: [], failures: [], ideas: [], rules: [] };
  const removed = [];
  for (const it of read.flatMap((v) => v.items)) {
    const key = keyOf(it.text);
    // 짧은 요지(`팀원 기억`)를 포함으로 걸면 그 낱말이 든 실패·규칙 줄까지 지운다
    if (cuts.some((cut) => (cut.length < SHORT_CUT ? key === cut : key.includes(cut)))) removed.push(it);
    else pool[it.bucket]?.push(it);
  }
  const buckets = {};
  for (const [key] of BUCKETS) {
    buckets[key] = pool[key]
      .sort((a, b) => scoreOf(b) - scoreOf(a) || newestFirst(a, b))
      .slice(0, MAX_LINES)
      .map(shape);
  }
  return { topic: words.join(' '), elapsed_ms: Date.now() - started, sources: report, buckets, excluded: removed.map((it) => ({ bucket: it.bucket, ...shape(it) })) };
}

export function formatDate(iso, now = new Date()) {
  const [y, m, d] = iso.split('-').map(Number);
  return y === now.getFullYear() ? `${m}/${d}` : `${y}/${m}/${d}`;
}

const whereOf = (it) =>
  it.source === 'pact' ? `pact 기록 ${it.repo}` : { memory: '메모리 파일', user: '사용자 말', assistant: 'AI 보고' }[it.source] ?? it.source;

export function render(result, now = new Date()) {
  const readable = result.sources.filter((s) => s.ok).length;
  const lines = [`recall: ${result.topic || '(주제 없음)'} — 출처 ${readable}/${result.sources.length} · ${result.elapsed_ms}ms`];
  if (result.excluded.length) lines.push(`- 뺀 것: ${result.excluded.length}줄 (기록에서 뺌)`);
  for (const s of result.sources) if (!s.ok) lines.push(`- 못 읽음: ${s.name} (${s.reason})`);
  for (const [key, title] of BUCKETS) {
    lines.push('', `## ${title}`);
    if (!result.buckets[key].length) lines.push('- 없음');
    for (const it of result.buckets[key]) {
      lines.push(`- ${it.similar ? '비슷한 기록 · ' : ''}(${formatDate(it.date, now)} · ${whereOf(it)}) ${it.text}${it.other_repo ? ' — 다른 저장소' : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// import.meta.url은 심볼릭 링크를 푼 경로인데 process.argv[1]은 풀지 않으므로 실제 경로끼리 비교한다
function isMainModule() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const { words, project, json } = parseArgs(process.argv.slice(2));
  const result = await run({ words, project });
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : render(result));
}
