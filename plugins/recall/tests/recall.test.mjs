import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, run, render, formatDate, MAX_LINES, MAX_TEXT } from '../scripts/recall.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'recall.mjs');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'recall-main-'));
const put = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const item = (o) => ({ bucket: 'attempts', overlap: 1, same_repo: false, date: '2026-10-01', source: 'pact', repo: 'other', text: '요지', path: '/p', ...o });
const fake = (name, items) => ({ name, collect: async () => ({ items }) });
const NOW = new Date(2026, 10, 1);
const NO_HONCHO = { HONCHO_BASE_URL: 'http://127.0.0.1:9', HONCHO_ENV_FILE: '/no/such/honcho.env' };

test('parseArgs: 주제 낱말은 공백으로 나눠 2자 이상만, 옵션은 따로 읽는다', () => {
  const a = parseArgs(['pact', '선택지 질문', 'a', 'pact', '--project', '/x/y', '--json']);
  assert.deepEqual(a, { words: ['pact', '선택지', '질문'], project: '/x/y', json: true });
  const b = parseArgs(['로그인']);
  assert.deepEqual(b, { words: ['로그인'], project: process.cwd(), json: false });
});

test('formatDate: 올해면 M/D, 아니면 YYYY/M/D', () => {
  assert.equal(formatDate('2026-10-09', NOW), '10/9');
  assert.equal(formatDate('2026-01-31', NOW), '1/31');
  assert.equal(formatDate('2025-12-03', NOW), '2025/12/3');
});

test('run: 점수(겹침 + 같은 저장소 2) 높은 순, 같으면 최근 순으로 묶고, 점수 1인 다른 저장소만 비슷한 기록이다', async () => {
  const items = [
    item({ text: 'A', overlap: 1, repo: 'x', date: '2026-10-01' }),
    item({ text: 'B', overlap: 1, same_repo: true, repo: 'me', date: '2026-09-01' }),
    item({ text: 'C', overlap: 2, repo: 'x', date: '2026-10-10' }),
    item({ text: 'D', overlap: 2, repo: 'y', date: '2026-10-20' }),
    item({ text: 'E', bucket: 'rules', overlap: 1, same_repo: true, repo: null, source: 'memory' }),
  ];
  const r = await run({ words: ['주제'], project: '/me', env: {}, sources: [fake('가짜', items)] });
  const a = r.buckets.attempts;
  assert.deepEqual(a.map((i) => i.text), ['B', 'D', 'C', 'A']);
  assert.deepEqual(a.map((i) => i.similar), [false, false, false, true]);
  assert.deepEqual(a.map((i) => i.other_repo), [false, true, true, true]);
  assert.equal(r.buckets.rules[0].other_repo, false);
  assert.equal(r.buckets.rules[0].similar, false);
  assert.deepEqual(r.buckets.failures, []);
  assert.deepEqual(r.buckets.ideas, []);
});

test('run: 항목은 약속한 칸만 남기고, 한 묶음은 많아야 8줄, 요지는 120자에서 자른다', async () => {
  const items = Array.from({ length: 12 }, (_, i) => item({ text: `항목${i}`, date: `2026-10-${String(i + 10).padStart(2, '0')}` }));
  items.push(item({ text: '길'.repeat(300), overlap: 5, date: '2026-10-30' }));
  const r = await run({ words: ['주제'], project: '/me', env: {}, sources: [fake('가짜', items)] });
  assert.equal(r.buckets.attempts.length, MAX_LINES);
  assert.equal(MAX_LINES, 8);
  assert.deepEqual(Object.keys(r.buckets.attempts[0]).sort(), ['date', 'other_repo', 'path', 'repo', 'similar', 'source', 'text']);
  assert.equal([...r.buckets.attempts[0].text].length, MAX_TEXT);
  assert.equal(MAX_TEXT, 120);
  assert.ok(r.buckets.attempts[0].text.endsWith('…'));
});

test('run: 출처 하나가 던져도 나머지는 가고, 까닭은 한 줄로 sources에 남는다', async () => {
  const boom = { name: '깨진 출처', collect: async () => { throw new Error('boom\n둘째 줄'); } };
  const r = await run({ words: ['주제'], project: '/me', env: {}, sources: [boom, fake('멀쩡', [item({ text: '살아 있음' })])] });
  assert.deepEqual(r.sources, [
    { name: '깨진 출처', ok: false, reason: 'boom' },
    { name: '멀쩡', ok: true, reason: null },
  ]);
  assert.deepEqual(r.buckets.attempts.map((i) => i.text), ['살아 있음']);
  assert.equal(typeof r.elapsed_ms, 'number');
  assert.equal(r.topic, '주제');
});

test('render: 머리줄, 못 읽음 줄, 네 묶음 제목(빈 묶음은 없음), 줄 꼴', () => {
  const result = {
    topic: 'pact 선택지',
    elapsed_ms: 12,
    sources: [
      { name: 'pact 기록', ok: true, reason: null },
      { name: '깨진 출처', ok: false, reason: 'boom' },
    ],
    excluded: [],
    buckets: {
      attempts: [
        { date: '2026-10-29', source: 'pact', repo: 'repoA', other_repo: false, similar: false, text: '요지 하나', path: '/a' },
        { date: '2025-12-03', source: 'pact', repo: 'repoB', other_repo: true, similar: true, text: '요지 둘', path: '/b' },
      ],
      failures: [],
      ideas: [],
      rules: [{ date: '2026-10-09', source: 'memory', repo: null, other_repo: false, similar: false, text: '규칙', path: '/m' }],
    },
  };
  assert.deepEqual(render(result, NOW).split('\n'), [
    'recall: pact 선택지 — 출처 1/2 · 12ms',
    '- 못 읽음: 깨진 출처 (boom)',
    '',
    '## 예전 시도와 그 끝',
    '- (10/29 · pact 기록 repoA) 요지 하나',
    '- 비슷한 기록 · (2025/12/3 · pact 기록 repoB) 요지 둘 — 다른 저장소',
    '',
    '## 실패와 원인',
    '- 없음',
    '',
    '## 미룬 아이디어',
    '- 없음',
    '',
    '## 지키라는 규칙',
    '- (10/9 · 메모리 파일) 규칙',
    '',
  ]);
});

test('render: 기억 서버 항목의 출처 이름은 사용자 말·AI 보고이고 다른 저장소 표시가 붙는다', () => {
  const result = {
    topic: '주제',
    elapsed_ms: 1,
    sources: [{ name: '기억 서버', ok: true, reason: null }],
    excluded: [],
    buckets: {
      attempts: [{ date: '2026-10-29', source: 'assistant', repo: 'repoB', other_repo: true, similar: false, text: '보고 요지', path: null }],
      failures: [],
      ideas: [],
      rules: [{ date: '2026-10-09', source: 'user', repo: null, other_repo: false, similar: false, text: '말 요지', path: null }],
    },
  };
  const lines = render(result, NOW).split('\n');
  assert.ok(lines.includes('- (10/29 · AI 보고) 보고 요지 — 다른 저장소'));
  assert.ok(lines.includes('- (10/9 · 사용자 말) 말 요지'));
});

test('run: 출처가 준 excluded와 같거나 그것을 포함하는 요지는 공백·문장부호를 뺀 뒤 비교해 네 묶음에서 빠지고, 빠진 항목은 result.excluded에 남는다', async () => {
  const items = [
    item({ bucket: 'ideas', text: '팀원 기억', overlap: 3 }),
    item({ bucket: 'ideas', text: '  팀원,  기억! ', overlap: 3, repo: 'b' }),
    item({ bucket: 'failures', text: '실패: 팀원 기억(보류) — 까닭', overlap: 3 }),
    item({ bucket: 'ideas', text: '팀원', overlap: 3 }),
    item({ bucket: 'ideas', text: '다른 아이디어', overlap: 2 }),
    item({ bucket: 'rules', text: '팀원 기억을 늘 먼저 본다', overlap: 1, source: 'memory', repo: null, same_repo: true }),
  ];
  const cut = [{ text: '팀원 기억…', date: '11/2', path: '/spec' }, { text: '…', date: '11/2', path: '/spec' }];
  const sources = [fake('가짜', items), { name: '뺌', collect: async () => ({ items: [], excluded: cut }) }];
  const r = await run({ words: ['주제'], project: '/me', env: {}, sources });
  assert.deepEqual(r.buckets.ideas.map((i) => i.text), ['팀원', '다른 아이디어']);
  assert.deepEqual(r.buckets.failures, []);
  assert.deepEqual(r.buckets.rules, []);
  assert.deepEqual(r.excluded.map((i) => [i.bucket, i.text]), [
    ['ideas', '팀원 기억'],
    ['ideas', '팀원, 기억!'],
    ['failures', '실패: 팀원 기억(보류) — 까닭'],
    ['rules', '팀원 기억을 늘 먼저 본다'],
  ]);
  assert.deepEqual(Object.keys(r.excluded[0]), ['bucket', 'date', 'source', 'repo', 'other_repo', 'similar', 'text', 'path']);
  assert.deepEqual(Object.keys(r), ['topic', 'elapsed_ms', 'sources', 'buckets', 'excluded']);
});

test('run: 빼는 것은 8줄로 자르기 전에 한다(빈자리는 다음 항목이 채운다), excluded를 안 주는 출처와 못 읽은 출처는 그냥 둔다', async () => {
  const many = Array.from({ length: 10 }, (_, i) => item({ bucket: 'ideas', text: `아이디어${i}`, date: `2026-10-${String(i + 10).padStart(2, '0')}` }));
  const cut = { name: '뺌', collect: async () => ({ items: [], excluded: [{ text: '아이디어9', date: '1/1', path: '/s' }] }) };
  const boom = { name: '깨짐', collect: async () => { throw new Error('boom'); } };
  const r = await run({ words: ['주제'], project: '/me', env: {}, sources: [fake('가짜', many), cut, boom] });
  assert.equal(r.buckets.ideas.length, MAX_LINES);
  assert.ok(!r.buckets.ideas.some((i) => i.text === '아이디어9'));
  assert.equal(r.buckets.ideas[0].text, '아이디어8');
  assert.equal(r.excluded.length, 1);
  assert.deepEqual(r.sources.map((s) => s.ok), [true, true, false]);
});

test('render: 뺀 것이 있으면 머리줄 바로 다음에 한 줄, 없으면 그 줄이 없다', () => {
  const base = { topic: '주제', elapsed_ms: 1, sources: [{ name: 'a', ok: false, reason: 'boom' }], buckets: { attempts: [], failures: [], ideas: [], rules: [] } };
  const cut = { bucket: 'ideas', date: '2026-10-29', source: 'pact', repo: 'r', other_repo: false, similar: false, text: '요지', path: '/p' };
  const withCut = render({ ...base, excluded: [cut, cut] }, NOW).split('\n');
  assert.deepEqual(withCut.slice(0, 3), ['recall: 주제 — 출처 0/1 · 1ms', '- 뺀 것: 2줄 (기록에서 뺌)', '- 못 읽음: a (boom)']);
  const without = render({ ...base, excluded: [] }, NOW);
  assert.ok(!without.includes('뺀 것'));
});

test('CLI: 명세의 기록에서 뺌 줄과 같은 요지의 다음 판 후보는 아이디어 묶음에서 빠지고 머리줄 다음에 뺀 것 줄이 나온다', () => {
  const root = tmp();
  const notNow = (extra) => `---\npact: 3\ntopic: 판단 기억\nstatus: done\ncreated: 2026-10-20\n---\n# 판단 기억\n## 목적\n판단을 기억한다\n## 하지 않는 것\n- 다음 판 후보: 팀원 기억, 다른 아이디어\n${extra}## 기능\n## 확인 필요\n## 결정 기록\n`;
  put(path.join(root, 'repoA/.pact/2026-10-20-판단-기억/spec.md'), notNow('- 기록에서 뺌: 팀원 기억 (11/2)\n'));
  const env = { ...process.env, ...NO_HONCHO, RECALL_ROOTS: root, CLAUDE_PROJECTS_DIR: tmp() };
  const r = spawnSync('node', [CLI, '판단', '--project', path.join(root, 'repoA')], { encoding: 'utf8', env, cwd: tmp() });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.match(lines[0], /^recall: 판단 — 출처 2\/3 · \d+ms$/);
  assert.equal(lines[1], '- 뺀 것: 1줄 (기록에서 뺌)');
  assert.match(lines[2], /^- 못 읽음: 기억 서버/);
  assert.match(r.stdout, /^- \(10\/20 · pact 기록 repoA\) 다른 아이디어$/m);
  assert.ok(!r.stdout.includes('팀원 기억'));
  const json = JSON.parse(spawnSync('node', [CLI, '판단', '--project', path.join(root, 'repoA'), '--json'], { encoding: 'utf8', env, cwd: tmp() }).stdout);
  assert.deepEqual(json.excluded.map((i) => [i.bucket, i.text, i.source]), [['ideas', '팀원 기억', 'pact']]);

  put(path.join(root, 'repoA/.pact/2026-10-20-판단-기억/spec.md'), notNow(''));
  const again = spawnSync('node', [CLI, '판단', '--project', path.join(root, 'repoA')], { encoding: 'utf8', env, cwd: tmp() });
  assert.ok(!again.stdout.includes('뺀 것'));
  assert.match(again.stdout, /^- \(10\/20 · pact 기록 repoA\) 팀원 기억$/m);
  assert.deepEqual(JSON.parse(spawnSync('node', [CLI, '판단', '--project', path.join(root, 'repoA'), '--json'], { encoding: 'utf8', env, cwd: tmp() }).stdout).excluded, []);
});

test('CLI: 종료 0, 네 묶음 제목, pact 기록과 메모리 파일 줄, 파일은 아무것도 쓰지 않는다', () => {
  const root = tmp();
  put(
    path.join(root, 'repoA/.pact/2026-10-20-선택지-질문/spec.md'),
    '---\npact: 3\ntopic: 선택지 질문\nstatus: building\ncreated: 2026-10-20\n---\n# 선택지 질문\n## 목적\n선택지를 묻는 법\n## 하지 않는 것\n- 다음 판 후보: 가 아이디어, 나 아이디어\n## 기능\n## 확인 필요\n- 사용자 확인 필요\n## 결정 기록\n',
  );
  const project = path.join(root, 'repoA');
  const mem = tmp();
  const key = project.replace(/[^A-Za-z0-9]/g, '-');
  put(path.join(mem, key, 'memory/fb.md'), '---\nname: fb\ndescription: 선택지는 둘 이하로\nmetadata:\n  type: feedback\n  modified: 2026-10-09T12:00:00.000Z\n---\n본문\n');
  const cwd = tmp();
  const env = { ...process.env, ...NO_HONCHO, RECALL_ROOTS: root, CLAUDE_PROJECTS_DIR: mem };
  const r = spawnSync('node', [CLI, '선택지', '--project', project], { encoding: 'utf8', env, cwd });
  assert.equal(r.status, 0, r.stderr);
  for (const h of ['## 예전 시도와 그 끝', '## 실패와 원인', '## 미룬 아이디어', '## 지키라는 규칙']) assert.ok(r.stdout.includes(h), h);
  assert.match(r.stdout, /^recall: 선택지 — 출처 2\/3 · \d+ms$/m);
  assert.match(r.stdout, /^- 못 읽음: 기억 서버 \(연결 거부 127\.0\.0\.1:9\)$/m);
  assert.match(r.stdout, /^- \(10\/20 · pact 기록 repoA\) 선택지 질문 — 멈춘 채 남음\(status building\)/m);
  assert.match(r.stdout, /^- \(10\/20 · pact 기록 repoA\) 가 아이디어$/m);
  assert.match(r.stdout, /^- \(10\/9 · 메모리 파일\) 선택지는 둘 이하로$/m);
  assert.deepEqual(readdirSync(cwd), []);
});

test('CLI: --json은 약속한 모양이다', () => {
  const root = tmp();
  put(path.join(root, 'repoA/.pact/2026-10-20-로그인/spec.md'), '---\ntopic: 로그인\nstatus: done\ncreated: 2026-10-20\n---\n## 목적\n로그인\n');
  const env = { ...process.env, ...NO_HONCHO, RECALL_ROOTS: root, CLAUDE_PROJECTS_DIR: tmp() };
  const r = spawnSync('node', [CLI, '로그인', '--project', path.join(root, 'repoB'), '--json'], { encoding: 'utf8', env, cwd: tmp() });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['topic', 'elapsed_ms', 'sources', 'buckets', 'excluded']);
  assert.deepEqual(out.excluded, []);
  assert.equal(out.topic, '로그인');
  assert.deepEqual(out.sources.map((s) => [s.name, s.ok, s.reason]), [['기억 서버', false, '연결 거부 127.0.0.1:9'], ['pact 기록', true, null], ['메모리 파일', true, null]]);
  assert.deepEqual(Object.keys(out.buckets), ['attempts', 'failures', 'ideas', 'rules']);
  assert.deepEqual(out.buckets.attempts, [
    {
      date: '2026-10-20',
      source: 'pact',
      repo: 'repoA',
      other_repo: true,
      similar: true,
      text: '로그인 — 완료 — 로그인',
      path: path.join(root, 'repoA/.pact/2026-10-20-로그인/spec.md'),
    },
  ]);
});

test('CLI: 출처 하나를 못 읽어도 종료 0이고 머리줄 아래에 못 읽음 줄이 남는다', () => {
  const env = { ...process.env, ...NO_HONCHO, RECALL_ROOTS: '/no/such/root', CLAUDE_PROJECTS_DIR: tmp() };
  const r = spawnSync('node', [CLI, '로그인', '--project', tmp()], { encoding: 'utf8', env, cwd: tmp() });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.match(lines[0], /^recall: 로그인 — 출처 1\/3 · \d+ms$/);
  assert.match(lines[1], /^- 못 읽음: 기억 서버 \(연결 거부 127\.0\.0\.1:9\)$/);
  assert.match(lines[2], /^- 못 읽음: pact 기록 \(.*RECALL_ROOTS.*\)$/);
  assert.ok(r.stdout.includes('## 지키라는 규칙'));
});

test('CLI: 주제 낱말이 없어도 종료 0이다', () => {
  const env = { ...process.env, ...NO_HONCHO, RECALL_ROOTS: tmp(), CLAUDE_PROJECTS_DIR: tmp() };
  const r = spawnSync('node', [CLI], { encoding: 'utf8', env, cwd: tmp() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^recall: \(주제 없음\)/);
});
