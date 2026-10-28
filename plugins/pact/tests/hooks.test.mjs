// 훅은 손으로 만든 입력 JSON을 stdin으로 넣고 자식 프로세스로 돌려 시험한다. 실제 Claude Code를 띄우는 시험은 검수 때 따로 한다(R18).
// 모든 시험은 CLAUDE_PLUGIN_DATA와 HOME을 임시 폴더로 돌려서, 진짜 ~/.claude 밑에는 아무것도 쓰지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, symlinkSync, utimesSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PACT_AGENTS, touchesPact, denyOutput, allowOutput } from '../hooks/guard.mjs';
import { LOGGED_AGENTS, readRecords, latestSpecCheckerReply, latestWorkerReply, latestVerifierFingerprint } from '../scripts/run-log.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'hooks', 'guard.mjs');
const ID = '2026-10-29-출결-관리';

const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// 판 하나의 놀이터. data(플러그인 데이터 폴더)는 만들지 않는다: 훅이 만들어야 생긴다.
function world() {
  const root = mkdtempSync(path.join(tmpdir(), 'pact-hook-'));
  made.push(root);
  const project = path.join(root, 'project');
  mkdirSync(path.join(project, 'docs', 'pact'), { recursive: true });
  mkdirSync(path.join(root, 'home'));
  return {
    root, project, n: 0,
    home: path.join(root, 'home'),
    data: path.join(root, 'plugin-data'),
    run: path.join(project, '.pact', ID),
    spec: path.join(project, 'docs', 'pact', `${ID}.md`),
  };
}

// 명세 파일. mtime은 초 단위 숫자.
function writeSpec(project, id, { status = 'building', mtime } = {}) {
  const file = path.join(project, 'docs', 'pact', `${id}.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\npact: 2\ntopic: x\nstatus: ${status}\n---\n# x\n## 기능\n- F1 오늘 수업 출석 현황 보기 [사용자]\n## 공통 규칙\n`);
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
}

const baseEnv = (w) => ({ ...process.env, CLAUDE_PLUGIN_DATA: w.data, HOME: w.home });

// 훅을 돌린다. 어떤 입력이든 종료 코드는 0이어야 한다.
function runHook(w, input, { env } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd: w.root, // 훅 프로세스의 cwd는 프로젝트와 상관없는 곳
    env: env ?? baseEnv(w),
  });
  assert.equal(r.status, 0, `종료 코드 0이어야 한다: ${r.stderr}`);
  return r;
}

function transcript(w, prompt) {
  const dir = path.join(w.root, 'transcripts');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${++w.n}.jsonl`);
  const first = { type: 'user', isSidechain: true, message: { role: 'user', content: prompt } };
  const second = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '작업 중' }] } };
  writeFileSync(file, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
  return file;
}

function stopInput(w, agentType, prompt, message, extra = {}) {
  return {
    hook_event_name: 'SubagentStop', session_id: 'session-1', cwd: w.project, permission_mode: 'default', stop_hook_active: false,
    agent_id: `agent-${w.n + 1}`, agent_type: agentType, agent_transcript_path: transcript(w, prompt), last_assistant_message: message, ...extra,
  };
}

// SubagentStop은 어떤 경우에도 막는 출력을 내지 않는다: stdout도 stderr도 비어 있어야 한다.
function stop(w, input) {
  const r = runHook(w, input);
  assert.equal(r.stdout, '', 'SubagentStop은 아무것도 출력하지 않는다');
  assert.equal(r.stderr, '');
  return r;
}

const errorLog = (w) => path.join(w.data, 'hook-error.log');
const errorLines = (w) => (existsSync(errorLog(w)) ? readFileSync(errorLog(w), 'utf8').split('\n').filter(Boolean) : []);

// 폴더 안의 모든 것과 파일 내용의 지문. 전과 후를 비교해 "아무 파일도 생기거나 바뀌지 않음"을 본다.
function tree(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      const rel = path.relative(dir, p);
      if (statSync(p).isDirectory()) { out.push(`${rel}/`); walk(p); } else out.push(`${rel}:${sha(readFileSync(p))}`);
    }
  };
  walk(dir);
  return out;
}

// pact 판이 하나 있는 놀이터: 명세, 실행 폴더, 이미 쌓인 기록.
function busyWorld() {
  const w = world();
  writeSpec(w.project, ID);
  mkdirSync(path.join(w.run, 'log'), { recursive: true });
  writeFileSync(path.join(w.run, 'log', 'subagents.jsonl'), '{"agent_type":"pact:worker","message":"앞 기록"}\n');
  writeFileSync(path.join(w.run, 'results.json'), '{"scenarios":[]}\n');
  return w;
}

// ---------- hooks.json ----------

test('hooks.json hangs one script on PreToolUse and SubagentStop through ${CLAUDE_PLUGIN_ROOT}', () => {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ['PreToolUse', 'SubagentStop']);
  assert.equal(cfg.hooks.PreToolUse.length, 1);
  assert.equal(cfg.hooks.PreToolUse[0].matcher, 'Agent|SendMessage|Edit|Write|MultiEdit|NotebookEdit|Bash');
  assert.equal(cfg.hooks.SubagentStop.length, 1);
  const hooks = [...cfg.hooks.PreToolUse, ...cfg.hooks.SubagentStop].flatMap((group) => group.hooks);
  assert.equal(hooks.length, 2);
  for (const hook of hooks) {
    assert.equal(hook.type, 'command');
    assert.ok(hook.timeout > 0, 'timeout이 있다');
  }
  assert.equal(new Set(hooks.map((h) => h.command)).size, 1, '훅 스크립트는 하나다');
  const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[^"]+)"$/.exec(hooks[0].command);
  assert.ok(m, hooks[0].command);
  assert.ok(existsSync(path.join(ROOT, m[1])), `${m[1]}가 있다`);
});

test('the command line in hooks.json, run by a shell with ${CLAUDE_PLUGIN_ROOT} set, actually runs the hook', () => {
  const w = world();
  mkdirSync(w.run, { recursive: true });
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const env = { ...baseEnv(w), CLAUDE_PLUGIN_ROOT: ROOT };
  const sh = (command, input) => spawnSync('sh', ['-c', command], { input: JSON.stringify(input), encoding: 'utf8', cwd: w.root, env });

  const stopped = sh(cfg.hooks.SubagentStop[0].hooks[0].command, stopInput(w, 'pact:worker', `run-dir: ${w.run} , 작업 번호 1`, '끝'));
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.stdout, '');
  assert.deepEqual(readRecords(w.run).map((r) => r.agent_type), ['pact:worker']);

  const before = tree(w.root);
  const pre = sh(cfg.hooks.PreToolUse[0].hooks[0].command, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(pre.stdout, '');
  assert.deepEqual(tree(w.root), before);
});

test('the hook still runs when the plugin folder is reached through a symbolic link', () => {
  // import.meta.url는 링크를 푼 경로이고 process.argv[1]은 풀지 않는다. 둘을 그대로 비교하면 훅이 소리 없이 아무것도 안 한다.
  const w = world();
  mkdirSync(w.run, { recursive: true });
  const link = path.join(w.root, 'plugin-link');
  symlinkSync(ROOT, link);
  const input = stopInput(w, 'pact:worker', `run-dir: ${w.run} , 작업 번호 1`, '끝');
  const r = spawnSync(process.execPath, [path.join(link, 'hooks', 'guard.mjs')], { input: JSON.stringify(input), encoding: 'utf8', cwd: w.root, env: baseEnv(w) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.deepEqual(readRecords(w.run).map((x) => x.agent_type), ['pact:worker']);
  const bad = spawnSync(process.execPath, [path.join(link, 'hooks', 'guard.mjs')], { input: 'not json', encoding: 'utf8', cwd: w.root, env: baseEnv(w) });
  assert.equal(bad.status, 0);
  assert.equal(errorLines(w).length, 1);
});

test('every tool the PreToolUse matcher lists is one touchesPact knows, so a new matcher entry cannot slip in unchecked', () => {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const samples = {
    Agent: { subagent_type: 'pact:worker', prompt: 'x' },
    SendMessage: { to: 'agent-1', message: '`.pact/2026-10-29-x/tasks/1-report.md`를 고쳐 주세요' },
    Edit: { file_path: '/p/.pact/r/results.json' },
    Write: { file_path: '/p/docs/pact/a.md' },
    MultiEdit: { file_path: '/p/.pact/r/log/subagents.jsonl' },
    NotebookEdit: { notebook_path: '/p/.pact/r/a.ipynb' },
    Bash: { command: 'node /x/pact/scripts/spec.mjs status a.md' },
  };
  const tools = cfg.hooks.PreToolUse[0].matcher.split('|');
  assert.deepEqual([...tools].sort(), Object.keys(samples).sort());
  for (const tool of tools) assert.equal(touchesPact({ tool_name: tool, tool_input: samples[tool] }), true, tool);
});

test('the agents the hook records are the agents the log module knows', () => {
  assert.deepEqual([...PACT_AGENTS].sort(), [...LOGGED_AGENTS].sort());
});

// ---------- 싼 검사 ----------

test('touchesPact: pact agents, .pact/ and docs/pact/ paths and pact scripts are pact calls; everything else is not', () => {
  const yes = [
    { tool_name: 'Agent', tool_input: { subagent_type: 'pact:spec-checker' } },
    { tool_name: 'Agent', tool_input: { subagent_type: 'pact:reviewer' } },
    { tool_name: 'Agent', tool_input: { subagent_type: 'pact:verifier' } },
    { tool_name: 'Write', tool_input: { file_path: '/p/.pact/r/results.json', content: 'x' } },
    { tool_name: 'Edit', tool_input: { file_path: 'docs/pact/2026-10-29-x.md' } },
    { tool_name: 'Bash', tool_input: { command: 'cat .pact/r/log/subagents.jsonl' } },
    { tool_name: 'Bash', tool_input: { command: 'echo x > docs/pact/a.md' } },
    { tool_name: 'Bash', tool_input: { command: 'node ~/.claude/plugins/cache/chenjing-plugins/pact/0.6.0/scripts/verification.mjs finish a.md .' } },
    { tool_name: 'Bash', tool_input: { command: 'cd /x && node plugins/pact/scripts/report.mjs /p/run' } },
    { tool_name: 'SendMessage', tool_input: { to: 'a', message: { text: 'pact:worker 야 고쳐라' } } },
  ];
  const no = [
    { tool_name: 'Agent', tool_input: { subagent_type: 'tiers:worker', prompt: 'run-dir: /p/.pact/r' } },
    { tool_name: 'Agent', tool_input: { subagent_type: 'Explore' } },
    { tool_name: 'Agent', tool_input: { subagent_type: 'pact:pact' } },
    { tool_name: 'Agent', tool_input: { subagent_type: 'pact:workers' } },
    { tool_name: 'Agent', tool_input: { subagent_type: 'worker' } },
    { tool_name: 'Agent', tool_input: { prompt: 'general purpose' } },
    { tool_name: 'Write', tool_input: { file_path: '/tmp/a.md', content: '.pact/와 docs/pact/를 설명하는 글' } },
    { tool_name: 'Edit', tool_input: { file_path: '/p/src/impact/index.js' } },
    { tool_name: 'Bash', tool_input: { command: 'ls -la && git status' } },
    { tool_name: 'Bash', tool_input: { command: 'npm test && node scripts/build.mjs' } },
    { tool_name: 'Bash', tool_input: { command: 'grep -r impact docs/impact' } },
    { tool_name: 'SendMessage', tool_input: { to: 'agent-1', message: 'hello' } },
    { tool_name: 'Read', tool_input: { file_path: '/p/.pact/r/results.json' } },
    // 모양이 이상한 입력도 던지지 않는다
    undefined, null, {}, { tool_name: 'Bash' }, { tool_name: 'Bash', tool_input: 'text' }, { tool_name: 'Write', tool_input: null },
    { tool_name: 'Edit', tool_input: { file_path: 42 } },
  ];
  for (const input of yes) assert.equal(touchesPact(input), true, JSON.stringify(input));
  for (const input of no) assert.equal(touchesPact(input), false, JSON.stringify(input));
});

test('denyOutput says why and what to do instead on one line, and allowOutput passes an updated input', () => {
  const deny = denyOutput('results.json은 verifier만 쓴다.\n', '고치려면\n  pact:verifier에게 다시 검수를 맡기세요.');
  assert.deepEqual(Object.keys(deny), ['hookSpecificOutput']);
  assert.equal(deny.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  const reason = deny.hookSpecificOutput.permissionDecisionReason;
  assert.equal(reason, '[pact] results.json은 verifier만 쓴다. 고치려면 pact:verifier에게 다시 검수를 맡기세요.');
  assert.doesNotMatch(reason, /\n/);
  assert.equal(denyOutput('까닭만').hookSpecificOutput.permissionDecisionReason, '[pact] 까닭만');
  const allow = allowOutput({ prompt: '바뀐 지시' });
  assert.deepEqual(allow.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { prompt: '바뀐 지시' } });
});

// ---------- (a) pact와 무관한 호출은 아무것도 하지 않는다 ----------

test('(a) a PreToolUse call that has nothing to do with pact prints nothing, exits 0 and creates no file', () => {
  const w = busyWorld();
  const calls = [
    { tool_name: 'Write', tool_input: { file_path: path.join(w.root, 'other', 'notes.txt'), content: `.pact/와 docs/pact/가 글에 있어도 상관없다 ${w.run}` } },
    { tool_name: 'Edit', tool_input: { file_path: '/tmp/x/a.js', old_string: 'a', new_string: 'b' } },
    { tool_name: 'MultiEdit', tool_input: { file_path: path.join(w.project, 'src', 'a.js'), edits: [] } },
    { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(w.project, 'a.ipynb') } },
    { tool_name: 'Agent', tool_input: { subagent_type: 'tiers:worker', prompt: `run-dir: ${w.run}` } },
    { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: `look at ${w.spec}` } },
    { tool_name: 'Agent', tool_input: { prompt: 'general purpose agent' } },
    { tool_name: 'Bash', tool_input: { command: 'ls -la && git status' } },
    { tool_name: 'SendMessage', tool_input: { to: 'agent-7', message: '고쳐 주세요' } },
    { tool_name: 'Bash' },
  ];
  const before = tree(w.root);
  for (const [i, call] of calls.entries()) {
    const caller = i % 2 ? { agent_id: 'agent-1', agent_type: 'tiers:worker' } : {};
    const r = runHook(w, { hook_event_name: 'PreToolUse', session_id: 's', cwd: w.project, ...caller, ...call });
    assert.equal(r.stdout, '', JSON.stringify(call));
    assert.equal(r.stderr, '');
  }
  assert.deepEqual(tree(w.root), before, '아무 파일도 생기거나 바뀌지 않는다');
  assert.equal(existsSync(w.data), false, '플러그인 데이터 폴더도 만들지 않는다');
});

test('(a) a SubagentStop from an agent that is not a pact agent prints nothing, exits 0 and leaves everything alone', () => {
  const w = busyWorld();
  const before = tree(w.root);
  // 첫 지시에 pact 실행 폴더가 들어 있어도, 없는 대화 기록 경로여도 읽지도 쓰지도 않는다
  const prompt = `run-dir: ${w.run} , 작업 번호 1`;
  const kinds = ['tiers:worker', 'Explore', 'general-purpose', 'worker', 'reviewer', 'pact:workers', 'notpact:worker', 'pact', 'pact:pact', ''];
  const inputs = [];
  for (const [i, type] of kinds.entries()) {
    const input = stopInput(w, type, prompt, '끝');
    inputs.push(i % 2 ? { ...input, agent_transcript_path: path.join(w.root, 'nope', 'agent.jsonl') } : input);
  }
  inputs.push({ hook_event_name: 'SubagentStop', cwd: w.project, last_assistant_message: '끝' }); // agent_type이 없다
  const snapshot = tree(w.root); // 대화 기록 파일은 이미 만들어졌다
  for (const input of inputs) stop(w, input);
  assert.deepEqual(tree(w.root), snapshot);
  assert.deepEqual(snapshot.filter((x) => !x.startsWith('transcripts')), before.filter((x) => !x.startsWith('transcripts')));
  assert.equal(existsSync(w.data), false);
});

test('a PreToolUse call that does touch pact is not blocked either (this version blocks nothing)', () => {
  const w = busyWorld();
  const calls = [
    { tool_name: 'Write', tool_input: { file_path: path.join(w.run, 'results.json'), content: '{}' } },
    { tool_name: 'Edit', tool_input: { file_path: w.spec, old_string: 'a', new_string: 'b' } },
    { tool_name: 'MultiEdit', tool_input: { file_path: path.join(w.run, 'log', 'subagents.jsonl'), edits: [] } },
    { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(w.run, 'x.ipynb') } },
    { tool_name: 'Agent', tool_input: { subagent_type: 'pact:worker', prompt: `run-dir: ${w.run}` } },
    { tool_name: 'Agent', tool_input: { subagent_type: 'pact:reviewer', prompt: `${w.run}/tasks/1-report.md` } },
    { tool_name: 'Bash', tool_input: { command: `node ${ROOT}/scripts/spec.mjs set-status ${w.spec} approved` } },
    { tool_name: 'Bash', tool_input: { command: `echo x > ${w.run}/log/subagents.jsonl` } },
    { tool_name: 'SendMessage', tool_input: { to: 'agent-1', message: `고쳐 주세요: ${w.run}/tasks/1-report.md` } },
  ];
  const before = tree(w.root);
  for (const [i, call] of calls.entries()) {
    assert.equal(touchesPact(call), true, `pact 호출로 보인다: ${JSON.stringify(call)}`);
    const caller = i % 2 ? { agent_id: 'agent-1', agent_type: 'pact:worker' } : {};
    const r = runHook(w, { hook_event_name: 'PreToolUse', session_id: 's', cwd: w.project, ...caller, ...call });
    assert.equal(r.stdout, '', JSON.stringify(call));
  }
  assert.deepEqual(tree(w.root), before);
});

// ---------- (b) worker ----------

test('(b) a pact:worker stop is appended to the log/ of the run in its first instruction; stopping twice leaves two records', () => {
  const w = world();
  mkdirSync(w.run, { recursive: true }); // 실행 폴더는 있고 log/는 없다
  const prompt = `## 목표\n훅을 넣는다\n## 맥락\nrun-dir: ${w.run} , 작업 번호 1. 보고서는 이 run-dir의 tasks/1-report.md.\nworktree: ${w.run}/wt\n## 범위\n…`;
  const message = `## 상태: DONE\n## 바꾼 파일\n- hooks/guard.mjs — 훅\n## 걱정·위험\n- 없음\n보고서: ${w.run}/tasks/1-report.md`;
  const input = stopInput(w, 'pact:worker', prompt, message, { agent_id: 'agent-w1' });
  const logFile = path.join(w.run, 'log', 'subagents.jsonl');
  assert.equal(existsSync(path.join(w.run, 'log')), false);

  stop(w, input);
  const lines = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const [first] = lines();
  assert.deepEqual(Object.keys(first), ['time', 'agent_type', 'agent_id', 'task', 'message']);
  assert.equal(first.agent_type, 'pact:worker');
  assert.equal(first.agent_id, 'agent-w1');
  assert.equal(first.task, 1);
  assert.equal(first.message, message);
  assert.ok(Math.abs(Date.now() - Date.parse(first.time)) < 60_000, `time은 지금이다: ${first.time}`);
  assert.match(first.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

  stop(w, input); // 같은 입력 한 번 더
  const both = lines();
  assert.equal(both.length, 2);
  assert.deepEqual(both[0], first, '앞 기록은 그대로다: 덮어쓰지 않는다');
  assert.equal(both[1].message, message);
  assert.deepEqual(errorLines(w), []);
});

test('(b) the task number comes from the report line, or from the brief when the reply is a BLOCKED one', () => {
  const w = world();
  mkdirSync(w.run, { recursive: true });
  stop(w, stopInput(w, 'pact:worker', `run-dir: ${w.run} , 작업 번호 2.`, `## 상태: DONE\n보고서: ${w.run}/tasks/2-report.md`));
  stop(w, stopInput(w, 'pact:worker', `run-dir: ${w.run} , 작업 번호 3. 앞 작업 보고서: ${w.run}/tasks/1-report.md, ${w.run}/tasks/2-report.md`, 'BLOCKED: 질문이 있다\n1. 선택지'));
  stop(w, stopInput(w, 'pact:worker', `run-dir: ${w.run}\n앞 작업 보고서: ${w.run}/tasks/1-report.md, ${w.run}/tasks/2-report.md`, 'BLOCKED: 번호를 알 수 없다'));
  assert.deepEqual(readRecords(w.run).map((r) => r.task), [2, 3, null]);
});

test('(b) the run-dir is created when it does not exist yet, together with .pact/.gitignore', () => {
  const w = world();
  writeSpec(w.project, ID);
  assert.equal(existsSync(path.join(w.project, '.pact')), false);
  stop(w, stopInput(w, 'pact:worker', `run-dir: ${w.run} , 작업 번호 1`, '끝'));
  assert.equal(readRecords(w.run).length, 1);
  assert.equal(readFileSync(path.join(w.project, '.pact', '.gitignore'), 'utf8'), '*\n');
});

// ---------- (c) spec-checker, reviewer, verifier ----------

test('(c) spec-checker (spec path only), reviewer (tasks/<n>-report.md) and verifier (run-dir) all land in the log/ of the same run', () => {
  const w = world();
  writeSpec(w.project, ID);
  const checkerReply = '## 이미 답이 있음\n- …\n## 사용자만 답할 수 있음\n1. …\n\n질문 라운드는 이것 한 번뿐입니다.';
  const reviewerReply = '## 명세 대조\n- 빠진 것: 없음\n## 판정: 통과';
  const verifierReply = `통과 3 · 실패 0 · 의심 0 · 미검증 0\n${w.run}/results.json`;
  // 실행 폴더가 아직 없다: spec-checker의 기록이 만든다
  stop(w, stopInput(w, 'pact:spec-checker', `명세 경로: ${w.spec}\n사용자가 말한 요구 목록:\n1. … (사용자 원문)\n프로젝트: ${w.project}`, checkerReply));
  stop(w, stopInput(w, 'pact:reviewer', `worker 보고서: ${w.run}/tasks/2-report.md\nbase abc123 head def456\n관련 명세 항목: F4 [사용자]`, reviewerReply));
  stop(w, stopInput(w, 'pact:verifier', `명세 경로: ${w.spec}\nrun-dir: ${w.run}\n실행 방법: node x.mjs`, verifierReply));

  const records = readRecords(w.run);
  assert.deepEqual(records.map((r) => r.agent_type), ['pact:spec-checker', 'pact:reviewer', 'pact:verifier']);
  assert.deepEqual(records.map((r) => r.message), [checkerReply, reviewerReply, verifierReply]);
  assert.deepEqual(records.map((r) => r.task), [null, 2, null]);
  assert.deepEqual(errorLines(w), []);
  // 다른 판의 폴더는 생기지 않았다
  assert.deepEqual(readdirSync(path.join(w.project, '.pact')).sort(), ['.gitignore', ID]);
});

// ---------- (d) verifier 지문 ----------

test('(d) a verifier stop records the sha256 of results.json as it is at that moment, and a later stop records the new one', () => {
  const w = world();
  mkdirSync(w.run, { recursive: true });
  const results = path.join(w.run, 'results.json');
  const first = Buffer.from(`${JSON.stringify({ spec: 'docs/pact/x.md', scenarios: [{ id: 'S1' }] }, null, 2)}\n한글`);
  writeFileSync(results, first);
  const verifier = (message) => stopInput(w, 'pact:verifier', `run-dir: ${w.run}\n명세 경로: ${w.spec}`, message);

  stop(w, verifier('통과 1'));
  assert.equal(readRecords(w.run)[0].results_sha256, sha(first));

  const second = Buffer.from('{"scenarios":[]}\n');
  writeFileSync(results, second);
  stop(w, verifier('통과 2')); // 고친 뒤 다시 검수
  const records = readRecords(w.run);
  assert.equal(records.length, 2);
  assert.equal(records[0].results_sha256, sha(first), '앞 지문은 그대로다');
  assert.equal(records[1].results_sha256, sha(second));
  assert.equal(latestVerifierFingerprint(w.run).results_sha256, sha(second));

  rmSync(results);
  stop(w, verifier('통과 3')); // results.json이 없다: 앞 지문으로 돌아가지 않는다
  assert.equal(latestVerifierFingerprint(w.run).results_sha256, null);

  // verifier가 아닌 에이전트의 줄에는 지문이 없다
  writeFileSync(results, first);
  stop(w, stopInput(w, 'pact:worker', `run-dir: ${w.run} , 작업 번호 1`, '끝'));
  stop(w, stopInput(w, 'pact:reviewer', `${w.run}/tasks/1-report.md`, '판정'));
  stop(w, stopInput(w, 'pact:spec-checker', w.spec, '검수'));
  for (const record of readRecords(w.run).slice(3)) assert.equal('results_sha256' in record, false, record.agent_type);
  assert.deepEqual(errorLines(w), [], 'results.json이 없는 것은 오류가 아니다');
});

test('a whole run, read back with the functions the later checks use', () => {
  const w = world();
  writeSpec(w.project, ID);
  mkdirSync(w.run, { recursive: true });
  writeFileSync(path.join(w.run, 'results.json'), '{}\n');
  stop(w, stopInput(w, 'pact:spec-checker', w.spec, '검수 답'));
  stop(w, stopInput(w, 'pact:worker', `run-dir: ${w.run} , 작업 번호 1`, `첫 답\n보고서: ${w.run}/tasks/1-report.md`));
  stop(w, stopInput(w, 'pact:worker', `run-dir: ${w.run} , 작업 번호 2`, `둘째 작업\n보고서: ${w.run}/tasks/2-report.md`));
  stop(w, stopInput(w, 'pact:reviewer', `${w.run}/tasks/1-report.md`, '고칠 것 있음'));
  stop(w, stopInput(w, 'pact:worker', `run-dir: ${w.run} , 작업 번호 1`, `고친 답\n보고서: ${w.run}/tasks/1-report.md`)); // SendMessage로 돌아온 같은 worker
  stop(w, stopInput(w, 'pact:verifier', `run-dir: ${w.run}`, '통과 1'));
  assert.equal(latestSpecCheckerReply(w.run).message, '검수 답');
  assert.ok(Date.parse(latestSpecCheckerReply(w.run).time) > 0);
  assert.match(latestWorkerReply(w.run, 1).message, /^고친 답/);
  assert.match(latestWorkerReply(w.run, 2).message, /^둘째 작업/);
  assert.equal(latestVerifierFingerprint(w.run).results_sha256, sha(Buffer.from('{}\n')));
});

// ---------- (e) 깨진 입력, 예외 ----------

test('(e) input that is not a JSON object ends with exit 0, no output and one line in the error log', () => {
  for (const raw of ['not json', '', '  \n', '{"hook_event_name": "SubagentStop", "agent_type": ', '[1,2]', 'null', '42', '"text"']) {
    const w = world();
    const r = runHook(w, raw);
    assert.equal(r.stdout, '', JSON.stringify(raw));
    assert.equal(r.stderr, '');
    const lines = errorLines(w);
    assert.equal(lines.length, 1, `${JSON.stringify(raw)} → ${lines.join(' / ')}`);
    assert.match(lines[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[stdin\] 입력이/);
    assert.equal(existsSync(path.join(w.project, '.pact')), false);
  }
});

test('(e) a transcript path that is not a file ends with exit 0 and one line in the error log; nothing is recorded when no run can be found', () => {
  const w = world(); // 명세도 실행 폴더도 없다
  const missing = path.join(w.root, 'nope', 'agent.jsonl');
  stop(w, stopInput(w, 'pact:worker', 'x', '끝', { agent_transcript_path: missing }));
  let lines = errorLines(w);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /\[SubagentStop pact:worker\]/);
  assert.match(lines[0], /실행 폴더를 찾지 못/);
  assert.match(lines[0], /ENOENT/);
  assert.equal(existsSync(path.join(w.project, '.pact')), false);

  // 대화 기록 경로 필드가 아예 없는 입력과 폴더인 경로도 같다
  const { agent_transcript_path: _omit, ...withoutPath } = stopInput(w, 'pact:reviewer', 'x', '판정');
  stop(w, withoutPath);
  stop(w, stopInput(w, 'pact:verifier', 'x', '통과', { agent_transcript_path: w.root }));
  lines = errorLines(w);
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(lines[1], /agent_transcript_path/);
  assert.match(lines[2], /EISDIR/);
  assert.equal(existsSync(path.join(w.project, '.pact')), false);
});

test('(e) when only the transcript is unreadable but the cwd project has a run in progress, the answer is still recorded', () => {
  const w = world();
  writeSpec(w.project, ID);
  stop(w, stopInput(w, 'pact:worker', 'x', '끝', { agent_transcript_path: path.join(w.root, 'nope.jsonl') }));
  assert.deepEqual(readRecords(w.run).map((r) => r.message), ['끝']);
  const lines = errorLines(w);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ENOENT/);
});

test('(e) an answer with no text is still recorded, and the error log says so', () => {
  const w = world();
  mkdirSync(w.run, { recursive: true });
  stop(w, stopInput(w, 'pact:worker', `run-dir: ${w.run}`, undefined));
  assert.deepEqual(readRecords(w.run).map((r) => r.message), ['']);
  assert.match(errorLines(w).join('\n'), /last_assistant_message/);
});

test('(e) when writing the record fails, the hook still exits 0 with no output and logs one line', () => {
  const w = world();
  mkdirSync(w.run, { recursive: true });
  writeFileSync(path.join(w.run, 'log'), 'log/ 자리에 파일이 있다'); // mkdir이 실패한다
  stop(w, stopInput(w, 'pact:worker', `run-dir: ${w.run} , 작업 번호 1`, '끝'));
  const lines = errorLines(w);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /\[SubagentStop pact:worker\]/);
  assert.match(lines[0], /EEXIST|ENOTDIR/);
  assert.doesNotMatch(lines[0], /\n/);
  assert.equal(readFileSync(path.join(w.run, 'log'), 'utf8'), 'log/ 자리에 파일이 있다');
});

test('(e) even when the error log itself cannot be written, the hook exits 0 and prints nothing', () => {
  const w = world();
  writeFileSync(w.data, '데이터 폴더 자리에 파일이 있다');
  const r = runHook(w, 'not json');
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('(e) PreToolUse never blocks on a hook failure either', () => {
  const w = world();
  writeFileSync(w.data, '데이터 폴더 자리에 파일이 있다');
  for (const input of [
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `echo x > ${w.run}/results.json` } },
    { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: null },
    { hook_event_name: 'PreToolUse' },
    { hook_event_name: 'SomethingElse', tool_name: 'Bash' },
    { tool_name: 'Bash' },
  ]) {
    const r = runHook(w, input);
    assert.equal(r.stdout, '', JSON.stringify(input));
  }
});

// ---------- (f) 실행 폴더 찾기: 첫 지시에 경로가 없을 때 ----------

test('(f) with no path in the first instruction, the run of the most recently changed in-progress spec in the cwd project is used', () => {
  const w = world();
  writeSpec(w.project, '2026-10-01-초안', { status: 'draft', mtime: 1000 });
  writeSpec(w.project, '2026-10-02-만드는-중', { status: 'building', mtime: 2000 });
  writeSpec(w.project, '2026-10-03-끝남', { status: 'done', mtime: 3000 });
  const pick = path.join(w.project, '.pact', '2026-10-02-만드는-중');

  stop(w, stopInput(w, 'pact:worker', '경로가 하나도 없는 지시', '끝'));
  assert.deepEqual(readRecords(pick).map((r) => r.agent_type), ['pact:worker']);
  assert.deepEqual(readdirSync(path.join(w.project, '.pact')).sort(), ['.gitignore', '2026-10-02-만드는-중'], '다른 판의 폴더는 생기지 않는다');

  // cwd가 프로젝트의 하위 폴더여도 같다
  const sub = path.join(w.project, 'plugins', 'pact');
  mkdirSync(sub, { recursive: true });
  stop(w, stopInput(w, 'pact:reviewer', '경로 없음', '판정', { cwd: sub }));
  assert.deepEqual(readRecords(pick).map((r) => r.agent_type), ['pact:worker', 'pact:reviewer']);

  // 더 최근에 바뀐 쪽이 이긴다
  utimesSync(path.join(w.project, 'docs', 'pact', '2026-10-01-초안.md'), 5000, 5000);
  stop(w, stopInput(w, 'pact:spec-checker', '경로 없음', '검수'));
  assert.deepEqual(readRecords(path.join(w.project, '.pact', '2026-10-01-초안')).map((r) => r.agent_type), ['pact:spec-checker']);
  assert.deepEqual(errorLines(w), []);
});

test('(f) when no run can be found by the path or by the cwd, nothing is recorded and the error log gets one line', () => {
  const w = world();
  writeSpec(w.project, ID, { status: 'done' });
  stop(w, stopInput(w, 'pact:worker', '경로 없는 지시', '끝'));
  const lines = errorLines(w);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /실행 폴더를 찾지 못/);
  assert.match(lines[0], new RegExp(w.project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(existsSync(path.join(w.project, '.pact')), false);

  // 프로젝트가 아닌 곳(docs/pact/가 없다)
  const elsewhere = path.join(w.root, 'elsewhere');
  mkdirSync(elsewhere);
  stop(w, stopInput(w, 'pact:verifier', '경로 없는 지시', '통과', { cwd: elsewhere }));
  assert.equal(errorLines(w).length, 2);
  assert.deepEqual(readdirSync(elsewhere), []);
});

// ---------- 데이터 폴더 ----------

test('without CLAUDE_PLUGIN_DATA the error log goes to ~/.claude/plugins/data/pact-chenjing-plugins', () => {
  const w = world();
  const env = { ...process.env, HOME: w.home };
  delete env.CLAUDE_PLUGIN_DATA;
  const r = runHook(w, 'not json', { env });
  assert.equal(r.stdout, '');
  const file = path.join(w.home, '.claude', 'plugins', 'data', 'pact-chenjing-plugins', 'hook-error.log');
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 1);
  assert.equal(existsSync(w.data), false);
});
