#!/usr/bin/env node
// OptiView 명령: hook <event> | serve | open | status | stop | focus
import fs from 'node:fs';
import path from 'node:path';
import { VERSION, loadConfig, baseUrl, home, token } from '../lib/config.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

async function serve() {
  const { createServer } = await import('../lib/server.mjs');
  const { createCmuxFocus } = await import('../lib/hosts/cmux.mjs');
  const cfg = loadConfig();
  const dir = home();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logFile = path.join(dir, 'server.log');
  const log = (msg) => {
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
    } catch { /* 무시 */ }
  };
  const hosts = process.env.OPTIVIEW_NO_HOSTS ? [] : [createCmuxFocus];
  let app;
  const stop = async () => { try { await app?.close(); } finally { process.exit(0); } };
  app = createServer({ home: dir, token: token(), hosts, log, onShutdown: stop });
  try {
    await app.listen(cfg.port);
  } catch (e) {
    // 이미 누가 떠 있으면(동시에 띄운 훅) 조용히 끝낸다
    if (e.code === 'EADDRINUSE') process.exit(0);
    throw e;
  }
  log(`OptiView ${VERSION} 시작 · pid ${process.pid} · ${baseUrl(cfg)}`);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // 창도 훅도 12시간 동안 없으면 스스로 내린다(다음 훅이 다시 띄운다)
  setInterval(() => { if (app.idleFor() > 12 * 3600 * 1000) stop(); }, 600000).unref();
}

async function main() {
  switch (cmd) {
    case 'hook': {
      const { runHook } = await import('../lib/hook.mjs');
      await runHook(rest[0]);
      return;
    }
    case 'serve':
      return serve();
    case 'open': {
      const { ensureServer } = await import('../lib/client.mjs');
      const { openReader } = await import('../lib/window.mjs');
      const cfg = loadConfig();
      if (!(await ensureServer(cfg))) throw new Error('서버를 띄우지 못했습니다');
      const mode = flag('dock') ? 'dock' : flag('app') ? 'app' : flag('browser') ? 'browser' : cfg.window === 'off' ? 'auto' : cfg.window;
      const how = openReader(`${baseUrl(cfg)}/`, { mode });
      console.log(how.opened ? `읽기 창을 열었습니다 (${how.how})` : `읽기 창을 열지 않았습니다 (${how.how})`);
      return;
    }
    case 'status': {
      const { health, request } = await import('../lib/client.mjs');
      const cfg = loadConfig();
      const h = await health(cfg);
      if (!h) { console.log(`꺼져 있음 (${baseUrl(cfg)})`); return; }
      const st = await request(cfg, 'GET', '/api/state');
      const f = st.focus;
      const shown = st.sessions.find((s) => s.id === f.sessionId);
      console.log(`OptiView ${h.version} · ${baseUrl(cfg)} · 읽기 창 ${h.clients}개 · 세션 ${st.sessions.length}개`);
      console.log(`포커스 연동: ${f.live.length ? f.live.join(', ') : '없음(마지막으로 질문한 세션을 따라감)'}`);
      console.log(`지금 보이는 대화: ${shown ? `${shown.title || shown.project || shown.id}${f.following ? '' : ' (고정)'}` : '없음'}`);
      return;
    }
    case 'stop': {
      const { request } = await import('../lib/client.mjs');
      try { await request(loadConfig(), 'POST', '/api/shutdown', {}, { timeoutMs: 1500 }); console.log('서버를 내렸습니다'); } catch { console.log('떠 있는 서버가 없습니다'); }
      return;
    }
    case 'focus': {
      // 포커스 연동이 없는 앱에서 스크립트로 포커스 칸을 알려 줄 때
      const { request } = await import('../lib/client.mjs');
      const host = flag('host');
      const id = flag('id');
      if (typeof host !== 'string' || typeof id !== 'string') throw new Error('optiview focus --host <앱> --id <칸 ID> [--label <이름>]');
      const label = typeof flag('label') === 'string' ? flag('label') : undefined;
      await request(loadConfig(), 'POST', '/api/focus', { terminal: { host, id }, label });
      return;
    }
    default:
      console.log(`OptiView ${VERSION}
  optiview open [--dock|--app|--browser]   읽기 창 열기
  optiview status | stop                   서버 상태 보기·내리기
  optiview focus --host <앱> --id <칸 ID>  포커스 칸 알리기(연동이 없는 앱용)
  optiview hook <event>                    Claude Code 훅(플러그인이 부름)`);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(cmd === 'hook' ? 0 : 1);
});
