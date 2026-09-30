// 훅이 도는 터미널이 어느 앱의 어느 칸인지. 앱이 터미널에 넣어 주는 환경 변수로만 판단한다.
// 포커스를 알려 주는 쪽(hosts/*)과 같은 ID를 써야 세션과 칸이 이어진다.
const ID = /^[\w:.-]{1,200}$/;
const clean = (v) => (typeof v === 'string' && ID.test(v) ? v.toLowerCase() : null);

export function terminalOf(env = process.env) {
  // claude -p·SDK 실행이나 백그라운드 작업은 칸의 환경 변수를 물려받았을 뿐 그 칸의 대화가 아니다.
  // 묶으면 사람이 쓰던 칸의 세션을 가로챈다(Orca도 CLAUDE_JOB_DIR이면 묶지 않는다).
  if (env.CLAUDE_JOB_DIR || /^sdk/.test(env.CLAUDE_CODE_ENTRYPOINT || '')) return null;
  const surface = clean(env.CMUX_SURFACE_ID);
  if (surface) return { host: 'cmux', id: surface, group: clean(env.CMUX_WORKSPACE_ID) };
  // Orca: ORCA_PANE_KEY = "<탭 ID>:<칸 UUID>". 탭 ID는 칸을 옮기면 바뀌므로 칸 UUID만 쓴다.
  const pane = typeof env.ORCA_PANE_KEY === 'string' ? clean(env.ORCA_PANE_KEY.split(':').pop()) : null;
  if (pane) return { host: 'orca', id: pane, group: clean(env.ORCA_WORKTREE_ID) };
  return null;
}

export function cleanTerminal(t) {
  if (!t || typeof t !== 'object') return null;
  const host = clean(t.host);
  const id = clean(t.id);
  if (!host || !id) return null;
  return { host, id, group: clean(t.group) };
}

export const terminalKey = (t) => (t?.host && t?.id ? `${t.host}:${t.id}` : null);
