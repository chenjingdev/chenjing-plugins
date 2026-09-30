// 마크다운 → HTML. 브라우저와 Node(검사)에서 같이 쓴다. 모든 글자는 이스케이프한다.
// Claude 답에서 쓰는 만큼만 지원한다: 제목, 문단, 목록(중첩·체크), 인용, 표, 코드, 가로줄, 인라인 강조·코드·링크.

const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])(?:(\s+)(.*))?$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const expandTabs = (line) => line.replace(/^\t+/, (t) => '    '.repeat(t.length));
const indentOf = (line) => line.match(/^ */)[0].length;

function isBlockStart(line, next, inPara = false) {
  const list = line.match(LIST);
  if (list && inPara && /\d/.test(list[2]) && parseInt(list[2], 10) !== 1) return false;
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || /^ {0,3}>/.test(line) || Boolean(list)
    || (line.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-'));
}

export function parseBlocks(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n').map(expandTabs);
  return blocksOf(lines);
}

function blocksOf(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m = line.match(FENCE);
    if (m) {
      const indent = m[1].length;
      const close = new RegExp(`^ {0,3}${m[2][0] === '`' ? '`' : '~'}{${m[2].length},}\\s*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) {
        body.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))));
        i++;
      }
      i++;
      out.push({ type: 'code', lang: m[3] || '', code: body.join('\n') });
      continue;
    }
    m = line.match(HEADING);
    if (m) { out.push({ type: 'heading', level: m[1].length, text: m[2] || '' }); i++; continue; }
    if (HR.test(line)) { out.push({ type: 'hr' }); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = cells(line);
      const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : null));
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(cells(lines[i])); i++; }
      out.push({ type: 'table', header, align, rows });
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim() && (/^ {0,3}>/.test(lines[i]) || !isBlockStart(lines[i], lines[i + 1]))) {
        body.push(lines[i].replace(/^ {0,3}> ?/, ''));
        i++;
      }
      out.push({ type: 'quote', blocks: blocksOf(body) });
      continue;
    }
    if (LIST.test(line)) {
      const r = parseList(lines, i);
      out.push(r.block);
      i = r.next;
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1], true)) { para.push(lines[i].trim()); i++; }
    out.push({ type: 'paragraph', text: para.join('\n') });
  }
  return out;
}

function cells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out = [];
  let cur = '';
  let code = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (ch === '`') code = !code;
    if (ch === '|' && !code) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function parseList(lines, start) {
  const first = lines[start].match(LIST);
  const ordered = /\d/.test(first[2]);
  const base = first[1].length;
  const items = [];
  let i = start;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      const n = j < lines.length && lines[j].match(LIST);
      if (n && n[1].length === base && /\d/.test(n[2]) === ordered) { i = j; continue; }
      break;
    }
    const m = lines[i].match(LIST);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
    const content = base + m[2].length + (m[3] ? m[3].length : 1);
    const body = [m[4] || ''];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && indentOf(lines[j]) > base) { body.push(''); i++; continue; }
        break;
      }
      const ind = indentOf(l);
      // 표시보다 더 들여 쓴 줄은 이 항목에 속한다(중첩 목록, 이어지는 문단, 코드)
      if (ind > base) { body.push(l.slice(Math.min(ind, content))); i++; continue; }
      if (isBlockStart(l, lines[i + 1])) break;
      body.push(l.trim());
      i++;
    }
    const task = body[0].match(/^\[([ xX])\]\s+(.*)$/);
    if (task) body[0] = task[2];
    items.push({ checked: task ? task[1] !== ' ' : null, blocks: blocksOf(body) });
  }
  return { block: { type: 'list', ordered, start: ordered ? parseInt(first[2], 10) : null, items }, next: i };
}

// 인라인: 코드 → 링크 → 강조 순서. 코드 안은 그대로 둔다.
export function inline(text) {
  const codes = [];
  let s = String(text ?? '').replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, body) => {
    codes.push(`<code>${escapeHtml(body.trim() || body)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  const links = [];
  const keep = (html) => { links.push(html); return `\u0001${links.length - 1}\u0001`; };
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (all, label, href) => {
    const raw = href.replace(/&amp;/g, '&');
    if (/^(https?:|mailto:)/i.test(raw)) return keep(`<a href="${escapeHtml(raw)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    // 파일 경로 링크는 이름만 보이고 경로는 툴팁으로 둔다
    return keep(`<span class="file" title="${href}">${label}</span>`);
  });
  s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<)（）]+[^\s<)（）.,;:!?。、])/g, (_, pre, url) => `${pre}${keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)}`);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/\n/g, '<br>');
  s = s.replace(/\u0001(\d+)\u0001/g, (_, n) => links[Number(n)]);
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => codes[Number(n)]);
}

export function renderBlocks(blocks) {
  return blocks.map(renderBlock).join('');
}

export function renderBlock(b) {
  switch (b.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(2, b.level + 1));
      return `<h${level}>${inline(b.text)}</h${level}>`;
    }
    case 'paragraph':
      return `<p>${inline(b.text)}</p>`;
    case 'code':
      return `<pre class="code"${b.lang ? ` data-lang="${escapeHtml(b.lang)}"` : ''}><code>${escapeHtml(b.code)}</code></pre>`;
    case 'hr':
      return '<hr>';
    case 'quote':
      return `<blockquote>${renderBlocks(b.blocks)}</blockquote>`;
    case 'table': {
      const cell = (tag, text, k) => `<${tag}${b.align[k] ? ` class="${b.align[k]}"` : ''}>${inline(text)}</${tag}>`;
      const head = `<tr>${b.header.map((c, k) => cell('th', c, k)).join('')}</tr>`;
      const rows = b.rows.map((r) => `<tr>${b.header.map((_, k) => cell('td', r[k] ?? '', k)).join('')}</tr>`).join('');
      return `<div class="table"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
    }
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
      const items = b.items.map((it) => {
        const tight = it.blocks.length === 1 && it.blocks[0].type === 'paragraph';
        const body = tight ? inline(it.blocks[0].text) : renderBlocks(it.blocks);
        if (it.checked === null) return `<li>${body}</li>`;
        return `<li class="task${it.checked ? ' done' : ''}"><span class="box" aria-label="${it.checked ? '완료' : '미완료'}"></span>${body}</li>`;
      }).join('');
      return `<${tag}${start}>${items}</${tag}>`;
    }
    default:
      return '';
  }
}

// 블록의 글자 수(접을지 정할 때 쓴다)
export function textLength(blocks) {
  let n = 0;
  for (const b of blocks) {
    if (b.type === 'paragraph' || b.type === 'heading') n += b.text.length;
    else if (b.type === 'code') n += b.code.length;
    else if (b.type === 'table') n += [b.header, ...b.rows].flat().join(' ').length;
    else if (b.type === 'quote') n += textLength(b.blocks);
    else if (b.type === 'list') for (const it of b.items) n += textLength(it.blocks);
  }
  return n;
}
