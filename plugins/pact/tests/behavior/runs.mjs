#!/usr/bin/env node
// 행동 시험의 "판" 저장소. 시험을 한 번 돌릴 때마다 판정 결과를 out/runs/<id>.json 하나로 쌓는다.
//   node tests/behavior/runs.mjs import-legacy [out-dir]   # out/에 남은 옛 기록을 "이전 기록 모음" 판 하나로 가져온다
//
// 판 파일의 모양(version 1):
//   id, at(ISO), kind('new'|'rejudge'|'legacy'), label?(legacy만 '이전 기록 모음')
//   scenarios: 돌린 장면 이름들, variants: 돌린 변형들, runs: 장면·변형마다 계획한 회차 수
//   pact: { fingerprint }  — pact 지침(skills·agents)의 지문. 모르면 null
//   defs: { <장면>: { scene, fixture, turns, checks } }  — 그때의 시나리오 말과 검사
//   attempts: [{ scenario, variant, n, limited, reused, fingerprint,
//                results: [{ pass(true|false|null), reason, match:[{turn,text}] }]  // defs.checks와 같은 순서, 한도 회차는 []
//                conversation: 결과 중 하나라도 pass===false인 회차만 대화 조각 배열, 아니면 null }]
// pass가 null이면 판정 불가(통과율에서 뺀다). 사용자 말풍선은 defs[장면].turns[turn]에서 가져온다.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { explain, hitLimit } from './judge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACT = path.resolve(HERE, '..', '..');
const VARIANT_ORDER = ['pact', 'control'];
const UNDECIDABLE = '판정 불가(작업 폴더 없음)';
// 작업 폴더의 파일을 봐야 하는 검사들. 폴더가 지워졌으면 다시 판정할 수 없다.
const NEEDS_WORKDIR = new Set(['fileChanged', 'noFileCreated', 'specLint', 'specMaxLines', 'specOpenAiAssumptionsMax']);

export const defaultOutDir = () => process.env.PACT_TEST_OUT || path.join(HERE, 'out');
const roundsDir = (outDir) => path.join(outDir, 'runs');

// ---- 지문 ----
function guidelineFiles(pactDir) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  return [...walk(path.join(pactDir, 'skills')), ...walk(path.join(pactDir, 'agents'))].sort();
}

// pact 지침(skills, agents)만의 지문. 판끼리 "지침 바뀜"을 가릴 때 쓴다.
export function guidelineHash(pactDir) {
  const h = createHash('sha256');
  for (const f of guidelineFiles(pactDir)) h.update(readFileSync(f));
  return h.digest('hex').slice(0, 16);
}

export const EXECUTION_CONTRACT = 'pact-exec-v2';

function treeFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory() ? treeFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)])
    .sort();
}

function hashFiles(hash, base, files) {
  for (const file of [...files].sort()) {
    const name = path.relative(base, file).split(path.sep).join('/');
    const bytes = existsSync(file) ? readFileSync(file) : null;
    hash.update(JSON.stringify([name, bytes?.length ?? null]));
    if (bytes) hash.update(bytes);
  }
}

// 실행 입력만 묶는다. checks/판정기 변경은 같은 응답을 다시 판정할 수 있다.
export function fingerprint(pactDir, scenario, variant, { execution = {}, fixtureDir, runnerFiles } = {}) {
  const { checks, ...asSent } = scenario;
  const h = createHash('sha256').update(JSON.stringify({ contract: EXECUTION_CONTRACT, variant, scenario: asSent, execution }));
  const fixture = fixtureDir ?? path.join(pactDir, 'tests', 'behavior', 'fixtures', scenario.fixture);
  hashFiles(h, fixture, treeFiles(fixture));
  hashFiles(h, pactDir, runnerFiles ?? [
    path.join(pactDir, 'tests', 'behavior', 'run.mjs'),
    path.join(pactDir, 'tests', 'behavior', 'runs.mjs'),
    path.join(pactDir, '.claude-plugin', 'plugin.json'),
    ...treeFiles(path.join(pactDir, 'scripts')),
  ]);
  if (variant === 'pact') hashFiles(h, pactDir, guidelineFiles(pactDir));
  return `${EXECUTION_CONTRACT}:${h.digest('hex')}`;
}

export function judgmentFingerprint(pactDir = PACT) {
  const h = createHash('sha256').update('pact-judge-v1');
  hashFiles(h, pactDir, [path.join(pactDir, 'tests', 'behavior', 'judge.mjs')]);
  return `pact-judge-v1:${h.digest('hex')}`;
}

// ---- 판정 ----
export function judgeOne(check, transcript, workdir, fixtureDir) {
  try {
    const { pass, reason, match } = explain(check, transcript, workdir, fixtureDir);
    return { pass, reason, match: match ?? [] };
  } catch (e) {
    if (/알 수 없는 check/.test(e.message)) throw e;
    return { pass: false, reason: `판정 중 오류: ${e.message}`, match: [] };
  }
}

export const judgeChecks = (scenario, transcript, workdir, fixtureDir) => scenario.checks.map((check) => judgeOne(check, transcript, workdir, fixtureDir));

// ---- 대화 ----
const MAX_STR = 3000;
const clip = (s) => (s.length > MAX_STR ? `${s.slice(0, MAX_STR)}…(+${s.length - MAX_STR}자 생략)` : s);
const clipDeep = (v) => {
  if (typeof v === 'string') return clip(v);
  if (Array.isArray(v)) return v.map(clipDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipDeep(x)]));
  return v;
};
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? []).map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[이미지]' : '')).filter(Boolean).join('\n');

// 결과판이 말풍선을 그릴 만큼만 남긴다: 답·생각·도구 호출·도구 결과·사용자 글. init 같은 큰 이벤트와 잡음은 뺀다.
export function compactConversation(transcript) {
  const items = [];
  transcript.forEach((events, turn) => {
    for (const e of events) {
      if (e?.type === 'assistant') {
        for (const c of e.message?.content ?? []) {
          if (c.type === 'text') items.push({ turn, type: 'text', role: 'assistant', text: clip(c.text ?? '') });
          else if (c.type === 'thinking') {
            if (c.thinking) items.push({ turn, type: 'thinking', role: 'assistant', text: clip(c.thinking) });
          } else if (c.type === 'tool_use') items.push({ turn, type: 'tool_use', role: 'assistant', id: c.id, name: c.name, input: clipDeep(c.input ?? {}) });
        }
      } else if (e?.type === 'user') {
        const content = e.message?.content;
        if (typeof content === 'string') items.push({ turn, type: 'user_text', role: 'user', text: clip(content) });
        else
          for (const c of content ?? []) {
            if (c.type === 'tool_result') items.push({ turn, type: 'tool_result', role: 'user', toolUseId: c.tool_use_id, text: clip(textOf(c.content)), isError: Boolean(c.is_error) });
            else if (c.type === 'text') items.push({ turn, type: 'user_text', role: 'user', text: clip(c.text ?? '') });
          }
      } else if (e?.type === 'result' && e.subtype && e.subtype !== 'success') {
        items.push({ turn, type: 'result', subtype: e.subtype, text: clip(String(e.result ?? '')) });
      }
    }
  });
  return items;
}

// ---- 판 만들기·쓰기·읽기 ----
const isFailed = (a) => !a.limited && a.results.some((r) => r.pass === false);

export function buildRound({ kind, at, scenarios, variants, runs, pactFingerprint, attempts, label, execution }) {
  const round = {
    version: 1,
    at: new Date(at).toISOString(),
    kind,
    ...(label ? { label } : {}),
    scenarios: scenarios.map((s) => s.name),
    variants,
    runs,
    // pact를 돌리지 않은 판(대조군만)에는 지침 지문이 의미 없다.
    pact: { fingerprint: variants.includes('pact') ? pactFingerprint ?? null : null },
    ...(execution ? { execution } : {}),
    judge: { fingerprint: judgmentFingerprint() },
    defs: Object.fromEntries(scenarios.map((s) => [s.name, { scene: s.scene, fixture: s.fixture, turns: s.turns, checks: s.checks }])),
    attempts: attempts.map((a) => ({
      scenario: a.scenario.name,
      variant: a.variant,
      n: a.n,
      limited: Boolean(a.limited),
      reused: Boolean(a.reused),
      fingerprint: a.fingerprint ?? null,
      results: a.limited ? [] : a.results,
      conversation: isFailed({ limited: a.limited, results: a.results ?? [] }) ? compactConversation(a.transcript ?? []) : null,
    })),
  };
  return round;
}

// out/runs/<id>.json으로 쓴다. 같은 초에 또 저장해도 덮어쓰지 않고 -2, -3을 붙인다.
export function saveRound(outDir, round) {
  const dir = roundsDir(outDir);
  mkdirSync(dir, { recursive: true });
  const base = round.at.replace(/[-:]/g, '').replace(/\.\d+/, '');
  for (let i = 1; ; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    const saved = { id, ...round };
    const file = path.join(dir, `${id}.json`);
    try {
      writeFileSync(file, JSON.stringify(saved, null, 1) + '\n', { flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    return { ...saved, file };
  }
}

export function listRounds(outDir) {
  const dir = roundsDir(outDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(path.join(dir, f), 'utf8'))];
      } catch (e) {
        console.error(`경고: 깨진 판 파일을 건너뜀: ${path.join(dir, f)} (${e.message})`);
        return [];
      }
    })
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

// ---- 옛 기록 가져오기 ----
export function readRecord(file) {
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const meta = lines[0];
  if (meta?.type !== 'pact-test') throw new Error('pact-test 메타가 없음');
  const transcript = [];
  for (const e of lines.slice(1)) (transcript[e._turn ?? 0] ??= []).push(e);
  for (let i = 0; i < transcript.length; i++) transcript[i] ??= [];
  return { meta, transcript };
}

// out/<장면>/<변형>-<n>.jsonl 전부를 "이전 기록 모음" 판 하나로 만든다. 판이 이미 하나라도 있으면 가져오지 않는다
// (새 시험이 같은 파일 이름으로 기록을 덮어쓰므로, 판이 쌓인 뒤의 기록은 옛 기록이 아니다).
export function importLegacy(outDir, { pactDir = PACT, scenariosDir = path.join(HERE, 'scenarios'), fixturesDir = path.join(HERE, 'fixtures') } = {}) {
  if (listRounds(outDir).length) return { created: false, reason: '이미 판이 있어 옛 기록을 가져오지 않음' };
  const defs = new Map();
  for (const f of existsSync(scenariosDir) ? readdirSync(scenariosDir).filter((f) => f.endsWith('.json')) : []) {
    const def = JSON.parse(readFileSync(path.join(scenariosDir, f), 'utf8'));
    defs.set(def.name, def);
  }
  const files = [];
  for (const dirent of existsSync(outDir) ? readdirSync(outDir, { withFileTypes: true }) : []) {
    if (!dirent.isDirectory() || dirent.name === 'runs') continue;
    for (const f of readdirSync(path.join(outDir, dirent.name))) {
      const m = /^(pact|control)-(\d+)\.jsonl$/.exec(f);
      if (m) files.push({ scenario: dirent.name, variant: m[1], n: Number(m[2]), file: path.join(outDir, dirent.name, f) });
    }
  }
  const skipped = [];
  const attempts = [];
  let latest = 0;
  let undecidable = 0;
  for (const rec of files) {
    const def = defs.get(rec.scenario);
    if (!def) {
      skipped.push(`${rec.scenario}/${rec.variant}-${rec.n}: 시나리오가 없음`);
      continue;
    }
    let loaded;
    try {
      loaded = readRecord(rec.file);
    } catch (e) {
      skipped.push(`${rec.scenario}/${rec.variant}-${rec.n}: ${e.message}`);
      continue;
    }
    const { meta, transcript } = loaded;
    latest = Math.max(latest, statSync(rec.file).mtimeMs);
    const limited = hitLimit(transcript);
    let results = [];
    if (!limited) {
      const fixtureDir = path.join(fixturesDir, def.fixture);
      const hasWork = existsSync(meta.workdir ?? '');
      results = def.checks.map((check) => {
        if (NEEDS_WORKDIR.has(check.kind) && !hasWork) {
          undecidable++;
          return { pass: null, reason: UNDECIDABLE, match: [] };
        }
        return judgeOne(check, transcript, meta.workdir, fixtureDir);
      });
    }
    attempts.push({ scenario: def, variant: rec.variant, n: rec.n, limited, reused: false, fingerprint: meta.fingerprint ?? null, results, transcript });
  }
  if (!attempts.length) return { created: false, reason: '가져올 옛 기록이 없음', skipped };
  const order = (a) => [a.scenario.name, VARIANT_ORDER.indexOf(a.variant), a.n];
  attempts.sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    return x[0].localeCompare(y[0]) || x[1] - y[1] || x[2] - y[2];
  });
  const scenarios = [...new Map(attempts.map((a) => [a.scenario.name, a.scenario])).values()];
  const variants = VARIANT_ORDER.filter((v) => attempts.some((a) => a.variant === v));
  // 모든 pact 기록이 지금 지침으로 돌린 것일 때만 판의 지침 지문을 알 수 있다.
  const pactAttempts = attempts.filter((a) => a.variant === 'pact');
  const sameGuidelines = pactAttempts.length > 0 && pactAttempts.every((a) => a.fingerprint === fingerprint(pactDir, a.scenario, 'pact'));
  const round = buildRound({
    kind: 'legacy',
    label: '이전 기록 모음',
    at: new Date(latest),
    scenarios,
    variants,
    runs: Math.max(...attempts.map((a) => a.n)),
    pactFingerprint: sameGuidelines ? guidelineHash(pactDir) : null,
    attempts,
  });
  const saved = saveRound(outDir, round);
  return { created: true, id: saved.id, file: saved.file, attempts: attempts.length, scenarios: scenarios.length, undecidable, skipped };
}

// ---- CLI ----
function cli(argv) {
  const [command, outArg] = argv;
  if (command !== 'import-legacy') {
    console.error('사용법: runs.mjs import-legacy [out-dir]');
    return 2;
  }
  const res = importLegacy(path.resolve(outArg ?? defaultOutDir()));
  if (res.created) {
    console.log(`이전 기록 모음 판을 만들었습니다: ${res.file}`);
    console.log(`장면 ${res.scenarios}개, 회차 ${res.attempts}개, 판정 불가 검사 ${res.undecidable}개`);
  } else console.log(res.reason);
  for (const s of res.skipped ?? []) console.error(`건너뜀: ${s}`);
  return 0;
}

const direct = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (direct) process.exitCode = cli(process.argv.slice(2));
