#!/usr/bin/env node
// 화면 도구(Codex CUA)가 없을 때 쓰는 머리 없는 브라우저. 이 컴퓨터의 Chrome을 창 없이 띄워 단계 목록을 그대로 돌리고,
// 단계마다 스크린샷을 남기며, 화면에서 난 오류(콘솔 오류, 잡히지 않은 예외, 실패한 요청)를 같이 돌려준다. 설치할 것은 없다.
//
// 사용: node browser.mjs <단계.json | ->  (- 는 표준 입력)
//   { "url": "http://127.0.0.1:3000/", "viewport": { "width": 1280, "height": 800 },
//     "steps": [
//       { "do": "goto", "url": "…" },                          주소 열기 (맨 위 url은 첫 goto다)
//       { "do": "click", "text": "로그인" },                    보이는 글자로 누르기 (또는 "selector")
//       { "do": "type", "label": "아이디", "text": "가" },      칸 채우기: "selector" | "label"(라벨 · placeholder · name)
//       { "do": "press", "key": "Enter" },
//       { "do": "upload", "selector": "input[type=file]", "files": ["/절대/경로"] },
//       { "do": "waitFor", "text": "올렸습니다" },              글자나 "selector"가 보일 때까지 (기본 5초)
//       { "do": "wait", "ms": 300 }, { "do": "back" }, { "do": "reload" },
//       { "do": "viewport", "width": 390, "height": 844 },
//       { "do": "eval", "js": "document.title" },               값을 돌려준다
//       { "do": "shot", "file": "/…/shots/S1-1.png" } ] }       지금 화면을 PNG로
// 출력(JSON): { ok, steps: [{ do, ok, error?, value? }], errors: [화면에서 난 오류], failed: [실패한 요청], dialogs: [뜬 확인 창], url, title, text }
// 한 단계가 실패하면 거기서 멈추고 그때의 화면 글(text)을 돌려준다. 끝나는 코드는 모두 됐으면 0, 아니면 1.
// 확인 창(alert · confirm)은 "확인"을 누른다. 취소를 눌러 보려면 그 앞에 { "do": "dialog", "accept": false }를 둔다.
// 로그인은 한 번의 실행 안에서만 이어진다. 시나리오 하나를 한 번에 돌린다.
// Chrome을 여기서 띄울 수 없는 자리(Claude Code 샌드박스 안)에서는 밖에서 `--remote-debugging-port=<포트>`로 띄워 둔 Chrome에 붙는다: PACT_BROWSER_CDP=http://127.0.0.1:<포트>
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CANDIDATES = [
  process.env.PACT_BROWSER,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
];
export const findBrowser = () => CANDIDATES.find((file) => file && existsSync(file)) ?? null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launch(binary, profile) {
  const child = spawn(binary, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MAC_CHROMIUM_TMPDIR: profile } }); // Chrome이 임시 파일(잠금 소켓)을 쓸 자리를 이 실행의 폴더로 준다. 샌드박스 안에서는 기본 자리에 못 쓴다.
  return new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error(`브라우저가 15초 안에 뜨지 않았다: ${err.slice(-300)}`)), 15000);
    child.stderr.on('data', (data) => {
      err += data;
      const found = err.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (found) { clearTimeout(timer); resolve({ child, port: Number(found[1]) }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`브라우저가 바로 끝났다(코드 ${code}): ${err.slice(-300)}`)); });
  });
}

async function connect(port) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('브라우저에 붙지 못했다')); });
  let next = 0;
  const waiting = new Map();
  const listeners = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && waiting.has(message.id)) {
      const { resolve, reject } = waiting.get(message.id);
      waiting.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    } else if (message.method) for (const listener of listeners) listener(message.method, message.params);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  return { send, on: (listener) => listeners.push(listener), close: async () => { socket.close(); await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {}); } };
}

// 화면 안에서 도는 찾기 함수. 보이는 요소만 고른다.
const FIND = `
const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
const byText = (text) => {
  const want = norm(text);
  const pools = ['button, a, [role=button], [role=tab], [role=link], input[type=submit], input[type=button], summary, label', '*'];
  for (const exact of [true, false]) for (const pool of pools) {
    const hits = [...document.querySelectorAll(pool)].filter((el) => visible(el) && (exact ? norm(el.innerText || el.value) === want : norm(el.innerText || el.value).includes(want)));
    if (hits.length) return hits.sort((a, b) => norm(a.innerText || a.value).length - norm(b.innerText || b.value).length)[0];
  }
  return null;
};
const byLabel = (label) => {
  const want = norm(label);
  for (const el of document.querySelectorAll('label')) if (norm(el.innerText).includes(want)) { const target = el.control || el.querySelector('input, textarea, select'); if (target && visible(target)) return target; }
  return [...document.querySelectorAll('input, textarea, select')].find((el) => visible(el) && [el.placeholder, el.name, el.id, el.getAttribute('aria-label')].some((v) => v && norm(v).includes(want))) || null;
};
const find = (q) => q.selector ? [...document.querySelectorAll(q.selector)].find(visible) || document.querySelector(q.selector) : q.label ? byLabel(q.label) : q.text ? byText(q.text) : null;
`;
const describe = (step) => step.selector ? `selector ${step.selector}` : step.label ? `칸 "${step.label}"` : `글자 "${step.text}"`;

export async function run(script, { binary = findBrowser() } = {}) {
  const remote = process.env.PACT_BROWSER_CDP ? Number(new URL(process.env.PACT_BROWSER_CDP).port) : null;
  if (!remote && !binary) throw new Error('이 컴퓨터에서 Chrome 계열 브라우저를 찾지 못했다. PACT_BROWSER에 실행 파일 경로를 넣어 알려 줄 수 있다.');
  const profile = remote ? null : mkdtempSync(path.join(os.tmpdir(), 'pact-browser-'));
  const { child, port } = remote ? { child: null, port: remote } : await launch(binary, profile);
  const out = { ok: true, steps: [], errors: [], failed: [], dialogs: [], url: null, title: null, text: null };
  try {
    const cdp = await connect(port);
    let loading = 0, acceptDialog = true;
    cdp.on((method, params) => {
      if (method === 'Page.frameStartedLoading') loading++;
      if (method === 'Page.frameStoppedLoading') loading = Math.max(0, loading - 1);
      if (method === 'Runtime.exceptionThrown') out.errors.push(`예외: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`.slice(0, 500));
      if (method === 'Runtime.consoleAPICalled' && params.type === 'error') out.errors.push(`콘솔 오류: ${params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 500));
      if (method === 'Network.responseReceived' && params.response.status >= 400) out.failed.push(`${params.response.status} ${params.response.url}`.slice(0, 300));
      if (method === 'Page.javascriptDialogOpening') {
        out.dialogs.push({ type: params.type, message: params.message, answered: acceptDialog ? '확인' : '취소' });
        cdp.send('Page.handleJavaScriptDialog', { accept: acceptDialog }).catch(() => {});
        acceptDialog = true;
      }
    });
    for (const domain of ['Page', 'Runtime', 'Network', 'DOM']) await cdp.send(`${domain}.enable`);
    if (remote) { // 붙어 쓰는 Chrome은 앞 실행의 로그인이 남아 있다. 실행마다 새로 시작하게 지운다.
      await cdp.send('Network.clearBrowserCookies');
      const first = script.url ?? (script.steps ?? []).find((step) => step.do === 'goto')?.url;
      if (first) await cdp.send('Storage.clearDataForOrigin', { origin: new URL(first).origin, storageTypes: 'all' });
    }
    const viewport = (v) => cdp.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: v.width < 600 });
    await viewport(script.viewport ?? { width: 1280, height: 800 });
    const settle = async (ms = 250) => { await sleep(ms); for (let waited = 0; loading > 0 && waited < 8000; waited += 100) await sleep(100); await sleep(100); };
    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression: `(() => { ${FIND} ${expression} })()`, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    const locate = async (step) => {
      const box = await evaluate(`const el = find(${JSON.stringify(step)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
      if (!box) throw new Error(`${describe(step)}를 화면에서 찾지 못했다`);
      return box;
    };
    const actions = {
      goto: async (step) => { loading = 0; await cdp.send('Page.navigate', { url: step.url }); await settle(400); },
      click: async (step) => {
        const { x, y } = await locate(step);
        for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
        await settle();
      },
      type: async (step) => {
        const found = await evaluate(`const el = find(${JSON.stringify(step)}); if (!el) return false; el.focus(); if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } return true;`);
        if (!found) throw new Error(`${describe(step)}를 화면에서 찾지 못했다`);
        await cdp.send('Input.insertText', { text: String(step.text ?? '') });
        await evaluate(`document.activeElement && document.activeElement.dispatchEvent(new Event('change', { bubbles: true }));`);
      },
      press: async (step) => {
        const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8 };
        const key = { key: step.key, code: step.key, windowsVirtualKeyCode: codes[step.key] ?? 0, text: step.key === 'Enter' ? '\r' : undefined };
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
        await settle();
      },
      upload: async (step) => {
        const { root } = await cdp.send('DOM.getDocument');
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: step.selector ?? 'input[type=file]' });
        if (!nodeId) throw new Error(`파일 칸(${step.selector ?? 'input[type=file]'})을 찾지 못했다`);
        await cdp.send('DOM.setFileInputFiles', { nodeId, files: step.files });
        await settle();
      },
      waitFor: async (step) => {
        const limit = step.timeout ?? 5000;
        for (let waited = 0; waited <= limit; waited += 100) {
          if (await evaluate(step.selector ? `const el = find(${JSON.stringify({ selector: step.selector })}); return Boolean(el && visible(el));` : `return norm(document.body.innerText).includes(norm(${JSON.stringify(step.text)}));`)) return;
          await sleep(100);
        }
        throw new Error(`${describe(step)}가 ${limit / 1000}초 안에 보이지 않았다`);
      },
      wait: (step) => sleep(step.ms ?? 300),
      back: async () => { await evaluate('history.back();'); await settle(400); },
      reload: async () => { loading = 0; await cdp.send('Page.reload'); await settle(400); },
      viewport: async (step) => { await viewport(step); await settle(150); },
      dialog: async (step) => { acceptDialog = step.accept !== false; },
      eval: (step) => evaluate(`return (${step.js});`),
      shot: async (step) => {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: step.full === true });
        mkdirSync(path.dirname(path.resolve(step.file)), { recursive: true });
        writeFileSync(path.resolve(step.file), Buffer.from(data, 'base64'));
      },
    };
    const steps = [...(script.url ? [{ do: 'goto', url: script.url }] : []), ...(script.steps ?? [])];
    for (const step of steps) {
      const record = { do: step.do, ...(step.text ? { text: step.text } : {}), ...(step.selector ? { selector: step.selector } : {}), ...(step.file ? { file: step.file } : {}) };
      try {
        if (!actions[step.do]) throw new Error(`모르는 단계: ${step.do}`);
        const value = await actions[step.do](step);
        out.steps.push({ ...record, ok: true, ...(value !== undefined ? { value } : {}) });
      } catch (error) {
        out.steps.push({ ...record, ok: false, error: error.message });
        out.ok = false;
        break;
      }
    }
    try {
      const state = await evaluate(`return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, 4000) };`);
      Object.assign(out, state);
    } catch { /* 화면이 이미 닫혔다 */ }
    await cdp.close();
  } finally {
    if (child) { child.kill(); await sleep(200); rmSync(profile, { recursive: true, force: true }); }
  }
  out.errors = [...new Set(out.errors)];
  out.failed = [...new Set(out.failed)];
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const source = process.argv[2];
  if (!source) { console.error('사용: node browser.mjs <단계.json | ->'); process.exit(2); }
  try {
    const out = await run(JSON.parse(readFileSync(source === '-' ? 0 : source, 'utf8')));
    console.log(JSON.stringify(out, null, 1));
    process.exit(out.ok ? 0 : 1);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exit(2);
  }
}
