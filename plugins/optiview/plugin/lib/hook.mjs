// Claude Code 훅. 세션 ID·기록 파일·터미널 칸을 서버에 알리기만 한다.
// 훅은 hooks.json에서 async로 돌아 Claude를 기다리게 하지 않는다. 어떤 오류도 Claude로 새지 않게 삼킨다.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, baseUrl, home } from './config.mjs';
import { request, ensureServer } from './client.mjs';
import { terminalOf } from './terminal.mjs';
import { openReader } from './window.mjs';

const EVENTS = new Set(['session-start', 'prompt', 'stop', 'stop-failure', 'session-end']);

function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const done = () => resolve(data);
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { clearTimeout(timer); done(); });
    process.stdin.on('error', () => { clearTimeout(timer); done(); });
  });
}

function logError(event, e) {
  try {
    const file = path.join(home(), 'hook.log');
    fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, `${new Date().toISOString()} ${event} ${e?.message || e}\n`);
  } catch { /* 기록도 못 하면 그냥 넘어간다 */ }
}

// 같은 때 여러 세션이 시작돼도 창은 한 번만 연다
function claimOpen() {
  const file = path.join(home(), 'opened-at');
  try {
    const last = Number(fs.readFileSync(file, 'utf8'));
    if (Date.now() - last < 60000) return false;
  } catch { /* 처음 */ }
  try { fs.writeFileSync(file, String(Date.now())); } catch { /* 무시 */ }
  return true;
}

export async function runHook(event) {
  if (!EVENTS.has(event)) return;
  // claude -p·SDK 실행과 백그라운드 작업은 사람이 보는 대화가 아니다. 등록하면 읽기 창을 가로챈다.
  // OPTIVIEW_INCLUDE_SDK=1은 실제 Claude로 훅을 검사할 때만 쓴다.
  const background = process.env.CLAUDE_JOB_DIR || /^sdk/.test(process.env.CLAUDE_CODE_ENTRYPOINT || '');
  if (background && !process.env.OPTIVIEW_INCLUDE_SDK) return;
  try {
    const input = JSON.parse((await readStdin()) || '{}');
    if (!input.session_id) return;
    const cfg = loadConfig();
    const h = await ensureServer(cfg);
    if (!h) throw new Error('서버를 띄우지 못함');
    const out = await request(cfg, 'POST', '/api/hook', {
      event,
      sessionId: input.session_id,
      transcriptPath: input.transcript_path,
      cwd: input.cwd,
      terminal: terminalOf(),
    }, { timeoutMs: 3000 });
    const fresh = !input.source || input.source === 'startup' || input.source === 'resume';
    if (event === 'session-start' && fresh && cfg.autoOpen && out.clients === 0 && claimOpen()) {
      openReader(`${baseUrl(cfg)}/`, { mode: cfg.window });
    }
  } catch (e) {
    logError(event, e);
  }
}
