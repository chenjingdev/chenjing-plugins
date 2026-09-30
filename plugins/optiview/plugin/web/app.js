// 읽기 창: 지금 포커스한 터미널의 대화를 한 턴씩 보인다. 입력은 받지 않는다(질문·선택은 터미널에서).
import { planAnswer, renderPlan, LIMITS } from './structure.js';
import { escapeHtml, inline } from './markdown.js';

const $ = (s) => document.querySelector(s);
const token = document.querySelector('meta[name="optiview-token"]').content;
const THEMES = ['terminal', 'auto', 'light', 'dark'];
const THEME_NAMES = { terminal: '터미널 색', auto: '시스템', light: '밝게', dark: '어둡게' };

const S = {
  focus: null,
  view: null, // { id, title, project, pages }
  viewId: null,
  cursor: null, // 보고 있는 턴 id. null이면 최신
  opened: new Map(), // 턴 id → Map(섹션 번호 → 열림)
  load: 0,
  connected: false,
  terminalColors: null,
};

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-optiview-token': token }, body: body === undefined ? undefined : JSON.stringify(body) });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error || String(r.status));
  return v;
}

const pages = () => S.view?.pages || [];

function index() {
  const all = pages();
  if (!all.length) return -1;
  if (S.cursor == null) return all.length - 1;
  const k = all.findIndex((p) => p.id === S.cursor);
  return k < 0 ? all.length - 1 : k;
}

async function loadView(id, { reset = false } = {}) {
  const ticket = ++S.load;
  if (!id) { S.view = null; S.viewId = null; render(true); return; }
  let v = null;
  try { v = await api('GET', `/api/sessions/${encodeURIComponent(id)}`); } catch { /* 세션이 사라졌을 수 있다 */ }
  if (ticket !== S.load) return;
  const same = S.viewId === id && !reset;
  const lastBefore = same ? pages().at(-1)?.id : null;
  S.viewId = id;
  S.view = v;
  // 세션을 바꾸거나 새 질문이 들어오면 최신 답으로 돌아간다
  const lastNow = pages().at(-1)?.id;
  const newTurn = same && lastBefore && lastNow !== lastBefore;
  if (!same || newTurn) S.cursor = null;
  render(!same || newTurn);
}

function applyFocus(f) {
  if (!f) return;
  S.focus = f;
  if (f.sessionId && f.sessionId !== S.viewId) loadView(f.sessionId, { reset: true });
  else renderChrome();
}

async function refreshState() {
  try {
    const st = await api('GET', '/api/state');
    applyFocus(st.focus);
    if (st.focus.sessionId && st.focus.sessionId === S.viewId) loadView(S.viewId);
  } catch { /* 다음 이벤트 때 다시 */ }
}

// ---------- 그리기 ----------

function render(scrollTop = false) {
  renderChrome();
  renderPage();
  if (scrollTop) $('#main').scrollTop = 0;
}

function renderChrome() {
  const f = S.focus || {};
  const v = S.view;
  $('#title').textContent = v ? (v.title || v.project || '세션') : 'OptiView';
  const sub = [];
  if (v?.project && v.title) sub.push(v.project);
  if (f.label && f.following && f.label !== v?.project) sub.push(f.label);
  if (!f.following) sub.push('고정됨');
  if (!S.connected) sub.push('서버 연결 중');
  $('#sub').textContent = sub.join(' · ');
  const dot = $('#dot');
  dot.dataset.state = !S.connected ? 'off' : !f.following ? 'pinned' : f.live?.length ? 'live' : 'prompt';
  dot.title = !f.following ? '고정됨: 포커스를 따라가지 않습니다' : f.live?.length ? `터미널 포커스를 따라갑니다 (${f.live.join(', ')})` : '마지막으로 질문한 세션을 따라갑니다';
  $('#follow').hidden = f.following !== false;
  const note = $('#note');
  note.hidden = !(f.away && f.following);
  note.textContent = 'Claude가 없는 칸을 보고 있어요 · 마지막 대화를 그대로 둡니다';
  renderNav();
}

function renderNav() {
  const all = pages();
  const k = index();
  $('#prev').disabled = k <= 0;
  $('#next').disabled = k < 0 || k >= all.length - 1;
  $('#pos').textContent = all.length ? `${k + 1} / ${all.length}` : '';
  $('#latest').hidden = k < 0 || all.length - 1 - k < 5;
  $('#copy').hidden = !(all[k]?.answer);
  $('#nav').hidden = !all.length;
}

function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}분 ${s % 60}초` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

function clock(t) {
  if (!t) return '';
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  return today ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function promptHtml(p) {
  if (p.kind === 'command') return `<span class="cmd">${escapeHtml(p.prompt)}</span>`;
  if (p.kind === 'notification') return `<span class="noti">작업 알림</span> ${inline(p.prompt)}`;
  return inline(p.prompt);
}

function renderPage() {
  const el = $('#page');
  const all = pages();
  const k = index();
  const p = all[k];
  if (!S.view) {
    el.innerHTML = `<div class="empty"><p>${S.focus?.sessionId ? '대화를 불러오는 중…' : 'Claude Code 세션을 시작하면 여기에 답이 보입니다.'}</p></div>`;
    return;
  }
  if (!p) {
    el.innerHTML = '<div class="empty"><p>이 세션에서 질문하면 답이 여기에 보입니다.</p></div>';
    return;
  }
  const extra = p.extra.length ? `<div class="extra">${p.extra.map((t) => `<p><span class="tag">작업 중 추가</span> ${inline(t)}</p>`).join('')}</div>` : '';
  let status = '';
  if (p.status === 'running') {
    // 시계가 어긋났거나 아주 오래된 턴이면 경과 대신 시작 시각을 보인다
    const since = Date.now() - p.startedAt;
    const when = since >= 0 && since < 6 * 3600000 ? `<span id="elapsed" data-since="${p.startedAt}">${elapsed(since)}</span>` : `${clock(p.startedAt)}부터`;
    status = `<div class="status running"><span class="spin" aria-hidden="true"></span><span>작업 중 · ${when}</span></div>`;
  }
  else if (p.status === 'interrupted') status = '<div class="status stop">중단됨</div>';
  else if (p.status === 'error') status = '<div class="status err">오류로 끝남</div>';
  let answer = '';
  if (p.answer) {
    const plan = planAnswer(p.answer);
    answer = `<article class="answer${p.status === 'running' ? ' partial' : ''}">${renderPlan(plan, S.opened.get(p.id))}</article>`;
  } else if (p.status !== 'running') {
    answer = '<p class="muted">글로 된 답이 없습니다.</p>';
  }
  const meta = p.status !== 'running' && p.endedAt ? `<div class="meta">${clock(p.endedAt)}${p.durationMs ? ` · ${elapsed(p.durationMs)}` : ''}${p.tools ? ` · 도구 ${p.tools}회` : ''}</div>` : '';
  el.innerHTML = `<div class="prompt" data-kind="${p.kind}"><div class="prompt-text">${promptHtml(p)}</div><button class="more" hidden>더 보기</button></div>${extra}${status}${answer}${meta}`;
  const pt = el.querySelector('.prompt-text');
  const more = el.querySelector('.prompt .more');
  if (pt.scrollHeight > pt.clientHeight + 2) {
    more.hidden = false;
    more.onclick = () => { pt.classList.toggle('full'); more.textContent = pt.classList.contains('full') ? '접기' : '더 보기'; };
  }
  // 긴 코드는 앞부분만 보이고 펼칠 수 있게 한다
  for (const pre of el.querySelectorAll('pre.code')) {
    const n = pre.textContent.split('\n').length;
    if (n <= LIMITS.codeLines) continue;
    pre.classList.add('clamp');
    const btn = document.createElement('button');
    btn.className = 'unclamp';
    btn.textContent = `코드 ${n}줄 모두 보기`;
    btn.onclick = () => { pre.classList.remove('clamp'); btn.remove(); };
    pre.after(btn);
  }
  for (const d of el.querySelectorAll('details.sec')) {
    d.addEventListener('toggle', () => {
      if (!S.opened.has(p.id)) S.opened.set(p.id, new Map());
      S.opened.get(p.id).set(Number(d.dataset.sec), d.open);
    });
  }
}

setInterval(() => {
  const e = document.getElementById('elapsed');
  if (e) e.textContent = elapsed(Date.now() - Number(e.dataset.since));
}, 1000);

// ---------- 조작 ----------

function go(delta) {
  const all = pages();
  const k = index();
  if (k < 0) return;
  const next = Math.max(0, Math.min(all.length - 1, k + delta));
  if (next === k) return;
  S.cursor = next === all.length - 1 ? null : all[next].id;
  render(true);
}

function latest() {
  S.cursor = null;
  render(true);
}

$('#prev').addEventListener('click', () => go(-1));
$('#next').addEventListener('click', () => go(1));
$('#latest').addEventListener('click', latest);
$('#follow').addEventListener('click', () => api('POST', '/api/focus', { follow: true }).then(applyFocus).catch(() => {}));
$('#copy').addEventListener('click', async () => {
  const p = pages()[index()];
  if (!p?.answer) return;
  try { await navigator.clipboard.writeText(p.answer); } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: p.answer });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  const b = $('#copy');
  b.textContent = '복사함';
  setTimeout(() => { b.textContent = '복사'; }, 1200);
});

document.addEventListener('keydown', (e) => {
  if (!$('#menu').hidden) { if (e.key === 'Escape') closeMenu(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input,textarea,select,[contenteditable]')) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  else if (e.key === 'End') { e.preventDefault(); latest(); }
});

// 세션 고르기(고르면 고정된다)
async function openMenu() {
  const list = $('#menu-list');
  list.innerHTML = '<p class="muted pad">불러오는 중…</p>';
  $('#menu').hidden = false;
  $('#who').setAttribute('aria-expanded', 'true');
  let st;
  try { st = await api('GET', '/api/state'); } catch { list.innerHTML = '<p class="muted pad">서버에 연결하지 못했습니다.</p>'; return; }
  const rows = [];
  if (!st.focus.following) rows.push('<button class="row follow-row" data-follow="1"><span class="row-title">터미널 포커스 따라가기</span></button>');
  for (const s of st.sessions.slice(0, 30)) {
    const cur = s.id === S.viewId ? ' current' : '';
    const running = s.status === 'running' ? '<span class="live-dot" title="작업 중"></span>' : '';
    const sub = [s.project, clock(s.lastActiveAt), s.ended ? '끝남' : ''].filter(Boolean).join(' · ');
    rows.push(`<button class="row${cur}" data-id="${escapeHtml(s.id)}" role="option"><span class="row-title">${running}${escapeHtml(s.title || s.project || s.id)}</span><span class="row-sub">${escapeHtml(sub)}</span></button>`);
  }
  list.innerHTML = rows.join('') || '<p class="muted pad">아직 세션이 없습니다.</p>';
}

function closeMenu() {
  $('#menu').hidden = true;
  $('#who').setAttribute('aria-expanded', 'false');
}

$('#who').addEventListener('click', () => ($('#menu').hidden ? openMenu() : closeMenu()));
$('#menu-list').addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  closeMenu();
  const body = row.dataset.follow ? { follow: true } : { sessionId: row.dataset.id };
  api('POST', '/api/focus', body).then(applyFocus).catch(() => {});
});
document.addEventListener('click', (e) => {
  if (!$('#menu').hidden && !e.target.closest('#menu') && !e.target.closest('#who')) closeMenu();
});

// ---------- 테마 ----------

function storedTheme() {
  try { return localStorage.getItem('optiview.theme'); } catch { return null; }
}

function applyTheme(name) {
  const root = document.documentElement;
  const t = name === 'terminal' && !S.terminalColors ? 'auto' : name;
  root.dataset.theme = t;
  if (t === 'terminal') {
    const { background, foreground } = S.terminalColors;
    root.style.setProperty('--term-bg', background);
    root.style.setProperty('--term-fg', foreground);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16) / 255);
    root.dataset.tone = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 'light' : 'dark';
  }
  $('#theme').textContent = `테마: ${THEME_NAMES[t]}`;
}

$('#theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme;
  const options = THEMES.filter((t) => t !== 'terminal' || S.terminalColors);
  const next = options[(options.indexOf(cur) + 1) % options.length];
  try { localStorage.setItem('optiview.theme', next); } catch { /* 저장 못 해도 이번엔 바뀐다 */ }
  applyTheme(next);
});

api('GET', '/api/theme').then((t) => { S.terminalColors = t.terminal; applyTheme(storedTheme() || 'terminal'); }).catch(() => applyTheme(storedTheme() || 'auto'));

// ---------- 연결 ----------

function connect() {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  es.addEventListener('hello', () => { S.connected = true; refreshState(); });
  es.addEventListener('state', (e) => { try { applyFocus(JSON.parse(e.data).focus); } catch { /* 다음 이벤트 */ } });
  es.addEventListener('session', (e) => {
    try { if (JSON.parse(e.data).id === S.viewId) loadView(S.viewId); } catch { /* 다음 이벤트 */ }
  });
  es.onerror = () => { S.connected = false; renderChrome(); };
}

render(true);
connect();
