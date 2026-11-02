import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collect, name } from '../scripts/recall/sources/pact-records.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'recall-pact-'));
const put = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const spec = ({ topic, status = 'done', created = '2026-10-20', purpose = '목적 한 줄', features = [], notNow = '', needs = '', rulings = 0 } = {}) => `---
pact: 3
topic: ${topic}
status: ${status}
created: ${created}
---
# ${topic}
## 목적
${purpose}
둘째 줄은 읽지 않는다.
## 범위
범위 글
## 하지 않는 것
${notNow}
## 기능
${features.map((f) => `- ${f}`).join('\n')}
## 공통 규칙
## 구조 판정
## 확인 필요
${needs}
## 결정 기록
${Array.from({ length: rulings }, (_, i) => `- Ruling: 결정 ${i}`).join('\n')}
`;

const run = (root, topicWords, project = root, env = {}) =>
  collect({ topicWords, project, env: { RECALL_ROOTS: root, ...env } });
const of = (items, bucket) => items.filter((i) => i.bucket === bucket);

test('출처 이름은 머리줄에 쓰는 말이다', () => {
  assert.equal(name, 'pact 기록');
});

test('날짜 있는 .pact 판과 옛 docs/pact 판이 같은 슬러그면 날짜 있는 판 하나만 남는다', async () => {
  const root = tmp();
  put(path.join(root, 'repoA/.pact/2026-10-20-선택지-질문/spec.md'), spec({ topic: '선택지 질문' }));
  put(path.join(root, 'repoA/docs/pact/2026-10-19-선택지-질문.md'), spec({ topic: '선택지 질문', created: '2026-10-19' }));
  put(path.join(root, 'repoA/.pact/다른-일/spec.md'), spec({ topic: '선택지 다른 일' }));
  const { items } = await run(root, ['선택지']);
  const attempts = of(items, 'attempts');
  assert.equal(attempts.length, 2);
  const same = attempts.filter((i) => i.text.startsWith('선택지 질문'));
  assert.equal(same.length, 1);
  assert.equal(same[0].path, path.join(root, 'repoA/.pact/2026-10-20-선택지-질문/spec.md'));
  assert.equal(same[0].date, '2026-10-20');
  assert.equal(same[0].repo, 'repoA');
  assert.equal(same[0].source, 'pact');
});

test('같은 슬러그라도 저장소가 다르면 따로 센다', async () => {
  const root = tmp();
  put(path.join(root, 'repoA/.pact/2026-10-20-로그인/spec.md'), spec({ topic: '로그인' }));
  put(path.join(root, 'repoB/.pact/2026-10-21-로그인/spec.md'), spec({ topic: '로그인', created: '2026-10-21' }));
  const { items } = await run(root, ['로그인']);
  assert.deepEqual(of(items, 'attempts').map((i) => i.repo).sort(), ['repoA', 'repoB']);
});

test('wt·scratch·node_modules·testbed·tmp·-wt- 경로의 기록은 뺀다', async () => {
  const root = tmp();
  put(path.join(root, 'keep/.pact/2026-10-20-주제/spec.md'), spec({ topic: '주제 진짜' }));
  for (const dir of ['wt/a', 'scratch/b', 'tmp/c', 'testbed/d', 'keep/node_modules/pkg', 'keep-wt-x', 'x-testbed-y']) {
    put(path.join(root, dir, '.pact/2026-10-20-주제/spec.md'), spec({ topic: `주제 복사본 ${dir}` }));
  }
  const { items } = await run(root, ['주제']);
  assert.deepEqual(of(items, 'attempts').map((i) => i.repo), ['keep']);
});

test('깊이 4를 넘는 폴더와 심볼릭 링크는 따라가지 않는다', async () => {
  const root = tmp();
  const outside = tmp();
  put(path.join(outside, 'linked/.pact/2026-10-20-링크/spec.md'), spec({ topic: '링크 주제' }));
  symlinkSync(path.join(outside, 'linked'), path.join(root, 'linked'));
  put(path.join(root, 'a/b/c/d/e/.pact/2026-10-20-깊이/spec.md'), spec({ topic: '깊이 주제' }));
  put(path.join(root, 'a/b/c/.pact/2026-10-20-얕음/spec.md'), spec({ topic: '얕음 주제' }));
  const { items } = await run(root, ['주제']);
  assert.deepEqual(of(items, 'attempts').map((i) => i.text.split(' — ')[0]), ['얕음 주제']);
});

test('옛 꼴 docs/pact/*.md를 읽고, 같은 이름의 .pact 폴더에서 results.json을 찾는다', async () => {
  const root = tmp();
  put(path.join(root, 'old/docs/pact/2026-10-21-대시보드.md'), spec({ topic: '대시보드', created: '2026-10-21', status: 'done' }));
  put(
    path.join(root, 'old/.pact/대시보드/results.json'),
    JSON.stringify({ scenarios: [{ title: '한도 차트', result: 'fail', summary: '점선이 안 그려짐' }] }),
  );
  const { items } = await run(root, ['대시보드']);
  const attempt = of(items, 'attempts')[0];
  assert.equal(attempt.path, path.join(root, 'old/docs/pact/2026-10-21-대시보드.md'));
  assert.equal(attempt.date, '2026-10-21');
  assert.match(of(items, 'failures')[0].text, /한도 차트/);
});

test('results.json의 fail·doubt는 실패 묶음으로 오고 pass는 오지 않는다', async () => {
  const root = tmp();
  const dir = path.join(root, 'r/.pact/2026-10-20-검수');
  put(path.join(dir, 'spec.md'), spec({ topic: '검수 주제' }));
  put(
    path.join(dir, 'results.json'),
    JSON.stringify({
      headline: '결과 머리말',
      scenarios: [
        { title: '통과한 장면', result: 'pass', summary: '잘 됨' },
        { title: '깨진 장면', result: 'fail', summary: '버튼이 안 눌림' },
        { title: '애매한 장면', result: 'doubt', decision: '고치지 않고 둠' },
        { title: '못 돌린 장면', result: 'unverified', summary: '도구 없음' },
      ],
    }),
  );
  const { items } = await run(root, ['검수']);
  assert.deepEqual(of(items, 'failures').map((i) => i.text), [
    '실패: 깨진 장면 — 버튼이 안 눌림',
    '의심: 애매한 장면 — 고치지 않고 둠',
  ]);
  assert.match(of(items, 'attempts')[0].text, /결과 머리말/);
});

test('summary.json의 headline은 끝 줄에, todo는 실패 묶음에 온다(목록·문자열 둘 다)', async () => {
  const root = tmp();
  put(path.join(root, 'r/.pact/2026-10-20-하나/spec.md'), spec({ topic: '하나 주제' }));
  put(path.join(root, 'r/.pact/2026-10-20-하나/summary.json'), JSON.stringify({ headline: '다 만들었다', todo: ['할 일 A', '할 일 B'] }));
  put(path.join(root, 'r/.pact/2026-10-21-둘/spec.md'), spec({ topic: '둘 주제', created: '2026-10-21' }));
  put(path.join(root, 'r/.pact/2026-10-21-둘/summary.json'), JSON.stringify({ todo: '할 일 하나뿐' }));
  const { items } = await run(root, ['주제']);
  const att = of(items, 'attempts').find((i) => i.text.startsWith('하나 주제'));
  assert.match(att.text, /다 만들었다/);
  const todos = of(items, 'failures').map((i) => i.text).sort();
  assert.deepEqual(todos, ['남은 할 일: 할 일 A', '남은 할 일: 할 일 B', '남은 할 일: 할 일 하나뿐']);
});

test('끝 줄: done이면 완료, 아니면 멈춘 채 남음(status …), 결정 수가 붙는다', async () => {
  const root = tmp();
  put(path.join(root, 'r/.pact/2026-10-20-끝/spec.md'), spec({ topic: '끝 주제', rulings: 3 }));
  put(path.join(root, 'r/.pact/2026-10-21-중간/spec.md'), spec({ topic: '중간 주제', status: 'building', created: '2026-10-21' }));
  const { items } = await run(root, ['주제']);
  const done = of(items, 'attempts').find((i) => i.text.startsWith('끝 주제'));
  const stuck = of(items, 'attempts').find((i) => i.text.startsWith('중간 주제'));
  assert.match(done.text, /^끝 주제 — 완료 · 결정 3건 — 목적 한 줄$/);
  assert.match(stuck.text, /^중간 주제 — 멈춘 채 남음\(status building\) — 목적 한 줄$/);
});

test('다음 판 후보는 괄호 밖 쉼표로 쪼개 아이디어 묶음으로 온다(줄 단독·문단 끝 둘 다)', async () => {
  const root = tmp();
  put(
    path.join(root, 'r/.pact/2026-10-20-후보/spec.md'),
    spec({ topic: '후보 주제', notNow: '- 새 로그인 만들기\n- 다음 판 후보: 팀원 기억, 판이 끝날 때 기억에 따로 적기, 상태와 알림(점, 바로 알리기), 마지막 것.' }),
  );
  put(
    path.join(root, 'r/.pact/2026-10-21-문단/spec.md'),
    spec({ topic: '문단 주제', created: '2026-10-21', notNow: '직접 보내는 시험 칸. 통계. 다음 판 후보: 가 아이디어, 나 아이디어.' }),
  );
  const { items } = await run(root, ['주제']);
  const ideas = of(items, 'ideas');
  assert.deepEqual(
    ideas.filter((i) => i.path.includes('후보')).map((i) => i.text),
    ['팀원 기억', '판이 끝날 때 기억에 따로 적기', '상태와 알림(점, 바로 알리기)', '마지막 것'],
  );
  assert.deepEqual(ideas.filter((i) => i.path.includes('문단')).map((i) => i.text), ['가 아이디어', '나 아이디어']);
});

test('확인 필요 항목은 실패 묶음으로 오되 이미 확인한 것(확인함)은 빠진다', async () => {
  const root = tmp();
  put(
    path.join(root, 'r/.pact/2026-10-20-확인/spec.md'),
    spec({ topic: '확인 주제', needs: '- 운영 허브에 등록할지 사용자 허락 필요\n- 확인함(10-28): 이미 풀린 것' }),
  );
  const { items } = await run(root, ['확인']);
  assert.deepEqual(of(items, 'failures').map((i) => i.text), ['확인 필요: 운영 허브에 등록할지 사용자 허락 필요']);
});

test('낱말이 하나도 안 겹치는 기록은 아무것도 내지 않는다', async () => {
  const root = tmp();
  put(path.join(root, 'r/.pact/2026-10-20-무관/spec.md'), spec({ topic: '무관한 일', features: ['F1 아무 기능 [사용자]'] }));
  put(path.join(root, 'r/.pact/2026-10-20-무관/results.json'), JSON.stringify({ scenarios: [{ title: '깨짐', result: 'fail', summary: '안 됨' }] }));
  const { items } = await run(root, ['전혀다른']);
  assert.deepEqual(items, []);
});

test('백틱 안의 코드·경로에는 낱말이 맞지 않는다(겉으로 쓴 낱말만 센다)', async () => {
  const root = tmp();
  put(
    path.join(root, 'r/.pact/2026-10-20-화면/spec.md'),
    spec({ topic: '화면 정리', purpose: '옛 `.pact/화면-정리/sketches/a.png` 를 `pact` 도구로 고친다', features: ['F1 `spec.mjs` 보기 [사용자]'] }),
  );
  const count = async (words) => (await run(root, words)).items.find((i) => i.bucket === 'attempts')?.overlap;
  assert.equal(await count(['pact']), undefined);
  assert.equal(await count(['sketches']), undefined);
  assert.equal(await count(['spec']), undefined);
  assert.equal(await count(['정리']), 1);
  assert.equal(await count(['도구']), 1);
});

test('영문·숫자 낱말은 낱말 경계로, 한글 낱말은 조사가 붙어도 되게 부분 일치로 맞는다', async () => {
  const root = tmp();
  put(path.join(root, 'r1/.pact/2026-10-20-가/spec.md'), spec({ topic: 'impact 분석', purpose: 'cua-bar2 앱에서 선택지를 묻는다' }));
  put(path.join(root, 'r2/.pact/2026-10-20-나/spec.md'), spec({ topic: '나', purpose: 'Pact를 고친다' }));
  const repos = async (words) => (await run(root, words)).items.filter((i) => i.bucket === 'attempts').map((i) => i.repo).sort();
  assert.deepEqual(await repos(['pact']), ['r2']);
  assert.deepEqual(await repos(['impact']), ['r1']);
  assert.deepEqual(await repos(['act']), []);
  assert.deepEqual(await repos(['cua-bar']), []);
  assert.deepEqual(await repos(['cua-bar2']), ['r1']);
  assert.deepEqual(await repos(['선택']), ['r1']);
});

test('겹침 수는 topic·목적 첫 줄·기능 줄의 서로 다른 주제 낱말 수다(대소문자 무시, 목적 둘째 줄은 안 봄)', async () => {
  const root = tmp();
  put(
    path.join(root, 'r/.pact/2026-10-20-겹침/spec.md'),
    spec({ topic: 'Pact 질문', purpose: '선택지를 묻는다', features: ['F1 화면 [사용자]'] }),
  );
  const count = async (words) => (await run(root, words)).items.find((i) => i.bucket === 'attempts')?.overlap;
  assert.equal(await count(['pact']), 1);
  assert.equal(await count(['pact', '선택지', '화면']), 3);
  assert.equal(await count(['pact', 'pact']), 1);
  assert.equal(await count(['둘째']), undefined);
});

test('--project가 기록의 저장소 안이면 same_repo, 아니면 other_repo 쪽이다', async () => {
  const root = tmp();
  put(path.join(root, 'repoA/.pact/2026-10-20-공통/spec.md'), spec({ topic: '공통 주제' }));
  put(path.join(root, 'repoB/.pact/2026-10-20-공통/spec.md'), spec({ topic: '공통 주제' }));
  const { items } = await run(root, ['공통'], path.join(root, 'repoA/plugins/x'));
  const flags = Object.fromEntries(items.filter((i) => i.bucket === 'attempts').map((i) => [i.repo, i.same_repo]));
  assert.deepEqual(flags, { repoA: true, repoB: false });
});

test('RECALL_ROOTS는 콜론으로 여러 개를 받고, 하나라도 읽히면 읽은 것이다', async () => {
  const a = tmp();
  const b = tmp();
  put(path.join(a, 'r1/.pact/2026-10-20-가/spec.md'), spec({ topic: '가 주제' }));
  put(path.join(b, 'r2/.pact/2026-10-20-나/spec.md'), spec({ topic: '나 주제' }));
  const both = await collect({ topicWords: ['주제'], project: a, env: { RECALL_ROOTS: `${a}:${b}:/no/such/root` } });
  assert.deepEqual(of(both.items, 'attempts').map((i) => i.repo).sort(), ['r1', 'r2']);
});

test('RECALL_ROOTS를 하나도 읽지 못하면 던진다(머리줄에 못 읽음으로 남는다)', async () => {
  await assert.rejects(() => run('/no/such/root', ['주제']), /RECALL_ROOTS/);
});

test('하지 않는 것의 `기록에서 뺌: 요지 (M/D)` 줄은 주제와 상관없이 모든 명세(옛 꼴 포함)에서 excluded로 모인다', async () => {
  const root = tmp();
  const a = path.join(root, 'repoA/.pact/2026-10-20-로그인/spec.md');
  const b = path.join(root, 'repoB/docs/pact/2026-10-01-결제.md');
  put(a, spec({ topic: '로그인', notNow: '- 기록에서 뺌: 팀원 기억 (11/2)\n- 기록에서 뺌 : 판이 끝날 때 기억에 따로 적기 (2025/12/3)\n- 다음 판 후보: 가 아이디어\n- 기록에서 뺌: 날짜 없는 줄\n기록에서 뺌: 줄 머리 - 없음 (1/2)\n  - 기록에서 뺌: 들여쓴 줄 (1/2)' }));
  put(b, spec({ topic: '결제', notNow: '- 기록에서 뺌: 괄호 (안) 있는 요지 (10/9)' }));
  const { items, excluded } = await run(root, ['로그인']);
  assert.deepEqual(
    [...excluded].sort((x, y) => x.text.localeCompare(y.text)),
    [
      { text: '괄호 (안) 있는 요지', date: '10/9', path: b },
      { text: '팀원 기억', date: '11/2', path: a },
      { text: '판이 끝날 때 기억에 따로 적기', date: '2025/12/3', path: a },
    ],
  );
  assert.deepEqual(of(items, 'ideas').map((i) => i.text), ['가 아이디어']);
});

test('기록에서 뺌 줄이 없으면 excluded는 빈 배열이다', async () => {
  const root = tmp();
  put(path.join(root, 'repoA/.pact/2026-10-20-로그인/spec.md'), spec({ topic: '로그인', notNow: '- 다음 판 후보: 가 아이디어' }));
  assert.deepEqual((await run(root, ['로그인'])).excluded, []);
});
