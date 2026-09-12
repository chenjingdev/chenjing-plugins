#!/usr/bin/env node
'use strict';
// tiers delegate guard — one PreToolUse/SubagentStop hook, three jobs:
//   1. pin: Agent calls that omit `model` get the configured tier (never the session model).
//   2. enforce (opt-in): the MAIN session may not implement — Edit/Write/MultiEdit/NotebookEdit and
//      file-writing Bash are denied with instructions to brief `tiers:worker`. Subagents pass.
//   3. brief check + handoff log: worker/general-purpose briefs must carry goal/context/scope/done;
//      accepted briefs and the worker's final report are written to ${CLAUDE_PLUGIN_DATA}/handoffs/.
// Fails open: any internal error is logged and the tool call proceeds unchanged.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULTS = { model: 'opus', enforce: false, pin: 'all', small_edit_chars: 200, log: true };
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

function loadConfig() {
  const cfg = { ...DEFAULTS };
  try {
    const raw = fs.readFileSync(path.join(dataDir(), 'delegate.json'), 'utf8');
    const parsed = JSON.parse(raw);
    for (const k of Object.keys(DEFAULTS)) if (parsed[k] !== undefined) cfg[k] = parsed[k];
  } catch (_) { /* missing or invalid → defaults */ }
  const env = String(process.env.TIERS_DELEGATE || '').trim().toLowerCase();
  if (['on', '1', 'true'].includes(env)) cfg.enforce = true;
  if (['off', '0', 'false'].includes(env)) cfg.enforce = false;
  if (!['all', 'worker', 'off'].includes(cfg.pin)) cfg.pin = 'all';
  cfg.small_edit_chars = Number(cfg.small_edit_chars) || 0;
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
function isTmpPath(tok) {
  const t = tok.replace(/^['"]|['"]$/g, '');
  return TMP_PREFIXES.some((p) => t.startsWith(p));
}
function pathLike(tok) {
  if (!tok || tok.startsWith('-')) return false;
  const t = tok.replace(/^['"]|['"]$/g, '');
  return t.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(t) || t.startsWith('~');
}
function segments(cmd) {
  return String(cmd).split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
}
// returns { op, targets } | null. targets === null means "unknown targets" (deny unless every path in the segment is tmp)
function writeOpInSegment(seg) {
  const toks = seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const first = toks.findIndex((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) && !['sudo', 'env', 'command', 'nohup', 'time'].includes(t));
  const head = toks[first] || '';
  const base = head.replace(/^.*\//, '');
  const rest = toks.slice(first + 1);
  const argsNoFlags = rest.filter((t) => !t.startsWith('-'));

  const redir = seg.match(/(^|[^<>])>{1,2}\s*(?!&)(['"]?)([^\s|;&'"]+)/);
  if (redir) return { op: 'redirect', targets: [redir[3]] };

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
function bashWriteViolation(cmd) {
  for (const seg of segments(cmd)) {
    const w = writeOpInSegment(seg);
    if (!w) continue;
    if (w.targets === null) {
      const paths = (seg.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).filter(pathLike);
      if (paths.length && paths.every(isTmpPath)) continue;
      return w.op;
    }
    if (w.targets.length && w.targets.every(isTmpPath)) continue;
    return w.op;
  }
  return null;
}

// ---------- messages ----------
function delegateInstructions(cfg) {
  return [
    '[tiers delegate] Delegate mode is on: the main session plans, briefs and verifies; `tiers:worker` implements.',
    'Do this instead of editing directly:',
    '1. Read only what you need to write the brief (specific files). Wide sweeps go to `tiers:scout`, which returns excerpts with provenance.',
    '2. Call Agent with subagent_type "tiers:worker" and a brief with these four sections (Korean or English headings, real content in each):',
    briefTemplate(),
    '3. If the worker returns BLOCKED, answer it with SendMessage to that same agent (its context is intact). Do not spawn a new one.',
    '4. Verify yourself afterwards: read the diff and run the done-when commands. Send fix-ups to the same worker.',
    `Escape hatches: one Edit under ${cfg.small_edit_chars} chars is allowed; writes under /tmp are allowed; for analysis sessions or a repeating BLOCKED loop run /tiers:delegate off (or start the session with TIERS_DELEGATE=off).`,
  ].join('\n');
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
  const isMain = !input.agent_id;
  const tool = input.tool_name;
  const ti = input.tool_input || {};

  if (tool === 'Agent') {
    const type = String(ti.subagent_type || '');
    const isWorker = WORKER_RE.test(type);
    let updated = null;
    if (type !== 'fork' && cfg.pin !== 'off') {
      if (isWorker && ti.model !== cfg.model) updated = { ...ti, model: cfg.model };
      else if (!isWorker && cfg.pin === 'all' && !ti.model) updated = { ...ti, model: cfg.model };
    }
    const effective = updated || ti;
    if (cfg.enforce && isMain && (isWorker || GENERIC_TYPES.has(type))) {
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

  if (!cfg.enforce || !isMain) return;

  if (EDIT_TOOLS.has(tool)) {
    if (tool === 'Edit' && cfg.small_edit_chars > 0 && !ti.replace_all) {
      const size = String(ti.old_string || '').length + String(ti.new_string || '').length;
      if (size <= cfg.small_edit_chars) return;
    }
    return deny(delegateInstructions(cfg));
  }

  if (tool === 'Bash') {
    const op = bashWriteViolation(ti.command || '');
    if (op) {
      return deny(`[tiers delegate] Bash write blocked in the main session (matched: ${op}). Reads, git status/log/diff, tests and /tmp writes are fine.\n${delegateInstructions(cfg)}`);
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
