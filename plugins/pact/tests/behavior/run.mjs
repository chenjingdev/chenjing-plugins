#!/usr/bin/env node
// 실패 장면 행동 시험. 깨끗한 프로필에서 claude -p로 시나리오를 돌리고 판정해 통과율 표를 낸다.
//   node tests/behavior/run.mjs <scenario|all> [--runs 5] [--variant pact|control|both] [--concurrency 3] [--resume 1]
// --resume 1이면 out/에 있는 유효한 transcript는 다시 돌리지 않고 다시 판정만 한다.
// 사용 한도에 걸린 회차는 실패로 세지 않고, 한도를 만나면 새 회차를 띄우지 않고 종료 코드 3으로 끝낸다.
// pact 변형만 --plugin-dir로 pact를 싣는다. 대조군에서도 실패가 안 나오는 검사는 지침이 필요 없다는 뜻이다.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge, hitLimit, wrappedUp } from './judge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACT = path.resolve(HERE, '..', '..');
const PROFILE = process.env.PACT_TEST_PROFILE || path.join(homedir(), '.bench', '_claude');
const TURN_TIMEOUT_MS = Number(process.env.PACT_TEST_TURN_TIMEOUT_MS) || 15 * 60 * 1000;
const CLAUDE = process.env.PACT_TEST_CLAUDE || 'claude';
// 터미널이 끼워 넣는 claude 래퍼(cmux shim)는 훅과 MCP를 더해 깨끗한 프로필을 흐리므로 PATH에서 뺀다.
const BASE_PATH = (process.env.PATH ?? '').split(':').filter((p) => !p.includes('cmux-cli-shims')).join(':');
const live = new Set();
let limited = false;
const killAll = () => {
  for (const child of live) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (killAll(), process.exit(130)));

function parseArgs(argv) {
  const opts = { target: argv[0], runs: 5, variant: 'both', concurrency: 3, resume: 0 };
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    opts[key] = key === 'variant' ? argv[i + 1] : Number(argv[i + 1]);
  }
  return opts;
}

function loggedIn() {
  try {
    return Boolean(JSON.parse(readFileSync(path.join(PROFILE, '.claude.json'), 'utf8')).oauthAccount);
  } catch {
    return false;
  }
}

// 브라우저 창이 실제로 열리지 않게 open을 아무것도 안 하는 것으로 바꾼다.
function fakeBin() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pact-bin-'));
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(path.join(dir, name), '#!/bin/sh\necho "(시험: $@ 열기 생략)"\n');
    chmodSync(path.join(dir, name), 0o755);
  }
  return dir;
}

function workdirFor(fixture) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pact-work-'));
  cpSync(fixture, dir, { recursive: true });
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'fixture');
  return dir;
}

function runTurn({ prompt, cwd, sessionId, variant, env }) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--max-turns', process.env.PACT_TEST_MAX_TURNS || '20'];
  if (sessionId) args.push('--resume', sessionId);
  if (variant === 'pact') args.push('--plugin-dir', PACT);
  if (process.env.PACT_TEST_MODEL) args.push('--model', process.env.PACT_TEST_MODEL);
  return new Promise((resolve) => {
    // 프로세스 그룹으로 띄워, 시간 초과나 중단 때 claude가 띄운 하위 프로세스까지 함께 끈다.
    const child = spawn(CLAUDE, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    live.add(child);
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, TURN_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      live.delete(child);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      const events = out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { type: 'raw', text: l };
          }
        });
      resolve({ events, code, err });
    });
  });
}

function judgeAll(scenario, transcript, cwd, fixture) {
  return scenario.checks.map((check) => {
    try {
      return judge(check, transcript, cwd, fixture);
    } catch (e) {
      if (/알 수 없는 check/.test(e.message)) throw e;
      return false;
    }
  });
}

// 보내는 턴이나 pact 지침(skills, agents)이 바뀌면 옛 transcript는 다시 쓰지 않는다.
// 검사(checks)만 바뀐 것은 다시 판정하면 되고, 대조군은 pact 지침과 상관없다.
function fingerprint(scenario, variant) {
  const { checks, ...asSent } = scenario;
  const h = createHash('sha256').update(JSON.stringify(asSent));
  if (variant === 'control') return h.digest('hex').slice(0, 16);
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  for (const f of [...walk(path.join(PACT, 'skills')), ...walk(path.join(PACT, 'agents'))].sort()) h.update(readFileSync(f));
  return h.digest('hex').slice(0, 16);
}

function loadPrevious(file, scenario, variant) {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const meta = lines[0];
  const transcript = [];
  for (const e of lines.slice(1)) (transcript[e._turn] ??= []).push(e);
  // 지문이 없는 옛 기록은 대조군만 받는다(대조군은 지침과 상관없음).
  const stamp = meta.fingerprint ?? (variant === 'control' ? fingerprint(scenario, variant) : null);
  if (stamp !== fingerprint(scenario, variant) || hitLimit(transcript) || !existsSync(meta.workdir ?? '')) return null;
  return { transcript, cwd: meta.workdir };
}

async function runOnce(scenario, variant, n, bin, resume) {
  const fixture = path.join(HERE, 'fixtures', scenario.fixture);
  const outFile = path.join(HERE, 'out', scenario.name, `${variant}-${n}.jsonl`);
  const previous = resume ? loadPrevious(outFile, scenario, variant) : null;
  if (previous) return { r: judgeAll(scenario, previous.transcript, previous.cwd, fixture), reused: true };
  if (limited) return { limited: true };
  const cwd = workdirFor(fixture);
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: PROFILE,
    PATH: `${bin}:${BASE_PATH}`,
    PACT_CHECKLIST_TIMEOUT_MS: '5000',
    CLAUDE_PLUGIN_DATA: path.join(tmpdir(), 'pact-test-data'),
  };
  const transcript = [];
  let sessionId = null;
  for (const prompt of scenario.turns) {
    const { events, code, err } = await runTurn({ prompt, cwd, sessionId, variant, env });
    transcript.push(events);
    sessionId = events.find((e) => e.session_id)?.session_id ?? sessionId;
    const result = events.find((e) => e.type === 'result');
    if (/\/login|Invalid API key|Not logged in/i.test(`${result?.result ?? ''}${err}`)) throw Object.assign(new Error('login'), { login: true });
    if (hitLimit(transcript)) {
      limited = true;
      break;
    }
    if (!result || code !== 0) break;
    // stopOnWrapUp: 대화가 끝난 뒤의 턴은 판정에 쓰지 않으므로 보내지 않는다(승인으로 읽혀 build까지 가는 비용을 막음).
    if (scenario.stopOnWrapUp && wrappedUp(transcript, -1)) break;
  }
  const outDir = path.join(HERE, 'out', scenario.name);
  mkdirSync(outDir, { recursive: true });
  const lines = [{ type: 'pact-test', scenario: scenario.name, variant, n, workdir: cwd, fingerprint: fingerprint(scenario, variant) }];
  transcript.forEach((events, turn) => events.forEach((e) => lines.push({ ...e, _turn: turn })));
  writeFileSync(outFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (hitLimit(transcript)) return { limited: true };
  return { r: judgeAll(scenario, transcript, cwd, fixture) };
}

async function pool(jobs, size) {
  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, size) }, worker));
  return results;
}

const describe = (c) => Object.entries(c).filter(([k]) => k !== 'kind').map(([k, v]) => `${k}=${v}`).join(' ');

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = path.join(HERE, 'scenarios');
  const all = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
  const scenarios = opts.target === 'all' ? all : all.filter((s) => s.name === opts.target);
  if (!opts.target || !scenarios.length) {
    console.error(`사용법: run.mjs <${all.map((s) => s.name).join('|')}|all> [--runs 5] [--variant pact|control|both] [--concurrency 3]`);
    return 2;
  }
  if (!loggedIn()) {
    console.error(`CLAUDE_CONFIG_DIR=${PROFILE} claude 로 한 번 /login 하세요`);
    return 2;
  }
  const variants = opts.variant === 'both' ? ['pact', 'control'] : [opts.variant];
  const bin = fakeBin();
  const jobs = [];
  for (const s of scenarios) for (const v of variants) for (let n = 1; n <= opts.runs; n++) jobs.push({ s, v, n });
  let finished = 0;
  const results = await pool(
    jobs.map((job) => async () => {
      const out = await runOnce(job.s, job.v, job.n, bin, opts.resume);
      const mark = out.limited ? '한도' : out.r.map((x) => (x ? 'O' : 'X')).join('') + (out.reused ? ' (이전 결과)' : '');
      console.error(`[${++finished}/${jobs.length}] ${job.s.name} ${job.v} #${job.n}: ${mark}`);
      return { ...job, ...out };
    }),
    opts.concurrency,
  );
  console.log('| 시나리오 | 검사 | ' + variants.join(' | ') + ' |');
  console.log('|---|---|' + variants.map(() => '---|').join(''));
  let ok = true;
  for (const s of scenarios) {
    s.checks.forEach((c, i) => {
      const cells = variants.map((v) => {
        const mine = results.filter((x) => x.s === s && x.v === v && !x.limited);
        const pass = mine.filter((x) => x.r[i]).length;
        if (v === 'pact' && (mine.length < opts.runs || pass < Math.ceil(mine.length * 0.8))) ok = false;
        return `${pass}/${mine.length}`;
      });
      console.log(`| ${s.name} | ${c.kind} ${describe(c)} | ${cells.join(' | ')} |`);
    });
  }
  if (limited) {
    console.error('사용 한도에 걸려 일부 회차를 돌리지 못했습니다. 한도가 풀린 뒤 --resume 1로 이어 돌리세요.');
    return 3;
  }
  return ok ? 0 : 1;
}

main().then(
  (code) => (process.exitCode = code),
  (err) => {
    if (err.login) {
      console.error(`CLAUDE_CONFIG_DIR=${PROFILE} claude 로 한 번 /login 하세요`);
      process.exitCode = 2;
    } else {
      console.error(err.stack ?? err.message);
      process.exitCode = 1;
    }
  },
);
