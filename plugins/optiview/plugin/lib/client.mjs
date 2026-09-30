// 훅과 명령이 로컬 서버와 이야기하는 쪽. 서버가 없거나 판이 다르면 새로 띄운다.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION, baseUrl, token } from './config.mjs';

const BIN = fileURLToPath(new URL('../bin/optiview.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function request(cfg, method, path, body, { timeoutMs = 2000, auth = true } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(baseUrl(cfg) + path, {
      method,
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', ...(auth ? { 'x-optiview-token': token() } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    const value = text ? JSON.parse(text) : {};
    if (!r.ok) throw Object.assign(new Error(value.error || `HTTP ${r.status}`), { status: r.status });
    return value;
  } finally {
    clearTimeout(timer);
  }
}

export async function health(cfg, timeoutMs = 400) {
  try {
    const h = await request(cfg, 'GET', '/api/health', undefined, { timeoutMs, auth: false });
    return h?.app === 'optiview' ? h : null;
  } catch {
    return null;
  }
}

// 서버에는 필요한 환경 변수만 넘긴다(Claude 세션의 비밀 값이 오래 사는 프로세스에 남지 않게)
function serverEnv(cfg) {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('OPTIVIEW_')) env[k] = v;
  env.OPTIVIEW_PORT = String(cfg.port);
  return env;
}

export function spawnServer(cfg) {
  const child = spawn(process.execPath, [BIN, 'serve'], { detached: true, stdio: 'ignore', env: serverEnv(cfg) });
  child.on('error', () => {});
  child.unref();
}

export async function ensureServer(cfg, { waitMs = 3000 } = {}) {
  let h = await health(cfg);
  if (h?.version === VERSION) return h;
  if (h) {
    // 다른 판이 떠 있으면 내려 달라고 한 뒤 새로 띄운다
    try { await request(cfg, 'POST', '/api/shutdown', {}, { timeoutMs: 800 }); } catch { /* 옛 판은 이 경로가 없을 수 있다 */ }
    await sleep(250);
  }
  spawnServer(cfg);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await sleep(80);
    h = await health(cfg, 300);
    if (h?.version === VERSION) return h;
  }
  return null;
}
