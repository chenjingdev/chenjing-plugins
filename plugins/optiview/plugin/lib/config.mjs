// 설정과 경로. 설정 파일은 ~/.optiview/config.json이고 환경 변수가 우선한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const VERSION = '0.8.0';

export function home() {
  return process.env.OPTIVIEW_HOME || path.join(os.homedir(), '.optiview');
}

export const DEFAULTS = {
  port: 4780, // 0.6(4777)과 겹치지 않게 한다
  window: 'auto', // auto(앱 창) | dock(cmux 오른쪽 Dock, 시험 중) | app | browser | off
  autoOpen: true, // 세션이 시작될 때 읽기 창이 없으면 연다
};

const ENV = {
  port: ['OPTIVIEW_PORT', Number],
  window: ['OPTIVIEW_WINDOW', String],
  autoOpen: ['OPTIVIEW_AUTO_OPEN', (v) => !/^(0|false|off|no)$/i.test(v)],
};

const WINDOWS = new Set(['auto', 'dock', 'app', 'browser', 'off']);

export function loadConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(home(), 'config.json'), 'utf8')); } catch { /* 없으면 기본값 */ }
  const cfg = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) if (file[key] !== undefined) cfg[key] = file[key];
  for (const [key, [name, cast]] of Object.entries(ENV)) {
    const v = process.env[name];
    if (v !== undefined && v !== '') cfg[key] = cast(v);
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) cfg.port = DEFAULTS.port;
  if (!WINDOWS.has(cfg.window)) cfg.window = DEFAULTS.window;
  cfg.autoOpen = cfg.autoOpen !== false;
  return cfg;
}

export function saveConfig(patch) {
  const file = path.join(home(), 'config.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 새로 만든다 */ }
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify({ ...cur, ...patch }, null, 2)}\n`);
}

// 서버와 훅이 같은 토큰을 쓴다. 파일 권한은 본인만 읽게 한다.
export function token() {
  const file = path.join(home(), 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch { /* 새로 만든다 */ }
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

export const baseUrl = (cfg) => `http://127.0.0.1:${cfg.port}`;
