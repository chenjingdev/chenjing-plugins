import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(here, '..', 'hooks', 'guard.js');

const FULL_BRIEF = `## 목표 (Goal)
Add a --json flag to the CLI so bench results can be piped into jq without scraping.
## 맥락 (Context)
Entry point is scripts/bench.mjs:40 (parseArgs). Output today is printed by printTable at :120. The user rejected a separate subcommand.
## 범위 (Scope)
Touch scripts/bench.mjs and its test only. Do not change the table format. Flag naming is your call.
## 완료 기준 (Done when)
node --test tests/ passes and \`node scripts/bench.mjs --json | jq .runs\` prints an array.`;

function run(input, { cfg, env = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tiers-guard-'));
  if (cfg) writeFileSync(path.join(dir, 'delegate.json'), JSON.stringify(cfg));
  const res = spawnSync('node', [GUARD], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, TIERS_DATA_DIR: dir, TIERS_DELEGATE: '', ...env },
  });
  let out = null;
  if (res.stdout.trim()) out = JSON.parse(res.stdout);
  return { out, dir, status: res.status, stderr: res.stderr };
}

const main = (tool_name, tool_input, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: 'sess-1234-abcd', cwd: '/proj', tool_name, tool_input, ...extra,
});
const sub = (tool_name, tool_input) => main(tool_name, tool_input, { agent_id: 'a1', agent_type: 'tiers:worker' });
const ON = { enforce: true, model: 'opus' };
const OFF = { enforce: false, model: 'opus' };
const decision = (r) => r.out?.hookSpecificOutput?.permissionDecision ?? null;

test('enforce off: main Edit passes untouched', () => {
  const r = run(main('Edit', { file_path: 'a.js', old_string: 'x'.repeat(500), new_string: 'y'.repeat(500) }), { cfg: OFF });
  assert.equal(r.out, null);
  assert.equal(r.status, 0);
});

test('enforce on: main Edit above the small-edit limit is denied with delegation instructions', () => {
  const r = run(main('Edit', { file_path: 'a.js', old_string: 'x'.repeat(150), new_string: 'y'.repeat(150) }), { cfg: ON });
  assert.equal(decision(r), 'deny');
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /tiers:worker/);
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /완료 기준/);
});

test('enforce on: a small main Edit is allowed; replace_all is not', () => {
  const small = run(main('Edit', { file_path: 'a.js', old_string: 'foo', new_string: 'bar' }), { cfg: ON });
  assert.equal(small.out, null);
  const ra = run(main('Edit', { file_path: 'a.js', old_string: 'foo', new_string: 'bar', replace_all: true }), { cfg: ON });
  assert.equal(decision(ra), 'deny');
  const zero = run(main('Edit', { file_path: 'a.js', old_string: 'foo', new_string: 'bar' }), { cfg: { ...ON, small_edit_chars: 0 } });
  assert.equal(decision(zero), 'deny');
});

test('enforce on: main Write/MultiEdit/NotebookEdit denied, subagent edits pass', () => {
  for (const t of ['Write', 'MultiEdit', 'NotebookEdit']) {
    assert.equal(decision(run(main(t, { file_path: 'a.js', content: 'x' }), { cfg: ON })), 'deny', t);
  }
  assert.equal(run(sub('Write', { file_path: 'a.js', content: 'x' }), { cfg: ON }).out, null);
  assert.equal(run(sub('Edit', { file_path: 'a.js', old_string: 'x'.repeat(900), new_string: '' }), { cfg: ON }).out, null);
});

test('enforce on: Bash write patterns are denied unless every target is under tmp', () => {
  const denied = [
    "sed -i 's/a/b/' src/app.js",
    'echo hi > src/out.txt',
    "cat <<'EOF' > src/new.js\nhello\nEOF",
    'cp /tmp/x.js src/x.js',
    'rm -rf dist',
    'git apply fix.patch',
    'python3 -c "open(\'src/a.py\',\'w\').write(1)"',
    'node -e "require(\'fs\').writeFileSync(\'a.json\', \'{}\')"',
    'printf x | tee src/a.txt',
  ];
  for (const c of denied) assert.equal(decision(run(main('Bash', { command: c }), { cfg: ON })), 'deny', c);
  const allowed = [
    'cat src/app.js',
    'git status && git diff --stat',
    'npm test 2>&1 | tail -20',
    'grep -rn TODO src/ > /tmp/todos.txt',
    "cat <<'EOF' > /tmp/probe.json\n{}\nEOF",
    'cp src/a.js /tmp/a.js',
    'mkdir -p /tmp/work',
    'ls > /dev/null 2>&1',
    'node --test tests/',
  ];
  for (const c of allowed) assert.equal(run(main('Bash', { command: c }), { cfg: ON }).out, null, c);
});

test('enforce on: subagent Bash writes are not touched', () => {
  assert.equal(run(sub('Bash', { command: "sed -i 's/a/b/' src/app.js" }), { cfg: ON }).out, null);
});

test('pin all: Agent calls without model get the configured model; fork is untouched', () => {
  const r = run(main('Agent', { subagent_type: 'Explore', prompt: 'find callers' }), { cfg: { ...OFF, model: 'sonnet' } });
  assert.equal(decision(r), 'allow');
  assert.equal(r.out.hookSpecificOutput.updatedInput.model, 'sonnet');
  assert.equal(r.out.hookSpecificOutput.updatedInput.prompt, 'find callers');
  const explicit = run(main('Agent', { subagent_type: 'Explore', prompt: 'x', model: 'haiku' }), { cfg: OFF });
  assert.equal(explicit.out, null);
  const fork = run(main('Agent', { subagent_type: 'fork', prompt: 'x' }), { cfg: OFF });
  assert.equal(fork.out, null);
});

test('pin worker: only tiers:worker is pinned, and it is pinned even with an explicit model', () => {
  const cfg = { ...OFF, pin: 'worker', model: 'opus' };
  assert.equal(run(main('Agent', { subagent_type: 'Explore', prompt: 'x' }), { cfg }).out, null);
  const w = run(main('Agent', { subagent_type: 'tiers:worker', prompt: FULL_BRIEF, model: 'fable' }), { cfg });
  assert.equal(w.out.hookSpecificOutput.updatedInput.model, 'opus');
  const off = run(main('Agent', { subagent_type: 'tiers:worker', prompt: FULL_BRIEF, model: 'fable' }), { cfg: { ...OFF, pin: 'off' } });
  assert.equal(off.out, null);
});

test('enforce on: worker/general-purpose briefs without the four sections are denied, naming the missing ones', () => {
  const r = run(main('Agent', { subagent_type: 'tiers:worker', prompt: '## Goal\nadd a flag please, you know the one\n## Context\nsee repo' }), { cfg: ON });
  assert.equal(decision(r), 'deny');
  const reason = r.out.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /범위 \(Scope\)/);
  assert.match(reason, /완료 기준 \(Done when\)/);
  assert.doesNotMatch(reason, /목표 \(Goal\)\s*,/);
  const gp = run(main('Agent', { prompt: 'fix the bug' }), { cfg: ON });
  assert.equal(decision(gp), 'deny');
  const scout = run(main('Agent', { subagent_type: 'tiers:scout', prompt: 'where is X used?' }), { cfg: ON });
  assert.equal(decision(scout), 'allow'); // pinned, not brief-checked
});

test('enforce on: a complete brief passes, is pinned, and is logged to handoffs/', () => {
  const r = run(main('Agent', { subagent_type: 'tiers:worker', prompt: FULL_BRIEF }), { cfg: ON });
  assert.equal(decision(r), 'allow');
  assert.equal(r.out.hookSpecificOutput.updatedInput.model, 'opus');
  const files = readdirSync(path.join(r.dir, 'handoffs'));
  assert.equal(files.length, 1);
  const body = readFileSync(path.join(r.dir, 'handoffs', files[0]), 'utf8');
  assert.match(body, /agent_type: tiers:worker/);
  assert.match(body, /# Brief/);
  assert.match(body, /--json flag/);
});

test('brief check accepts bold/colon labels and English headings; subagent callers are not checked', () => {
  const bold = `**Goal**: ship the --json flag for bench output so it can be piped to jq.
**Context**: parseArgs at scripts/bench.mjs:40, printTable at :120, user rejected a subcommand.
**Scope**: scripts/bench.mjs and tests only, keep the table format, naming is yours.
**Done when**: node --test tests/ passes and --json prints a JSON array.`;
  assert.equal(decision(run(main('Agent', { subagent_type: 'tiers:worker', prompt: bold }), { cfg: ON })), 'allow');
  const fromSub = run(sub('Agent', { subagent_type: 'tiers:worker', prompt: 'do it' }), { cfg: ON });
  assert.equal(decision(fromSub), 'allow');
});

test('SubagentStop appends the worker report to the matching handoff by prompt hash', () => {
  const first = run(main('Agent', { subagent_type: 'tiers:worker', prompt: FULL_BRIEF }), { cfg: ON });
  const transcript = path.join(first.dir, 'agent-x.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: FULL_BRIEF } }) + '\n');
  const stop = spawnSync('node', [GUARD], {
    input: JSON.stringify({ hook_event_name: 'SubagentStop', session_id: 'sess-1234-abcd', agent_id: 'a9', agent_type: 'tiers:worker',
      agent_transcript_path: transcript, last_assistant_message: '## Status: DONE\n## Changes\n- scripts/bench.mjs — added --json' }),
    encoding: 'utf8', env: { ...process.env, TIERS_DATA_DIR: first.dir, TIERS_DELEGATE: '' },
  });
  assert.equal(stop.status, 0);
  const files = readdirSync(path.join(first.dir, 'handoffs'));
  const body = readFileSync(path.join(first.dir, 'handoffs', files[0]), 'utf8');
  assert.match(body, /# Result \(/);
  assert.match(body, /Status: DONE/);
});

test('TIERS_DELEGATE env overrides the config in both directions', () => {
  const offEnv = run(main('Write', { file_path: 'a.js', content: 'x' }), { cfg: ON, env: { TIERS_DELEGATE: 'off' } });
  assert.equal(offEnv.out, null);
  const onEnv = run(main('Write', { file_path: 'a.js', content: 'x' }), { cfg: OFF, env: { TIERS_DELEGATE: 'on' } });
  assert.equal(decision(onEnv), 'deny');
});

test('missing or corrupt config falls back to defaults (enforce off, pin all); internal errors fail open', () => {
  const r = run(main('Write', { file_path: 'a.js', content: 'x' }));
  assert.equal(r.out, null);
  const dir = mkdtempSync(path.join(tmpdir(), 'tiers-guard-'));
  writeFileSync(path.join(dir, 'delegate.json'), '{not json');
  const res = spawnSync('node', [GUARD], { input: 'also not json', encoding: 'utf8', env: { ...process.env, TIERS_DATA_DIR: dir } });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.ok(existsSync(path.join(dir, 'guard-error.log')));
});
