// 읽기 창 열기. 기본은 주소창 없는 앱 창(Chrome 계열), 없으면 기본 브라우저.
// dock을 고르면 cmux 오른쪽 Dock에 브라우저 탭으로 붙인다(워크스페이스별 Dock인지 창 전체 Dock인지 아직 확인 중이라 기본값이 아니다).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { home } from './config.mjs';

const MAC_APPS = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'];

function detached(cmd, args, env) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env });
  child.on('error', () => {});
  child.unref();
}

export function cmuxBin(env = process.env) {
  const candidates = [env.CMUX_BUNDLED_CLI_PATH, '/Applications/cmux.app/Contents/Resources/bin/cmux'];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function cmuxJson(bin, args, env) {
  return JSON.parse(execFileSync(bin, ['--json', ...args], { env, timeout: 3000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
}

// 이미 Dock이나 화면 어딘가에 읽기 창이 있으면 새로 만들지 않는다
function cmuxHasReader(bin, url, env) {
  const origin = new URL(url).origin;
  let found = false;
  const walk = (o) => {
    if (found || !o || typeof o !== 'object') return;
    if (o.type === 'browser' && typeof o.url === 'string' && o.url.startsWith(origin)) { found = true; return; }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  walk(cmuxJson(bin, ['tree', '--all'], env));
  return found;
}

function openDock(url, env) {
  const bin = cmuxBin(env);
  if (!bin) return false;
  try {
    if (cmuxHasReader(bin, url, env)) return true;
    execFileSync(bin, ['new-surface', '--type', 'browser', '--placement', 'dock', '--url', url], { env, timeout: 3000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function openApp(url) {
  // 창 전용 프로필: 크기와 위치를 따로 기억하고 평소 브라우저 탭과 섞이지 않는다
  const profile = path.join(home(), 'window-reader');
  const args = [`--app=${url}`, '--window-size=480,860', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check'];
  if (process.platform === 'darwin') {
    const app = MAC_APPS.find((name) => ['/Applications', path.join(process.env.HOME || '', 'Applications')].some((d) => fs.existsSync(path.join(d, `${name}.app`))));
    if (!app) return null;
    detached('open', ['-na', app, '--args', ...args]);
    return { opened: true, how: app };
  }
  for (const bin of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    try {
      execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
      detached(bin, args);
      return { opened: true, how: bin };
    } catch { /* 다음 후보 */ }
  }
  return null;
}

function openBrowser(url) {
  if (process.platform === 'darwin') detached('open', [url]);
  else if (process.platform === 'win32') detached('cmd', ['/c', 'start', '', url]);
  else detached('xdg-open', [url]);
  return { opened: true, how: 'browser' };
}

export function openReader(url, { mode = 'auto', env = process.env } = {}) {
  if (env.OPTIVIEW_NO_OPEN) return { opened: false, how: 'disabled' };
  const inCmux = Boolean(env.CMUX_SURFACE_ID);
  const want = mode === 'auto' ? 'app' : mode;
  if (want === 'off') return { opened: false, how: 'off' };
  if (want === 'dock' && inCmux && openDock(url, env)) return { opened: true, how: 'cmux Dock' };
  if (want === 'app' || want === 'dock') {
    const r = openApp(url);
    if (r) return r;
  }
  return openBrowser(url);
}
