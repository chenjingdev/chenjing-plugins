// cmux 포커스: cmux가 모든 이벤트를 덧붙여 쓰는 ~/.cmuxterm/events.jsonl을 따라 읽는다.
// 소켓 권한이 필요 없고, 새로 붙은 줄만 읽으므로 CPU를 거의 쓰지 않는다.
// 쓰는 이벤트: workspace.selected, window.keyed(보이는 워크스페이스), surface.focused/selected(워크스페이스 안 입력 칸)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TAIL = 4 * 1024 * 1024; // 시작할 때 현재 상태를 복원하려고 읽는 끝부분
const POLL_MS = 1500; // fs.watch를 못 믿을 때(파일 교체 등)를 대비한 확인 간격
const NAMES = /"name":"(workspace\.selected|window\.keyed|surface\.focused|surface\.selected|surface\.closed|workspace\.closed)"/;

export function cmuxEventsFile() {
  return process.env.OPTIVIEW_CMUX_EVENTS || path.join(os.homedir(), '.cmuxterm', 'events.jsonl');
}

const lower = (v) => (typeof v === 'string' && v ? v.toLowerCase() : null);

// 이벤트를 받아 "지금 보이는 워크스페이스의 입력 칸"을 계산한다. 파일 읽기와 떼어 두어 검사하기 쉽게 한다.
export function createCmuxState() {
  let boot = null;
  let active = null;
  const focusedBy = new Map();
  const titles = new Map();

  function apply(ev) {
    if (!ev || typeof ev.name !== 'string') return;
    if (ev.boot_id && ev.boot_id !== boot) {
      if (boot) { active = null; focusedBy.clear(); }
      boot = ev.boot_id;
    }
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    const ws = lower(p.workspace_id) || lower(ev.workspace_id);
    const surface = lower(ev.surface_id) || lower(p.surface_id);
    const terminal = !p.kind || p.kind === 'terminal';
    switch (ev.name) {
      case 'workspace.selected':
        if (ws) {
          active = ws;
          const title = p.custom_title || p.title;
          if (typeof title === 'string' && title.trim()) titles.set(ws, title.trim());
        }
        break;
      case 'window.keyed':
        if (ws) active = ws;
        return 'keyed';
      case 'surface.focused':
        if (ws && surface && terminal) focusedBy.set(ws, surface);
        break;
      case 'surface.selected':
        if (ws && surface && terminal && p.focused === true) focusedBy.set(ws, surface);
        break;
      case 'surface.closed':
        if (ws && focusedBy.get(ws) === surface) focusedBy.delete(ws);
        break;
      case 'workspace.closed':
        if (ws) { focusedBy.delete(ws); if (active === ws) active = null; }
        break;
      default:
    }
  }

  // 보이는 워크스페이스와 그 안의 입력 칸. 칸을 모르면(분할을 한 번도 안 옮긴 워크스페이스) terminal은 null이다
  function current() {
    if (!active) return null;
    const id = focusedBy.get(active);
    return { group: active, terminal: id ? { host: 'cmux', id, group: active } : null, label: titles.get(active) || null };
  }

  return { apply, current };
}

export function createCmuxFocus({ file = cmuxEventsFile(), onFocus, log = () => {}, pollMs = POLL_MS }) {
  const state = createCmuxState();
  let offset = 0;
  let ino = null;
  let rest = Buffer.alloc(0);
  let last = null;
  let watcher = null;
  let timer = null;
  let started = false;

  let keyed = false;
  function emit() {
    const cur = state.current();
    if (!cur) return;
    const key = `${cur.group}|${cur.terminal?.id}|${cur.label}`;
    const force = keyed;
    keyed = false;
    if (key === last && !force) return;
    last = key;
    onFocus({ host: 'cmux', group: cur.group, terminal: cur.terminal, label: cur.label });
  }

  function lines(buf) {
    const data = rest.length ? Buffer.concat([rest, buf]) : buf;
    const nl = data.lastIndexOf(0x0a);
    if (nl < 0) { rest = Buffer.from(data); return; }
    rest = Buffer.from(data.subarray(nl + 1));
    for (const line of data.subarray(0, nl).toString('utf8').split('\n')) {
      if (!NAMES.test(line)) continue;
      try { if (state.apply(JSON.parse(line)) === 'keyed') keyed = true; } catch { /* 깨진 줄은 넘긴다 */ }
    }
  }

  function read(fromTail) {
    let st;
    try { st = fs.statSync(file); } catch { return false; }
    if (ino !== null && st.ino !== ino) { offset = 0; rest = Buffer.alloc(0); } // 16MiB에서 새 파일로 바뀐다
    if (st.size < offset) { offset = 0; rest = Buffer.alloc(0); }
    ino = st.ino;
    if (fromTail && st.size > TAIL) {
      // 끝부분만 읽고, 잘린 첫 줄은 버린다
      offset = st.size - TAIL;
      rest = Buffer.alloc(0);
      const buf = readRange(offset, st.size);
      const nl = buf.indexOf(0x0a);
      offset = st.size;
      lines(nl >= 0 ? buf.subarray(nl + 1) : Buffer.alloc(0));
    } else if (st.size > offset) {
      const buf = readRange(offset, st.size);
      offset = st.size;
      lines(buf);
    }
    emit();
    return true;
  }

  function readRange(from, to) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(to - from);
      const n = fs.readSync(fd, buf, 0, buf.length, from);
      return buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  }

  function watch() {
    try {
      watcher?.close();
      watcher = fs.watch(file, { persistent: false }, () => { try { read(false); } catch (e) { log(`cmux read: ${e.message}`); } });
      watcher.on('error', () => { watcher?.close(); watcher = null; });
    } catch { watcher = null; }
  }

  function tick() {
    try {
      if (!started) {
        if (read(true)) { started = true; watch(); log('cmux focus: events.jsonl 따라 읽기 시작'); }
        return;
      }
      const before = ino;
      read(false);
      if (ino !== before || !watcher) watch();
    } catch (e) {
      log(`cmux tick: ${e.message}`);
    }
  }

  return {
    start() { tick(); timer = setInterval(tick, pollMs); timer.unref?.(); },
    close() { clearInterval(timer); watcher?.close(); },
    current: () => state.current(),
  };
}
