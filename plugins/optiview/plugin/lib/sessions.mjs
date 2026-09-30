// 세션 목록: 훅이 알려 준 세션 ID, 기록 파일, 작업 폴더, 터미널 칸.
// 답 내용은 따로 저장하지 않는다. Claude Code 기록 파일이 원본이다.
import fs from 'node:fs';
import path from 'node:path';
import { TranscriptIndex } from './transcript.mjs';
import { cleanTerminal, terminalKey } from './terminal.mjs';

const KEEP_DAYS = 14;
const KEEP_MAX = 300;

export function isTranscriptPath(p) {
  return typeof p === 'string' && path.isAbsolute(p) && p.endsWith('.jsonl') && !p.includes('\0');
}

export function createSessions({ file, onChange = () => {} }) {
  const map = new Map();
  const indexes = new Map();
  let saveTimer = null;

  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const s of saved.sessions || []) if (s?.id) map.set(s.id, s);
  } catch { /* 처음이면 비어 있다 */ }

  function writeNow() {
    saveTimer = null;
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    const list = [...map.values()].filter((s) => s.lastActiveAt >= cutoff)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, KEEP_MAX);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ sessions: list }));
      fs.renameSync(tmp, file);
    } catch { /* 다음 저장 때 다시 */ }
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeNow, 300);
    saveTimer.unref?.();
  }

  // 훅이 보낸 값으로 세션을 만들거나 고친다
  function touch(id, { cwd, transcriptPath, terminal, event } = {}) {
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) return null;
    const now = Date.now();
    let s = map.get(id);
    if (!s) {
      s = { id, cwd: null, transcriptPath: null, terminal: null, startedAt: now, lastActiveAt: now, ended: false };
      map.set(id, s);
    }
    if (typeof cwd === 'string' && path.isAbsolute(cwd)) s.cwd = cwd;
    if (isTranscriptPath(transcriptPath) && transcriptPath !== s.transcriptPath) {
      s.transcriptPath = transcriptPath;
      indexes.delete(id);
    }
    const t = cleanTerminal(terminal);
    if (t) { s.terminal = t; s.boundAt = now; }
    s.lastActiveAt = now;
    s.ended = event === 'session-end';
    save();
    onChange(s);
    return s;
  }

  function index(id) {
    const s = map.get(id);
    if (!s?.transcriptPath) return null;
    let ix = indexes.get(id);
    if (!ix) { ix = new TranscriptIndex(s.transcriptPath); indexes.set(id, ix); }
    ix.update();
    return ix;
  }

  // 기록 파일이 늘었는지 본다. 바뀌었으면 true
  function refresh(id) {
    const s = map.get(id);
    if (!s?.transcriptPath) return false;
    let ix = indexes.get(id);
    if (!ix) { ix = new TranscriptIndex(s.transcriptPath); indexes.set(id, ix); }
    return ix.update();
  }

  function summary(s) {
    const ix = indexes.get(s.id);
    const pages = ix ? ix.pages() : [];
    const last = pages.at(-1);
    const firstPrompt = pages.find((p) => p.kind === 'human')?.prompt || '';
    return {
      id: s.id,
      title: ix?.title || firstLine(firstPrompt) || null,
      project: s.cwd ? path.basename(s.cwd) : null,
      cwd: s.cwd,
      terminal: s.terminal,
      lastActiveAt: s.lastActiveAt,
      ended: s.ended,
      turns: pages.length,
      status: last?.status || null,
    };
  }

  function view(id) {
    const s = map.get(id);
    if (!s) return null;
    const ix = index(id);
    return { ...summary(s), pages: ix ? ix.pages() : [] };
  }

  // 한 터미널 칸에서 가장 최근에 시작된 세션(/clear나 재시작으로 세션이 바뀐다)
  function byTerminal(key) {
    let best = null;
    for (const s of map.values()) {
      if (terminalKey(s.terminal) !== key) continue;
      if (!best || (s.boundAt || 0) >= (best.boundAt || 0)) best = s; // 같은 시각이면 나중에 생긴 세션
    }
    return best;
  }

  // 한 워크스페이스에 묶인 세션들. 칸마다 가장 최근 세션만, 최근 활동 순
  function inGroup(host, group) {
    const byKey = new Map();
    for (const s of map.values()) {
      if (s.ended || s.terminal?.host !== host || s.terminal?.group !== group) continue;
      const key = terminalKey(s.terminal);
      const cur = byKey.get(key);
      if (!cur || (s.boundAt || 0) >= (cur.boundAt || 0)) byKey.set(key, s);
    }
    return [...byKey.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  // 세션 고르기 목록. 최근 세션은 제목을 보이려고 기록을 읽어 둔다
  function list() {
    const all = [...map.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    for (const s of all.slice(0, 15)) if (Date.now() - s.lastActiveAt < 86400000) refresh(s.id);
    return all.map(summary);
  }

  return {
    touch,
    refresh,
    view,
    byTerminal,
    inGroup,
    list,
    get: (id) => map.get(id) || null,
    recent: (ms) => [...map.values()].filter((s) => Date.now() - s.lastActiveAt < ms),
    flush() { if (saveTimer) { clearTimeout(saveTimer); writeNow(); } },
  };
}

function firstLine(text) {
  const line = String(text || '').split('\n').find((l) => l.trim()) || '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
