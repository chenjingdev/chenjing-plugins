#!/usr/bin/env node
// 행동 시험 결과판. out/runs/*.json 판을 읽어 서버 없이 브라우저에서 열리는 페이지 하나(out/board.html)를 만든다.
//   node tests/behavior/board.mjs [out-dir]     # 결과판만 다시 만들고 경로를 출력한다
// 시험(run.mjs)이 끝나면 자동으로 만들어진다. 쌓인 판이 아직 없으면 out/에 남은 옛 기록을 첫 판으로 가져온 뒤 만든다.
//
// 통과율·기준·가르지 못함·오르내림은 HTML 밖의 순수 함수(tally, buildViews)가 계산하고, 페이지는 그 결과를 그리기만 한다.
// 통과한 회차의 대화는 판에 없고 out/<장면>/<변형>-<n>.jsonl(가장 최근 실행)에 있으므로, 결과판을 만들 때 읽어 넣는다.
import { writeFileSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRounds, importLegacy, readRecord, compactConversation, defaultOutDir } from './runs.mjs';

const VARIANTS = ['pact', 'control'];

// ---- 계산(순수 함수) ----

// 유효 회차의 80%를 올린 값. 정수로 계산해 부동소수 오차를 피한다.
export const threshold = (valid) => Math.ceil((valid * 4) / 5);

// 검사를 순서가 아니라 종류와 인자로 알아본다.
export function checkKey(check) {
  const { kind, ...rest } = check;
  return JSON.stringify([kind, Object.keys(rest).sort().map((k) => [k, rest[k]])]);
}

// 한 장면 안에서 종류와 인자가 같은 검사가 둘이면 두 번째부터 #2, #3을 붙인다.
function keysOf(checks) {
  const seen = new Map();
  return checks.map((c) => {
    const k = checkKey(c);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : `${k}#${n}`;
  });
}

export const describeCheck = (c) => [c.kind, ...Object.entries(c).filter(([k]) => k !== 'kind').map(([k, v]) => `${k}=${v}`)].join(' ');

const ABSENT = { ran: false, valid: 0, passed: 0, failed: 0, limited: 0, undecidable: 0, short: false, red: false, delta: null };

// 판 하나에서 (장면, 변형, 검사) 칸의 통과율. 한도 회차와 판정 불가(pass:null)는 통과율에서 뺀다.
export function tally(round, scenario, variant, key) {
  const checks = round.defs?.[scenario]?.checks;
  const idx = checks ? keysOf(checks).indexOf(key) : -1;
  const attempts = round.attempts.filter((a) => a.scenario === scenario && a.variant === variant);
  if (idx < 0 || !attempts.length) return { ...ABSENT };
  let passed = 0;
  let failed = 0;
  let limited = 0;
  let undecidable = 0;
  for (const a of attempts) {
    const r = a.limited ? null : a.results[idx];
    if (a.limited) limited++;
    else if (!r || r.pass === null) undecidable++;
    else if (r.pass) passed++;
    else failed++;
  }
  const valid = passed + failed;
  const short = valid > 0 && passed < threshold(valid);
  return { ran: true, valid, passed, failed, limited, undecidable, short, red: short && variant === 'pact', delta: null };
}

function deltaOf(now, prev, prevId) {
  const a = now.passed * prev.valid;
  const b = prev.passed * now.valid;
  const dir = a > b ? 'up' : a < b ? 'down' : 'same';
  const sameSize = now.valid === prev.valid;
  const amount = sameSize ? Math.abs(now.passed - prev.passed) : Math.round(Math.abs((100 * now.passed) / now.valid - (100 * prev.passed) / prev.valid));
  return { prevId, prevPassed: prev.passed, prevValid: prev.valid, dir, amount, pct: !sameSize };
}

// 모든 판(시각 오름차순)에 대해, 결과판 표를 그릴 계산 결과를 만든다.
export function buildViews(rounds) {
  const names = [...new Set(rounds.flatMap((r) => Object.keys(r.defs ?? {})))].sort();
  const latestDef = (name) => [...rounds].reverse().find((r) => r.defs?.[name])?.defs[name];
  return rounds.map((round, i) => {
    const earlier = rounds.slice(0, i).reverse();
    const earlierCell = (scenario, variant, key) => {
      for (const r of earlier) {
        const c = tally(r, scenario, variant, key);
        if (c.ran && c.valid > 0) return { id: r.id, cell: c };
      }
      return null;
    };
    const rows = [];
    for (const name of names) {
      const inRound = Boolean(round.defs?.[name]);
      const def = round.defs?.[name] ?? latestDef(name);
      const keys = keysOf(def.checks);
      def.checks.forEach((check, j) => {
        const key = keys[j];
        const cells = {};
        for (const v of VARIANTS) {
          const c = inRound ? tally(round, name, v, key) : { ...ABSENT };
          if (c.ran && c.valid > 0) {
            const prev = earlierCell(name, v, key);
            if (prev) c.delta = deltaOf(c, prev.cell, prev.id);
          }
          cells[v] = c;
        }
        // 가르지 못함: 대조군도 기준 이상. 이 판에 대조군이 없으면 가장 최근 대조군 판의 값을 쓴다.
        let control = null;
        if (inRound) {
          const own = cells.control;
          if (own.ran && own.valid > 0) control = { from: null, passed: own.passed, valid: own.valid, noSplit: !own.short };
          else {
            const prev = earlierCell(name, 'control', key);
            if (prev) control = { from: prev.id, passed: prev.cell.passed, valid: prev.cell.valid, noSplit: !prev.cell.short };
          }
        }
        rows.push({ scenario: name, scene: def.scene, inRound, checkKey: key, checkIdx: inRound ? j : -1, checkLabel: describeCheck(check), cells, control });
      });
    }
    // 지침 바뀜: 직전에 pact를 돌린 판과 pact 지침 지문이 다르면. 어느 한쪽이 모르면 말하지 않는다.
    let guidelinesChanged = null;
    if (round.variants.includes('pact')) {
      const prevPact = earlier.find((r) => r.variants.includes('pact'));
      const [now, before] = [round.pact?.fingerprint ?? null, prevPact?.pact?.fingerprint ?? null];
      if (now && before) guidelinesChanged = now !== before;
    }
    return { id: round.id, guidelinesChanged, rows };
  });
}

// ---- 페이지에서도 쓰는 순수 함수(문자열로 페이지에 그대로 넣는다. 바깥 이름을 쓰지 말 것) ----

// 칸에 쓸 글자: 4/5, ▲1, 한도 1, 불가 2
export function cellText(c) {
  const notes = [];
  if (c.limited) notes.push('한도 ' + c.limited);
  if (c.undecidable) notes.push('불가 ' + c.undecidable);
  let delta = null;
  if (c.delta) delta = (c.delta.dir === 'up' ? '▲' : c.delta.dir === 'down' ? '▼' : '±') + c.delta.amount + (c.delta.pct && c.delta.dir !== 'same' ? '%p' : '');
  return { score: c.passed + '/' + c.valid, delta, deltaDir: c.delta ? c.delta.dir : null, notes, red: Boolean(c.red) };
}

// text 안에서 needles가 처음 나오는 자리를 겹치지 않게 묶어, 강조할 조각과 아닌 조각으로 나눈다.
export function markSegments(text, needles) {
  const ranges = [];
  for (const needle of needles) {
    if (!needle) continue;
    const i = text.indexOf(needle);
    if (i >= 0) ranges.push([i, i + needle.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const segs = [];
  let pos = 0;
  for (const [s, e] of merged) {
    if (s > pos) segs.push({ text: text.slice(pos, s), mark: false });
    segs.push({ text: text.slice(s, e), mark: true });
    pos = e;
  }
  if (pos < text.length) segs.push({ text: text.slice(pos), mark: false });
  return segs;
}

// 걸린 문장들을 그 문장이 처음 나오는 글(texts) 쪽에 배정한다. 어느 글에서도 못 찾은 문장은 missing.
export function placeMatches(texts, needles) {
  const perText = texts.map(() => []);
  const missing = [];
  for (const needle of needles) {
    const i = texts.findIndex((t) => t.includes(needle));
    if (i >= 0) perText[i].push(needle);
    else missing.push(needle);
  }
  return { perText, missing };
}

// ---- 데이터 모으기 ----

const clipTo = (s, n) => (s.length > n ? `${s.slice(0, n)}…(+${s.length - n}자 생략)` : s);
const MAX_TOOL_INPUT = 600;
const MAX_TOOL_RESULT = 500;
const MAX_USER_TEXT = 800;

// 말풍선에 필요한 것만 남긴다. 답과 생각은 그대로, 도구 호출·결과와 사용자 글(스킬 본문)은 앞부분만.
export function slimConversation(items) {
  const names = new Map(items.filter((i) => i.type === 'tool_use').map((i) => [i.id, i.name]));
  return items.map((i) => {
    switch (i.type) {
      case 'tool_use':
        return { turn: i.turn, type: i.type, name: i.name, text: clipTo(JSON.stringify(i.input ?? {}), MAX_TOOL_INPUT) };
      case 'tool_result':
        return { turn: i.turn, type: i.type, name: names.get(i.toolUseId) ?? '', text: clipTo(i.text ?? '', MAX_TOOL_RESULT), isError: Boolean(i.isError) };
      case 'user_text':
        return { turn: i.turn, type: i.type, text: clipTo(i.text ?? '', MAX_USER_TEXT) };
      case 'result':
        return { turn: i.turn, type: i.type, subtype: i.subtype, text: i.text ?? '' };
      default:
        return { turn: i.turn, type: i.type, text: i.text ?? '' };
    }
  });
}

// 통과한 회차의 대화는 판에 없다. out/<장면>/<변형>-<n>.jsonl은 (장면, 변형, n)의 가장 최근 실행만 담으므로,
// 그 회차를 가장 마지막으로 담은 판에서, 한도가 아니고 지문이 같을 때만 읽어 넣는다.
function conversationFromLog(outDir, a) {
  const file = path.join(outDir, a.scenario, `${a.variant}-${a.n}.jsonl`);
  if (!existsSync(file)) return null;
  try {
    const { meta, transcript } = readRecord(file);
    // 지문이 없는 옛 기록은 지문이 없는 jsonl과만 짝이다(새 시험이 덮어썼다면 jsonl에 지문이 있다).
    return (meta.fingerprint ?? null) === (a.fingerprint ?? null) ? compactConversation(transcript) : null;
  } catch {
    return null;
  }
}

export function collectBoard(outDir) {
  const rounds = listRounds(outDir);
  const lastRoundOf = new Map();
  rounds.forEach((r, i) => r.attempts.forEach((a) => lastRoundOf.set(`${a.scenario}/${a.variant}/${a.n}`, i)));
  const views = buildViews(rounds);
  return {
    rounds: rounds.map((r, i) => ({
      id: r.id,
      at: r.at,
      kind: r.kind,
      label: r.label ?? null,
      scenarios: r.scenarios,
      variants: r.variants,
      runs: r.runs,
      guidelinesChanged: views[i].guidelinesChanged,
      view: { rows: views[i].rows },
      defs: Object.fromEntries(Object.entries(r.defs).map(([name, d]) => [name, { scene: d.scene, turns: d.turns, checks: d.checks }])),
      attempts: r.attempts.map((a) => {
        let conversation = a.conversation;
        if (!conversation && !a.limited && lastRoundOf.get(`${a.scenario}/${a.variant}/${a.n}`) === i) conversation = conversationFromLog(outDir, a);
        return {
          scenario: a.scenario,
          variant: a.variant,
          n: a.n,
          limited: a.limited,
          reused: a.reused,
          results: a.results,
          conversation: conversation ? slimConversation(conversation) : null,
        };
      }),
    })),
  };
}

// ---- 페이지 ----

const CSS = String.raw`
:root {
  --bg: #f6f7f9; --panel: #ffffff; --text: #1d2330; --muted: #667085; --line: #d9dee7;
  --red-bg: #fde8e8; --red-line: #d92d20; --red-text: #a1170d;
  --green: #067647; --up: #067647; --down: #b42318;
  --accent: #2459d8; --accent-bg: #e6edfc;
  --mark: #ffe28a; --user-bg: #2459d8; --user-text: #ffffff; --bot-bg: #eef1f6; --fold-bg: #f4f5f8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #12151b; --panel: #1b1f27; --text: #e6e9ef; --muted: #9aa3b2; --line: #2d3340;
    --red-bg: #43191a; --red-line: #f97066; --red-text: #fda29b;
    --green: #47cd89; --up: #47cd89; --down: #f97066;
    --accent: #7ba3ff; --accent-bg: #1f2c4d;
    --mark: #7a5b00; --user-bg: #2f5fd0; --user-text: #ffffff; --bot-bg: #272c37; --fold-bg: #222733;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif; }
header { padding: 14px 16px 10px; border-bottom: 1px solid var(--line); background: var(--panel); }
h1 { font-size: 17px; margin: 0 0 8px; }
.picker { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; }
.picker label { color: var(--muted); }
select { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; max-width: 100%; }
.roundinfo { margin-top: 6px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 4px 12px; }
.badge { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; font-size: 12px; white-space: nowrap; }
.badge.changed { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }
.badge.split { border-color: var(--muted); color: var(--muted); }
.layout { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 14px; padding: 14px 16px 40px; align-items: start; }
@media (max-width: 900px) { .layout { grid-template-columns: minmax(0, 1fr); } }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
.tablewrap { overflow-x: auto; }
table.grid { border-collapse: collapse; width: 100%; }
.grid th, .grid td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
.grid thead th { color: var(--muted); font-weight: 600; font-size: 12px; position: sticky; top: 0; background: var(--panel); }
.grid td.cell, .grid thead th { white-space: nowrap; }
.grid th.scene { width: 22%; font-weight: 600; background: var(--panel); border-right: 1px solid var(--line); }
.grid th.scene small { display: block; color: var(--muted); font-weight: 400; }
.grid td.check { word-break: break-word; }
.grid td.check code { font-size: 12px; }
.grid tr.absent { opacity: .45; }
.grid tr.groupstart td, .grid tr.groupstart th { border-top: 2px solid var(--line); }
.dim { color: var(--muted); font-size: 12px; }
.cellbtn { font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 8px; padding: 3px 8px; cursor: pointer; display: inline-flex; flex-wrap: nowrap; gap: 2px 8px; align-items: baseline; text-align: left; }
.cellbtn:hover { border-color: var(--accent); }
.cellbtn.sel { outline: 2px solid var(--accent); outline-offset: 1px; }
.cellbtn.red { background: var(--red-bg); border-color: var(--red-line); color: var(--red-text); }
.score { font-weight: 700; font-variant-numeric: tabular-nums; }
.delta { font-size: 12px; font-variant-numeric: tabular-nums; }
.delta.up { color: var(--up); } .delta.down { color: var(--down); } .delta.same { color: var(--muted); }
.note { font-size: 12px; color: var(--muted); border: 1px dashed var(--line); border-radius: 4px; padding: 0 4px; }
.flag { font-size: 12px; font-weight: 700; }
#panel { padding: 12px 14px 16px; position: sticky; top: 8px; max-height: calc(100vh - 16px); overflow-y: auto; }
@media (max-width: 900px) { #panel { position: static; max-height: none; } }
#panel h2 { font-size: 15px; margin: 0 0 2px; }
#panel .sub { color: var(--muted); margin: 0 0 8px; }
.hint, .empty { color: var(--muted); }
.okline { color: var(--green); font-weight: 600; margin: 6px 0; }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.tab { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; cursor: pointer; }
.tab[aria-selected="true"] { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); font-weight: 600; }
.tab.fail { border-color: var(--red-line); }
.reason { margin: 8px 0; padding: 6px 10px; border-left: 4px solid var(--line); background: var(--fold-bg); border-radius: 4px; }
.reason.bad { border-left-color: var(--red-line); color: var(--red-text); }
.reason.good { border-left-color: var(--green); }
.convo { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.line { display: flex; }
.line.user { justify-content: flex-end; }
.bubble { max-width: 88%; border-radius: 14px; padding: 8px 12px; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
.line.user .bubble { background: var(--user-bg); color: var(--user-text); border-bottom-right-radius: 4px; }
.line.bot .bubble { background: var(--bot-bg); border-bottom-left-radius: 4px; }
.turnmark { align-self: center; color: var(--muted); font-size: 12px; }
mark { background: var(--mark); color: inherit; border-radius: 3px; padding: 0 1px; }
details.fold { max-width: 88%; background: var(--fold-bg); border: 1px solid var(--line); border-radius: 8px; padding: 2px 10px; font-size: 13px; }
details.fold.right { align-self: flex-end; }
details.fold summary { cursor: pointer; color: var(--muted); }
details.fold pre { margin: 6px 0; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
details.fold.err summary { color: var(--red-text); }
.missing { font-size: 13px; color: var(--muted); border: 1px dashed var(--line); border-radius: 8px; padding: 4px 10px; }
.missing q { color: var(--text); background: var(--mark); }
`;

// 페이지 스크립트. 사용자 글은 textContent로만 넣는다(innerHTML을 쓰지 않는다). 백틱과 ${ 를 쓰지 말 것.
const PAGE_JS = String.raw`
'use strict';
const DATA = JSON.parse(document.getElementById('data').textContent);
const KIND_NAME = { legacy: '이전 기록 모음', rejudge: '다시 판정', new: '' };
const VARIANT_NAME = { pact: 'pact', control: '대조군' };
const state = { roundId: null, sel: null, n: null };
const $ = (s) => document.querySelector(s);

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) e.append(kid);
  return e;
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
const roundById = (id) => DATA.rounds.find((r) => r.id === id);
const current = () => roundById(state.roundId);

function roundTitle(r) {
  const parts = [fmtTime(r.at)];
  if (r.label || KIND_NAME[r.kind]) parts.push(r.label || KIND_NAME[r.kind]);
  if (r.guidelinesChanged) parts.push('지침 바뀜');
  parts.push(r.variants.map((v) => VARIANT_NAME[v] || v).join('+') + ' · 장면 ' + r.scenarios.length);
  return parts.join(' · ');
}

function renderPicker() {
  const sel = $('#round');
  sel.replaceChildren(...DATA.rounds.slice().reverse().map((r, i) => h('option', { value: r.id }, roundTitle(r) + (i === 0 ? ' (최근)' : ''))));
  sel.value = state.roundId;
  const r = current();
  $('#info').replaceChildren(
    ...[
      h('span', null, '시각 ' + fmtTime(r.at)),
      (r.label || KIND_NAME[r.kind]) && h('span', { class: 'badge' }, r.label || KIND_NAME[r.kind]),
      r.guidelinesChanged && h('span', { class: 'badge changed', title: '직전에 pact를 돌린 판과 pact 지침(skills, agents)이 다릅니다' }, '지침 바뀜'),
      h('span', null, '돌린 변형: ' + r.variants.map((v) => VARIANT_NAME[v] || v).join(', ')),
      h('span', null, '장면 ' + r.scenarios.length + '개 · 계획 회차 ' + r.runs),
    ].filter(Boolean),
  );
}

function cellNode(round, row, variant) {
  const c = row.cells[variant];
  if (!c.ran) return h('td', { class: 'cell' }, h('span', { class: 'dim' }, '이 판에 없음'));
  const t = cellText(c);
  const on = state.sel && state.sel.scenario === row.scenario && state.sel.key === row.checkKey && state.sel.variant === variant;
  const prev = c.delta ? '직전 판(' + fmtTime(roundById(c.delta.prevId).at) + ') ' + c.delta.prevPassed + '/' + c.delta.prevValid : '비교할 직전 판 없음';
  const btn = h(
    'button',
    { type: 'button', class: 'cellbtn' + (c.red ? ' red' : '') + (on ? ' sel' : ''), 'aria-pressed': on ? 'true' : 'false', title: prev, onclick: () => select(row.scenario, variant, row.checkKey) },
    h('span', { class: 'score' }, t.score),
    t.delta && h('span', { class: 'delta ' + t.deltaDir }, t.delta),
    t.notes.map((n) => h('span', { class: 'note' }, n)),
    t.red && h('span', { class: 'flag' }, '✗ 미달'),
  );
  return h('td', { class: 'cell' }, btn);
}

function checkNode(row) {
  const out = [h('code', null, row.checkLabel)];
  if (row.control && row.control.noSplit) {
    const where = row.control.from ? ', ' + fmtTime(roundById(row.control.from).at) + ' 판 값' : '';
    out.push(' ', h('span', { class: 'badge split', title: '대조군도 기준 이상이라 이 검사는 지침이 있는지 없는지를 가르지 못합니다' }, '가르지 못함'));
    out.push(h('div', { class: 'dim' }, '대조군 ' + row.control.passed + '/' + row.control.valid + where));
  } else if (row.control && row.control.from) {
    out.push(h('div', { class: 'dim' }, '대조군 ' + row.control.passed + '/' + row.control.valid + ', ' + fmtTime(roundById(row.control.from).at) + ' 판 값'));
  }
  return h('td', { class: 'check' }, out);
}

function renderTable() {
  const round = current();
  const rows = round.view.rows;
  const body = h('tbody');
  const counts = new Map();
  rows.forEach((r) => counts.set(r.scenario, (counts.get(r.scenario) || 0) + 1));
  let last = null;
  for (const row of rows) {
    const first = row.scenario !== last;
    last = row.scenario;
    const tr = h('tr', { class: (row.inRound ? '' : 'absent') + (first ? ' groupstart' : '') });
    if (first) tr.append(h('th', { class: 'scene', scope: 'rowgroup', rowspan: counts.get(row.scenario) }, row.scene, h('small', null, row.scenario)));
    tr.append(checkNode(row), cellNode(round, row, 'pact'), cellNode(round, row, 'control'));
    body.append(tr);
  }
  const head = h('thead', null, h('tr', null, h('th', null, '장면'), h('th', null, '검사'), h('th', null, 'pact'), h('th', null, '대조군')));
  $('#grid').replaceChildren(h('table', { class: 'grid' }, head, body));
}

function select(scenario, variant, key) {
  state.sel = { scenario, variant, key };
  state.n = null;
  renderTable();
  renderPanel();
}

function statusOf(a, r) {
  if (a.limited) return 'limit';
  if (!r || r.pass === null) return 'unk';
  return r.pass ? 'pass' : 'fail';
}
const STATUS_MARK = { limit: '한도', unk: '불가', pass: '✓', fail: '✗' };

function renderPanel() {
  const box = $('#panel');
  const round = current();
  const sel = state.sel;
  const row = sel && round.view.rows.find((r) => r.scenario === sel.scenario && r.checkKey === sel.key);
  if (!row || !row.cells[sel.variant].ran) {
    state.sel = null;
    box.replaceChildren(h('p', { class: 'hint' }, '표의 칸을 누르면 그 검사에 실패한 회차와 대화를 볼 수 있습니다.'));
    return;
  }
  const cell = row.cells[sel.variant];
  const t = cellText(cell);
  const infos = round.attempts
    .filter((a) => a.scenario === sel.scenario && a.variant === sel.variant)
    .sort((x, y) => x.n - y.n)
    .map((a) => {
      const r = a.limited ? null : a.results[row.checkIdx];
      return { a, r, status: statusOf(a, r) };
    });
  const failing = infos.filter((i) => i.status === 'fail');
  const order = failing.concat(infos.filter((i) => i.status !== 'fail'));
  if (state.n == null || !order.some((i) => i.a.n === state.n)) state.n = order[0].a.n;
  const chosen = order.find((i) => i.a.n === state.n);
  const kids = [
    h('h2', null, row.scene + ' · ' + VARIANT_NAME[sel.variant]),
    h('p', { class: 'sub' }, h('code', null, row.checkLabel), ' — ' + t.score + (t.notes.length ? ' (' + t.notes.join(', ') + ')' : '')),
    failing.length ? h('p', { class: 'okline', style: 'color:var(--red-text)' }, '실패한 회차 ' + failing.length + '개') : h('p', { class: 'okline' }, '실패 없음 — 회차를 골라 대화를 볼 수 있습니다'),
    h(
      'div',
      { class: 'tabs', role: 'tablist' },
      order.map((i) =>
        h('button', { type: 'button', role: 'tab', class: 'tab ' + i.status, 'aria-selected': i.a.n === state.n ? 'true' : 'false', onclick: () => { state.n = i.a.n; renderPanel(); } }, '#' + i.a.n + ' ' + STATUS_MARK[i.status]),
      ),
    ),
    conversationNode(round, sel.scenario, chosen),
  ];
  box.replaceChildren(...kids);
}

function fold(summary, text, cls) {
  return h('details', { class: 'fold ' + (cls || '') }, h('summary', null, summary), h('pre', null, text));
}

function conversationNode(round, scenario, info) {
  const { a, r, status } = info;
  const wrap = h('div', { class: 'convo' });
  const lead = [];
  if (r) lead.push(h('div', { class: 'reason ' + (status === 'fail' ? 'bad' : status === 'pass' ? 'good' : '') }, STATUS_MARK[status] + ' ' + r.reason));
  if (a.limited) lead.push(h('p', { class: 'empty' }, '사용 한도로 돌리지 못한 회차라 대화가 없습니다.'));
  else if (!a.conversation) lead.push(h('p', { class: 'empty' }, '이 회차의 대화는 남아 있지 않습니다. 통과한 회차의 대화는 마지막 판에만 남습니다.'));
  if (!a.conversation) return h('div', null, lead);
  const turns = round.defs[scenario].turns;
  const nTurns = Math.max(1, ...a.conversation.map((c) => c.turn + 1));
  const needles = r && r.pass === false ? r.match : [];
  for (let t = 0; t < nTurns; t++) {
    if (turns[t] != null) wrap.append(h('div', { class: 'line user' }, h('div', { class: 'bubble' }, turns[t])));
    const items = a.conversation.filter((c) => c.turn === t);
    const placed = placeMatches(items.filter((c) => c.type === 'text').map((c) => c.text), needles.filter((m) => m.turn === t).map((m) => m.text));
    let ti = 0;
    for (const c of items) {
      if (c.type === 'text') {
        const segs = markSegments(c.text, placed.perText[ti++]);
        wrap.append(h('div', { class: 'line bot' }, h('div', { class: 'bubble' }, segs.map((s) => (s.mark ? h('mark', null, s.text) : s.text)))));
      } else if (c.type === 'thinking') wrap.append(fold('생각', c.text));
      else if (c.type === 'tool_use') wrap.append(fold('도구 호출: ' + c.name, c.text));
      else if (c.type === 'tool_result') wrap.append(fold('도구 결과' + (c.name ? ': ' + c.name : '') + (c.isError ? ' (오류)' : ''), c.text, c.isError ? 'err' : ''));
      else if (c.type === 'user_text') wrap.append(fold('스킬 본문·사용자 글', c.text, 'right'));
      else if (c.type === 'result') wrap.append(h('div', { class: 'turnmark' }, '끝남: ' + c.subtype + (c.text ? ' — ' + c.text : '')));
    }
    if (placed.missing.length) wrap.append(h('div', { class: 'missing' }, '걸린 문장(위 대화에서 위치를 못 찾음): ', placed.missing.map((m) => [h('q', null, m), ' '])));
  }
  return h('div', null, lead, wrap);
}

function setRound(id) {
  state.roundId = id;
  state.n = null;
  renderPicker();
  renderTable();
  renderPanel();
}

if (!DATA.rounds.length) {
  document.getElementById('app').replaceChildren(h('p', { class: 'empty', style: 'padding:16px' }, '쌓인 판이 없습니다. 시험을 돌리면 여기에 보입니다.'));
} else {
  $('#round').addEventListener('change', (e) => setRound(e.target.value));
  setRound(DATA.rounds[DATA.rounds.length - 1].id);
}
`;

// JSON을 <script> 안에 넣어도 </script>나 <!--로 깨지지 않게 <를 모두 <로 바꾼다.
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);
const embedJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c').split(LINE_SEP).join('\\u2028').split(PARA_SEP).join('\\u2029');

export function renderBoard(data) {
  const shared = [cellText, markSegments, placeMatches].map((f) => f.toString()).join('\n');
  const empty = data.rounds.length === 0;
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>행동 시험 결과판</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>행동 시험 결과판</h1>
  <div class="picker"><label for="round">판</label><select id="round" aria-label="판 고르기"></select></div>
  <div class="roundinfo" id="info"></div>
</header>
<main id="app" class="layout">
  <section class="card tablewrap" id="grid" aria-label="통과율 표">${empty ? '<p class="empty" style="padding:16px">쌓인 판이 없습니다. 시험을 돌리면 여기에 보입니다.</p>' : ''}</section>
  <aside class="card" id="panel" aria-label="실패한 회차와 대화"></aside>
</main>
<script type="application/json" id="data">${embedJson(data)}</script>
<script>
${shared}
${PAGE_JS}
</script>
</body>
</html>
`;
}

export function buildBoard(outDir) {
  const html = renderBoard(collectBoard(outDir));
  const file = path.join(outDir, 'board.html');
  writeFileSync(file, html);
  return { file, bytes: Buffer.byteLength(html), rounds: listRounds(outDir).length };
}

// ---- CLI ----
function cli(argv) {
  const outDir = path.resolve(argv[0] ?? defaultOutDir());
  if (!listRounds(outDir).length) {
    const legacy = importLegacy(outDir);
    if (legacy.created) console.error(`옛 기록 ${legacy.attempts}개를 이전 기록 모음 판으로 가져옴: ${legacy.file}`);
    else {
      console.error(`쌓인 판이 없습니다: ${outDir} (${legacy.reason}). 시험을 한 번 돌리세요.`);
      return 1;
    }
  }
  console.log(buildBoard(outDir).file);
  return 0;
}

const direct = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (direct) process.exitCode = cli(process.argv.slice(2));
