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

test('delegate on: main Edit above the small-edit limit is denied with a short handoff note', () => {
  const r = run(main('Edit', { file_path: 'a.js', old_string: 'x'.repeat(150), new_string: 'y'.repeat(150) }), { cfg: ON });
  assert.equal(decision(r), 'deny');
  const reason = r.out.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /tiers:worker/);
  assert.match(reason, /\/tiers:delegate off/);
  // short on purpose: the brief template belongs to the brief check, not to every denied edit
  assert.ok(reason.split('\n').length <= 2, `${reason.split('\n').length} lines: ${reason}`);
  assert.ok(reason.length <= 300, `${reason.length} chars: ${reason}`);
  assert.doesNotMatch(reason, /완료 기준|Escape hatches/);
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

// non-prose targets on purpose: .md/.txt are the main session's to write (see the prose tests below),
// so a prose extension here would test the prose rule, not the write-op detection this test is about.
test('delegate on: Bash write patterns are denied unless every target is under tmp', () => {
  const denied = [
    "sed -i 's/a/b/' src/app.js",
    "sed -i 's/a/b/'", // the script is not a path, so this has no readable target at all
    'echo hi > src/out.log',
    'echo "hi" > src/x.log',
    'echo x >> notes.log',
    "echo '>' > src/gt.log",
    "cat <<'EOF' > src/new.js\nhello\nEOF",
    'cp /tmp/x.js src/x.js',
    'rm -rf dist',
    'git apply fix.patch',
    'python3 -c "open(\'src/a.py\',\'w\').write(1)"',
    'node -e "require(\'fs\').writeFileSync(\'a.json\', \'{}\')"',
    'printf x | tee src/a.log',
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
  const hidden = `cat <<'EOF' > /tmp/a\n${body}\nEOF\necho hi > src/x.js`;
  assert.equal(decision(run(main('Bash', { command: hidden }), { cfg: ON })), 'deny');
  // ...and the body's own >, ; and | are not writes
  assert.equal(run(main('Bash', { command: `cat <<'EOF' > /tmp/a\na > b\nEOF` }), { cfg: ON }).out, null);
  assert.equal(run(main('Bash', { command: `cat <<'EOF' > /tmp/a\n${body}\nEOF` }), { cfg: ON }).out, null);
  assert.equal(run(main('Bash', { command: `cat <<-EOF > /tmp/a\n\t${body}\n\tEOF` }), { cfg: ON }).out, null);
  // same heredoc, real target: still denied
  assert.equal(decision(run(main('Bash', { command: `cat <<'EOF' > src/new.js\n${body}\nEOF` }), { cfg: ON })), 'deny');
  assert.equal(decision(run(main('Bash', { command: `cat <<EOF >> notes.log\n${body}\nEOF` }), { cfg: ON })), 'deny');
});

test('delegate on: subagent Bash writes are not touched', () => {
  assert.equal(run(sub('Bash', { command: "sed -i 's/a/b/' src/app.js" }), { cfg: ON }).out, null);
});

test('prose: the main session writes human-facing text itself, at any size and by any tool', () => {
  const long = 'a'.repeat(300);
  assert.equal(run(main('Edit', { file_path: 'README.md', old_string: long, new_string: 'b' }), { cfg: ON }).out, null);
  assert.equal(run(main('Write', { file_path: 'docs/notes.txt', content: long }), { cfg: ON }).out, null);
  assert.equal(run(main('Write', { file_path: 'README.MD', content: long }), { cfg: ON }).out, null); // case-insensitive
  assert.equal(run(main('Bash', { command: 'printf x >> CHANGELOG.md' }), { cfg: ON }).out, null);
  assert.equal(run(main('Bash', { command: "sed -i '' s/a/b/ README.md" }), { cfg: ON }).out, null);
  assert.equal(run(main('Bash', { command: "sed -i 's/a/b/' docs/guide.rst" }), { cfg: ON }).out, null);
  // code is still the worker's
  assert.equal(decision(run(main('Edit', { file_path: 'a.js', old_string: long, new_string: 'b' }), { cfg: ON })), 'deny');
  assert.equal(decision(run(main('Bash', { command: 'printf x >> src/a.js' }), { cfg: ON })), 'deny');
  assert.equal(decision(run(main('Bash', { command: 'cp README.md src/a.js' }), { cfg: ON })), 'deny'); // one non-prose target is enough
});

test('prose: the worker may not write it, and is told where to put the text instead', () => {
  const r = run(sub('Edit', { file_path: 'README.md', old_string: 'x', new_string: 'y' }), { cfg: ON });
  assert.equal(decision(r), 'deny');
  const reason = r.out.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /Docs for the session/);
  assert.ok(reason.split('\n').length <= 2, `${reason.split('\n').length} lines: ${reason}`);
  for (const t of ['Write', 'MultiEdit']) {
    assert.equal(decision(run(sub(t, { file_path: 'docs/handover.md', content: 'x' }), { cfg: ON })), 'deny', t);
  }
  assert.equal(decision(run(sub('Bash', { command: "sed -i '' s/a/b/ README.md" }), { cfg: ON })), 'deny');
  assert.equal(decision(run(sub('Bash', { command: 'echo x > notes.txt' }), { cfg: ON })), 'deny');
  assert.equal(decision(run(sub('Bash', { command: 'printf x | tee docs/a.rst' }), { cfg: ON })), 'deny');
  // code, tests, config and everyday Bash stay the worker's
  assert.equal(run(sub('Write', { file_path: 'src/a.js', content: 'x' }), { cfg: ON }).out, null);
  assert.equal(run(sub('Bash', { command: 'echo x > build.log' }), { cfg: ON }).out, null);
  assert.equal(run(sub('Bash', { command: 'node --test tests/ > /tmp/out' }), { cfg: ON }).out, null);
});

test('prose: a scratch note under tmp is not a document — the worker may write it', () => {
  const allowed = [
    main('Write', { file_path: '/tmp/notes.md', content: 'x' }),
    main('Write', { file_path: '/private/tmp/claude-501/scratchpad/plan.md', content: 'x' }),
    main('Edit', { file_path: '/var/folders/ab/cd/T/draft.txt', old_string: 'a', new_string: 'b' }),
    main('Bash', { command: 'echo x > /tmp/notes.md' }),
    main('Bash', { command: "sed -i '' s/a/b/ /tmp/notes.md" }),
  ];
  for (const i of allowed) assert.equal(run({ ...i, agent_id: 'a1', agent_type: 'tiers:worker' }, { cfg: ON }).out, null, JSON.stringify(i.tool_input));
  // ...but a document in the repo is still denied
  assert.equal(decision(run(sub('Write', { file_path: 'docs/notes.md', content: 'x' }), { cfg: ON })), 'deny');
  assert.equal(decision(run(sub('Bash', { command: 'cp /tmp/notes.md docs/notes.md' }), { cfg: ON })), 'deny');
});

test('prose: the worker side denies only when it is sure — an unknown target passes', () => {
  const pass = [
    'echo x > "$OUT"',            // target is a variable — not readable as prose, so not blocked
    "sed -i 's/a/b/' $FILE",
    'git apply fix.patch',        // unknown targets, none of them readable as prose
    'rm -rf dist',
    "python3 -c \"open('src/a.py','w').write(1)\"",
  ];
  for (const c of pass) assert.equal(run(sub('Bash', { command: c }), { cfg: ON }).out, null, c);
  // an unknown *directory* is still a known prose file
  assert.equal(decision(run(sub('Bash', { command: 'echo x > ${DOC}/a.md' }), { cfg: ON })), 'deny');
});

test('prose: only tiers:worker is held to it — other subagents and an unlabelled one pass', () => {
  for (const agent_type of ['general-purpose', 'tiers:scout', 'Explore']) {
    const r = run(main('Edit', { file_path: 'README.md', old_string: 'x'.repeat(300), new_string: 'y' }, { agent_id: 'a1', agent_type }), { cfg: ON });
    assert.equal(r.out, null, agent_type);
  }
  const unlabelled = run(main('Edit', { file_path: 'README.md', old_string: 'x'.repeat(300), new_string: 'y' }, { agent_id: 'a1' }), { cfg: ON });
  assert.equal(unlabelled.out, null);
});

test('prose: an empty list turns the rule off; a malformed one falls back to the defaults', () => {
  const edit = (cfg) => ({ mainR: run(main('Edit', { file_path: 'README.md', old_string: 'x'.repeat(300), new_string: 'y' }), { cfg }),
    subR: run(sub('Edit', { file_path: 'README.md', old_string: 'x', new_string: 'y' }), { cfg }) });
  const off = edit({ ...ON, prose: [] });
  assert.equal(decision(off.mainR), 'deny');   // back to "the main session doesn't implement"
  assert.equal(off.subR.out, null);
  for (const prose of ['md', ['md'], null, 42]) {
    const r = edit({ ...ON, prose });
    assert.equal(r.mainR.out, null, JSON.stringify(prose));
    assert.equal(decision(r.subR), 'deny', JSON.stringify(prose));
  }
  const custom = edit({ ...ON, prose: ['.MD'] }); // normalised to lower case
  assert.equal(custom.mainR.out, null);
  assert.equal(decision(custom.subR), 'deny');
  assert.equal(run(sub('Edit', { file_path: 'notes.txt', old_string: 'x', new_string: 'y' }), { cfg: { ...ON, prose: ['.md'] } }).out, null);
});

test('prose: the switch still governs it — off means the worker writes prose too', () => {
  assert.equal(run(sub('Edit', { file_path: 'README.md', old_string: 'x', new_string: 'y' }), { cfg: OFF }).out, null);
  assert.equal(run(sub('Bash', { command: 'echo x > README.md' }), { cfg: OFF }).out, null);
  assert.equal(run(sub('Edit', { file_path: 'README.md', old_string: 'x', new_string: 'y' }), { cfg: ON, env: { TIERS_DELEGATE: 'off' } }).out, null);
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

test('SubagentStop twice on the same brief appends both reports to that one handoff, in order', () => {
  // The SendMessage flow: the worker stops, gets a follow-up, stops again. Its transcript still
  // opens with the original brief, so both reports belong to the handoff that brief created.
  const OTHER_BRIEF = FULL_BRIEF.replace('--json flag', '--csv flag');
  const first = run(main('Agent', { subagent_type: 'tiers:worker', prompt: FULL_BRIEF }), { cfg: ON });
  run(main('Agent', { subagent_type: 'tiers:worker', prompt: OTHER_BRIEF }), { cfg: ON, dir: first.dir });
  const transcript = path.join(first.dir, 'agent-x.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: FULL_BRIEF } }) + '\n');
  const stop = (last_assistant_message) => spawnSync('node', [GUARD], {
    input: JSON.stringify({ hook_event_name: 'SubagentStop', session_id: 'sess-1234-abcd', agent_id: 'a9', agent_type: 'tiers:worker',
      agent_transcript_path: transcript, last_assistant_message }),
    encoding: 'utf8', env: { ...process.env, TIERS_DATA_DIR: first.dir, TIERS_DELEGATE: '' },
  });
  assert.equal(stop('## Status: BLOCKED\nwhich flag name?').status, 0);
  assert.equal(stop('## Status: DONE\n- scripts/bench.mjs — added --json').status, 0);

  const hdir = path.join(first.dir, 'handoffs');
  const files = readdirSync(hdir);
  assert.equal(files.length, 2);
  const bodies = files.map((f) => readFileSync(path.join(hdir, f), 'utf8'));
  const mine = bodies.find((b) => b.includes('--json flag'));
  const other = bodies.find((b) => b.includes('--csv flag'));
  assert.equal((mine.match(/# Result \(/g) || []).length, 2);
  assert.ok(mine.indexOf('Status: BLOCKED') < mine.indexOf('Status: DONE'));
  assert.match(mine, /# Result \([^)]*, round 2\)/);
  assert.ok(!other.includes('# Result'), 'the other brief\'s handoff stays untouched');
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
  // everything else in the data dir is the hook's, not the session's — the prose rule does not
  // reach in here, even though a handoff record really is a .md file
  assert.equal(decision(at(main('Write', { file_path: path.join(dir, 'handoffs', 'a.md'), content: 'x' }))), 'deny');
  assert.equal(decision(at(main('Bash', { command: `rm -rf ${dir}` }))), 'deny');
  assert.equal(decision(at(main('Bash', { command: `rm ${dir}/handoffs/x.md` }))), 'deny');
  assert.equal(decision(at(main('Edit', { file_path: `${short.replace('/delegate.json', '')}/handoffs/x.md`, old_string: 'a', new_string: 'b' }))), 'deny');
  assert.equal(decision(at(main('Bash', { command: 'echo x > $CLAUDE_PLUGIN_DATA/handoffs/x.md' }))), 'deny');
  assert.equal(decision(at(main('Bash', { command: 'echo x > ${CLAUDE_PLUGIN_DATA}/notes.md' }))), 'deny');
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

// ---------- SessionStart: the role text ----------
const ROLE = path.join(here, '..', 'skills', 'delegate', 'references', 'role.md');
const start = (extra = {}) => ({ hook_event_name: 'SessionStart', session_id: 'sess-1234-abcd', cwd: '/proj', source: 'startup', ...extra });
const context = (r) => r.out?.hookSpecificOutput?.additionalContext ?? null;

test('SessionStart: delegate on injects references/role.md as additionalContext', () => {
  const r = run(start(), { cfg: ON });
  assert.equal(r.status, 0);
  assert.equal(r.out.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = context(r);
  assert.match(ctx, /tiers:worker/);
  assert.match(ctx, /tiers:scout/);
  assert.equal(ctx, readFileSync(ROLE, 'utf8').trim()); // role.md is the only source, emitted as written
});

test('SessionStart: delegate off says nothing at all', () => {
  const r = run(start(), { cfg: OFF });
  assert.equal(r.out, null);
  assert.equal(r.status, 0);
});

test('SessionStart: a subagent gets nothing — it has its own start event and prompt', () => {
  const r = run(start({ agent_id: 'a1', agent_type: 'tiers:worker' }), { cfg: ON });
  assert.equal(r.out, null);
  assert.equal(r.status, 0);
});

test('SessionStart: the TIERS_DELEGATE env switch governs it too', () => {
  const r = run(start(), { cfg: ON, env: { TIERS_DELEGATE: 'off' } });
  assert.equal(r.out, null);
  assert.equal(r.status, 0);
});
