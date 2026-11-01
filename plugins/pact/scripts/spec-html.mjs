// 명세를 사용자가 읽는 HTML 한 장으로 만든다(승인을 묻기 전에 연다). 파일 하나로 열리고 외부 자원·스크립트가 없다.
// 태그·위험 표시를 읽는 규칙은 spec.mjs의 것을 그대로 쓴다. 여기서 새로 읽는 것은 태그 콜론 뒤의 출처뿐이다.
import { parseSpec, splitTrailing, tagParts, decisionRulings, ITEM_HEAD, ITEM_SECTIONS, HAS_RISK_MARK } from './spec.mjs';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 백틱 안 글만 <code>로 바꾼다. 그 밖의 마크다운은 해석하지 않는다. 글을 먼저 escape하므로 백틱 안의 <도 안전하다.
const inline = (s) => esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>');

// 태그 콜론 뒤의 출처: `10/18`, `2025/10/18`, AI 가정 꼴의 `기록 10/11`. 날짜 뒤에 글이 더 있으면 그것이 다른 저장소 이름이다.
const SOURCE = /^(?:기록\s+)?((?:\d{4}\/)?\d{1,2}\/\d{1,2})(?:\s+(\S.*))?$/;

const chip = (cls, text) => `<span class="chip ${cls}">${esc(text)}</span>`;
const label = (id) => (id ? `<strong>${esc(id)}</strong> ` : '');

// 목록 줄 하나(번호 뒤의 글 또는 케이스 줄): 칩을 단 HTML과 요약에 쓸 분류
function renderLine(rest) {
  const { text, rawTag, risk } = splitTrailing(rest);
  const { name, rest: detail } = tagParts(rawTag);
  const known = name === '사용자' || name === 'AI 가정';
  const chips = [];
  // 줄 가운데의 위험 표시도 delegate가 거절하므로(approval.mjs riskItems) 같은 눈으로 센다
  const marked = risk !== null || HAS_RISK_MARK.test(rest);
  if (risk !== null) chips.push(chip('risk', risk ? `위험: ${risk}` : '위험'));
  else if (marked) chips.push(chip('risk', '위험'));
  let record = false;
  let other = false;
  if (known) {
    chips.push(chip(name === '사용자' ? 'user' : 'ai', name));
    const source = SOURCE.exec(detail);
    if (source) {
      record = true;
      chips.push(chip('rec', `기록 ${source[1]}`));
      if (source[2]) {
        other = true;
        chips.push(chip('repo', `다른 저장소 ${source[2]}`));
      }
    } else if (detail) chips.push(chip('note', detail));
  }
  const body = rawTag !== null && !known ? `${text} [${rawTag}]` : text;
  return { html: inline(body) + chips.join(''), tag: known ? name : null, record, other, risk: marked };
}

// 한 칸의 줄을 문단·목록·접힌 블록으로 나눈다. 번호(F1 등)는 항목 칸에서만 읽는다.
function parseBlocks(lines, itemSection) {
  const blocks = [];
  let para = null;
  let list = null;
  let item = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*<details\b/i.test(line)) {
      let end = i;
      while (end < lines.length - 1 && !/<\/details>/i.test(lines[end])) end++;
      const chunk = lines.slice(i, end + 1).join('\n');
      const summary = /<summary>([\s\S]*?)<\/summary>/i.exec(chunk)?.[1].trim();
      const inner = chunk.replace(/^\s*<details[^>]*>/i, '').replace(/<summary>[\s\S]*?<\/summary>/i, '').replace(/<\/details>\s*$/i, '');
      blocks.push({ type: 'details', summary: summary || '펼치기', blocks: parseBlocks(inner.split('\n'), itemSection) });
      para = list = item = null;
      i = end;
    } else if (!line.trim()) para = null;
    else if (/^-\s+/.test(line)) {
      const head = itemSection ? ITEM_HEAD.exec(line) : null;
      item = { id: head?.[1] ?? null, rest: head ? head[2] : line.replace(/^-\s+/, '').trim(), subs: [] };
      if (!list) blocks.push((list = { type: 'list', items: [] }));
      list.items.push(item);
      para = null;
    } else if (item && /^\s+\S/.test(line)) item.subs.push(line.replace(/^\s+(?:-\s+)?/, '').trim());
    else {
      list = item = null;
      if (!para) blocks.push((para = { type: 'para', lines: [] }));
      para.lines.push(line.trim());
    }
  }
  return blocks;
}

// 줄을 그리면서 요약 상자에 쓸 개수와 목록을 모은다
function renderBlocks(blocks, found) {
  const line = (rest, id) => {
    const r = renderLine(rest);
    if (r.tag === '사용자') found.user++;
    else if (r.tag === 'AI 가정') found.ai++;
    if (r.record) found.record++;
    if (r.other) found.other.push(label(id) + r.html);
    if (r.risk) found.risk.push(label(id) + r.html);
    return r;
  };
  return blocks
    .map((block) => {
      if (block.type === 'para') return `<p>${block.lines.map(inline).join('<br>')}</p>`;
      if (block.type === 'details') return `<details><summary>${inline(block.summary)}</summary>\n${renderBlocks(block.blocks, found)}</details>`;
      const items = block.items.map((it) => {
        const head = line(it.rest, it.id);
        const subs = it.subs.map((sub) => {
          const r = line(sub, it.id);
          return `<li${r.other ? ' class="other"' : ''}>${r.html}</li>`;
        });
        return `<li${head.other ? ' class="other"' : ''}>${label(it.id)}${head.html}${subs.length ? `<ul class="sub">${subs.join('')}</ul>` : ''}</li>`;
      });
      return `<ul>${items.join('')}</ul>`;
    })
    .join('\n');
}

const STYLE = `
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 720px; margin: 24px auto; padding: 0 16px; color: #222; background: #fff; }
  h1 { font-size: 22px; margin: 0; }
  h2 { font-size: 16px; margin: 24px 0 4px; }
  h3 { font-size: 14px; margin: 12px 0 2px; }
  .meta { color: #666; font-size: 13px; margin: 2px 0 16px; }
  .summary { border: 1px solid #ddd; background: #f7f7f7; border-radius: 6px; padding: 8px 14px 10px; }
  .summary p { margin: 4px 0; font-weight: 600; }
  .none { color: #888; }
  p { margin: 4px 0; }
  ul { margin: 2px 0; padding-left: 22px; }
  li { padding: 2px 0; }
  li.other { border-left: 3px solid #e8820c; padding-left: 8px; }
  ul.sub { font-size: 13px; color: #555; }
  code { background: #f1f1f1; border-radius: 3px; padding: 0 4px; font-size: 13px; }
  details { margin: 8px 0; }
  summary { cursor: pointer; color: #555; }
  .chip { display: inline-block; font-size: 12px; line-height: 1.5; padding: 0 7px; margin-left: 5px; border-radius: 10px; white-space: nowrap; }
  .user { background: #dbeafe; color: #1e40af; }
  .ai { background: #eee; color: #555; }
  .risk { background: #fde2e2; color: #b42318; }
  .rec { border: 1px solid #e8820c; color: #a15c00; }
  .repo { background: #e8820c; color: #fff; }
  .note { background: #f1f1f1; color: #666; font-size: 11px; }
`;

export function renderSpecHtml(text, { title } = {}) {
  const spec = parseSpec(text);
  const heading = title ?? spec.frontmatter.topic ?? '명세';
  const found = { user: 0, ai: 0, record: 0, other: [], risk: [] };
  const rulings = decisionRulings(text).length;
  const sections = Object.entries(spec.sections).map(([name, body]) => {
    // 결정 기록은 지난 판단을 적은 글이라 그 안에 인용된 태그·위험 표시는 요약에 세지 않는다
    const tally = name === '결정 기록' ? { user: 0, ai: 0, record: 0, other: [], risk: [] } : found;
    const html = renderBlocks(parseBlocks(body.split('\n'), ITEM_SECTIONS.includes(name)), tally);
    if (name === '결정 기록') return `<details class="log"><summary>${esc(name)} — Ruling ${rulings}개</summary>\n${html}</details>`;
    return `<h2>${esc(name)}</h2>\n${html || (name === '확인 필요' ? '<p class="none">없음</p>' : '')}`;
  });
  const list = (label, entries) => (entries.length ? `<h3>${label}</h3>\n<ul>${entries.map((e) => `<li>${e}</li>`).join('')}</ul>\n` : '');
  const meta = ['status', 'created'].filter((key) => spec.frontmatter[key]).map((key) => `${key}: ${spec.frontmatter[key]}`);
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(heading)} — 명세</title>
<style>${STYLE}</style></head><body>
<h1>${esc(heading)}</h1>
<p class="meta">${esc(meta.join(' · '))}</p>
<div class="summary">
<p>[사용자] ${found.user}개 · [AI 가정] ${found.ai}개 · 기록에서 온 줄 ${found.record}개(다른 저장소 ${found.other.length}개) · 위험 ${found.risk.length}개</p>
${list('다른 저장소에서 온 줄', found.other)}${list('위험 줄', found.risk)}</div>
${sections.join('\n')}
</body></html>
`;
}
