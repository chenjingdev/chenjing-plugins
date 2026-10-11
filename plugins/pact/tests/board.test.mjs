import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { threshold, checkKey, tally, buildViews, collectBoard, renderBoard, buildBoard, markSegments, placeMatches, cellText, encodeHash, decodeHash } from './behavior/board.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const boardCli = path.join(here, 'behavior', 'board.mjs');
const made = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pact-board-'));
  made.push(dir);
  return dir;
};
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

// ---- 판 만들기 도우미 ----
const A = { kind: 'replyMatch', pattern: 'a' };
const B = { kind: 'firstReplyQuestionCount', max: 1 };
const C = { kind: 'specMaxLines', max: 40 };
const def = (checks, scene = '장면') => ({ scene, fixture: 'fx', turns: ['처음 말'], checks });
const att = (scenario, variant, n, passes, extra = {}) => ({
  scenario,
  variant,
  n,
  limited: false,
  reused: false,
  fingerprint: null,
  results: passes.map((pass) => ({ pass, reason: `이유 ${pass}`, match: [] })),
  conversation: null,
  ...extra,
});
const lim = (scenario, variant, n) => att(scenario, variant, n, [], { limited: true });
let seq = 0;
function round({ id, fp = null, variants = ['pact', 'control'], defs, attempts, kind = 'new' }) {
  seq++;
  return {
    version: 1,
    id,
    at: `2026-10-11T${String(seq).padStart(2, '0')}:00:00.000Z`,
    kind,
    scenarios: Object.keys(defs),
    variants,
    runs: 5,
    pact: { fingerprint: variants.includes('pact') ? fp : null },
    defs,
    attempts,
  };
}
const row = (view, scenario, key) => view.rows.find((r) => r.scenario === scenario && r.checkKey === key);

test('threshold is 80% of the valid attempts, rounded up', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 10, 15].map(threshold), [0, 1, 2, 3, 4, 4, 8, 12]);
});

test('checkKey identifies a check by kind and arguments, not by key order', () => {
  assert.equal(checkKey({ kind: 'k', a: 1, b: 2 }), checkKey({ b: 2, kind: 'k', a: 1 }));
  assert.notEqual(checkKey({ kind: 'k', a: 1 }), checkKey({ kind: 'k', a: 2 }));
  assert.notEqual(checkKey({ kind: 'k', a: 1 }), checkKey({ kind: 'j', a: 1 }));
});

test('a pact cell below 80% of valid attempts is red; at the threshold it is not', () => {
  const r = round({
    id: 'r',
    defs: { s: def([A, B]) },
    attempts: [
      ...[true, true, true, false, false].map((p, i) => att('s', 'pact', i + 1, [p, true])),
      ...[true, true, true, true, false].map((p, i) => att('s', 'control', i + 1, [true, p])),
    ],
  });
  const a = tally(r, 's', 'pact', checkKey(A));
  assert.deepEqual([a.valid, a.passed, a.failed, a.red], [5, 3, 2, true]);
  const b = tally(r, 's', 'pact', checkKey(B));
  assert.deepEqual([b.valid, b.passed, b.red], [5, 5, false]);
  // 대조군은 기준에 못 미쳐도 빨갛게 하지 않는다(미달 여부만 안다).
  const c = tally(r, 's', 'control', checkKey(B));
  assert.deepEqual([c.valid, c.passed, c.short, c.red], [5, 4, false, false]);
  const d = tally(r, 's', 'control', checkKey(A));
  assert.deepEqual([d.passed, d.short, d.red], [5, false, false]);
  const exactly = round({ id: 'x', defs: { s: def([A]) }, attempts: [true, true, true, true, false].map((p, i) => att('s', 'pact', i + 1, [p])) });
  assert.equal(tally(exactly, 's', 'pact', checkKey(A)).red, false);
});

test('pass:null (undecidable) is left out of the rate and counted separately', () => {
  const r = round({
    id: 'r',
    variants: ['pact'],
    defs: { s: def([A, C]) },
    attempts: [att('s', 'pact', 1, [true, null]), att('s', 'pact', 2, [true, null]), att('s', 'pact', 3, [false, true]), att('s', 'pact', 4, [true, null])],
  });
  const a = tally(r, 's', 'pact', checkKey(A));
  assert.deepEqual([a.valid, a.passed, a.undecidable], [4, 3, 0]);
  const c = tally(r, 's', 'pact', checkKey(C));
  assert.deepEqual([c.valid, c.passed, c.undecidable, c.red], [1, 1, 3, false]);
  // 유효 회차가 하나도 없으면 빨갛지 않다.
  const none = round({ id: 'n', variants: ['pact'], defs: { s: def([C]) }, attempts: [att('s', 'pact', 1, [null]), att('s', 'pact', 2, [null])] });
  const n = tally(none, 's', 'pact', checkKey(C));
  assert.deepEqual([n.valid, n.undecidable, n.red], [0, 2, false]);
});

test('limited attempts are left out of the rate and counted as "한도"', () => {
  const r = round({
    id: 'r',
    variants: ['pact'],
    defs: { s: def([A]) },
    attempts: [att('s', 'pact', 1, [true]), att('s', 'pact', 2, [true]), att('s', 'pact', 3, [true]), att('s', 'pact', 4, [true]), lim('s', 'pact', 5)],
  });
  const a = tally(r, 's', 'pact', checkKey(A));
  assert.deepEqual([a.valid, a.passed, a.limited, a.red], [4, 4, 1, false]);
  assert.equal(cellText(a).notes.join(','), '한도 1');
  const onlyLimited = round({ id: 'l', variants: ['pact'], defs: { s: def([A]) }, attempts: [lim('s', 'pact', 1)] });
  const l = tally(onlyLimited, 's', 'pact', checkKey(A));
  assert.deepEqual([l.ran, l.valid, l.limited, l.red], [true, 0, 1, false]);
});

test('a variant or scenario the round did not run is marked as absent', () => {
  const r = round({ id: 'r', variants: ['pact'], defs: { s: def([A]) }, attempts: [att('s', 'pact', 1, [true])] });
  assert.equal(tally(r, 's', 'control', checkKey(A)).ran, false);
  assert.equal(tally(r, 'other', 'pact', checkKey(A)).ran, false);
  const rounds = [r, round({ id: 'r2', defs: { other: def([B], '다른 장면') }, attempts: [att('other', 'pact', 1, [true]), att('other', 'control', 1, [true])] })];
  const view = buildViews(rounds)[0];
  const gone = row(view, 'other', checkKey(B));
  assert.equal(gone.inRound, false);
  assert.equal(gone.cells.pact.ran, false);
  assert.equal(gone.scene, '다른 장면');
  const here = row(view, 's', checkKey(A));
  assert.equal(here.inRound, true);
  assert.equal(here.cells.control.ran, false);
});

test('"가르지 못함": the control also reaches the threshold; a round without control borrows the latest earlier control round', () => {
  const rounds = [
    // r1: 대조군 5/5 -> A는 가르지 못함, B는 대조군 1/5 -> 가름
    round({
      id: 'r1',
      defs: { s: def([A, B]) },
      attempts: [
        ...[0, 1, 2, 3, 4].map((i) => att('s', 'pact', i + 1, [true, true])),
        ...[0, 1, 2, 3, 4].map((i) => att('s', 'control', i + 1, [true, i === 0])),
      ],
    }),
    // r2: pact만. 대조군은 r1 값을 쓴다.
    round({ id: 'r2', variants: ['pact'], defs: { s: def([A, B]) }, attempts: [0, 1, 2].map((i) => att('s', 'pact', i + 1, [true, true])) }),
    // r3: 대조군이 바뀌었다(A 1/5)
    round({
      id: 'r3',
      defs: { s: def([A, B]) },
      attempts: [
        ...[0, 1, 2, 3, 4].map((i) => att('s', 'pact', i + 1, [true, true])),
        ...[0, 1, 2, 3, 4].map((i) => att('s', 'control', i + 1, [i === 0, true])),
      ],
    }),
    // r4: pact만. 이후 판이 아니라 가장 최근(r3) 대조군을 쓴다.
    round({ id: 'r4', variants: ['pact'], defs: { s: def([A, B]) }, attempts: [att('s', 'pact', 1, [true, true])] }),
  ];
  const [v1, v2, v3, v4] = buildViews(rounds);
  assert.deepEqual(row(v1, 's', checkKey(A)).control, { from: null, passed: 5, valid: 5, noSplit: true });
  assert.equal(row(v1, 's', checkKey(B)).control.noSplit, false);
  assert.deepEqual(row(v2, 's', checkKey(A)).control, { from: 'r1', passed: 5, valid: 5, noSplit: true });
  assert.equal(row(v2, 's', checkKey(B)).control.from, 'r1');
  assert.equal(row(v3, 's', checkKey(A)).control.noSplit, false);
  assert.equal(row(v3, 's', checkKey(B)).control.noSplit, true);
  assert.deepEqual(row(v4, 's', checkKey(A)).control, { from: 'r3', passed: 1, valid: 5, noSplit: false });
  // 대조군을 돌린 적이 없으면 모른다.
  const lonely = buildViews([round({ id: 'x', variants: ['pact'], defs: { s: def([A]) }, attempts: [att('s', 'pact', 1, [true])] })])[0];
  assert.equal(row(lonely, 's', checkKey(A)).control, null);
});

test('arrows compare with the previous round, pairing checks by kind and arguments even when their order changed', () => {
  const rounds = [
    round({ id: 'r1', variants: ['pact'], defs: { s: def([A, B]) }, attempts: [0, 1, 2, 3, 4].map((i) => att('s', 'pact', i + 1, [i < 3, i < 4])) }),
    // 순서가 바뀌고 검사 C가 끼었다. A 5/5(▲2), B 2/5(▼2)
    round({ id: 'r2', variants: ['pact'], defs: { s: def([C, B, A]) }, attempts: [0, 1, 2, 3, 4].map((i) => att('s', 'pact', i + 1, [true, i < 2, true])) }),
    // 다른 장면만 돌린 판 -> 그 사이 건너뛰고 r2와 비교
    round({ id: 'r3', variants: ['pact'], defs: { t: def([A]) }, attempts: [att('t', 'pact', 1, [true])] }),
    // 회차 수가 달라지면 백분율 차이: A 2/2 = 100% vs 5/5 = 100% -> ±0, B 1/2=50% vs 2/5=40% -> ▲10%p
    round({ id: 'r4', variants: ['pact'], defs: { s: def([A, B]) }, attempts: [att('s', 'pact', 1, [true, true]), att('s', 'pact', 2, [true, false])] }),
  ];
  const [v1, v2, v3, v4] = buildViews(rounds);
  assert.equal(row(v1, 's', checkKey(A)).cells.pact.delta, null);
  const a2 = row(v2, 's', checkKey(A)).cells.pact;
  assert.deepEqual(a2.delta, { prevId: 'r1', prevPassed: 3, prevValid: 5, dir: 'up', amount: 2, pct: false });
  const b2 = row(v2, 's', checkKey(B)).cells.pact;
  assert.deepEqual([b2.delta.dir, b2.delta.amount], ['down', 2]);
  assert.equal(row(v2, 's', checkKey(C)).cells.pact.delta, null);
  assert.equal(row(v3, 't', checkKey(A)).cells.pact.delta, null);
  const a4 = row(v4, 's', checkKey(A)).cells.pact;
  assert.deepEqual([a4.delta.prevId, a4.delta.dir, a4.delta.amount, a4.delta.pct], ['r2', 'same', 0, true]);
  const b4 = row(v4, 's', checkKey(B)).cells.pact;
  assert.deepEqual([b4.delta.dir, b4.delta.amount, b4.delta.pct], ['up', 10, true]);
  assert.equal(cellText(a2).delta, '▲2');
  assert.equal(cellText(a2).prev, '직전 3/5');
  assert.equal(cellText(row(v1, 's', checkKey(A)).cells.pact).prev, null);
  assert.equal(cellText(b2).delta, '▼2');
  assert.equal(cellText(a4).delta, '±0');
  assert.equal(cellText(b4).delta, '▲10%p');
});

test('"지침 바뀜": the pact guideline fingerprint differs from the previous pact round; unknown fingerprints are not claimed', () => {
  const mk = (id, over) => round({ id, defs: { s: def([A]) }, attempts: [att('s', 'pact', 1, [true]), att('s', 'control', 1, [true])], ...over });
  const rounds = [
    mk('r1', { fp: 'aaa' }),
    mk('r2', { fp: 'aaa' }),
    mk('r3', { variants: ['control'], attempts: [att('s', 'control', 1, [true])] }), // pact 없는 판은 건너뛴다
    mk('r4', { fp: 'bbb' }),
    mk('r5', { fp: null }),
    mk('r6', { fp: 'ccc' }),
  ];
  const views = buildViews(rounds);
  assert.deepEqual(
    views.map((v) => v.guidelinesChanged),
    [null, false, null, true, null, null],
  );
});

test('markSegments and placeMatches pick out the matched sentences in the assistant text', () => {
  const segs = markSegments('하나. 둘이 걸림? 셋.', ['둘이 걸림?']);
  assert.deepEqual(segs, [{ text: '하나. ', mark: false }, { text: '둘이 걸림?', mark: true }, { text: ' 셋.', mark: false }]);
  assert.deepEqual(markSegments('abc', []), [{ text: 'abc', mark: false }]);
  assert.deepEqual(markSegments('abcdef', ['bcd', 'cde']).map((s) => [s.text, s.mark]), [['a', false], ['bcde', true], ['f', false]]);
  const placed = placeMatches(['첫 글', '둘째 글 여기'], ['여기', '없는 문장']);
  assert.deepEqual(placed.perText, [[], ['여기']]);
  assert.deepEqual(placed.missing, ['없는 문장']);
});

// ---- 파일로 모은 데이터와 페이지 ----
const turnEvents = (text) => [{ type: 'assistant', message: { content: [{ type: 'text', text }] } }, { type: 'result', subtype: 'success', result: text }];
function writeRecord(out, scenario, variant, n, fingerprint, texts) {
  mkdirSync(path.join(out, scenario), { recursive: true });
  const lines = [{ type: 'pact-test', scenario, variant, n, workdir: '/nonexistent', fingerprint }];
  texts.forEach((t, turn) => turnEvents(t).forEach((e) => lines.push({ ...e, _turn: turn })));
  writeFileSync(path.join(out, scenario, `${variant}-${n}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
function writeRounds(out, rounds) {
  mkdirSync(path.join(out, 'runs'), { recursive: true });
  for (const r of rounds) writeFileSync(path.join(out, 'runs', `${r.id}.json`), JSON.stringify(r));
}

test('collectBoard fills the conversation of passing attempts from the latest jsonl only when the fingerprint matches', () => {
  const out = tmp();
  const failing = [{ turn: 0, type: 'text', role: 'assistant', text: '실패한 답 </script><b>x</b>' }];
  const r1 = round({
    id: 'r1',
    defs: { s: def([A]) },
    attempts: [att('s', 'pact', 1, [true], { fingerprint: 'f1' }), att('s', 'pact', 2, [true], { fingerprint: 'f2' }), att('s', 'pact', 3, [false], { fingerprint: 'f3', conversation: failing }), att('s', 'pact', 4, [true], { fingerprint: 'f4' }), att('s', 'pact', 5, [true]), att('s', 'pact', 6, [true])],
  });
  // r2가 4번 회차를 한도로 덮었으니 r1의 4번 통과 대화는 jsonl에서 복원할 수 없다(jsonl은 한도 때 일부만 남음).
  const r2 = round({ id: 'r2', defs: { s: def([A]) }, attempts: [lim('s', 'pact', 4)] });
  writeRounds(out, [r1, r2]);
  writeRecord(out, 's', 'pact', 1, 'f1', ['회차1 답']);
  writeRecord(out, 's', 'pact', 2, 'OTHER', ['지문이 달라 못 씀']);
  writeRecord(out, 's', 'pact', 4, 'f4', ['한도 때 일부']);
  writeRecord(out, 's', 'pact', 5, null, ['지문 없는 옛 기록']); // 판의 회차도 지문이 없으면 짝
  writeRecord(out, 's', 'pact', 6, 'newer', ['덮어쓴 새 기록']); // 판의 회차는 지문이 없는데 jsonl에는 있으면 덮어쓴 것
  const data = collectBoard(out);
  const at = (roundId, n) => data.rounds.find((r) => r.id === roundId).attempts.find((a) => a.n === n);
  assert.ok(at('r1', 1).conversation.some((c) => c.type === 'text' && c.text === '회차1 답'));
  assert.equal(at('r1', 1).conversation.find((c) => c.type === 'text').turn, 0);
  assert.equal(at('r1', 2).conversation, null);
  assert.equal(at('r1', 3).conversation[0].text, failing[0].text);
  assert.equal(at('r1', 4).conversation, null);
  assert.ok(at('r1', 5).conversation.some((c) => c.text === '지문 없는 옛 기록'));
  assert.equal(at('r1', 6).conversation, null);
  assert.equal(at('r2', 4).conversation, null);
  assert.equal(data.rounds.length, 2);
  assert.equal(data.rounds[1].view.rows.length, 1);
});

test('collectBoard keeps bubble text whole but trims tool inputs and results to their beginning', () => {
  const out = tmp();
  const long = 'z'.repeat(2500);
  const conv = [
    { turn: 0, type: 'text', role: 'assistant', text: long },
    { turn: 0, type: 'tool_use', role: 'assistant', id: 't1', name: 'Write', input: { file_path: 'a.md', content: long } },
    { turn: 0, type: 'tool_result', role: 'user', toolUseId: 't1', text: long, isError: true },
    { turn: 0, type: 'user_text', role: 'user', text: long },
  ];
  writeRounds(out, [round({ id: 'r1', defs: { s: def([A]) }, attempts: [att('s', 'pact', 1, [false], { conversation: conv })] })]);
  const c = collectBoard(out).rounds[0].attempts[0].conversation;
  assert.equal(c[0].text.length, 2500);
  assert.ok(c[1].text.length < 900 && c[1].text.includes('Write') === false && c[1].name === 'Write');
  assert.ok(c[2].text.length < 700 && c[2].text.includes('생략') && c[2].isError === true && c[2].name === 'Write');
  assert.ok(c[3].text.length < 1000);
});

test('renderBoard makes one self-contained page: data cannot break out of the script and nothing loads from outside', () => {
  const evil = '</script><img src=x onerror=alert(1)><!-- 끝';
  const out = tmp();
  writeRounds(out, [round({ id: 'r1', defs: { s: def([A], evil) }, attempts: [att('s', 'pact', 1, [false], { conversation: [{ turn: 0, type: 'text', role: 'assistant', text: evil }] })] })]);
  const html = renderBoard(collectBoard(out));
  assert.match(html, /^<!doctype html>/i);
  assert.equal((html.match(/<\/script/gi) ?? []).length, (html.match(/<script/gi) ?? []).length);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!/<(script|link|img|iframe)[^>]+(src|href)=["']?(https?:)?\/\//i.test(html));
  assert.ok(!/https?:\/\//.test(html), '외부 주소가 없어야 함');
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /<html lang="ko">/);
  // 데이터는 JSON으로 살아 있다.
  const json = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)[1];
  assert.equal(JSON.parse(json).rounds[0].defs.s.scene, evil);
  // 페이지 스크립트는 문법 오류가 없다.
  const scripts = [...html.matchAll(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0]));
});

test('buildBoard writes board.html next to the rounds and the CLI prints its path', () => {
  const out = tmp();
  writeRounds(out, [round({ id: 'r1', defs: { s: def([A]) }, attempts: [att('s', 'pact', 1, [true])] })]);
  const res = buildBoard(out);
  assert.equal(res.file, path.join(out, 'board.html'));
  assert.ok(existsSync(res.file));
  assert.ok(res.bytes > 1000);
  const cli = spawnSync('node', [boardCli, out], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), path.join(out, 'board.html'));
});

test('the CLI imports old records as the first round and builds the page; with nothing to import it says so and exits 1', () => {
  const empty = tmp();
  const none = spawnSync('node', [boardCli, empty], { encoding: 'utf8' });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /쌓인 판이 없/);
  assert.ok(!existsSync(path.join(empty, 'board.html')));

  const out = tmp();
  writeRecord(out, 'confirm-only', 'control', 1, null, ['이렇게 정할게요.']);
  const res = spawnSync('node', [boardCli, out], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /이전 기록 모음 판으로 가져옴/);
  assert.equal(res.stdout.trim(), path.join(out, 'board.html'));
  const html = readFileSync(path.join(out, 'board.html'), 'utf8');
  const data = JSON.parse(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(data.rounds.length, 1);
  assert.equal(data.rounds[0].kind, 'legacy');
  assert.equal(data.rounds[0].attempts[0].scenario, 'confirm-only');
  assert.ok(data.rounds[0].attempts[0].conversation.some((c) => c.text === '이렇게 정할게요.'));
});

test('an empty round list still renders a page that says there is nothing yet', () => {
  const html = renderBoard(collectBoard(tmp()));
  assert.match(html, /<script type="application\/json" id="data">/);
  assert.match(html, /쌓인 판이 없습니다/);
});

test('a cell with no valid attempt shows only "판정 불가 n" / "한도 n" without a 0/0 score', () => {
  const r = round({
    id: 'r',
    variants: ['pact'],
    defs: { s: def([A, C]) },
    attempts: [0, 1, 2, 3, 4].map((i) => att('s', 'pact', i + 1, [true, null])).concat([lim('s', 'pact', 6)]),
  });
  const c = cellText(tally(r, 's', 'pact', checkKey(C)));
  assert.deepEqual([c.score, c.muted, c.red, c.notes], [null, true, false, ['판정 불가 5', '한도 1']]);
  // 유효 회차가 있으면 지금처럼 4/5 옆에 "불가 n"
  const mixed = round({ id: 'm', variants: ['pact'], defs: { s: def([C]) }, attempts: [att('s', 'pact', 1, [true]), att('s', 'pact', 2, [null])] });
  const m = cellText(tally(mixed, 's', 'pact', checkKey(C)));
  assert.deepEqual([m.score, m.muted, m.notes], ['1/1', false, ['불가 1']]);
  const onlyLimited = cellText(tally(round({ id: 'l', variants: ['pact'], defs: { s: def([A]) }, attempts: [lim('s', 'pact', 1)] }), 's', 'pact', checkKey(A)));
  assert.deepEqual([onlyLimited.score, onlyLimited.muted, onlyLimited.notes], [null, true, ['한도 1']]);
});

test('the address hash round-trips the chosen round and cell, and survives odd characters', () => {
  const cell = { scenario: 's 1', variant: 'pact', key: checkKey({ kind: 'replyMatch', pattern: '정&해=요#' }) };
  const hash = encodeHash('20261011T010203Z', cell);
  assert.match(hash, /^#round=20261011T010203Z&cell=/);
  assert.deepEqual(decodeHash(hash), { round: '20261011T010203Z', cell });
  assert.deepEqual(decodeHash(encodeHash('r1', null)), { round: 'r1', cell: null });
  for (const bad of ['', '#', '#cell=%E0%A4%A', '#round=r1&cell=notjson', '#round=r1&cell=%5B1%5D']) assert.deepEqual(decodeHash(bad), { round: bad.includes('round=r1') ? 'r1' : null, cell: null }, bad);
});

test('a broken round file warns once per board run', () => {
  const out = tmp();
  writeRounds(out, [round({ id: 'r1', defs: { s: def([A]) }, attempts: [att('s', 'pact', 1, [true])] })]);
  writeFileSync(path.join(out, 'runs', 'broken.json'), '{ nope');
  const res = spawnSync('node', [boardCli, out], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal((res.stderr.match(/깨진 판 파일/g) ?? []).length, 1, res.stderr);
});
