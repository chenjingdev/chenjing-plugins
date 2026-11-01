#!/usr/bin/env node
// recall: 주제 낱말로 이 기계의 기록(pact 기록, Claude 메모리 파일)을 뒤져 네 묶음을 표준 출력으로 낸다.
//   node recall.mjs <주제 낱말…> [--project <dir>] [--json]
// 파일은 쓰지 않고(결과는 그때그때 보여 줄 뿐 남기지 않는다) 종료 코드는 늘 0이다. 못 읽은 출처는 머리줄에 적는다.
//
// 출처 모듈(scripts/sources/*.mjs)의 약속:
//   export const name                      머리줄의 "못 읽음: <name>"에 쓰는 이름
//   export async function collect({ topicWords, project, env }) → { items }
//   item = { bucket: 'attempts'|'failures'|'ideas'|'rules', overlap, same_repo, date: 'YYYY-MM-DD',
//            source: 'pact'|'memory'|…, repo: <폴더 이름>|null, text, path }
// 주제 낱말과 하나도 안 겹치는(overlap 0) 것은 모듈이 내지 않는다. 점수·비슷한 기록 표시·자르기는 여기서 한 곳에서 한다.
// 모듈이 던지면 그 출처만 못 읽음이 되고 나머지는 계속 간다.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pactRecords from './sources/pact-records.mjs';
import * as memoryFiles from './sources/memory-files.mjs';

export const MAX_LINES = 8;
export const MAX_TEXT = 120;
const SOURCES = [pactRecords, memoryFiles];
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

// 같은 주제로 친 정도: 겹친 낱말 수 + 이 프로젝트의 저장소 안이면 2
const scoreOf = (it) => it.overlap + (it.same_repo ? 2 : 0);
const newestFirst = (a, b) => (b.date > a.date) - (b.date < a.date);

// 줄을 짧게: 여러 줄은 한 줄로 합치고 MAX_TEXT자(마지막 글자는 …)에서 자른다. 원문 전체는 싣지 않는다.
function clip(text) {
  const chars = [...String(text).replace(/\s+/g, ' ').trim()];
  return chars.length > MAX_TEXT ? `${chars.slice(0, MAX_TEXT - 1).join('')}…` : chars.join('');
}

export async function run({ words, project, env = process.env, sources = SOURCES }) {
  const started = Date.now();
  const settled = await Promise.allSettled(
    sources.map(async (s) => {
      const { items } = await s.collect({ topicWords: words, project, env });
      return [...items];
    }),
  );
  const pool = { attempts: [], failures: [], ideas: [], rules: [] };
  const report = settled.map((r, i) => {
    if (r.status === 'rejected') return { name: sources[i].name, ok: false, reason: String(r.reason?.message ?? r.reason).split('\n')[0] };
    for (const it of r.value) pool[it.bucket]?.push(it);
    return { name: sources[i].name, ok: true, reason: null };
  });
  const buckets = {};
  for (const [key] of BUCKETS) {
    buckets[key] = pool[key]
      .sort((a, b) => scoreOf(b) - scoreOf(a) || newestFirst(a, b))
      .slice(0, MAX_LINES)
      .map((it) => ({
        date: it.date,
        source: it.source,
        repo: it.repo ?? null,
        other_repo: it.repo != null && !it.same_repo,
        similar: scoreOf(it) === 1,
        text: clip(it.text),
        path: it.path,
      }));
  }
  return { topic: words.join(' '), elapsed_ms: Date.now() - started, sources: report, buckets };
}

// 올해 날짜는 M/D, 다른 해는 YYYY/M/D
export function formatDate(iso, now = new Date()) {
  const [y, m, d] = iso.split('-').map(Number);
  return y === now.getFullYear() ? `${m}/${d}` : `${y}/${m}/${d}`;
}

const whereOf = (it) => (it.source === 'pact' ? `pact 기록 ${it.repo}` : it.source === 'memory' ? '메모리 파일' : it.source);

export function render(result, now = new Date()) {
  const readable = result.sources.filter((s) => s.ok).length;
  const lines = [`recall: ${result.topic || '(주제 없음)'} — 출처 ${readable}/${result.sources.length} · ${result.elapsed_ms}ms`];
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
