import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collect, name } from '../scripts/sources/honcho.mjs';
import { projectDirName } from '../scripts/sources/memory-files.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'recall.mjs');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'recall-honcho-'));
const NO_ENV_FILE = path.join(tmpdir(), 'recall-honcho-no-such-env-file');
const TOPIC = ['pact', '선택지'];
const Q_USER = 'pact 선택지';
const Q_COMPLAINT = 'pact 선택지 불편 안 됨 실패 짜증 문제';
const Q_REPORT = 'pact 선택지 막힌 곳 실패 다음 판 후보 남은 할 일 완료';

let seq = 0;
const msg = (o = {}) => ({
  id: `m${++seq}`,
  content: 'pact 선택지 이야기',
  peer_id: 'tester',
  session_id: `s${seq}`,
  created_at: '2026-10-18T12:00:00.000000Z',
  metadata: { source: 'claude', claude_role: 'user', direct_user: true },
  ...o,
});
const ai = (o = {}) =>
  msg({ peer_id: 'assistant_claude', metadata: { source: 'claude', claude_role: 'assistant', direct_user: false }, ...o });

async function serve(handler = () => ({})) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const rec = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      requests.push(rec);
      const { status = 200, json = [], delay = 0, text } = (await handler(rec)) ?? {};
      if (delay) await new Promise((r) => setTimeout(r, delay));
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text ?? JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}
async function withServer(handler, fn) {
  const server = await serve(handler);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}
const kindOf = (rec) => (!rec.body.filters ? 'report' : rec.body.query === Q_USER ? 'user' : 'complaint');
const answer = ({ user = [], complaint = [], report = [] }) => (rec) => ({ json: { user, complaint, report }[kindOf(rec)] });
const envFor = (server, extra = {}) => ({
  HONCHO_BASE_URL: server.url,
  HONCHO_WORKSPACE_ID: 'ws',
  HONCHO_USER_NAME: 'tester',
  HONCHO_ENV_FILE: NO_ENV_FILE,
  RECALL_ROOTS: tmp(),
  ...extra,
});
const get = (server, extra, project = '/p/me') => collect({ topicWords: TOPIC, project, env: envFor(server, extra) });
const textsOf = ({ items }) => items.map((i) => i.text).sort();

function cli(args, env) {
  return new Promise((resolve) => {
    const cwd = tmp();
    const child = spawn('node', [CLI, ...args], { env: { ...process.env, RECALL_ROOTS: tmp(), CLAUDE_PROJECTS_DIR: tmp(), HONCHO_ENV_FILE: NO_ENV_FILE, ...env }, cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr, cwd }));
  });
}

test('출처 이름', () => {
  assert.equal(name, '기억 서버');
});

test('요청 셋: 경로, 본문(질문·limit·필터), Bearer 머리', async () => {
  await withServer(undefined, async (server) => {
    await get(server, { HONCHO_API_BEARER_TOKEN: 'tok-123' });
    assert.equal(server.requests.length, 3);
    for (const r of server.requests) {
      assert.equal(r.method, 'POST');
      assert.equal(r.url, '/v3/workspaces/ws/search');
      assert.equal(r.headers.authorization, 'Bearer tok-123');
      assert.match(r.headers['content-type'], /application\/json/);
      assert.equal(r.body.limit, 20);
    }
    const byQuery = Object.fromEntries(server.requests.map((r) => [r.body.query, r.body]));
    assert.deepEqual(Object.keys(byQuery).sort(), [Q_USER, Q_COMPLAINT, Q_REPORT].sort());
    assert.deepEqual(byQuery[Q_USER].filters, { peer_id: 'tester' });
    assert.deepEqual(byQuery[Q_COMPLAINT].filters, { peer_id: 'tester' });
    assert.equal('filters' in byQuery[Q_REPORT], false);
  });
});

test('토큰이 없으면 Authorization 머리가 없고, workspace 기본은 memory, 사용자 peer 기본은 user다', async () => {
  await withServer(undefined, async (server) => {
    await get(server, { HONCHO_WORKSPACE_ID: '', HONCHO_USER_NAME: '' });
    for (const r of server.requests) {
      assert.equal('authorization' in r.headers, false);
      assert.equal(r.url, '/v3/workspaces/memory/search');
    }
    assert.deepEqual(server.requests.find((r) => r.body.query === Q_USER).body.filters, { peer_id: 'user' });
  });
});

test('주제 낱말이 없으면 요청하지 않는다', async () => {
  await withServer(undefined, async (server) => {
    assert.deepEqual(await collect({ topicWords: [], project: '/p', env: envFor(server) }), { items: [] });
    assert.equal(server.requests.length, 0);
  });
});

test('거르기: 시스템 꼬리표로 시작하는 글, 2,000자 넘는 사용자 말, direct_user가 false 아닌 assistant, 겹침 0은 뺀다', async () => {
  const tagged = ['<system-reminder>', '<command-message>', '<local-command-stdout>', '<task-notification>', '<cross-session>'].map((t) => msg({ content: `${t} pact 선택지` }));
  const user = [
    ...tagged,
    msg({ content: `pact ${'가'.repeat(1996)}` }),
    msg({ content: `pact ${'가'.repeat(1995)}` }),
    msg({ content: '겹치는 낱말이 없는 말' }),
    msg({ content: '선택지 사용자 말 하나' }),
  ];
  const report = [
    ai({ content: `pact ${'나'.repeat(2500)}` }),
    ai({ content: 'pact AI 보고 하나' }),
    ai({ content: 'pact 사람이 직접 한 말', metadata: { source: 'claude', direct_user: true } }),
    ai({ content: 'pact 메타 없음', metadata: undefined }),
    msg({ content: 'pact 사용자 peer가 낀 결과', peer_id: 'user_chen', metadata: { source: 'claude', direct_user: false } }),
    ai({ content: '<task-notification> pact 알림' }),
  ];
  await withServer(answer({ user, report }), async (server) => {
    const { items } = await get(server);
    assert.deepEqual(
      items.map((i) => [i.source, [...i.text].length]),
      [
        ['user', 2000],
        ['user', '선택지 사용자 말 하나'.length],
        ['assistant', 2500 + 5],
        ['assistant', 'pact AI 보고 하나'.length],
      ],
    );
  });
});

test('같은 세션의 사용자 말은 겹침이 가장 높은 하나만 남고, 다른 세션은 그대로다', async () => {
  const user = [
    msg({ session_id: 'same', content: 'pact 하나만 겹침' }),
    msg({ session_id: 'same', content: 'pact 선택지 둘 다 겹침' }),
    msg({ session_id: 'other', content: 'pact 다른 세션' }),
  ];
  await withServer(answer({ user, complaint: user }), async (server) => {
    assert.deepEqual(textsOf(await get(server)), ['pact 다른 세션', 'pact 선택지 둘 다 겹침']);
  });
});

test('같은 세션이라도 사용자 말과 AI 보고는 각각 하나씩 남는다', async () => {
  const user = [msg({ session_id: 'same', content: 'pact 사용자 말' })];
  const report = [ai({ session_id: 'same', content: 'pact 선택지 AI 보고' }), ai({ session_id: 'same', content: 'pact 다른 AI 보고' })];
  await withServer(answer({ user, report }), async (server) => {
    assert.deepEqual(textsOf(await get(server)), ['pact 사용자 말', 'pact 선택지 AI 보고']);
  });
});

test('겹침 점수는 주제 낱말의 서로 다른 개수이고 백틱 안 낱말과 영문 부분 문자열은 세지 않는다', async () => {
  const user = [msg({ content: 'pact 선택지 둘' }), msg({ content: '`pact` 코드와 선택지' }), msg({ content: 'impact 선택지' })];
  await withServer(answer({ user }), async (server) => {
    const { items } = await get(server);
    assert.deepEqual(items.map((i) => [i.text, i.overlap]), [['pact 선택지 둘', 2], ['pact 코드와 선택지', 1], ['impact 선택지', 1]]);
  });
});

test('묶음: 사용자 말 — 규칙 > 실패 > 아이디어 > 시도, 한 글자 늘은 한글 낱말 속에서는 안 건다', async () => {
  const cases = [
    ['pact 선택지는 앞으로 둘만', 'rules'],
    ['pact 선택지는 늘 둘만', 'rules'],
    ['pact 선택지 하지 마', 'rules'],
    ['pact 선택지 항상 불편', 'rules'],
    ['pact 선택지 금지 원칙', 'rules'],
    ['pact 선택지가 불편해', 'failures'],
    ['pact 선택지 안 됨', 'failures'],
    ['pact 선택지 안 돼', 'failures'],
    ['pact 선택지 짜증 문제 깨짐 막힘', 'failures'],
    ['pact 선택지 실패 나중에', 'failures'],
    ['pact 선택지 하면 좋겠다', 'ideas'],
    ['pact 선택지 아이디어', 'ideas'],
    ['pact 선택지 다음에', 'ideas'],
    ['pact 선택지 추가하자', 'ideas'],
    ['pact 선택지 넣어 줘', 'ideas'],
    ['오늘 pact 선택지를 물어봤다', 'attempts'],
    ['pact 선택지 늘어났다', 'attempts'],
    ['pact 선택지를 해 봤다', 'attempts'],
  ];
  await withServer(answer({ user: cases.map(([content]) => msg({ content })) }), async (server) => {
    const { items } = await get(server);
    assert.deepEqual(items.map((i) => [i.text, i.bucket]), cases);
  });
});

test('묶음: AI 보고 — 막힌 곳·실패·의심은 실패, 다음 판 후보·다음에 고칠·후보는 아이디어, 나머지는 시도', async () => {
  const cases = [
    ['pact 선택지 막힌 곳은 훅', 'failures'],
    ['pact 선택지 실패했다', 'failures'],
    ['pact 선택지 의심스럽다', 'failures'],
    ['pact 선택지 다음 판 후보는 팀원', 'ideas'],
    ['pact 선택지 다음에 고칠 것', 'ideas'],
    ['pact 선택지 후보 하나', 'ideas'],
    ['pact 선택지 실패와 후보', 'failures'],
    ['pact 선택지를 끝냈다', 'attempts'],
    ['pact 선택지 앞으로 불편', 'attempts'],
  ];
  await withServer(answer({ report: cases.map(([content]) => ai({ content })) }), async (server) => {
    const { items } = await get(server);
    assert.deepEqual(items.map((i) => [i.text, i.bucket]), cases);
  });
});

test('항목 꼴: source·날짜·path, 요지는 첫 줄(마크다운 머리와 백틱을 벗김)이고 첫 줄이 비면 첫 문장이다', async () => {
  const user = [
    msg({
      content: '## **pact** 선택지 `코드`\n둘째 줄',
      metadata: { source: 'claude', direct_user: true, transcript_path: '/h/.claude/projects/-x/abc.jsonl' },
    }),
    msg({ content: '- \npact 선택지를 바꿨어요. 이제 된다\n다음 줄', metadata: { source: 'codex', direct_user: true, codex_rollout_path: '/h/rollout.jsonl' } }),
  ];
  const report = [ai({ content: 'pact 선택지 보고' })];
  await withServer(answer({ user, report }), async (server) => {
    const { items } = await get(server);
    assert.deepEqual(
      items.map(({ source, text, path: p }) => ({ source, text, path: p })),
      [
        { source: 'user', text: 'pact 선택지 코드', path: '/h/.claude/projects/-x/abc.jsonl' },
        { source: 'user', text: 'pact 선택지를 바꿨어요.', path: '/h/rollout.jsonl' },
        { source: 'assistant', text: 'pact 선택지 보고', path: null },
      ],
    );
    assert.ok(items.every((i) => /^2026-10-1[89]$/.test(i.date)));
  });
});

test('날짜는 created_at을 이 기계의 지역 시간 날짜로 바꾼 것이다', async () => {
  const saved = process.env.TZ;
  process.env.TZ = 'Asia/Seoul';
  try {
    await withServer(answer({ user: [msg({ created_at: '2026-10-18T20:00:00.000000Z' })] }), async (server) => {
      assert.deepEqual((await get(server)).items.map((i) => i.date), ['2026-10-19']);
    });
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('저장소: transcript_path 슬러그를 RECALL_ROOTS 아래 폴더와 가장 긴 앞머리로 맞추고, 없으면 cwd의 basename, 둘 다 없으면 null', async () => {
  const root = tmp();
  for (const d of ['demo', 'demo-extra', '.hidden']) mkdirSync(path.join(root, d));
  const slug = (d) => projectDirName(path.join(root, d));
  const at = (s) => ({ source: 'claude', direct_user: true, transcript_path: `/Users/x/.claude/projects/${s}/u.jsonl` });
  const user = [
    msg({ content: 'pact 선택지 a', metadata: at(`${slug('demo')}-plugins-pact`) }),
    msg({ content: 'pact 선택지 b', metadata: at(`${slug('demo-extra')}--pact-wt`) }),
    msg({ content: 'pact 선택지 c', metadata: at(slug('demo')) }),
    msg({ content: 'pact 선택지 d', metadata: at(`${slug('demo')}x`) }),
    msg({ content: 'pact 선택지 e', metadata: { source: 'codex', direct_user: true, cwd: '/elsewhere/where/proj' } }),
    msg({ content: 'pact 선택지 f', metadata: { source: 'claude', direct_user: true } }),
    msg({ content: 'pact 선택지 g', metadata: { ...at('-no-match'), cwd: '/elsewhere/where/other' } }),
  ];
  await withServer(answer({ user }), async (server) => {
    const project = path.join(root, 'demo', 'packages', 'a');
    const { items } = await collect({ topicWords: TOPIC, project, env: envFor(server, { RECALL_ROOTS: root }) });
    assert.deepEqual(
      items.map((i) => [i.text.slice(-1), i.repo, i.same_repo]),
      [['a', 'demo', true], ['b', 'demo-extra', false], ['c', 'demo', true], ['d', null, false], ['e', 'proj', false], ['f', null, false], ['g', 'other', false]],
    );
    const inCwd = await collect({ topicWords: TOPIC, project: '/elsewhere/where/proj/sub', env: envFor(server, { RECALL_ROOTS: root }) });
    assert.deepEqual(inCwd.items.filter((i) => i.repo === 'proj').map((i) => i.same_repo), [true]);
  });
});

test('닿지 않는 주소는 연결 거부 까닭으로 던진다', async () => {
  await assert.rejects(
    collect({ topicWords: TOPIC, project: '/p', env: { HONCHO_BASE_URL: 'http://127.0.0.1:9', HONCHO_ENV_FILE: NO_ENV_FILE } }),
    { message: '연결 거부 127.0.0.1:9' },
  );
});

test('요청 하나가 시간 안에 못 오면 그 요청만 버리고 나머지 결과는 낸다', async () => {
  const handler = (rec) => ({ user: { delay: 1500, json: [msg({ content: 'pact 느린 사용자 말' })] }, complaint: { json: [msg({ content: 'pact 불만 말' })] }, report: {} })[kindOf(rec)];
  await withServer(handler, async (server) => {
    const started = Date.now();
    assert.deepEqual(textsOf(await get(server, { RECALL_REQUEST_MS: '150' })), ['pact 불만 말']);
    assert.ok(Date.now() - started < 1200, '느린 요청을 기다리지 않는다');
  });
});

test('모든 요청이 시간 안에 못 오면 시간 초과 까닭으로 던진다', async () => {
  await withServer(() => ({ delay: 1000 }), async (server) => {
    await assert.rejects(get(server, { RECALL_REQUEST_MS: '100' }), { message: '0.1초 안에 응답 없음' });
  });
});

test('전체 예산이 요청 시간보다 짧으면 예산 까닭으로 던진다', async () => {
  await withServer(() => ({ delay: 1000 }), async (server) => {
    await assert.rejects(get(server, { RECALL_BUDGET_MS: '100' }), { message: '전체 예산 0.1초 안에 응답 없음' });
  });
});

test('요청 하나가 HTTP 오류여도 나머지 결과는 내고, 전부 오류면 상태 코드로 던진다', async () => {
  await withServer((rec) => (kindOf(rec) === 'user' ? { status: 500 } : { json: kindOf(rec) === 'report' ? [ai({ content: 'pact AI 보고' })] : [] }), async (server) => {
    assert.deepEqual(textsOf(await get(server)), ['pact AI 보고']);
  });
  await withServer(() => ({ status: 401, json: { detail: 'no' } }), async (server) => {
    await assert.rejects(get(server), { message: 'HTTP 401' });
  });
});

test('응답이 메시지 배열이 아니거나 JSON이 아니면 읽을 수 없는 응답으로 던진다', async () => {
  await withServer(() => ({ json: { detail: 'x' } }), async (server) => {
    await assert.rejects(get(server), { message: '응답이 메시지 목록이 아님' });
  });
  await withServer(() => ({ text: '<html>' }), async (server) => {
    await assert.rejects(get(server), { message: '응답을 읽을 수 없음' });
  });
});

test('환경 변수가 없으면 HONCHO_ENV_FILE의 KEY=VALUE 줄로 채우고(따옴표·export·주석 처리), 환경 변수가 있으면 그것이 이긴다', async () => {
  await withServer(undefined, async (server) => {
    const file = path.join(tmp(), '.env');
    writeFileSync(
      file,
      `# 주석\nHONCHO_BASE_URL="${server.url}"\nexport HONCHO_WORKSPACE_ID='ws2'\nHONCHO_USER_NAME=from-file\n\nHONCHO_API_BEARER_TOKEN=file-token\nUNRELATED=1\n`,
    );
    await collect({ topicWords: TOPIC, project: '/p', env: { HONCHO_ENV_FILE: file, HONCHO_USER_NAME: 'from-env', RECALL_ROOTS: tmp() } });
    assert.equal(server.requests.length, 3);
    for (const r of server.requests) {
      assert.equal(r.url, '/v3/workspaces/ws2/search');
      assert.equal(r.headers.authorization, 'Bearer file-token');
    }
    assert.deepEqual(server.requests.find((r) => r.body.query === Q_USER).body.filters, { peer_id: 'from-env' });
  });
});

test('CLI: 닿지 않는 주소여도 종료 0이고 머리줄은 출처 2/3, 못 읽음 줄 하나, 나머지 출처 결과는 그대로다', async () => {
  const r = await cli(['pact', '선택지', '--project', tmp()], { HONCHO_BASE_URL: 'http://127.0.0.1:9' });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.match(lines[0], /^recall: pact 선택지 — 출처 2\/3 · \d+ms$/);
  assert.equal(lines[1], '- 못 읽음: 기억 서버 (연결 거부 127.0.0.1:9)');
  assert.equal(lines.filter((l) => l.startsWith('- 못 읽음')).length, 1);
  assert.ok(r.stdout.includes('## 지키라는 규칙'));
  assert.deepEqual(readdirSync(r.cwd), []);
});

test('CLI: 서버가 느려 시간이 지나도 종료 0이고 시간 초과를 한 줄로 알린다', async () => {
  await withServer(() => ({ delay: 1000 }), async (server) => {
    const r = await cli(['pact', '선택지', '--project', tmp()], { HONCHO_BASE_URL: server.url, RECALL_REQUEST_MS: '100' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^recall: pact 선택지 — 출처 2\/3 · \d+ms\n- 못 읽음: 기억 서버 \(0\.1초 안에 응답 없음\)\n/);
  });
});

test('CLI: 가짜 서버의 사용자 말·AI 보고가 줄에 나오고 출처 이름과 저장소 표시가 붙는다', async () => {
  const root = tmp();
  mkdirSync(path.join(root, 'demo'));
  mkdirSync(path.join(root, 'else'));
  const at = (d) => ({ source: 'claude', direct_user: true, transcript_path: `/h/.claude/projects/${projectDirName(path.join(root, d))}/u.jsonl` });
  const user = [msg({ content: 'pact 선택지는 앞으로 둘만', metadata: at('else') }), msg({ content: 'pact 선택지가 불편해', metadata: at('demo') })];
  const report = [ai({ content: 'pact 선택지 막힌 곳은 훅이다', metadata: { ...at('demo'), direct_user: false } })];
  await withServer(answer({ user, report }), async (server) => {
    const r = await cli(['pact', '선택지', '--project', path.join(root, 'demo')], { HONCHO_BASE_URL: server.url, RECALL_ROOTS: root });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^recall: pact 선택지 — 출처 3\/3 · \d+ms\n\n/);
    assert.match(r.stdout, /^- \([\d/]+ · 사용자 말\) pact 선택지는 앞으로 둘만 — 다른 저장소$/m);
    assert.match(r.stdout, /^- \([\d/]+ · 사용자 말\) pact 선택지가 불편해$/m);
    assert.match(r.stdout, /^- \([\d/]+ · AI 보고\) pact 선택지 막힌 곳은 훅이다$/m);
  });
});

test('토큰 값은 정상·오류·닿지 않는 어느 출력에도 나오지 않는다', async () => {
  const token = 'sekret-token-xyz-9';
  const seen = [];
  await withServer(() => ({ status: 401, json: { detail: 'bad' } }), async (server) => {
    seen.push(await cli(['pact', '선택지', '--project', tmp()], { HONCHO_BASE_URL: server.url, HONCHO_API_BEARER_TOKEN: token }));
    seen.push(await cli(['pact', '선택지', '--project', tmp(), '--json'], { HONCHO_BASE_URL: server.url, HONCHO_API_BEARER_TOKEN: token }));
  });
  seen.push(await cli(['pact', '선택지', '--project', tmp()], { HONCHO_BASE_URL: 'http://127.0.0.1:9', HONCHO_API_BEARER_TOKEN: token }));
  await withServer(answer({ user: [msg()] }), async (server) => {
    seen.push(await cli(['pact', '선택지', '--project', tmp()], { HONCHO_BASE_URL: server.url, HONCHO_API_BEARER_TOKEN: token }));
  });
  assert.match(seen[0].stdout, /- 못 읽음: 기억 서버 \(HTTP 401\)/);
  for (const r of seen) {
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!(r.stdout + r.stderr).includes(token));
  }
});
