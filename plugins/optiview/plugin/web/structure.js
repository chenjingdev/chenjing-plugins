// 답의 구조만 다듬는다. 문장은 한 글자도 바꾸지 않는다.
// - 긴 답: 첫 결론(제목 앞 글)은 펼쳐 두고, 제목 달린 섹션은 접어서 제목만 보인다.
// - 짧은 답: 그대로 보인다.
// - 끝에서 사용자에게 묻는 말(과 바로 앞 선택지 목록)은 접지 않고 강조한다. 답은 터미널에서 한다.
import { parseBlocks, renderBlocks, inline } from './markdown.js';

// 사용자 기록 651개 답 기준: 중간값 843자, 상위 25%가 1,300자 넘음. 긴 답의 96%가 제목 달린 섹션을 갖는다.
export const LIMITS = { chars: 1300, lines: 28, codeLines: 18 };
const BOLD_LINE = /^\*\*([^*\n]{1,80}?)\*\*\s*[:：]?\s*$/;
const QUESTION = /(?:[?？]|(?:까요|주시겠어요|주실래요|원하시나요|하시겠어요|인가요|맞나요))[\s.!…)"'”’]*$/;

// 굵은 글씨만 있는 줄은 제목으로 본다. 첫 줄만 굵고 다음 줄이 이어지면 제목과 문단으로 나눈다.
function withPseudoHeadings(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'paragraph') {
      const [first, ...more] = b.text.split('\n');
      const m = first.match(BOLD_LINE);
      if (m) {
        out.push({ type: 'heading', level: 3, text: m[1].trim(), pseudo: true });
        if (more.length) out.push({ type: 'paragraph', text: more.join('\n') });
        continue;
      }
    }
    out.push(b);
  }
  return out;
}

function hintOf(blocks) {
  let items = 0;
  let rows = 0;
  let code = 0;
  let paras = 0;
  for (const b of blocks) {
    if (b.type === 'list') items += b.items.length;
    else if (b.type === 'table') rows += b.rows.length;
    else if (b.type === 'code') code += b.code.split('\n').length;
    else if (b.type === 'paragraph' || b.type === 'quote') paras++;
  }
  const parts = [];
  if (items) parts.push(`${items}항목`);
  if (rows) parts.push(`표 ${rows}행`);
  if (code) parts.push(`코드 ${code}줄`);
  if (!parts.length && paras) parts.push(`${paras}문단`);
  return parts.join(' · ');
}

export function planAnswer(text) {
  const src = String(text ?? '');
  const blocks = withPseudoHeadings(parseBlocks(src));
  const lead = [];
  const sections = [];
  let cur = null;
  for (const b of blocks) {
    if (b.type === 'heading' && (b.pseudo || b.level <= 3)) {
      cur = { title: b.text, blocks: [] };
      sections.push(cur);
    } else {
      (cur ? cur.blocks : lead).push(b);
    }
  }
  const tail = cur ? cur.blocks : lead;
  const ask = [];
  const last = tail.at(-1);
  if (last?.type === 'paragraph' && QUESTION.test(last.text.trim())) {
    ask.unshift(tail.pop());
    const prev = tail.at(-1);
    if (prev?.type === 'list' && prev.items.length <= 6) ask.unshift(tail.pop());
  }
  const long = src.length > LIMITS.chars || src.split('\n').length > LIMITS.lines;
  const folded = long && sections.length > 0;
  sections.forEach((s, k) => {
    s.open = !folded || (k === 0 && lead.length === 0);
    s.hint = hintOf(s.blocks);
  });
  return { folded, lead, sections, ask };
}

// opened: 사용자가 이 답에서 펼치거나 접은 섹션(번호 → 열림 여부)
export function renderPlan(plan, opened = new Map()) {
  let html = '';
  if (plan.lead.length) html += `<div class="lead">${renderBlocks(plan.lead)}</div>`;
  plan.sections.forEach((s, k) => {
    const body = renderBlocks(s.blocks);
    if (!plan.folded) {
      html += `<section class="sec plain"><h3 class="sec-title">${inline(s.title)}</h3>${body}</section>`;
      return;
    }
    const open = opened.has(k) ? opened.get(k) : s.open;
    const hint = s.hint ? `<span class="hint">${s.hint}</span>` : '';
    html += `<details class="sec" data-sec="${k}"${open ? ' open' : ''}><summary><span class="sec-title">${inline(s.title)}</span>${hint}</summary><div class="sec-body">${body}</div></details>`;
  });
  if (plan.ask.length) html += `<div class="ask" role="note"><span class="ask-label">답이 필요해요 · 터미널에서 답하세요</span>${renderBlocks(plan.ask)}</div>`;
  return html;
}
