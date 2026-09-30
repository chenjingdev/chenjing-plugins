import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../plugin/lib/server.mjs';
import { user, say, done, title, jsonl } from './fixtures/transcript.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-server-'));
const token = 'test-token';
let app;
let base;

before(async () => {
  app = createServer({ home, token });
  base = `http://127.0.0.1:${await app.listen(0)}`;
});
after(async () => { await app.close(); });

const call = async (method, p, body, headers = {}) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-optiview-token': token, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

function transcript(name, entries) {
  const file = path.join(home, `${name}.jsonl`);
  fs.writeFileSync(file, jsonl(entries));
  return file;
}

test('health는 토큰 없이, 나머지는 토큰이 있어야 한다. 다른 Host·Origin은 막는다', async () => {
  const h = await fetch(`${base}/api/health`).then((r) => r.json());
  assert.equal(h.app, 'optiview');
  assert.equal((await call('GET', '/api/state', undefined, { 'x-optiview-token': 'wrong' })).status, 401);
  assert.equal((await call('POST', '/api/focus', { follow: true }, { origin: 'https://evil.example' })).status, 403);
  const port = new URL(base).port;
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { host: `evil.example:${port}` } }, (r) => { r.resume(); resolve(r.statusCode); });
  });
  assert.equal(status, 403);
});

test('정적 파일은 정해진 것만', async () => {
  assert.equal((await fetch(`${base}/web/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/web/..%2Flib%2Fconfig.mjs`)).status, 404);
  const page = await fetch(`${base}/`).then((r) => r.text());
  assert.ok(page.includes(`content="${token}"`));
});

test('훅으로 세션을 알리면 기록 파일에서 턴을 읽고, 연동 없는 터미널은 질문한 세션을 보인다', async () => {
  const file = transcript('a', [title('로그인 버그'), user('로그인 오류 원인 찾아 줘'), say('세션 쿠키 만료 시간이 0이었습니다.'), done()]);
  assert.equal((await call('POST', '/api/hook', { event: 'session-start', sessionId: 'sess-a', transcriptPath: file, cwd: '/tmp/demo-app' })).status, 200);
  await call('POST', '/api/hook', { event: 'prompt', sessionId: 'sess-a', transcriptPath: file, cwd: '/tmp/demo-app' });
  const view = (await call('GET', '/api/sessions/sess-a')).body;
  assert.equal(view.title, '로그인 버그');
  assert.equal(view.project, 'demo-app');
  assert.equal(view.pages[0].answer, '세션 쿠키 만료 시간이 0이었습니다.');
  const st = (await call('GET', '/api/state')).body;
  assert.equal(st.focus.sessionId, 'sess-a');
  assert.equal((await call('POST', '/api/hook', { event: 'nope', sessionId: 'sess-a' })).status, 400);
  assert.equal((await call('POST', '/api/hook', { event: 'prompt', sessionId: '../../etc' })).status, 400);
});

test('SSE: 포커스가 바뀌면 state, 기록이 늘면 session 이벤트', async () => {
  const fileB = transcript('b', [user('문서 정리해 줘'), say('정리했습니다.'), done()]);
  await call('POST', '/api/hook', { event: 'session-start', sessionId: 'sess-b', transcriptPath: fileB, cwd: '/tmp/docs', terminal: { host: 'cmux', id: 'SURF-B' } });
  const events = [];
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/events?token=${token}`, { signal: ctl.signal });
  const reader = res.body.getReader();
  const pump = (async () => {
    let buf = '';
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += Buffer.from(value).toString('utf8');
        let at;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const name = frame.match(/^event: (.+)$/m)?.[1];
          const data = frame.match(/^data: (.+)$/m)?.[1];
          if (name) events.push([name, data ? JSON.parse(data) : null]);
        }
      }
    } catch { /* 끊김 */ }
  })();
  const waitFor = async (pred) => {
    for (let i = 0; i < 80; i++) { const e = events.find(pred); if (e) return e; await new Promise((r) => setTimeout(r, 25)); }
    assert.fail(`이벤트가 오지 않음: ${JSON.stringify(events)}`);
  };
  try {
    await waitFor(([n]) => n === 'hello');
    // cmux 연동이 칸 포커스를 알린 것처럼
    await call('POST', '/api/focus', { terminal: { host: 'cmux', id: 'surf-b' }, label: '문서' });
    const [, st] = await waitFor(([n, d]) => n === 'state' && d.focus.sessionId === 'sess-b');
    assert.equal(st.focus.label, '문서');
    fs.appendFileSync(fileB, jsonl([user('표도 넣어 줘'), say('넣었습니다.'), done()]));
    await call('POST', '/api/hook', { event: 'stop', sessionId: 'sess-b', transcriptPath: fileB });
    await waitFor(([n, d]) => n === 'session' && d.id === 'sess-b');
    assert.equal((await call('GET', '/api/sessions/sess-b')).body.pages.length, 2);
  } finally {
    ctl.abort();
    await pump;
  }
});

test('세션 고정과 따라가기', async () => {
  let st = (await call('POST', '/api/focus', { sessionId: 'sess-a' })).body;
  assert.deepEqual([st.sessionId, st.following], ['sess-a', false]);
  assert.equal((await call('POST', '/api/focus', { sessionId: 'nope' })).status, 404);
  st = (await call('POST', '/api/focus', { follow: true })).body;
  assert.deepEqual([st.sessionId, st.following], ['sess-b', true]);
});

test('세션 목록은 저장되어 서버를 다시 띄워도 남는다', async () => {
  app.sessions.flush();
  const again = createServer({ home, token });
  try {
    const port = await again.listen(0);
    const st = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'x-optiview-token': token } }).then((r) => r.json());
    assert.deepEqual(st.sessions.map((s) => s.id).sort(), ['sess-a', 'sess-b']);
  } finally {
    await again.close();
  }
});
