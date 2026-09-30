// Claude Code 대화 기록(JSONL)에서 턴을 뽑는다. 턴 = 사람의 질문 + 그 턴의 답.
// 파일을 처음부터 한 번 읽고, 그 뒤로는 늘어난 부분만 이어 읽는다.
import fs from 'node:fs';

const CHUNK = 4 * 1024 * 1024;
const MAX_TURNS = 400;
// 답 = 마지막으로 길게 쓴 글 덩어리부터 끝까지. 긴 답을 쓴 뒤 도구를 한 번 더 부르고
// "메모리에 적었습니다"처럼 짧게 끝나는 턴에서 본문이 사라지지 않게 한다.
const SUBSTANTIAL = 600;
const DONE_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

// 사용자 줄의 종류. null이면 턴과 무관한 줄(로컬 명령 출력 등)이다.
export function promptKind(text) {
  const s = text.trimStart();
  if (s.startsWith('[Request interrupted')) return 'interrupt';
  if (/^<(local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|system-reminder)\b/.test(s)) return null;
  if (s.startsWith('<task-notification>')) return 'notification';
  if (/^<command-(name|message|args)>/.test(s)) return 'command';
  return 'human';
}

export function commandLabel(text) {
  const name = text.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.trim() || '';
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() || '';
  return [name, args].filter(Boolean).join(' ') || '명령';
}

export function notificationLabel(text) {
  return text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() || '백그라운드 작업 알림';
}

function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some((b) => b?.type === 'tool_result')) return null;
  const text = content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n');
  const images = content.filter((b) => b?.type === 'image').length;
  if (!images || /\[Image #\d+\]/.test(text)) return text || null; // Claude Code가 [Image #n]을 이미 넣는다
  return `${text}${text ? '\n' : ''}[이미지 ${images}개]`;
}

// 도구 호출로 나뉜 글 덩어리들 중 답이 시작되는 덩어리
function answerStart(runs) {
  for (let i = runs.length - 1; i >= 0; i--) if (runs[i].length >= SUBSTANTIAL) return i;
  for (let i = runs.length - 1; i >= 0; i--) if (runs[i]) return i;
  return -1;
}

export function answerOf(runs) {
  const from = answerStart(runs);
  return from < 0 ? '' : runs.slice(from).filter(Boolean).join('\n\n');
}

export class TranscriptIndex {
  constructor(file) {
    this.file = file;
    this.version = 0;
    this.reset();
  }

  reset() {
    this.offset = 0;
    this.ino = null;
    this.rest = Buffer.alloc(0);
    this.turns = [];
    this.cur = null;
    this.title = null;
    this.version++;
  }

  // 늘어난 부분을 읽는다. 바뀐 게 있으면 true
  update() {
    let st;
    try { st = fs.statSync(this.file); } catch { return false; }
    if (this.ino !== null && (st.ino !== this.ino || st.size < this.offset)) this.reset();
    this.ino = st.ino;
    if (st.size <= this.offset) return false;
    const before = this.version;
    const fd = fs.openSync(this.file, 'r');
    try {
      while (this.offset < st.size) {
        const buf = Buffer.alloc(Math.min(CHUNK, st.size - this.offset));
        const n = fs.readSync(fd, buf, 0, buf.length, this.offset);
        if (n <= 0) break;
        this.offset += n;
        const data = this.rest.length ? Buffer.concat([this.rest, buf.subarray(0, n)]) : buf.subarray(0, n);
        // 줄바꿈 바이트에서만 자른다(UTF-8 글자가 두 조각으로 갈리지 않는다)
        const nl = data.lastIndexOf(0x0a);
        if (nl < 0) { this.rest = Buffer.from(data); continue; }
        this.rest = Buffer.from(data.subarray(nl + 1));
        for (const line of data.subarray(0, nl).toString('utf8').split('\n')) this.line(line);
      }
    } finally {
      fs.closeSync(fd);
    }
    return this.version !== before;
  }

  line(raw) {
    if (!raw) return;
    // 필요한 줄만 JSON으로 읽는다. 도구 결과 줄은 크고 많아서 먼저 거른다.
    const user = raw.includes('"type":"user"');
    if (user && raw.includes('"type":"tool_result"')) return;
    if (!user && !raw.includes('"type":"assistant"') && !raw.includes('"type":"system"')
      && !raw.includes('"type":"ai-title"') && !raw.includes('"queued_command"')) return;
    let o;
    try { o = JSON.parse(raw); } catch { return; }
    if (!o || o.isSidechain) return;
    if (o.type === 'user') this.onUser(o);
    else if (o.type === 'assistant') this.onAssistant(o);
    else if (o.type === 'system') this.onSystem(o);
    else if (o.type === 'ai-title') this.onTitle(o);
    else if (o.type === 'attachment') this.onAttachment(o);
  }

  onUser(o) {
    if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return;
    const text = userText(o.message?.content);
    if (text == null) return;
    const kind = promptKind(text);
    if (!kind) return;
    const at = Date.parse(o.timestamp) || 0;
    const cur = this.cur;
    if (kind === 'interrupt') {
      if (cur && cur.status === 'running') { cur.status = 'interrupted'; cur.endedAt = at; this.version++; }
      return;
    }
    if (cur && cur.status === 'running') { cur.status = 'ended'; cur.endedAt = at; }
    const prompt = kind === 'command' ? commandLabel(text) : kind === 'notification' ? notificationLabel(text) : text;
    this.cur = { id: String(o.uuid || `${at}-${this.turns.length}`), kind, prompt, extra: [], runs: [''], answer: '', status: 'running', startedAt: at, endedAt: null, tools: 0 };
    this.turns.push(this.cur);
    if (this.turns.length > MAX_TURNS) this.turns.splice(0, this.turns.length - MAX_TURNS);
    this.version++;
  }

  onAssistant(o) {
    const cur = this.cur;
    const blocks = o.message?.content;
    if (!cur || !Array.isArray(blocks)) return;
    let changed = false;
    for (const b of blocks) {
      if (b?.type === 'tool_use') {
        cur.tools++;
        if (cur.runs.at(-1)) cur.runs.push('');
        changed = true;
      } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        const last = cur.runs.length - 1;
        cur.runs[last] = cur.runs[last] ? `${cur.runs[last]}\n\n${b.text}` : b.text;
        changed = true;
      }
    }
    // 답이 시작되는 덩어리보다 오래된 것은 다시 쓸 일이 없다
    const from = answerStart(cur.runs);
    if (from > 0) cur.runs.splice(0, from);
    const reason = o.message?.stop_reason;
    const next = o.isApiErrorMessage ? 'error' : DONE_REASONS.has(reason) ? 'done' : 'running';
    if (cur.status === 'running' || cur.status === 'done' || cur.status === 'error') {
      if (next !== cur.status) { cur.status = next; changed = true; }
      if (next !== 'running') cur.endedAt = Date.parse(o.timestamp) || cur.endedAt;
    }
    if (changed) {
      cur.answer = answerOf(cur.runs);
      this.version++;
    }
  }

  onSystem(o) {
    const cur = this.cur;
    if (!cur || (o.subtype !== 'turn_duration' && o.subtype !== 'stop_hook_summary')) return;
    if (cur.status === 'running') {
      cur.status = 'done';
      cur.endedAt = Date.parse(o.timestamp) || cur.endedAt;
      this.version++;
    }
    if (o.subtype === 'turn_duration' && Number.isFinite(o.durationMs)) cur.durationMs = o.durationMs;
  }

  onTitle(o) {
    const title = typeof o.aiTitle === 'string' ? o.aiTitle.trim() : '';
    if (title && title !== this.title) { this.title = title; this.version++; }
  }

  // 작업 중에 사람이 친 말은 대기열을 거쳐 그 턴에 흡수된다
  onAttachment(o) {
    const a = o.attachment;
    if (a?.type !== 'queued_command' || a.commandMode !== 'prompt' || !this.cur) return;
    const text = typeof a.prompt === 'string' ? a.prompt.trim() : '';
    if (!text || promptKind(text) !== 'human') return;
    this.cur.extra.push(text);
    this.version++;
  }

  // 창에 보일 턴. 답이 없는 명령·알림 턴은 뺀다(예: /compact, /effort는 답이 오지 않는다)
  pages() {
    return this.turns.filter((t) => t.kind === 'human' || t.answer).map(pageOf);
  }
}

function pageOf(t) {
  return {
    id: t.id,
    kind: t.kind,
    prompt: t.prompt,
    extra: t.extra.slice(),
    answer: t.answer,
    status: t.status,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    durationMs: t.durationMs ?? null,
    tools: t.tools,
  };
}
