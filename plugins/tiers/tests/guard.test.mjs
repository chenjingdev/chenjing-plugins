import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
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

function run(input, { cfg, env = {}, dir } = {}) {
  const d = dir || mkdtempSync(path.join(tmpdir(), 'tiers-guard-'));
  if (cfg) writeFileSync(path.join(d, 'delegate.json'), JSON.stringify(cfg));
  const res = spawnSync('node', [GUARD], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, TIERS_DATA_DIR: d, TIERS_DELEGATE: '', ...env },
  });
  let out = null;
  if (res.stdout.trim()) out = JSON.parse(res.stdout);
  return { out, dir: d, status: res.status, stderr: res.stderr };
}

const main = (tool_name, tool_input, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: 'sess-1234-abcd', cwd: '/proj', tool_name, tool_input, ...extra,
});
const sub = (tool_name, tool_input) => main(tool_name, tool_input, { agent_id: 'a1', agent_type: 'tiers:worker' });
const ON = { enabled: true, model: 'opus' };
const OFF = { enabled: false, model: 'opus' };
const decision = (r) => r.out?.hookSpecificOutput?.permissionDecision ?? null;

test('delegate off: the hook is silent — edits pass and nothing is pinned', () => {
  const edit = run(main('Edit', { file_path: 'a.js', old_string: 'x'.repeat(500), new_string: 'y'.repeat(500) }), { cfg: OFF });
  assert.equal(edit.out, null);
  assert.equal(edit.status, 0);
  assert.equal(run(main('Write', { file_path: 'a.js', content: 'x' }), { cfg: OFF }).out, null);
  assert.equal(run(main('Bash', { command: 'echo hi > src/out.txt' }), { cfg: OFF }).out, null);
  for (const subagent_type of ['tiers:worker', 'Explore', 'general-purpose']) {
    assert.equal(run(main('Agent', { subagent_type, prompt: 'just do it' }), { cfg: OFF }).out, null, subagent_type);
  }
});

test('delegate on: main Edit above the small-edit limit is denied with delegation instructions', () => {
  const r = run(main('Edit', { file_path: 'a.js', old_string: 'x'.repeat(150), new_string: 'y'.repeat(150) }), { cfg: ON });
  assert.equal(decision(r), 'deny');
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /tiers:worker/);
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /완료 기준/);
});

test('delegate on: a small main Edit is allowed; replace_all is not', () => {
  const small = run(main('Edit', { file_path: 'a.js', old_string: 'foo', new_string: 'bar' }), { cfg: ON });
  assert.equal(small.out, null);
  const ra = run(main('Edit', { file_path: 'a.js', old_string: 'foo', new_string: 'bar', replace_all: true }), { cfg: ON });
  assert.equal(decision(ra), 'deny');
  const zero = run(main('Edit', { file_path: 'a.js', old_string: 'foo', new_string: 'bar' }), { cfg: { ...ON, small_edit_chars: 0 } });
  assert.equal(decision(zero), 'deny');
});

test('delegate on: main Write/MultiEdit/NotebookEdit denied, subagent edits pass', () => {
  for (const t of ['Write', 'MultiEdit', 'NotebookEdit']) {
    assert.equal(decision(run(main(t, { file_path: 'a.js', content: 'x' }), { cfg: ON })), 'deny', t);
  }
  assert.equal(run(sub('Write', { file_path: 'a.js', content: 'x' }), { cfg: ON }).out, null);
  assert.equal(run(sub('Edit', { file_path: 'a.js', old_string: 'x'.repeat(900), new_string: '' }), { cfg: ON }).out, null);
});

test('delegate on: Bash write patterns are denied unless every target is under tmp', () => {
  const denied = [
    "sed -i 's/a/b/' src/app.js",
    'echo hi > src/out.txt',
    'echo "hi" > src/x.txt',
    'echo x >> notes.md',
    "echo '>' > src/gt.txt",
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

test('delegate on: a > inside quotes or ${...} is not a redirect', () => {
  const allowed = [
    'echo "TIERS_DELEGATE=${TIERS_DELEGATE:-<unset>}"',
    "echo 'a > b'",
    'grep -n "=>" src/a.js',
    "awk '$1 > 3' data.txt",
    "printf '%s\\n' \"x>y\"",
    'echo "pipe | and ; and > all quoted"',
  ];
  for (const c of allowed) assert.equal(run(main('Bash', { command: c }), { cfg: ON }).out, null, c);
});

test('delegate on: a heredoc body is data — it neither hides nor fakes a redirect', () => {
  const body = "don't; echo 'x' | tee a > b";
  // the stray quote in the body must not mask the real redirect on the line after EOF
  const hidden = `cat <<'EOF' > /tmp/a\n${body}\nEOF\necho hi > src/x.txt`;
  assert.equal(decision(run(main('Bash', { command: hidden }), { cfg: ON })), 'deny');
  // ...and the body's own >, ; and | are not writes
  assert.equal(run(main('Bash', { command: `cat <<'EOF' > /tmp/a\na > b\nEOF` }), { cfg: ON }).out, null);
  assert.equal(run(main('Bash', { command: `cat <<'EOF' > /tmp/a\n${body}\nEOF` }), { cfg: ON }).out, null);
  assert.equal(run(main('Bash', { command: `cat <<-EOF > /tmp/a\n\t${body}\n\tEOF` }), { cfg: ON }).out, null);
  // same heredoc, real target: still denied
  assert.equal(decision(run(main('Bash', { command: `cat <<'EOF' > src/new.js\n${body}\nEOF` }), { cfg: ON })), 'deny');
  assert.equal(decision(run(main('Bash', { command: `cat <<EOF >> notes.md\n${body}\nEOF` }), { cfg: ON })), 'deny');
});

test('delegate on: subagent Bash writes are not touched', () => {
  assert.equal(run(sub('Bash', { command: "sed -i 's/a/b/' src/app.js" }), { cfg: ON }).out, null);
});

test('pin all: Agent calls without model get the configured model; fork is untouched', () => {
  const r = run(main('Agent', { subagent_type: 'Explore', prompt: 'find callers' }), { cfg: { ...ON, model: 'sonnet' } });
  assert.equal(decision(r), 'allow');
  assert.equal(r.out.hookSpecificOutput.updatedInput.model, 'sonnet');
  assert.equal(r.out.hookSpecificOutput.updatedInput.prompt, 'find callers');
  const explicit = run(main('Agent', { subagent_type: 'Explore', prompt: 'x', model: 'haiku' }), { cfg: ON });
  assert.equal(explicit.out, null);
  const fork = run(main('Agent', { subagent_type: 'fork', prompt: 'x' }), { cfg: ON });
  assert.equal(fork.out, null);
  const w = run(main('Agent', { subagent_type: 'tiers:worker', prompt: FULL_BRIEF, model: 'fable' }), { cfg: ON });
  assert.equal(w.out.hookSpecificOutput.updatedInput.model, 'opus');
});

test('pin worker: only tiers:worker is pinned, and it is pinned even with an explicit model', () => {
  const cfg = { ...ON, pin: 'worker', model: 'opus' };
  assert.equal(run(main('Agent', { subagent_type: 'Explore', prompt: 'x' }), { cfg }).out, null);
  const w = run(main('Agent', { subagent_type: 'tiers:worker', prompt: FULL_BRIEF, model: 'fable' }), { cfg });
  assert.equal(w.out.hookSpecificOutput.updatedInput.model, 'opus');
});

test('unknown pin values (including the retired "off") fall back to all', () => {
  for (const pin of ['off', 'nonsense', null]) {
    const r = run(main('Agent', { subagent_type: 'Explore', prompt: 'x' }), { cfg: { ...ON, pin } });
    assert.equal(r.out?.hookSpecificOutput?.updatedInput?.model, 'opus', String(pin));
  }
});

test('delegate on: worker/general-purpose briefs without the four sections are denied, naming the missing ones', () => {
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

test('delegate on: a complete brief passes, is pinned, and is logged to handoffs/', () => {
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

test('SubagentStop appends the worker report to the matching handoff by prompt hash, even after the switch is off', () => {
  const first = run(main('Agent', { subagent_type: 'tiers:worker', prompt: FULL_BRIEF }), { cfg: ON });
  writeFileSync(path.join(first.dir, 'delegate.json'), JSON.stringify(OFF)); // turned off while the worker ran
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

test('TIERS_DELEGATE env overrides the config in both directions, pinning included', () => {
  const offEnv = { TIERS_DELEGATE: 'off' };
  assert.equal(run(main('Write', { file_path: 'a.js', content: 'x' }), { cfg: ON, env: offEnv }).out, null);
  assert.equal(run(main('Agent', { subagent_type: 'Explore', prompt: 'x' }), { cfg: ON, env: offEnv }).out, null);
  const onEnv = { TIERS_DELEGATE: 'on' };
  assert.equal(decision(run(main('Write', { file_path: 'a.js', content: 'x' }), { cfg: OFF, env: onEnv })), 'deny');
  const pinned = run(main('Agent', { subagent_type: 'Explore', prompt: 'x' }), { cfg: OFF, env: onEnv });
  assert.equal(pinned.out.hookSpecificOutput.updatedInput.model, 'opus');
});

test('a pre-0.3.1 config with only `enforce` still turns the hook on', () => {
  const cfg = { enforce: true, model: 'opus' };
  assert.equal(decision(run(main('Write', { file_path: 'a.js', content: 'x' }), { cfg })), 'deny');
  const pinned = run(main('Agent', { subagent_type: 'Explore', prompt: 'x' }), { cfg });
  assert.equal(pinned.out.hookSpecificOutput.updatedInput.model, 'opus');
  const both = run(main('Write', { file_path: 'a.js', content: 'x' }), { cfg: { enforce: true, enabled: false } });
  assert.equal(both.out, null); // `enabled` wins when both are present
});

test('delegate on: delegate.json is always writable — and nothing else in the data dir', (t) => {
  // not under tmpdir(): /tmp and /var/folders are allowed by another rule, which would hide the bug
  const dir = mkdtempSync(path.join(homedir(), '.tiers-guard-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgFile = path.join(dir, 'delegate.json');
  const short = `~${dir.slice(homedir().length)}/delegate.json`;
  const at = (input) => run(input, { dir, cfg: { ...ON, small_edit_chars: 0 } });
  // the config file, in every spelling the guard accepts
  assert.equal(at(main('Write', { file_path: cfgFile, content: '{"enabled":false}' })).out, null);
  assert.equal(at(main('Edit', { file_path: cfgFile, old_string: 'x'.repeat(900), new_string: 'y' })).out, null);
  assert.equal(at(main('NotebookEdit', { notebook_path: cfgFile })).out, null); // exercises notebook_path
  assert.equal(at(main('Bash', { command: `cat <<'EOF' > ${cfgFile}\n{"enabled":false}\nEOF` })).out, null);
  assert.equal(at(main('Bash', { command: `node -e "require('fs').writeFileSync('${cfgFile}', '{}')"` })).out, null);
  assert.equal(at(main('Bash', { command: `echo '{}' > ${short}` })).out, null);
  assert.equal(at(main('Bash', { command: 'echo \'{}\' > $CLAUDE_PLUGIN_DATA/delegate.json' })).out, null);
  assert.equal(at(main('Bash', { command: 'echo \'{}\' > ${CLAUDE_PLUGIN_DATA}/delegate.json' })).out, null);
  assert.equal(at(main('Bash', { command: `mkdir -p ${dir}` })).out, null); // mkdir is not a write op
  // everything else in the data dir is the hook's, not the session's
  assert.equal(decision(at(main('Write', { file_path: path.join(dir, 'handoffs', 'a.md'), content: 'x' }))), 'deny');
  assert.equal(decision(at(main('Bash', { command: `rm -rf ${dir}` }))), 'deny');
  assert.equal(decision(at(main('Bash', { command: `rm ${dir}/handoffs/x.md` }))), 'deny');
  assert.equal(decision(at(main('Bash', { command: `echo x > ${dir}/guard-error.log` }))), 'deny');
  const sibling = path.join(path.dirname(dir), '.tiers-guard-sibling.json');
  assert.equal(decision(at(main('Write', { file_path: sibling, content: '{}' }))), 'deny');
  assert.equal(decision(at(main('Bash', { command: `echo x > ${sibling}` }))), 'deny');
});

test('missing or corrupt config falls back to defaults (delegate off, pin all); internal errors fail open', () => {
  const r = run(main('Write', { file_path: 'a.js', content: 'x' }));
  assert.equal(r.out, null);
  assert.equal(run(main('Agent', { subagent_type: 'Explore', prompt: 'x' })).out, null);
  const dir = mkdtempSync(path.join(tmpdir(), 'tiers-guard-'));
  writeFileSync(path.join(dir, 'delegate.json'), '{not json');
  const res = spawnSync('node', [GUARD], { input: 'also not json', encoding: 'utf8', env: { ...process.env, TIERS_DATA_DIR: dir } });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.ok(existsSync(path.join(dir, 'guard-error.log')));
});
