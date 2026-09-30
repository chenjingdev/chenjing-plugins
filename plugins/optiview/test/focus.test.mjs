import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCmuxState, createCmuxFocus } from '../plugin/lib/hosts/cmux.mjs';
import { createFocus } from '../plugin/lib/focus.mjs';
import { createSessions } from '../plugin/lib/sessions.mjs';
import { terminalOf } from '../plugin/lib/terminal.mjs';

const W1 = 'AAAA0000-0000-0000-0000-000000000001';
const W2 = 'AAAA0000-0000-0000-0000-000000000002';
const S1 = 'BBBB0000-0000-0000-0000-000000000001';
const S2 = 'BBBB0000-0000-0000-0000-000000000002';
const S3 = 'BBBB0000-0000-0000-0000-000000000003';
const SHELL = 'BBBB0000-0000-0000-0000-00000000000f';
const low = (s) => s.toLowerCase();
const ev = (name, extra = {}, payload = {}) => ({ boot_id: 'boot-1', name, workspace_id: null, surface_id: null, payload, ...extra });
const selected = (ws, title) => ev('workspace.selected', { workspace_id: ws }, { workspace_id: ws, custom_title: title, selected: true });
const focused = (ws, s, kind = 'terminal') => ev('surface.focused', { workspace_id: ws, surface_id: s }, { kind, surface_id: s, origin: 'bonsplit_selection' });
const keyed = (ws) => ev('window.keyed', {}, { workspace_id: ws, is_key_window: true });

test('cmux: 보이는 워크스페이스의 입력 칸, 브라우저는 무시, 워크스페이스별로 기억', () => {
  const st = createCmuxState();
  st.apply(selected(W1, '백엔드'));
  assert.deepEqual(st.current(), { group: low(W1), terminal: null, label: '백엔드' });
  st.apply(focused(W1, S1));
  assert.deepEqual(st.current(), { group: low(W1), terminal: { host: 'cmux', id: low(S1), group: low(W1) }, label: '백엔드' });
  st.apply(focused(W1, 'CCCC-browser', 'browser'));
  assert.equal(st.current().terminal.id, low(S1));
  st.apply(selected(W2, '문서'));
  assert.equal(st.current().terminal, null);
  st.apply(focused(W2, S2));
  st.apply(selected(W1, '백엔드'));
  assert.equal(st.current().terminal.id, low(S1));
  assert.equal(st.apply(keyed(W2)), 'keyed');
  assert.equal(st.current().terminal.id, low(S2));
  st.apply(ev('surface.closed', { workspace_id: W2, surface_id: S2 }, { surface_id: S2 }));
  assert.equal(st.current().terminal, null);
  st.apply({ ...selected(W1, '백엔드'), boot_id: 'boot-2' }); // cmux를 다시 켜면 새로 모은다
  assert.equal(st.current().terminal, null);
});

test('cmux: events.jsonl 끝부분으로 현재 상태를 복원하고, 새 줄을 따라 읽고, 창에 돌아오면 다시 알린다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-cmux-'));
  const file = path.join(dir, 'events.jsonl');
  const noise = JSON.stringify(ev('agent.hook.PreToolUse', {}, { note: 'x'.repeat(200) }));
  fs.writeFileSync(file, `${[selected(W1, '백엔드'), focused(W1, S1)].map((e) => JSON.stringify(e)).join('\n')}\n${noise}\n`);
  const seen = [];
  const host = createCmuxFocus({ file, pollMs: 50, onFocus: (v) => seen.push([v.terminal?.id, v.label]) });
  const wait = async (n) => { for (let i = 0; i < 60 && seen.length < n; i++) await new Promise((r) => setTimeout(r, 25)); };
  host.start();
  try {
    assert.deepEqual(seen, [[low(S1), '백엔드']]);
    fs.appendFileSync(file, `${JSON.stringify(focused(W1, S2))}\n`);
    await wait(2);
    assert.deepEqual(seen.at(-1), [low(S2), '백엔드']);
    fs.appendFileSync(file, `${JSON.stringify(keyed(W1))}\n`);
    await wait(3);
    assert.deepEqual(seen.at(-1), [low(S2), '백엔드']);
    fs.renameSync(file, `${file}.1`); // 16MiB에서 새 파일로 바뀐다
    fs.writeFileSync(file, `${JSON.stringify(focused(W1, S1))}\n`);
    await wait(4);
    assert.deepEqual(seen.at(-1), [low(S1), '백엔드']);
  } finally {
    host.close();
  }
});

test('터미널 식별: cmux·Orca 환경 변수, claude -p와 백그라운드 작업은 묶지 않는다', () => {
  assert.deepEqual(terminalOf({ CMUX_SURFACE_ID: S1, CMUX_WORKSPACE_ID: W1 }), { host: 'cmux', id: low(S1), group: low(W1) });
  assert.deepEqual(terminalOf({ ORCA_PANE_KEY: 'tab-7:CCCC0000-0000-0000-0000-000000000009', ORCA_WORKTREE_ID: 'wt-1' }), { host: 'orca', id: 'cccc0000-0000-0000-0000-000000000009', group: 'wt-1' });
  assert.equal(terminalOf({ CMUX_SURFACE_ID: S1, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), null);
  assert.equal(terminalOf({ ORCA_PANE_KEY: 'tab-7:leaf', CLAUDE_JOB_DIR: '/tmp/job' }), null);
  assert.equal(terminalOf({ TERM_PROGRAM: 'iTerm.app' }), null);
  assert.equal(terminalOf({ CMUX_SURFACE_ID: '$(rm -rf /)' }), null);
});

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-focus-'));
  const sessions = createSessions({ file: path.join(dir, 'sessions.json') });
  const focus = createFocus({ sessions });
  const cmux = (id, ws = W1) => ({ host: 'cmux', id: low(id), group: low(ws) });
  const seeCmux = (id, ws = W1, label = '백엔드') => focus.hostSeen({ host: 'cmux', group: low(ws), terminal: id ? cmux(id, ws) : null, label });
  const start = (sid, terminal) => { const s = sessions.touch(sid, { terminal, event: 'session-start' }); focus.sessionTouched(s, 'session-start'); return s; };
  const ask = (sid) => focus.sessionTouched(sessions.touch(sid, { event: 'prompt' }), 'prompt');
  const now = () => focus.snapshot();
  return { sessions, focus, cmux, seeCmux, start, ask, now };
}

test('포커스: 클릭한 칸의 세션, Claude 없는 칸이면 마지막 대화 유지, 고정과 따라가기', () => {
  const { focus, cmux, seeCmux, start, now } = world();
  start('sess-a', cmux(S1));
  start('sess-b', cmux(S2));
  seeCmux(S2);
  assert.equal(now().sessionId, 'sess-b');
  seeCmux(S1);
  assert.equal(now().sessionId, 'sess-a');
  seeCmux(SHELL);
  assert.deepEqual([now().sessionId, now().away], ['sess-a', true]);
  focus.pin('sess-b');
  seeCmux(S1);
  assert.deepEqual([now().sessionId, now().following], ['sess-b', false]);
  focus.follow();
  assert.deepEqual([now().sessionId, now().following, now().away], ['sess-a', true, false]);
});

test('포커스: 칸을 모르는 워크스페이스는 그 안의 Claude 세션을, 없으면 마지막 대화를 둔다', () => {
  const { cmux, seeCmux, start, now } = world();
  start('solo', cmux(S3, W2));
  start('sess-a', cmux(S1));
  seeCmux(S1);
  seeCmux(null, W2, '문서');
  assert.deepEqual([now().sessionId, now().label], ['solo', '문서']);
  seeCmux(null, 'AAAA0000-0000-0000-0000-0000000000ee', '빈 워크스페이스');
  assert.deepEqual([now().sessionId, now().away], ['solo', true]);
});

test('포커스: 보이는 워크스페이스에서 친 질문은 그 칸으로, 안 보이는 워크스페이스의 질문은 무시', () => {
  const { sessions, focus, cmux, seeCmux, start, now } = world();
  start('left', cmux(S1));
  start('right', cmux(S2));
  start('far', cmux(S3, W2));
  seeCmux(null); // W1이 보이지만 어느 분할인지 모른다
  focus.sessionTouched(sessions.touch('right', { event: 'prompt' }), 'prompt');
  assert.equal(now().sessionId, 'right');
  focus.sessionTouched(sessions.touch('far', { event: 'prompt' }), 'prompt'); // 자동화가 W2 칸에 보낸 질문
  assert.equal(now().sessionId, 'right');
  focus.sessionTouched(sessions.touch('left', { event: 'prompt' }), 'prompt');
  assert.equal(now().sessionId, 'left');
});

test('포커스: 같은 칸에서 /clear로 새 세션이 생기면 새 세션을 보인다', () => {
  const { cmux, seeCmux, start, now } = world();
  seeCmux(S1);
  start('sess-old', cmux(S1));
  assert.equal(now().sessionId, 'sess-old');
  start('sess-new', cmux(S1));
  assert.equal(now().sessionId, 'sess-new');
});

test('포커스: 연동이 없는 터미널은 마지막으로 질문한 세션을 따라간다', () => {
  const { start, ask, now } = world();
  start('plain-1', null);
  start('plain-2', null);
  assert.equal(now().sessionId, 'plain-1');
  ask('plain-2');
  assert.deepEqual([now().sessionId, now().source], ['plain-2', 'prompt']);
});
