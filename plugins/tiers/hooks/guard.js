#!/usr/bin/env node
'use strict';
// tiers delegate guard — one PreToolUse/SubagentStop hook behind one switch.
// `enabled` (opt-in, or TIERS_DELEGATE=on|off for a session) turns the whole PreToolUse side on:
//   1. pin: Agent calls get the configured tier instead of inheriting the session model.
//      `pin` is the scope only — all (every subagent) or worker (`tiers:worker` alone).
//   2. no implementing in the MAIN session — Edit/Write/MultiEdit/NotebookEdit and file-writing
//      Bash are denied with instructions to brief `tiers:worker`. Subagents pass.
//   3. brief check + handoff log: worker/general-purpose briefs must carry goal/context/scope/done;
//      accepted briefs and the worker's final report are written to ${CLAUDE_PLUGIN_DATA}/handoffs/.
// `enabled: false` → PreToolUse emits nothing at all, pinning included. SubagentStop still closes
// out a handoff started while it was on (`log`). Writes to the guard's own delegate.json are
// always allowed — that one file, nothing else in the data dir — so /tiers:delegate off can run.
// Fails open: any internal error is logged and the tool call proceeds unchanged.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULTS = { model: 'opus', enabled: false, pin: 'all', small_edit_chars: 200, log: true };
const WORKER_RE = /(^|:)worker$/;
const GENERIC_TYPES = new Set(['', 'general-purpose', 'claude']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const SECTIONS = [
  // (?![\p{L}\p{N}]) = "end of word" for both Korean and Latin (\b only knows ASCII).
  { key: 'goal', label: '목표 (Goal)', re: /^(?:목표|goals?|objectives?)(?![\p{L}\p{N}])/iu },
  { key: 'context', label: '맥락 (Context)', re: /^(?:맥락|배경|context|background)(?![\p{L}\p{N}])/iu },
  { key: 'scope', label: '범위 (Scope)', re: /^(?:범위|경계|scope|boundar(?:y|ies)|non-goals?|하지 말 것|do not|don'?t)(?![\p{L}\p{N}])/iu },
  { key: 'done', label: '완료 기준 (Done when)', re: /^(?:완료 ?기준|완료 ?조건|검증|acceptance|done[- ]when|definition of done|verif(?:y|ication))(?![\p{L}\p{N}])/iu },
];
const HEADING_PREFIX = /^\s*(?:#{1,6}\s*|\*\*|[-*•]\s*\*\*|[-*•]\s*|\d+[.)]\s*)?/;
const LABEL_TAIL = /^[^\n:*—–-]{0,30}?(?::|\*\*|—|–|-)?\s*/;

const TMP_PREFIXES = ['/tmp/', '/private/tmp/', '/private/var/folders/', '/var/folders/', '$TMPDIR', '${TMPDIR', '/dev/null'];

function dataDir() {
  return process.env.TIERS_DATA_DIR
    || process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), '.claude', 'plugins', 'data', 'tiers-chenjing-plugins');
}

// The guard's own config file is always writable: /tiers:delegate on|off|setup rewrites it from
// the main session, and that must work whatever small_edit_chars says. Only that one file — the
// handoff log and guard-error.log are written by the hook process itself, never by the session.
function configPaths() {
  const dir = String(dataDir()).replace(/\/+$/, '');
  const home = String(os.homedir() || '').replace(/\/+$/, '');
  const out = [`${dir}/delegate.json`, '$CLAUDE_PLUGIN_DATA/delegate.json', '${CLAUDE_PLUGIN_DATA}/delegate.json'];
  if (home && dir.startsWith(`${home}/`)) out.push(`~${dir.slice(home.length)}/delegate.json`);
  return out;
}

function loadConfig() {
  const cfg = { ...DEFAULTS };
  try {
    const raw = fs.readFileSync(path.join(dataDir(), 'delegate.json'), 'utf8');
    const parsed = JSON.parse(raw);
    for (const k of Object.keys(DEFAULTS)) if (parsed[k] !== undefined) cfg[k] = parsed[k];
    // back-compat: `enabled` was called `enforce` before 0.3.1
    if (parsed.enabled === undefined && parsed.enforce !== undefined) cfg.enabled = parsed.enforce;
  } catch (_) { /* missing or invalid → defaults */ }
  const env = String(process.env.TIERS_DELEGATE || '').trim().toLowerCase();
  if (['on', '1', 'true'].includes(env)) cfg.enabled = true;
  if (['off', '0', 'false'].includes(env)) cfg.enabled = false;
  cfg.enabled = Boolean(cfg.enabled);
  if (!['all', 'worker'].includes(cfg.pin)) cfg.pin = 'all';
  cfg.small_edit_chars = Number(cfg.small_edit_chars) || 0;
  cfg.config_paths = configPaths();
  return cfg;
}

function logError(err) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.appendFileSync(path.join(dataDir(), 'guard-error.log'), `${new Date().toISOString()} ${err && err.stack || err}\n`);
  } catch (_) { /* ignore */ }
}

function emit(obj) { process.stdout.write(JSON.stringify(obj)); }
function deny(reason) {
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}
function allowWith(updatedInput) {
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } });
}

// ---------- brief check ----------
function briefTemplate() {
  return [
    '## 목표 (Goal) — what to achieve in the user\'s terms, plus how you resolved anything ambiguous',
    '## 맥락 (Context) — what you already found: files with line refs, conventions, decisions made in the conversation and why, rejected alternatives',
    '## 범위 (Scope) — files to touch and not to touch, what the user explicitly does not want, decisions you delegate to the worker\'s discretion',
    '## 완료 기준 (Done when) — observable criteria and the exact verification commands that must pass',
  ].join('\n');
}

function analyzeBrief(text) {
  const lines = String(text || '').split(/\r?\n/);
  const found = {}; // key -> content chars
  let current = null;
  for (const rawLine of lines) {
    const stripped = rawLine.replace(HEADING_PREFIX, '');
    let matched = null;
    for (const s of SECTIONS) {
      if (s.re.test(stripped)) { matched = s; break; }
    }
    if (matched) {
      current = matched.key;
      if (found[current] === undefined) found[current] = 0;
      const inline = stripped.replace(matched.re, '').replace(LABEL_TAIL, '');
      found[current] += inline.replace(/\s+/g, '').length;
      continue;
    }
    if (current) found[current] += rawLine.replace(/\s+/g, '').length;
  }
  const missing = SECTIONS.filter((s) => (found[s.key] || 0) < 20).map((s) => s.label);
  return { missing };
}

// ---------- bash write detection ----------
function hasPrefix(tok, prefixes) {
  const t = String(tok).replace(/^['"]|['"]$/g, '');
  return prefixes.some((p) => t.startsWith(p) || t === p.replace(/\/$/, ''));
}
function isConfigPath(tok, cfg) {
  const t = String(tok).replace(/^['"]|['"]$/g, '');
  return ((cfg && cfg.config_paths) || configPaths()).includes(t);
}
function isAllowedWritePath(tok, cfg) { return hasPrefix(tok, TMP_PREFIXES) || isConfigPath(tok, cfg); }
function pathLike(tok) {
  if (!tok || tok.startsWith('-')) return false;
  const t = tok.replace(/^['"]|['"]$/g, '');
  return t.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(t) || t.startsWith('~');
}
const HEREDOC_RE = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z_][A-Za-z0-9_]*))/;
// Blanks heredoc bodies (and their terminator line) so the text a command is *fed* is never read
// as shell syntax: a stray ' in the body must not open a quote and hide the next line's redirect,
// and a > or | in the body must not look like one. Same length as the input, so offsets still line
// up; the newline that ends the terminator line survives as a segment boundary.
function stripHeredocs(s) {
  let out = s;
  const blank = (from, to) => {
    if (to <= from) return;
    out = out.slice(0, from) + ' '.repeat(to - from) + out.slice(to);
  };
  let quote = null;
  let brace = 0;
  const pending = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") { if (c === "'") quote = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === '$' && s[i + 1] === '{') { brace++; i++; continue; }
    if (brace > 0) { if (c === '}') brace--; else if (c === '{') brace++; continue; }
    if (quote === '"') { if (c === '"') quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const m = HEREDOC_RE.exec(s.slice(i));
      if (m) {
        pending.push({ word: m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4], strip: m[1] === '-' });
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === '\n' && pending.length) {
      let j = i + 1;
      while (pending.length && j < s.length) {
        const { word, strip } = pending.shift();
        while (j < s.length) {
          const nl = s.indexOf('\n', j);
          const end = nl === -1 ? s.length : nl;
          const done = (strip ? s.slice(j, end).replace(/^[\t ]*/, '') : s.slice(j, end)) === word;
          blank(j, end);
          if (done) { j = end; break; }
          if (nl === -1) { j = s.length; break; }
          blank(nl, nl + 1); // an interior body newline is not a command boundary
          j = nl + 1;
        }
      }
      i = j - 1;
      continue;
    }
  }
  return out;
}
// Marks the characters that are shell syntax: outside single/double quotes and outside ${...}.
// Everything else is data — `echo "a > b"`, `grep "=>"`, `${VAR:-<unset>}` redirect nothing.
function topLevelMask(s) {
  const mask = new Array(s.length).fill(false);
  let quote = null;
  let brace = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") { if (c === "'") quote = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === '$' && s[i + 1] === '{') { brace++; i++; continue; }
    if (brace > 0) { if (c === '}') brace--; else if (c === '{') brace++; continue; }
    if (quote === '"') { if (c === '"') quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    mask[i] = true;
  }
  return mask;
}
function segments(cmd) {
  const s = stripHeredocs(String(cmd));
  const mask = topLevelMask(s);
  const out = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (!mask[i]) continue;
    const c = s[i];
    const and = c === '&' && s[i + 1] === '&';
    if (!(and || c === '|' || c === ';' || c === '\n')) continue;
    out.push(s.slice(start, i));
    if (and || (c === '|' && s[i + 1] === '|')) i++;
    start = i + 1;
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}
// the file a real (unquoted) > or >> writes to, or null. `2>&1` and `<>` are not file writes.
function redirectTarget(seg) {
  const mask = topLevelMask(seg);
  for (let i = 0; i < seg.length; i++) {
    if (!mask[i] || seg[i] !== '>') continue;
    if (i > 0 && seg[i - 1] === '<') continue;
    let j = i + 1;
    if (seg[j] === '>') j++;
    while (seg[j] === ' ' || seg[j] === '\t') j++;
    if (seg[j] === '&') { i = j; continue; }
    let tok = '';
    if (seg[j] === '"' || seg[j] === "'") {
      const end = seg.indexOf(seg[j], j + 1);
      tok = end === -1 ? seg.slice(j + 1) : seg.slice(j + 1, end);
      j = end === -1 ? seg.length : end;
    } else {
      while (j < seg.length && !/[\s|;&<>'"]/.test(seg[j])) { tok += seg[j]; j++; }
    }
    if (tok) return tok;
    i = j;
  }
  return null;
}
// path-ish strings in a segment, looking inside quoted code too: node -e "...writeFileSync('x')".
function candidatePaths(seg) {
  const out = [];
  for (const t of (seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [])) {
    const body = t.replace(/^(['"])([\s\S]*)\1$/, '$2');
    const inner = [];
    const re = /'([^']*)'|"([^"]*)"/g;
    let m;
    while ((m = re.exec(body))) inner.push(m[1] !== undefined ? m[1] : m[2]);
    if (inner.length) { for (const q of inner) if (pathLike(q)) out.push(q); continue; }
    if (pathLike(t)) out.push(t.replace(/^['"]|['"]$/g, ''));
  }
  return out;
}
// returns { op, targets } | null. targets === null means "unknown targets" (deny unless every path in the segment is tmp)
function writeOpInSegment(seg) {
  const toks = seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const first = toks.findIndex((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) && !['sudo', 'env', 'command', 'nohup', 'time'].includes(t));
  const head = toks[first] || '';
  const base = head.replace(/^.*\//, '');
  const rest = toks.slice(first + 1);
  const argsNoFlags = rest.filter((t) => !t.startsWith('-'));

  const redir = redirectTarget(seg);
  if (redir) return { op: 'redirect', targets: [redir] };

  if (['cp', 'mv', 'install'].includes(base)) return { op: base, targets: argsNoFlags.slice(-1) };
  if (['rm', 'touch', 'ln', 'truncate', 'shred', 'rmdir'].includes(base)) return { op: base, targets: argsNoFlags };
  if (base === 'tee') return { op: 'tee', targets: argsNoFlags };
  if (base === 'sed' && rest.some((t) => /^-[a-zA-Z]*i/.test(t) || t === '--in-place')) return { op: 'sed -i', targets: null };
  if (base === 'perl' && rest.some((t) => /^-[a-zA-Z]*i/.test(t))) return { op: 'perl -i', targets: null };
  if (base === 'git' && rest[0] === 'apply') return { op: 'git apply', targets: null };
  if (base === 'patch') return { op: 'patch', targets: null };
  if (base === 'dd' && rest.some((t) => t.startsWith('of='))) return { op: 'dd', targets: rest.filter((t) => t.startsWith('of=')).map((t) => t.slice(3)) };
  if (/\bopen\([^)]*['"][wa]\+?['"]/.test(seg)) return { op: 'python open(w)', targets: null };
  if (/\b(writeFileSync|writeFile|appendFileSync|appendFile|outputFile|renameSync|unlinkSync)\s*\(/.test(seg)) return { op: 'node fs write', targets: null };
  return null;
}
function bashWriteViolation(cmd, cfg) {
  const allowed = (t) => isAllowedWritePath(t, cfg);
  for (const seg of segments(cmd)) {
    const w = writeOpInSegment(seg);
    if (!w) continue;
    if (w.targets === null) {
      const paths = candidatePaths(seg);
      if (paths.length && paths.every(allowed)) continue;
      return w.op;
    }
    if (w.targets.length && w.targets.every(allowed)) continue;
    return w.op;
  }
  return null;
}

// ---------- messages ----------
// One line, deliberately. A denied edit only has to teach two things: it is not yours to make, and
// `tiers:worker` makes it. The four-section template belongs to the brief check below — that is the
// moment a model actually needs it — and the worker agent's own description carries it too.
function delegateNote() {
  return 'Hand it to the tiers:worker subagent instead (Agent, subagent_type "tiers:worker") with a brief, then verify the diff yourself; /tiers:delegate off turns this guard off.';
}

// ---------- handoff log ----------
function sha(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }
function handoffDir() { return path.join(dataDir(), 'handoffs'); }
function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function writeHandoff(input, agentType, model) {
  const prompt = input.tool_input && input.tool_input.prompt || '';
  const now = new Date();
  const sid = String(input.session_id || 'nosession').slice(0, 8);
  const psha = sha(prompt);
  fs.mkdirSync(handoffDir(), { recursive: true });
  const file = path.join(handoffDir(), `${stamp(now)}-${sid}-${psha.slice(0, 8)}.md`);
  const head = [
    '---',
    `session: ${input.session_id || ''}`,
    `cwd: ${input.cwd || ''}`,
    `agent_type: ${agentType}`,
    `model: ${model || ''}`,
    `prompt_sha: ${psha}`,
    `started: ${now.toISOString()}`,
    '---',
    '',
    '# Brief',
    '',
    prompt,
    '',
  ].join('\n');
  fs.writeFileSync(file, head, { mode: 0o600 });
}
function firstUserPrompt(transcriptPath) {
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of raw.split('\n').slice(0, 20)) {
      if (!line.trim()) continue;
      let rec; try { rec = JSON.parse(line); } catch (_) { continue; }
      if (rec.type !== 'user' || !rec.message) continue;
      const c = rec.message.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n');
    }
  } catch (_) { /* ignore */ }
  return null;
}
function appendResult(input) {
  const dir = handoffDir();
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  if (!files.length) return;
  const prompt = firstUserPrompt(input.agent_transcript_path);
  const psha = prompt !== null ? sha(prompt) : null;
  const sid = String(input.session_id || '');
  let target = null;
  for (const f of files.slice().reverse()) {
    const p = path.join(dir, f);
    const body = fs.readFileSync(p, 'utf8');
    if (body.includes('\n# Result')) continue;
    if (psha && body.includes(`prompt_sha: ${psha}`)) { target = p; break; }
    if (!psha && sid && body.includes(`session: ${sid}`) && !target) target = p;
  }
  if (!target) return;
  const msg = input.last_assistant_message || '(no final message captured)';
  fs.appendFileSync(target, `\n# Result (${new Date().toISOString()}, agent ${input.agent_id || ''})\n\n${msg}\n`);
}

// ---------- main ----------
function handlePreToolUse(input, cfg) {
  if (!cfg.enabled) return; // one switch: off means no pinning, no denials, no handoff log
  const isMain = !input.agent_id;
  const tool = input.tool_name;
  const ti = input.tool_input || {};

  if (tool === 'Agent') {
    const type = String(ti.subagent_type || '');
    const isWorker = WORKER_RE.test(type);
    let updated = null;
    if (type !== 'fork') {
      if (isWorker && ti.model !== cfg.model) updated = { ...ti, model: cfg.model };
      else if (!isWorker && cfg.pin === 'all' && !ti.model) updated = { ...ti, model: cfg.model };
    }
    const effective = updated || ti;
    if (isMain && (isWorker || GENERIC_TYPES.has(type))) {
      const { missing } = analyzeBrief(ti.prompt);
      if (missing.length) {
        return deny([
          `[tiers delegate] The brief for ${type || 'general-purpose'} is missing: ${missing.join(', ')}. Each section needs real content (20+ chars).`,
          'Resend the Agent call with the completed brief:',
          briefTemplate(),
          'Put what you already know into 맥락 (Context) — the worker starts with no memory of this conversation.',
        ].join('\n'));
      }
    }
    if (cfg.log && isWorker) {
      try { writeHandoff(input, type, effective.model); } catch (e) { logError(e); }
    }
    if (updated) return allowWith(updated);
    return;
  }

  if (!isMain) return;

  if (EDIT_TOOLS.has(tool)) {
    const target = tool === 'NotebookEdit' ? ti.notebook_path : ti.file_path;
    if (target && isConfigPath(target, cfg)) return; // the guard's own delegate.json, nothing else
    if (tool === 'Edit' && cfg.small_edit_chars > 0 && !ti.replace_all) {
      const size = String(ti.old_string || '').length + String(ti.new_string || '').length;
      if (size <= cfg.small_edit_chars) return;
    }
    return deny(`[tiers delegate] ${tool} blocked in the main session — you plan and verify here, you don't implement.\n${delegateNote()}`);
  }

  if (tool === 'Bash') {
    const op = bashWriteViolation(ti.command || '', cfg);
    if (op) {
      return deny(`[tiers delegate] Bash write blocked in the main session (matched: ${op}). Reads, git status/log/diff, tests and /tmp writes are fine.\n${delegateNote()}`);
    }
  }
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw || '{}');
      const cfg = loadConfig();
      if (input.hook_event_name === 'PreToolUse') handlePreToolUse(input, cfg);
      else if (input.hook_event_name === 'SubagentStop' && cfg.log && WORKER_RE.test(String(input.agent_type || ''))) appendResult(input);
    } catch (e) {
      logError(e);
    }
    process.exit(0);
  });
}

if (require.main === module) main();
module.exports = { analyzeBrief, bashWriteViolation, loadConfig, handlePreToolUse };
