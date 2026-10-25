// run.mjs를 가짜 claude로 끝까지 돌려, 판이 out/runs/에 쌓이는지 본다(비용 없음).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listRounds } from './behavior/runs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const run = path.join(here, 'behavior', 'run.mjs');

// 호출 번호로 답을 바꾸는 가짜 claude: 1~2번(첫 회차) 통과, 3~4번(둘째 회차) 실패, 5번부터 사용 한도.
function fakeClaude(dir) {
  const counter = path.join(dir, 'count');
  writeFileSync(counter, '0');
  const bin = path.join(dir, 'fake-claude.mjs');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const n = Number(readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1;
writeFileSync(${JSON.stringify(counter)}, String(n));
const out = (e) => console.log(JSON.stringify({ session_id: 's' + n, ...e }));
if (n >= 5) {
  out({ type: 'result', subtype: 'success', result: "You've hit your session limit" });
} else {
  const text = n <= 2 ? '이렇게 정할게요.' : '이거 괜찮을까요?';
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', result: text });
}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

// 시험이 만드는 작업 폴더·임시 파일까지 dir 안에 모이도록 TMPDIR도 dir 안으로 돌린다.
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
function world() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pact-e2e-'));
  made.push(dir);
  mkdirSync(path.join(dir, 'tmp'));
  const profile = path.join(dir, 'profile');
  mkdirSync(profile);
  writeFileSync(path.join(profile, '.claude.json'), JSON.stringify({ oauthAccount: { id: 'x' } }));
  const out = path.join(dir, 'out');
  const env = { ...process.env, TMPDIR: path.join(dir, 'tmp'), PACT_TEST_CLAUDE: fakeClaude(dir), PACT_TEST_PROFILE: profile, PACT_TEST_OUT: out };
  return { dir, out, env };
}

test('run.mjs saves a round (pass without conversation, fail with, limited marked) and exits 3 on a limit', () => {
  const { out, env } = world();
  const res = spawnSync('node', [run, 'confirm-only', '--runs', '3', '--variant', 'control', '--concurrency', '1'], { encoding: 'utf8', env });
  assert.equal(res.status, 3, res.stderr);
  assert.match(res.stderr, /판 저장/);
  // 한도로 끝나도 결과판을 새로 만들고 경로를 알린다.
  assert.ok(res.stderr.includes(`결과판: ${path.join(out, 'board.html')}`), res.stderr);
  const board = readFileSync(path.join(out, 'board.html'), 'utf8');
  assert.match(board, /행동 시험 결과판/);
  assert.match(board, /"limited":true/);

  const rounds = listRounds(out);
  assert.equal(rounds.length, 1);
  const r = rounds[0];
  assert.equal(r.kind, 'new');
  assert.deepEqual(r.scenarios, ['confirm-only']);
  assert.deepEqual(r.variants, ['control']);
  assert.equal(r.runs, 3);
  assert.equal(r.attempts.length, 3);
  const [a, b, c] = r.attempts;
  assert.deepEqual(a.results.map((x) => x.pass), [true, true, true]);
  assert.equal(a.conversation, null);
  assert.equal(a.results[1].match[0].text, '이렇게 정할게요.');
  assert.deepEqual(b.results.map((x) => x.pass), [false, false, true]);
  assert.match(b.results[0].reason, /금지 패턴/);
  assert.ok(b.conversation.some((x) => x.type === 'text' && x.text === '이거 괜찮을까요?'));
  assert.equal(c.limited, true);
  assert.deepEqual(c.results, []);
  assert.ok(r.defs['confirm-only'].turns.length >= 2);
  assert.equal(typeof a.fingerprint, 'string');
  // 통과한 회차의 대화는 jsonl에 그대로 남는다.
  assert.match(readFileSync(path.join(out, 'confirm-only', 'control-1.jsonl'), 'utf8'), /정할게요/);

  // --resume 1: 이미 있는 두 회차를 다시 판정만 하면 "다시 판정" 판이 하나 더 쌓인다.
  const again = spawnSync('node', [run, 'confirm-only', '--runs', '2', '--variant', 'control', '--concurrency', '1', '--resume', '1'], { encoding: 'utf8', env });
  assert.equal(again.status, 0, again.stderr);
  const all = listRounds(out);
  assert.equal(all.length, 2);
  const rejudged = all.at(-1);
  assert.equal(rejudged.kind, 'rejudge');
  assert.equal(rejudged.runs, 2);
  assert.ok(rejudged.attempts.every((x) => x.reused));
  assert.deepEqual(rejudged.attempts[1].results.map((x) => x.pass), [false, false, true]);
  // 다시 판정한 판도 결과판에 쌓인다: 판 2개, 통과한 1번 회차의 대화는 jsonl에서 채워진다.
  const again2 = readFileSync(path.join(out, 'board.html'), 'utf8');
  const data = JSON.parse(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(again2)[1]);
  assert.equal(data.rounds.length, 2);
  assert.ok(data.rounds[1].attempts[0].conversation.some((c) => c.type === 'text' && c.text === '이렇게 정할게요.'));
});

test('run.mjs imports the old records as the first round before overwriting them, only when no round exists yet', () => {
  const { out, env } = world();
  const old = path.join(out, 'confirm-only', 'control-1.jsonl');
  mkdirSync(path.dirname(old), { recursive: true });
  const meta = { type: 'pact-test', scenario: 'confirm-only', variant: 'control', n: 1, workdir: path.join(out, 'gone') };
  const say = (text, _turn) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] }, _turn });
  writeFileSync(old, [meta, say('옛 답', 0), say('옛 답', 1)].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const past = new Date('2026-01-02T03:04:05Z');
  utimesSync(old, past, past);

  const res = spawnSync('node', [run, 'confirm-only', '--runs', '1', '--variant', 'control'], { encoding: 'utf8', env });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /이전 기록 모음 판으로 가져옴/);
  const [legacy, fresh] = listRounds(out);
  assert.equal(legacy.kind, 'legacy');
  assert.equal(legacy.at, '2026-01-02T03:04:05.000Z');
  assert.equal(legacy.attempts.length, 1);
  assert.ok(legacy.attempts[0].conversation.some((m) => m.text === '옛 답')); // 덮어쓰기 전의 기록을 판정했다
  assert.equal(fresh.kind, 'new');
  assert.match(readFileSync(old, 'utf8'), /정할게요/); // jsonl은 새 시험이 덮어썼다

  // 판이 이미 있으면 다시 가져오지 않는다.
  const again = spawnSync('node', [run, 'confirm-only', '--runs', '1', '--variant', 'control'], { encoding: 'utf8', env });
  assert.doesNotMatch(again.stderr, /가져옴/);
  assert.equal(listRounds(out).filter((r) => r.kind === 'legacy').length, 1);
});

test('resume reruns a response when its requested model or CLI launcher changes', () => {
  const { dir, out, env } = world();
  const args = [run, 'confirm-only', '--runs', '1', '--variant', 'control', '--concurrency', '1'];
  const runWith = (extra = {}) => spawnSync('node', [...args, '--resume', '1'], { encoding: 'utf8', env: { ...env, ...extra } });
  const first = runWith({ PACT_TEST_MODEL: 'model-a' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(path.join(dir, 'count'), 'utf8'), '2');
  writeFileSync(path.join(env.PACT_TEST_PROFILE, '.claude.json'), JSON.stringify({ oauthAccount: { id: 'x' }, numStartups: 2 }));
  const same = runWith({ PACT_TEST_MODEL: 'model-a' });
  assert.equal(same.status, 0, same.stderr);
  assert.equal(readFileSync(path.join(dir, 'count'), 'utf8'), '2', 'unchanged execution rejudges without a CLI call');
  const changed = runWith({ PACT_TEST_MODEL: 'model-b' });
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(readFileSync(path.join(dir, 'count'), 'utf8'), '4', 'different requested model runs both turns again');
  assert.equal(listRounds(out).at(-1).attempts[0].reused, false);
  const meta = JSON.parse(readFileSync(path.join(out, 'confirm-only/control-1.jsonl'), 'utf8').split('\n')[0]);
  assert.equal(meta.execution.model, 'model-b');
  assert.equal(typeof meta.judge.fingerprint, 'string');
  writeFileSync(path.join(dir, 'count'), '0');
  writeFileSync(env.PACT_TEST_CLAUDE, readFileSync(env.PACT_TEST_CLAUDE, 'utf8') + '\n// launcher version changed\n');
  const launcherChanged = runWith({ PACT_TEST_MODEL: 'model-b' });
  assert.equal(launcherChanged.status, 0, launcherChanged.stderr);
  assert.equal(readFileSync(path.join(dir, 'count'), 'utf8'), '2', 'different launcher bytes rerun rather than reuse');
  assert.equal(listRounds(out).at(-1).kind, 'new');
});

test('resume never treats unstamped legacy control responses as current execution evidence', () => {
  const { dir, out, env } = world();
  const args = [run, 'confirm-only', '--runs', '1', '--variant', 'control', '--concurrency', '1'];
  const first = spawnSync('node', args, { encoding: 'utf8', env });
  assert.equal(first.status, 0, first.stderr);
  const file = path.join(out, 'confirm-only/control-1.jsonl');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const meta = JSON.parse(lines[0]);
  delete meta.fingerprint;
  writeFileSync(file, [JSON.stringify(meta), ...lines.slice(1)].join('\n') + '\n');
  const resumed = spawnSync('node', [...args, '--resume', '1'], { encoding: 'utf8', env });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(readFileSync(path.join(dir, 'count'), 'utf8'), '4');
  assert.equal(listRounds(out).at(-1).attempts[0].reused, false);
});
