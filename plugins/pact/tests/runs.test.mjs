import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { judgeChecks, compactConversation, buildRound, saveRound, listRounds, importLegacy, fingerprint, guidelineHash, judgmentFingerprint } from './behavior/runs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const made = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pact-runs-'));
  made.push(dir);
  return dir;
};
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const say = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const done = (text) => ({ type: 'result', subtype: 'success', result: text });

const scenario = {
  name: 'demo',
  scene: '데모 장면',
  fixture: 'fx',
  turns: ['처음 말', '두번째 말'],
  checks: [{ kind: 'replyMatch', pattern: '정할게요' }, { kind: 'replyNotMatch', pattern: '괜찮을까요\\?$' }],
};

test('judgeChecks returns pass, reason and match per check, and turns an exception into a failed reason', () => {
  const t = [[say('시작')], [say('이렇게 정할게요.\n괜찮을까요?')]];
  const [a, b] = judgeChecks(scenario, t, tmp(), tmp());
  assert.equal(a.pass, true);
  assert.deepEqual(a.match, [{ turn: 1, text: '이렇게 정할게요.' }]);
  assert.equal(b.pass, false);
  assert.match(b.reason, /금지 패턴/);

  const bad = { ...scenario, checks: [{ kind: 'replyMatch', pattern: '(' }] };
  const [e] = judgeChecks(bad, t, tmp(), tmp());
  assert.equal(e.pass, false);
  assert.match(e.reason, /^판정 중 오류: /);
  assert.deepEqual(e.match, []);

  assert.throws(() => judgeChecks({ ...scenario, checks: [{ kind: 'nope' }] }, t, tmp(), tmp()), /알 수 없는 check/);
});

test('compactConversation keeps bubbles and drops init/noise events, trimming huge strings', () => {
  const big = 'x'.repeat(10000);
  const t = [
    [
      { type: 'system', subtype: 'init', tools: ['a'.repeat(5000)] },
      { type: 'system', subtype: 'thinking_tokens' },
      { type: 'rate_limit_event' },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'thinking', thinking: '생각' }] } },
      say('안녕'),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'a.md', content: big } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '썼음' }], is_error: false }] } },
      { type: 'user', message: { content: '사용자 글' } },
      { type: 'result', subtype: 'error_max_turns', result: '' },
    ],
    [say('둘째'), done('둘째')],
  ];
  const c = compactConversation(t);
  assert.deepEqual(
    c.map((x) => [x.turn, x.type]),
    [[0, 'thinking'], [0, 'text'], [0, 'tool_use'], [0, 'tool_result'], [0, 'user_text'], [0, 'result'], [1, 'text']],
  );
  assert.equal(c[0].text, '생각');
  assert.equal(c[2].name, 'Write');
  assert.ok(c[2].input.content.length < 3100);
  assert.match(c[2].input.content, /생략/);
  assert.equal(c[3].text, '썼음');
  assert.equal(c[3].toolUseId, 't1');
  assert.equal(c[4].text, '사용자 글');
  assert.equal(c[5].subtype, 'error_max_turns');
  assert.ok(JSON.stringify(c).length < 8000);
});

const attempt = (variant, n, pass, extra = {}) => ({
  scenario,
  variant,
  n,
  fingerprint: 'fp',
  reused: false,
  limited: false,
  transcript: [[say('질문?'), done('질문?')], [say('끝')]],
  results: scenario.checks.map((c) => ({ pass, reason: pass ? '좋음' : '나쁨', match: [] })),
  ...extra,
});

test('buildRound/saveRound: failed attempts keep their conversation, passing ones do not, limited ones are marked', () => {
  const out = tmp();
  const round = buildRound({
    kind: 'new',
    at: new Date('2026-10-11T01:02:03.456Z'),
    scenarios: [scenario],
    variants: ['pact'],
    runs: 3,
    pactFingerprint: 'abc',
    attempts: [attempt('pact', 1, true), attempt('pact', 2, false), attempt('pact', 3, false, { limited: true, results: [], transcript: [[done("You've hit your session limit")]] })],
  });
  const saved = saveRound(out, round);
  assert.equal(saved.id, '20261011T010203Z');
  assert.ok(saved.file.endsWith(path.join('runs', '20261011T010203Z.json')));
  const [r] = listRounds(out);
  assert.equal(r.id, saved.id);
  assert.equal(r.kind, 'new');
  assert.equal(r.at, '2026-10-11T01:02:03.456Z');
  assert.deepEqual(r.scenarios, ['demo']);
  assert.deepEqual(r.variants, ['pact']);
  assert.equal(r.runs, 3);
  assert.deepEqual(r.pact, { fingerprint: 'abc' });
  assert.deepEqual(r.defs.demo.turns, ['처음 말', '두번째 말']);
  assert.deepEqual(r.defs.demo.checks, scenario.checks);
  const [pass, fail, limit] = r.attempts;
  assert.equal(pass.conversation, null);
  assert.equal(pass.results.length, 2);
  assert.equal(fail.conversation.length, 2);
  assert.deepEqual(fail.conversation[0], { turn: 0, type: 'text', role: 'assistant', text: '질문?' });
  assert.equal(limit.limited, true);
  assert.deepEqual(limit.results, []);
  assert.equal(limit.conversation, null);
  // 같은 시각에 또 저장해도 덮어쓰지 않는다.
  const again = saveRound(out, round);
  assert.equal(again.id, '20261011T010203Z-2');
  assert.equal(listRounds(out).length, 2);
});

test('a round without the pact variant has no guideline fingerprint', () => {
  const r = buildRound({ kind: 'new', at: new Date(), scenarios: [scenario], variants: ['control'], runs: 1, pactFingerprint: 'abc', attempts: [attempt('control', 1, true)] });
  assert.equal(r.pact.fingerprint, null);
});

test('listRounds skips a broken round file with a warning and returns the rest', () => {
  const out = tmp();
  saveRound(out, buildRound({ kind: 'new', at: new Date(), scenarios: [scenario], variants: ['pact'], runs: 1, pactFingerprint: 'x', attempts: [attempt('pact', 1, true)] }));
  writeFileSync(path.join(out, 'runs', 'broken.json'), '{ 깨짐');
  const res = spawnSync('node', ['--input-type=module', '-e', `import { listRounds } from ${JSON.stringify(new URL('./behavior/runs.mjs', import.meta.url).href)}; console.log(listRounds(${JSON.stringify(out)}).length)`], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), '1');
  assert.match(res.stderr, /깨진 판 파일/);
});

test('a resumed run where every valid attempt was reused is a rejudge round', () => {
  const r = buildRound({
    kind: 'rejudge',
    at: new Date(),
    scenarios: [scenario],
    variants: ['control'],
    runs: 1,
    pactFingerprint: 'abc',
    attempts: [attempt('control', 1, true, { reused: true })],
  });
  assert.equal(r.kind, 'rejudge');
  assert.equal(r.attempts[0].reused, true);
});

// ---- 옛 기록 가져오기 ----
function legacyWorld() {
  const root = tmp();
  const pactDir = path.join(root, 'pact');
  mkdirSync(path.join(pactDir, 'skills'), { recursive: true });
  mkdirSync(path.join(pactDir, 'agents'), { recursive: true });
  writeFileSync(path.join(pactDir, 'skills', 'a.md'), '지침');
  const scenariosDir = path.join(root, 'scenarios');
  const fixturesDir = path.join(root, 'fixtures');
  mkdirSync(scenariosDir);
  mkdirSync(path.join(fixturesDir, 'fx'), { recursive: true });
  writeFileSync(path.join(fixturesDir, 'fx', 'a.txt'), '원본');
  const spec = {
    ...scenario,
    checks: [...scenario.checks, { kind: 'fileChanged', path: 'a.txt' }, { kind: 'specLint' }],
  };
  writeFileSync(path.join(scenariosDir, 'demo.json'), JSON.stringify(spec));
  const out = path.join(root, 'out');
  const live = path.join(root, 'live-workdir');
  mkdirSync(live);
  writeFileSync(path.join(live, 'a.txt'), '바뀜');
  const write = (variant, n, workdir, events, fp, mtime) => {
    mkdirSync(path.join(out, 'demo'), { recursive: true });
    const file = path.join(out, 'demo', `${variant}-${n}.jsonl`);
    const meta = { type: 'pact-test', scenario: 'demo', variant, n, workdir, ...(fp ? { fingerprint: fp } : {}) };
    const lines = [meta, ...events.map((e) => ({ ...e, _turn: e._turn ?? 0 }))];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    utimesSync(file, mtime, mtime);
  };
  const gone = path.join(root, 'deleted-workdir');
  const early = new Date('2026-10-10T04:00:00Z');
  const late = new Date('2026-10-10T16:30:00Z');
  const good = [say('시작'), { ...say('이렇게 정할게요.'), _turn: 1 }];
  const bad = [say('시작'), { ...say('괜찮을까요?'), _turn: 1 }];
  write('control', 1, gone, good, null, early);
  write('control', 2, gone, bad, null, early);
  write('pact', 1, live, good, fingerprint(pactDir, spec, 'pact'), late);
  write('pact', 2, gone, [{ type: 'result', result: "You've hit your session limit", _turn: 0 }], 'stale', late);
  return { root, pactDir, scenariosDir, fixturesDir, out, spec };
}

test('importLegacy builds one 이전 기록 모음 round; undecidable checks are null and failing attempts keep conversation', () => {
  const w = legacyWorld();
  const res = importLegacy(w.out, w);
  assert.equal(res.created, true);
  assert.equal(res.attempts, 4);
  const rounds = listRounds(w.out);
  assert.equal(rounds.length, 1);
  const r = rounds[0];
  assert.equal(r.kind, 'legacy');
  assert.equal(r.label, '이전 기록 모음');
  assert.equal(r.at, '2026-10-10T16:30:00.000Z');
  assert.deepEqual(r.scenarios, ['demo']);
  assert.deepEqual(r.variants, ['pact', 'control']);
  assert.equal(r.runs, 2);
  assert.equal(r.defs.demo.checks.length, 4);
  const get = (v, n) => r.attempts.find((a) => a.variant === v && a.n === n);

  const c1 = get('control', 1);
  assert.deepEqual(c1.results.map((x) => x.pass), [true, true, null, null]);
  assert.equal(c1.results[2].reason, '판정 불가(작업 폴더 없음)');
  assert.equal(c1.results[3].reason, '판정 불가(작업 폴더 없음)');
  assert.equal(c1.conversation, null);
  assert.equal(c1.fingerprint, null);

  const c2 = get('control', 2);
  assert.deepEqual(c2.results.map((x) => x.pass), [false, false, null, null]);
  assert.ok(c2.conversation.length > 0);

  // 작업 폴더가 남아 있으면 파일 검사도 그대로 판정한다.
  const p1 = get('pact', 1);
  assert.equal(p1.results[2].pass, true);
  assert.equal(p1.results[3].pass, false);
  assert.equal(p1.results[3].reason, '명세 파일 없음');

  const p2 = get('pact', 2);
  assert.equal(p2.limited, true);
  assert.deepEqual(p2.results, []);

  // 지문이 지금 지침과 같은 pact 기록뿐이 아니면 판의 지침 지문은 모른다(null).
  assert.equal(r.pact.fingerprint, null);
});

test('importLegacy records the guideline hash when every pact record was made with the current guidelines', () => {
  const w = legacyWorld();
  // 한도 기록의 지문도 현재 것으로 맞춘다.
  const file = path.join(w.out, 'demo', 'pact-2.jsonl');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const meta = JSON.parse(lines[0]);
  meta.fingerprint = fingerprint(w.pactDir, w.spec, 'pact');
  writeFileSync(file, [JSON.stringify(meta), ...lines.slice(1)].join('\n') + '\n');
  importLegacy(w.out, w);
  assert.equal(listRounds(w.out)[0].pact.fingerprint, guidelineHash(w.pactDir));
});

test('importLegacy twice still leaves one round, and never imports once any round exists', () => {
  const w = legacyWorld();
  assert.equal(importLegacy(w.out, w).created, true);
  const second = importLegacy(w.out, w);
  assert.equal(second.created, false);
  assert.match(second.reason, /이미 판이 있/);
  assert.equal(readdirSync(path.join(w.out, 'runs')).length, 1);

  const other = legacyWorld();
  saveRound(other.out, buildRound({ kind: 'new', at: new Date(), scenarios: [scenario], variants: ['pact'], runs: 1, pactFingerprint: 'x', attempts: [attempt('pact', 1, true)] }));
  assert.equal(importLegacy(other.out, other).created, false);
  assert.equal(listRounds(other.out).length, 1);
});

test('importLegacy with no records makes no round', () => {
  const w = legacyWorld();
  const empty = tmp();
  const res = importLegacy(empty, w);
  assert.equal(res.created, false);
  assert.match(res.reason, /기록이 없/);
});

test('CLI: runs.mjs import-legacy <out-dir> prints the result and is idempotent', () => {
  // CLI는 실제 scenarios/·fixtures/를 쓰므로 실제 장면 이름으로 기록을 만든다.
  const out = tmp();
  mkdirSync(path.join(out, 'confirm-only'));
  const meta = { type: 'pact-test', scenario: 'confirm-only', variant: 'control', n: 1, workdir: path.join(out, 'gone') };
  const events = [{ ...say('이렇게 정할게요.'), _turn: 0 }, { ...say('이렇게 정할게요.'), _turn: 1 }];
  writeFileSync(path.join(out, 'confirm-only', 'control-1.jsonl'), [meta, ...events].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const script = path.join(here, 'behavior', 'runs.mjs');
  const first = spawnSync('node', [script, 'import-legacy', out], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /이전 기록 모음/);
  const second = spawnSync('node', [script, 'import-legacy', out], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /이미 판이 있/);
  assert.equal(readdirSync(path.join(out, 'runs')).length, 1);
  assert.equal(listRounds(out)[0].attempts[0].results[2].pass, true); // agentNotInvoked는 작업 폴더 없이도 판정된다
  assert.equal(spawnSync('node', [script, 'nope'], { encoding: 'utf8' }).status, 2);
});

function executionWorld() {
  const root = tmp();
  const pact = path.join(root, 'pact');
  for (const dir of ['skills', 'agents', 'scripts', 'tests/behavior/fixtures/fx']) mkdirSync(path.join(pact, dir), { recursive: true });
  writeFileSync(path.join(pact, 'skills', 'task.md'), 'task instructions');
  writeFileSync(path.join(pact, 'scripts', 'probe.mjs'), 'export const probe = 1;');
  writeFileSync(path.join(pact, 'tests/behavior', 'run.mjs'), 'runner v1');
  writeFileSync(path.join(pact, 'tests/behavior/fixtures/fx', 'input.txt'), 'fixture v1');
  return { pact, fixture: path.join(pact, 'tests/behavior/fixtures/fx'), options: { execution: { model: 'test-model-a', cli: { path: '/fake/claude', digest: 'cli-a' } } } };
}

test('execution fingerprint invalidates both variants on fixture bytes, paths, model, CLI identity and runner code', () => {
  for (const variant of ['pact', 'control']) {
    const w = executionWorld();
    const fp = (options = w.options) => fingerprint(w.pact, scenario, variant, options);
    const original = fp();
    writeFileSync(path.join(w.fixture, 'input.txt'), 'fixture v2');
    const fixtureChanged = fp();
    assert.notEqual(fixtureChanged, original, 'changed input bytes must rerun the model');
    writeFileSync(path.join(w.fixture, 'same-bytes-new-path.txt'), 'fixture v2');
    assert.notEqual(fp(), fixtureChanged, 'fixture path set is an execution input');
    assert.notEqual(fp({ execution: { ...w.options.execution, model: 'test-model-b' } }), fp(), 'model changes cannot reuse another model response');
    assert.notEqual(fp({ execution: { ...w.options.execution, cli: { path: '/fake/claude', digest: 'cli-b' } } }), fp(), 'CLI identity changes must rerun');
    const beforeRunner = fp();
    writeFileSync(path.join(w.pact, 'tests/behavior/run.mjs'), 'runner v2');
    assert.notEqual(fp(), beforeRunner, 'runner behavior changes must rerun');
    const beforeProbe = fp();
    writeFileSync(path.join(w.pact, 'scripts/probe.mjs'), 'export const probe = 2;');
    assert.notEqual(fp(), beforeProbe, 'helpers available to the model are execution inputs');
    assert.match(original, /^pact-exec-v2:/, 'new execution stamps cannot be confused with legacy stamps');
  }
});

test('checks-only changes retain execution fingerprint; judgment provenance is separate', () => {
  const w = executionWorld();
  for (const variant of ['pact', 'control']) {
    const before = fingerprint(w.pact, scenario, variant, w.options);
    const changedChecks = { ...scenario, checks: [{ kind: 'replyMatch', pattern: 'new assertion' }] };
    assert.equal(fingerprint(w.pact, changedChecks, variant, w.options), before);
  }
  const round = buildRound({ kind: 'new', at: new Date(), scenarios: [scenario], variants: ['control'], runs: 1, attempts: [attempt('control', 1, true)] });
  assert.equal(typeof round.judge?.fingerprint, 'string', 'saved verdicts name the judgment implementation');
});

test('fixture ordering is stable and judgment-code changes only change verdict provenance', () => {
  const a = executionWorld();
  const b = executionWorld();
  for (const [world, names] of [[a, ['z.txt', 'a.txt']], [b, ['a.txt', 'z.txt']]]) {
    for (const name of names) writeFileSync(path.join(world.fixture, name), name);
  }
  for (const variant of ['pact', 'control']) {
    assert.equal(fingerprint(a.pact, scenario, variant, a.options), fingerprint(b.pact, scenario, variant, b.options));
  }
  const judgeFile = path.join(a.pact, 'tests/behavior/judge.mjs');
  writeFileSync(judgeFile, 'judge v1');
  const executionBefore = fingerprint(a.pact, scenario, 'control', a.options);
  const judgmentBefore = judgmentFingerprint(a.pact);
  writeFileSync(judgeFile, 'judge v2');
  assert.equal(fingerprint(a.pact, scenario, 'control', a.options), executionBefore);
  assert.notEqual(judgmentFingerprint(a.pact), judgmentBefore);
});
