// 로컬 서버: 훅이 알린 세션을 모으고, 포커스를 정하고, 읽기 창에 SSE로 알린다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './config.mjs';
import { createSessions } from './sessions.mjs';
import { createFocus } from './focus.mjs';
import { cleanTerminal } from './terminal.mjs';
import { terminalColors } from './theme.mjs';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const FILES = {
  'app.js': 'text/javascript; charset=utf-8',
  'markdown.js': 'text/javascript; charset=utf-8',
  'structure.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'icon.svg': 'image/svg+xml',
};
const EVENTS = new Set(['session-start', 'prompt', 'stop', 'stop-failure', 'session-end']);
const WATCH_MS = 6 * 3600 * 1000; // 이 시간 안에 움직인 세션의 기록 파일만 지켜본다
const WATCH_MAX = 40;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function createServer({ home, token, hosts = [], log = () => {}, onShutdown = () => {} }) {
  const clients = new Set();
  const watchers = new Map();
  const pending = new Map();
  let lastActivity = Date.now();
  let port = 0;
  let stateTimer = null;

  const sessions = createSessions({ file: path.join(home, 'sessions.json') });
  const focus = createFocus({ sessions, onChange: () => broadcastState() });

  function send(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  // 여러 변화가 한꺼번에 와도 창에는 한 번만 알린다
  function broadcastState() {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => send('state', { focus: focus.snapshot() }), 30);
  }

  function refresh(id) {
    let changed = false;
    try { changed = sessions.refresh(id); } catch (e) { log(`refresh ${id}: ${e.message}`); }
    if (changed) send('session', { id });
    return changed;
  }

  // 기록 파일이 바뀌면 조금 모았다가 읽는다
  function watch(s) {
    if (!s?.transcriptPath || watchers.has(s.id)) return;
    if (watchers.size >= WATCH_MAX) {
      const oldest = [...watchers.keys()].map(sessions.get).filter(Boolean).sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
      if (oldest) unwatch(oldest.id);
    }
    try {
      const w = fs.watch(s.transcriptPath, { persistent: false }, () => {
        clearTimeout(pending.get(s.id));
        pending.set(s.id, setTimeout(() => { pending.delete(s.id); refresh(s.id); }, 80));
      });
      w.on('error', () => unwatch(s.id));
      watchers.set(s.id, w);
    } catch { /* 파일이 아직 없으면 다음 훅 때 다시 */ }
  }

  function unwatch(id) {
    watchers.get(id)?.close();
    watchers.delete(id);
    clearTimeout(pending.get(id));
    pending.delete(id);
  }

  // fs.watch가 놓친 변화를 위해 보이는 세션은 가끔 직접 확인하고, 오래된 감시는 정리한다
  const sweep = setInterval(() => {
    const shown = focus.snapshot().sessionId;
    if (shown && clients.size) refresh(shown);
    for (const id of [...watchers.keys()]) {
      const s = sessions.get(id);
      if (!s || Date.now() - s.lastActiveAt > WATCH_MS) unwatch(id);
    }
  }, 2000);
  sweep.unref?.();

  for (const s of sessions.recent(WATCH_MS)) watch(s);

  const hostHandles = hosts.map((make) => make({ onFocus: (seen) => focus.hostSeen(seen), log }));
  for (const h of hostHandles) h.start();

  function hook(body) {
    const event = String(body.event || '');
    if (!EVENTS.has(event)) throw Object.assign(new Error('unknown event'), { status: 400 });
    const s = sessions.touch(body.sessionId, { cwd: body.cwd, transcriptPath: body.transcriptPath, terminal: body.terminal, event });
    if (!s) throw Object.assign(new Error('bad session'), { status: 400 });
    lastActivity = Date.now();
    watch(s);
    refresh(s.id);
    focus.sessionTouched(s, event);
    broadcastState();
    return { ok: true, clients: clients.size };
  }

  const routes = {
    'GET /api/state': () => ({ version: VERSION, focus: focus.snapshot(), sessions: sessions.list() }),
    'GET /api/theme': () => ({ terminal: terminalColors() }),
    'POST /api/hook': (body) => hook(body),
    'POST /api/focus': (body) => {
      if (body.follow) focus.follow();
      else if (body.sessionId) focus.pin(String(body.sessionId));
      else {
        // 다른 앱 연동이 포커스 칸을 알려 줄 때(optiview focus 명령)
        const t = cleanTerminal(body.terminal);
        if (!t) throw Object.assign(new Error('sessionId, follow or terminal required'), { status: 400 });
        focus.hostSeen({ host: t.host, group: t.group, terminal: t, label: typeof body.label === 'string' ? body.label.slice(0, 80) : null });
      }
      return focus.snapshot();
    },
    'POST /api/shutdown': () => { setTimeout(() => onShutdown(), 20); return { ok: true }; },
  };

  function allowedHost(req) {
    const host = String(req.headers.host || '');
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  }

  function json(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 256 * 1024) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  function page(res) {
    const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8').replace('%%TOKEN%%', token);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': CSP });
    res.end(html);
  }

  function events(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ version: VERSION })}\n\n`);
    clients.add(res);
    lastActivity = Date.now();
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); lastActivity = Date.now(); });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHost(req)) return json(res, 403, { error: 'bad host' });
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /api/health') return json(res, 200, { app: 'optiview', version: VERSION, pid: process.pid, clients: clients.size });
      if (route === 'GET /' || route === 'GET /index.html') return page(res);
      if (req.method === 'GET' && url.pathname.startsWith('/web/')) {
        const name = url.pathname.slice(5);
        if (!Object.hasOwn(FILES, name)) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': FILES[name], 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(path.join(WEB, name)));
      }
      if (route === 'GET /favicon.ico') { res.writeHead(200, { 'content-type': FILES['icon.svg'] }); return res.end(fs.readFileSync(path.join(WEB, 'icon.svg'))); }
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
      const given = req.headers['x-optiview-token'] || (route === 'GET /api/events' ? url.searchParams.get('token') : null);
      if (given !== token) return json(res, 401, { error: 'unauthorized' });
      if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'bad origin' });
      if (route === 'GET /api/events') return events(req, res);
      const m = url.pathname.match(/^\/api\/sessions\/([\w-]{1,100})$/);
      if (req.method === 'GET' && m) {
        const view = sessions.view(m[1]);
        return view ? json(res, 200, view) : json(res, 404, { error: 'not found' });
      }
      const handler = routes[route];
      if (!handler) return json(res, 404, { error: 'not found' });
      const body = req.method === 'POST' ? await readBody(req) : {};
      return json(res, 200, await handler(body));
    } catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
      if (!e.status) log(`error: ${e.stack || e.message}`);
    }
  });

  return {
    listen(p = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, '127.0.0.1', () => { port = server.address().port; resolve(port); });
      });
    },
    idleFor: () => (clients.size ? 0 : Date.now() - lastActivity),
    close() {
      clearInterval(sweep);
      clearTimeout(stateTimer);
      for (const h of hostHandles) h.close();
      for (const id of [...watchers.keys()]) unwatch(id);
      for (const res of clients) res.end();
      sessions.flush();
      return new Promise((resolve) => server.close(() => resolve()));
    },
    focus,
    sessions,
  };
}
