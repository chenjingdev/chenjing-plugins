// 지금 읽기 창에 어느 세션을 보일지 정한다.
// - 앱 연동(hosts/*)이 알린 포커스 칸에 Claude 세션이 있으면 그 세션을 보인다.
// - 칸은 모르고 보이는 워크스페이스만 알면(분할을 옮긴 적 없는 워크스페이스) 그 안의 Claude 세션을 보인다.
// - 보이는 워크스페이스에서 질문이 들어오면 그 칸이 포커스다. 사람은 보이는 칸에만 칠 수 있다.
//   보이지 않는 워크스페이스에서 온 질문(자동화)은 포커스를 옮기지 않는다.
// - 포커스 칸에 Claude가 없으면(셸 분할 등) 마지막 대화를 그대로 두고 away로 표시한다.
// - 앱 연동이 없는 터미널은 마지막으로 질문한 세션을 따라간다.
// - 창에서 세션을 직접 고르면 고정한다. 따라가기를 누르기 전까지 움직이지 않는다.
import { terminalKey } from './terminal.mjs';

export function createFocus({ sessions, onChange = () => {} }) {
  const seen = new Map(); // host → { group, terminal, label }: 앱이 알린 지금 보이는 곳
  let state = { sessionId: null, source: null, following: true, away: false, terminal: null, label: null, revision: 0 };

  function set(patch) {
    const next = { ...state, ...patch };
    const same = ['sessionId', 'source', 'following', 'away', 'label'].every((k) => next[k] === state[k])
      && terminalKey(next.terminal) === terminalKey(state.terminal);
    if (same) return;
    state = { ...next, revision: state.revision + 1 };
    onChange(snapshot());
  }

  function resolve(host) {
    const v = seen.get(host);
    if (!state.following || !v) return;
    if (v.terminal) {
      const s = sessions.byTerminal(terminalKey(v.terminal));
      if (s) set({ sessionId: s.id, source: host, away: false, terminal: v.terminal, label: v.label });
      else set({ away: Boolean(state.sessionId), source: host, terminal: v.terminal, label: v.label });
      return;
    }
    const inGroup = v.group ? sessions.inGroup(host, v.group) : [];
    const pick = inGroup.find((s) => s.id === state.sessionId) || inGroup[0];
    if (pick) set({ sessionId: pick.id, source: host, away: false, terminal: pick.terminal, label: v.label });
    else set({ away: Boolean(state.sessionId), source: host, terminal: null, label: v.label });
  }

  // 앱 연동이 알린 지금 보이는 곳(terminal이 null이면 워크스페이스만 안다)
  function hostSeen({ host, group = null, terminal = null, label = null }) {
    if (!host) return;
    seen.set(host, { group: group || terminal?.group || null, terminal, label });
    resolve(host);
  }

  // 훅이 알린 세션 활동
  function sessionTouched(s, event) {
    if (!s) return;
    const t = s.terminal;
    const v = t?.host ? seen.get(t.host) : null;
    if (v) {
      const visible = v.group && t.group === v.group;
      if (event === 'prompt' && visible) {
        seen.set(t.host, { ...v, terminal: t });
        resolve(t.host);
      } else if ((v.terminal && terminalKey(v.terminal) === terminalKey(t)) || (!v.terminal && visible)) {
        resolve(t.host); // 보이는 칸에서 /clear 등으로 새 세션이 생겼다
      }
      return;
    }
    if (!state.following) return;
    if (event === 'prompt') set({ sessionId: s.id, source: 'prompt', away: false, terminal: t, label: null });
    else if (!state.sessionId && event === 'session-start') set({ sessionId: s.id, source: 'start', away: false, terminal: t, label: null });
  }

  function pin(sessionId) {
    if (!sessions.get(sessionId)) throw Object.assign(new Error('session not found'), { status: 404 });
    set({ sessionId, source: 'manual', following: false, away: false });
  }

  function follow() {
    set({ following: true });
    for (const host of seen.keys()) resolve(host);
  }

  function snapshot() {
    return { ...state, live: [...seen.keys()] };
  }

  return { hostSeen, sessionTouched, pin, follow, snapshot };
}
