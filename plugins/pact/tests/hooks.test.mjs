// 훅은 손으로 만든 입력 JSON을 stdin으로 넣고 자식 프로세스로 돌려 시험한다. 실제 Claude Code를 띄우는 시험은 검수 때 따로 한다(R18).
// 모든 시험은 CLAUDE_PLUGIN_DATA와 HOME을 임시 폴더로 돌려서, 진짜 ~/.claude 밑에는 아무것도 쓰지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, symlinkSync, utimesSync, rmSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PACT_AGENTS, touchesPact, denyOutput, allowOutput } from '../hooks/guard.mjs';
import { LOGGED_AGENTS, appendRecord, readRecords, latestSpecCheckerReply, latestWorkerReply, latestVerifierFingerprint } from '../scripts/run-log.mjs';
import { grantApproval, specText, typed, writeTranscript, runSpec, assertRefused, checkerReply, T, SESSION } from './approval-world.mjs';

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
    // 이 컴퓨터의 파일 시스템은 대소문자를 가리지 않는다: `.PACT/`도 실제 `.pact/`다
    { tool_name: 'Write', tool_input: { file_path: '/p/.PACT/r/RESULTS.JSON', content: 'x' } },
    { tool_name: 'Bash', tool_input: { command: 'echo x > .Pact/r/LOG/x' } },
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

test('PreToolUse calls that touch pact but are none of the gated ones still pass, whoever makes them', () => {
  const w = busyWorld();
  const calls = [
    { tool_name: 'Write', tool_input: { file_path: path.join(w.run, 'summary.json'), content: '{}' } },
    { tool_name: 'Edit', tool_input: { file_path: w.spec, old_string: 'a', new_string: 'b' } },
    { tool_name: 'MultiEdit', tool_input: { file_path: path.join(w.run, 'plan.md'), edits: [] } },
    { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(w.run, 'x.ipynb') } },
    { tool_name: 'Agent', tool_input: { subagent_type: 'pact:reviewer', prompt: `${w.run}/tasks/1-report.md` } },
    { tool_name: 'Agent', tool_input: { subagent_type: 'pact:verifier', prompt: `run-dir: ${w.run}` } },
    { tool_name: 'Agent', tool_input: { subagent_type: 'pact:spec-checker', prompt: `명세 경로: ${w.spec}` } },
    { tool_name: 'Bash', tool_input: { command: `echo x > ${w.run}/report.html` } },
    { tool_name: 'Bash', tool_input: { command: `cat ${w.run}/results.json ${w.run}/log/subagents.jsonl | jq .` } },
    { tool_name: 'Bash', tool_input: { command: `node ${ROOT}/scripts/spec.mjs status ${w.spec}` } },
    { tool_name: 'Bash', tool_input: { command: `node ${ROOT}/scripts/spec.mjs lint ${w.spec}` } },
    { tool_name: 'Bash', tool_input: { command: `node ${ROOT}/scripts/spec.mjs run-dir ${w.spec}` } },
    { tool_name: 'Bash', tool_input: { command: `node ${ROOT}/scripts/verification.mjs check ${w.spec} ${w.project}` } },
    { tool_name: 'SendMessage', tool_input: { to: 'agent-1', message: `고쳐 주세요: ${w.run}/tasks/1-report.md` } },
  ];
  const before = tree(w.root);
  for (const call of calls) {
    assert.equal(touchesPact(call), true, `pact 호출로 보인다: ${JSON.stringify(call)}`);
    for (const caller of [{}, { agent_id: 'agent-1', agent_type: 'pact:worker' }]) {
      const r = runHook(w, { hook_event_name: 'PreToolUse', session_id: 's', cwd: w.project, ...caller, ...call });
      assert.equal(r.stdout, '', JSON.stringify({ call, caller }));
    }
  }
  assert.deepEqual(tree(w.root), before);
});

// ---------- 승인 기록이 없으면 pact:worker를 부르지 못한다 (F2) ----------

const SUB = { agent_id: 'agent-9', agent_type: 'pact:worker' };

// 하위 에이전트가 없는 입력은 메인 세션이다
const pre = (w, call, caller = {}) => runHook(w, { hook_event_name: 'PreToolUse', session_id: 's', cwd: w.project, ...caller, ...call });
const workerCall = (prompt) => ({ tool_name: 'Agent', tool_input: { subagent_type: 'pact:worker', description: '작업 2', prompt } });
const brief = (w) => `## 목표\n훅을 넣는다\n## 맥락\nrun-dir: ${w.run} , 작업 번호 2. 보고서는 이 run-dir의 tasks/2-report.md.\nworktree: ${w.run}/wt\n## 범위\n…`;

// 막았는지: 출력이 deny이고 까닭이 한 줄이다. 까닭 글을 돌려준다.
function denied(r, label = '') {
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput'], label);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse', label);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', label);
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /^\[pact\] \S/, label);
  assert.doesNotMatch(reason, /\n/, `${label}: 까닭은 한 줄이다`);
  assert.equal(r.stderr, '', label);
  return reason;
}
const passed = (r, label = '') => assert.equal(r.stdout, '', label || '통과: 출력이 없다');

// 승인 기록을 스크립트로 받을 수 있는 판. 훅 시험의 world()에 대화 기록 자리를 더한다.
function approvalWorld(options) {
  const w = busyWorld();
  if (options?.spec) writeFileSync(w.spec, options.spec);
  return { ...w, id: ID, sessionId: SESSION, transcript: path.join(w.home, '.claude', 'projects', '-fake', `${SESSION}.jsonl`) };
}

test('(i) the main session calling pact:worker for a new spec with no approval record is denied, with the reason and what to do on one line', () => {
  const w = approvalWorld();
  const before = tree(w.root);
  const reason = denied(pre(w, workerCall(brief(w))));
  assert.match(reason, /승인 기록이 없다/);
  assert.match(reason, /spec\.mjs approve <명세> - <<'EOF'/);
  assert.doesNotMatch(reason, /"<사용자 말>"/, '큰따옴표 인자 꼴은 알리지 않는다');
  assert.match(reason, /delegate/);
  assert.deepEqual(tree(w.root), before, '막으면서 아무것도 만들지 않는다');
  // 상대 경로로 가리켜도 같다
  denied(pre(w, workerCall(`run-dir: .pact/${ID} , 작업 번호 1`)), '상대 경로');
});

test('(i) with an approval record the call goes through, and it goes through whether the record is an approval or a delegation', () => {
  const w = approvalWorld();
  grantApproval(w);
  passed(pre(w, workerCall(brief(w))));
  const d = approvalWorld();
  grantApproval(d, { kind: 'delegate' });
  passed(pre(d, workerCall(brief(d))));
  assert.deepEqual(errorLines(w), []);
  assert.deepEqual(errorLines(d), []);
});

test('(i) an old spec (pact: 1, status building) goes through with no record; an old draft is denied like a new spec', () => {
  const old = approvalWorld({ spec: specText({ pact: 1, status: 'building' }) });
  passed(pre(old, workerCall(brief(old))));
  for (const status of ['approved', 'verifying', 'done']) {
    writeFileSync(old.spec, specText({ pact: 1, status }));
    passed(pre(old, workerCall(brief(old))), status);
  }
  writeFileSync(old.spec, specText({ pact: 1, status: 'draft' }));
  assert.match(denied(pre(old, workerCall(brief(old)))), /승인 기록이 없다/);
  // 날짜 없는 옛 실행 폴더(.pact/<주제>)로 불러도 날짜 붙은 명세로 옛 판인지 본다
  writeFileSync(old.spec, specText({ pact: 1, status: 'building' }));
  const undated = path.join(old.project, '.pact', '출결-관리');
  mkdirSync(undated, { recursive: true });
  passed(pre(old, workerCall(`run-dir: ${undated} , 작업 번호 3`)));
});

test('(i) a brief that names no run is denied with "put run-dir and the task number in the context", even when the cwd project has a run in progress', () => {
  const w = approvalWorld();
  grantApproval(w);
  for (const prompt of ['## 목표\n훅을 넣는다\n## 맥락\n앞 작업이 만든 것: 없음', '', undefined, `보고서: tasks/1-report.md`]) {
    const reason = denied(pre(w, workerCall(prompt)), String(prompt));
    assert.match(reason, /맥락 칸에 run-dir과 작업 번호를 넣는다/);
  }
  // 프로젝트가 아닌 곳에서 불러도 같다
  denied(pre(w, workerCall(brief({ run: '' })), {}), '빈 경로');
  const elsewhere = path.join(w.root, 'elsewhere');
  mkdirSync(elsewhere);
  assert.match(denied(runHook(w, { hook_event_name: 'PreToolUse', session_id: 's', cwd: elsewhere, ...workerCall('경로 없음') })), /맥락 칸에 run-dir/);
  // 없는 판을 가리키면(오타) 명세도 기록도 없다고 알린다
  const typo = path.join(w.project, '.pact', '2026-11-01-없는-판');
  assert.match(denied(pre(w, workerCall(`run-dir: ${typo} , 작업 번호 1`))), /명세를 찾지 못하고 승인 기록도 없다/);
  assert.equal(existsSync(typo), false, '없는 판의 폴더를 만들지 않는다');
});

test('(i) a delegation is looked at again when the worker is called: a risk item in the spec now, or a transcript that no longer holds the quote, denies', () => {
  const w = approvalWorld({ spec: specText({ status: 'building' }) }); // 위임을 기록한 때의 [사용자] 줄이 아래 명세들과 같아야 F3(승인 뒤 바뀐 줄)에 걸리지 않는다
  grantApproval(w, { kind: 'delegate' });
  passed(pre(w, workerCall(brief(w))));
  // 지금 명세에 위험 항목이 생겼다
  writeFileSync(w.spec, specText({ status: 'building', rules: '- R2 오래된 기록을 지운다 [위험: 지우기] [AI 가정]\n' }));
  const risky = denied(pre(w, workerCall(brief(w))));
  assert.match(risky, /위임으로 시작하려는데 지금 명세에 위험 항목이 있다: R2에 \[위험: …\] 표시가 있다/);
  assert.match(risky, /사용자의 승인을 받아 spec\.mjs approve/);
  writeFileSync(w.spec, specText({ status: 'building', features: '- F2 자료 비우기 [위험: 지우기] [사용자]\n' }));
  assert.match(denied(pre(w, workerCall(brief(w)))), /F2에 \[위험: …\] 표시가 있다/);
  // 콜론을 빠뜨린 표시도 표시다
  writeFileSync(w.spec, specText({ status: 'building', features: '- F2 자료 비우기 [위험 지우기] [사용자]\n' }));
  assert.match(denied(pre(w, workerCall(brief(w)))), /F2에 \[위험: …\] 표시가 있다/);
  // 표시가 없으면 낱말이 있어도 막지 않는다(표시가 빠졌는지는 spec-checker가 뜻으로 본다)
  writeFileSync(w.spec, specText({ status: 'building', rules: '- R2 오래된 기록을 삭제한다 [AI 가정]\n' }));
  passed(pre(w, workerCall(brief(w))));
  // 위험이 없어지면 다시 통과한다
  writeFileSync(w.spec, specText({ status: 'building' }));
  passed(pre(w, workerCall(brief(w))));
  // 인용을 다시 맞춰 볼 수 없다
  const saved = readFileSync(w.transcript, 'utf8');
  rmSync(w.transcript);
  assert.match(denied(pre(w, workerCall(brief(w)))), /인용을 다시 맞춰 보지 못했다/);
  writeTranscript(w, [typed('다른 말', '2026-10-29T01:00:00.000Z')]);
  assert.match(denied(pre(w, workerCall(brief(w)))), /다시 찾지 못했다/);
  writeFileSync(w.transcript, saved);
  passed(pre(w, workerCall(brief(w))));
  // 사용자가 위험을 보고 승인하면 이어 간다
  writeFileSync(w.spec, specText({ status: 'building', rules: '- R2 오래된 기록을 지운다 [위험: 지우기] [AI 가정]\n' }));
  denied(pre(w, workerCall(brief(w))));
  grantApproval(w, { kind: 'approve', text: '위험한 것도 알고 승인합니다' });
  passed(pre(w, workerCall(brief(w))));
});

test('(i) only the main session is held to this: a sub-agent calling pact:worker, and the other pact agents, are not asked for a record', () => {
  const w = approvalWorld(); // 승인 기록 없음
  passed(pre(w, workerCall(brief(w)), SUB), '하위 에이전트');
  for (const subagent_type of ['pact:reviewer', 'pact:verifier', 'pact:spec-checker']) {
    passed(pre(w, { tool_name: 'Agent', tool_input: { subagent_type, prompt: brief(w) } }), subagent_type);
  }
  passed(pre(w, { tool_name: 'Agent', tool_input: { subagent_type: 'tiers:worker', prompt: brief(w) } }), '다른 플러그인의 worker');
});

// ---------- 승인 뒤 [사용자] 줄이 바뀌면 pact:worker를 부르지 못한다 (F3) ----------

const USER_BASE = specText({
  status: 'building',
  features: '- F2 출석은 시작 10분 뒤에 닫는다 [사용자]\n  - 케이스: 10분이 지남 → 닫힘 표시\n- F3 화면 문구는 한국어 — 한국어 사용자라서 [AI 가정]\n',
  rules: '- R2 결석 사유는 선생님만 본다 [사용자]\n',
});
// 승인한 뒤 명세를 이렇게 고쳤다: 글, 태그, 빼기, 더하기, 케이스 줄. 바뀐 줄의 번호도 같이 둔다.
const USER_EDITS = {
  글: [(t) => t.replace('시작 10분 뒤에', '시작 15분 뒤에'), 'F2 바뀜'],
  태그: [(t) => t.replace('결석 사유는 선생님만 본다 [사용자]', '결석 사유는 선생님만 본다 [AI 가정]'), 'R2 태그가 바뀜'],
  '번호 태그': [(t) => t.replace('선생님만 본다 [사용자]', '선생님만 본다 [사용자: 검수 1]'), 'R2 바뀜'],
  빼기: [(t) => t.replace('- R2 결석 사유는 선생님만 본다 [사용자]\n', ''), 'R2 빠짐'],
  더하기: [(t) => t.replace('## 공통 규칙\n', '## 공통 규칙\n- R9 새 규칙 [사용자]\n'), 'R9 더해짐'],
  '케이스 줄': [(t) => t.replace('10분이 지남 → 닫힘 표시', '10분이 지남 → 닫히고 알림'), 'F2 바뀜'],
};

test('(d) a [사용자] line changed after the approval: the hook denies pact:worker and names the line, for an approval and for a delegation, and writes nothing', () => {
  for (const kind of ['approve', 'delegate']) {
    for (const [label, [edit, named]] of Object.entries(USER_EDITS)) {
      const w = approvalWorld({ spec: USER_BASE });
      grantApproval(w, { kind });
      passed(pre(w, workerCall(brief(w))), `${kind}: 그대로면 통과`);
      writeFileSync(w.spec, edit(USER_BASE));
      const before = tree(w.root);
      const reason = denied(pre(w, workerCall(brief(w))), `${kind} / ${label}`);
      assert.match(reason, /승인 뒤 \[사용자\] 줄이 바뀌었다/, `${kind} / ${label}`);
      assert.ok(reason.includes(named), `${kind} / ${label}: "${named}"를 알린다: ${reason}`);
      assert.match(reason, /바꿔 달라고 한 사용자 말을 인용해 spec\.mjs approve <명세> - <<'EOF'로 다시 기록한다/);
      assert.match(reason, /사용자가 파일을 직접 고쳤으면 한 번 묻고 그 답을 인용한다/);
      assert.doesNotMatch(reason, /"<사용자 말>"/, '큰따옴표 인자 꼴은 알리지 않는다');
      assert.deepEqual(tree(w.root), before, '막으면서 아무것도 만들지 않는다');
      assert.deepEqual(errorLines(w), []);
    }
  }
});

test('(d) the call goes through again once the person is quoted in a newer message and the spec approved again; the same or an older message does not', () => {
  const w = approvalWorld({ spec: USER_BASE });
  grantApproval(w, { text: '승인', time: T(10) });
  writeFileSync(w.spec, USER_EDITS.글[0](USER_BASE));
  denied(pre(w, workerCall(brief(w))));
  // 앞 기록에 쓴 말이나 더 옛 말로는 다시 기록되지 않는다
  assertRefused(runSpec(w, ['approve', w.spec, '승인']), /앞 승인 기록에 쓴 메시지/);
  assert.match(denied(pre(w, workerCall(brief(w)))), /F2 바뀜/, '거절했으니 그대로 막혀 있다');
  // 바꿔 달라고 한 새 말을 인용하면 통과한다
  const r = grantApproval(w, { text: '출석 닫는 시간을 15분으로 바꿔 주세요', time: T(20), checker: false });
  assert.equal(r.length, 2, '이력이 쌓인다');
  passed(pre(w, workerCall(brief(w))));
  assert.deepEqual(errorLines(w), []);
  // 또 바뀌면 또 새 말이 있어야 한다
  writeFileSync(w.spec, USER_EDITS.글[0](USER_BASE).replace('15분', '20분'));
  denied(pre(w, workerCall(brief(w))));
  assertRefused(runSpec(w, ['approve', w.spec, '출석 닫는 시간을 15분으로 바꿔 주세요']), /앞 승인 기록에 쓴 메시지/);
});

// [AI 가정] 항목 밑 케이스 줄에 사용자의 답([사용자: 검수 1])이 달린 명세: F5가 짝으로 세는 그 줄을 F3도 지킨다
const AI_CASE_BASE = USER_BASE.replace(
  '- F3 화면 문구는 한국어 — 한국어 사용자라서 [AI 가정]\n',
  '- F3 화면 문구는 한국어 — 한국어 사용자라서 [AI 가정]\n- F4 결석 사유 보기 — 기본은 선생님만 [AI 가정]\n  - 케이스: 학생이 봄 → 안 보임 [사용자: 검수 1]\n  - 케이스: 교사가 봄 → 보임\n',
);

test('(d) the case line of an [AI 가정] item that carries the person\'s answer is held like any [사용자] line: the hook denies pact:worker when it changes, while the AI head line and the AI case lines around it change freely', () => {
  assert.notEqual(AI_CASE_BASE, USER_BASE);
  for (const kind of ['approve', 'delegate']) {
    const w = approvalWorld({ spec: AI_CASE_BASE });
    grantApproval(w, { kind, ...(kind === 'approve' ? { checkerMessage: checkerReply(['결석 사유를 학생도 볼 수 있나요?']) } : {}) }); // 검수 1의 짝은 케이스 줄의 태그다
    passed(pre(w, workerCall(brief(w))), `${kind}: 그대로면 통과`);
    for (const [label, edit] of Object.entries({
      '머리 줄': (t) => t.replace('기본은 선생님만', '기본은 담임만'),
      '다른 AI 케이스 줄': (t) => t.replace('교사가 봄 → 보임', '교사가 봄 → 이름만 보임'),
      '앞에 AI 케이스 줄을 더함': (t) => t.replace('  - 케이스: 학생이 봄', '  - 케이스: 관리자가 봄 → 보임\n  - 케이스: 학생이 봄'),
      '머리 줄에 번호 태그': (t) => t.replace('기본은 선생님만 [AI 가정]', '기본은 선생님만 [AI 가정: 검수 5 맡김]'),
    })) {
      writeFileSync(w.spec, edit(AI_CASE_BASE));
      passed(pre(w, workerCall(brief(w))), `${kind} / ${label}: AI가 고치는 줄이라 통과`);
    }
    for (const [label, edit, named] of [
      ['글', (t) => t.replace('학생이 봄 → 안 보임', '학생이 봄 → 이름만 보임'), 'F4의 [사용자] 줄 바뀜("케이스: 학생이 봄 → 안 보임 [사용자: 검수 1]" → "케이스: 학생이 봄 → 이름만 보임 [사용자: 검수 1]")'],
      ['번호 태그', (t) => t.replace('안 보임 [사용자: 검수 1]', '안 보임 [사용자]'), 'F4의 [사용자] 줄 바뀜'],
      ['줄 빼기', (t) => t.replace('  - 케이스: 학생이 봄 → 안 보임 [사용자: 검수 1]\n', ''), 'F4의 [사용자] 줄 빠짐("케이스: 학생이 봄 → 안 보임 [사용자: 검수 1]")'],
      ['[AI 가정]으로 바꾸기', (t) => t.replace('안 보임 [사용자: 검수 1]', '안 보임 [AI 가정]'), 'F4의 [사용자] 줄 빠짐'],
      ['다른 케이스 줄에 [사용자]를 더함', (t) => t.replace('교사가 봄 → 보임\n', '교사가 봄 → 보임 [사용자]\n'), 'F4의 [사용자] 줄 더해짐("케이스: 교사가 봄 → 보임 [사용자]")'],
    ]) {
      writeFileSync(w.spec, edit(AI_CASE_BASE));
      const before = tree(w.root);
      const reason = denied(pre(w, workerCall(brief(w))), `${kind} / ${label}`);
      assert.ok(reason.includes(named), `${kind} / ${label}: "${named}"를 알린다: ${reason}`);
      assert.doesNotMatch(reason, /기본은 (선생님|담임)만/, `${kind} / ${label}: [AI 가정] 머리 줄의 글은 알리지 않는다`);
      assert.deepEqual(tree(w.root), before, '막으면서 아무것도 만들지 않는다');
    }
    // 바꿔 달라고 한 새 말로 다시 기록하면 이어 간다
    writeFileSync(w.spec, AI_CASE_BASE.replace('학생이 봄 → 안 보임', '학생이 봄 → 이름만 보임'));
    denied(pre(w, workerCall(brief(w))), `${kind}: 바꾼 뒤 다시 기록하기 전`);
    grantApproval(w, { kind, text: '학생에게는 이름만 보이게 바꿔 주세요', time: T(30), checker: false });
    passed(pre(w, workerCall(brief(w))), `${kind}: 다시 기록한 뒤`);
    assert.deepEqual(errorLines(w), []);
  }
});

test('(d) a delegation does not get around it: the old delegation words cannot be written again after a [사용자] line changed', () => {
  const w = approvalWorld({ spec: USER_BASE });
  grantApproval(w, { kind: 'delegate', text: '끝까지 알아서 해', time: T(1) });
  writeFileSync(w.spec, USER_EDITS.글[0](USER_BASE));
  denied(pre(w, workerCall(brief(w))));
  assertRefused(runSpec(w, ['delegate', w.spec, '끝까지 알아서 해']), /앞 승인 기록에 쓴 메시지/);
  denied(pre(w, workerCall(brief(w))));
});

test('(a)(d) end to end: the answer the hook logged for the spec-checker is what approve reads, and the worker gate follows the approval that record let through', () => {
  const w = approvalWorld({ spec: USER_BASE });
  const reply = [
    '## 이미 답이 있음', '- 없음', '', '## 사소함 — AI가 정함', '- 없음', '', '## 사용자만 답할 수 있음',
    '검수 1. 출석을 몇 분 뒤에 닫을까요? (기본안: 10분) — 화면이 달라진다', '검수 2. 결석 사유를 학생도 볼 수 있나요? (기본안: 선생님만) — 화면이 달라진다',
    '', '질문 라운드는 이것 한 번뿐입니다.',
  ].join('\n');
  stop(w, stopInput(w, 'pact:spec-checker', `명세 경로: ${w.spec}`, reply)); // 훅이 spec-checker의 마지막 답을 log/에 남긴다
  const soon = new Date(Date.now() + 3_600_000).toISOString(); // 훅이 남긴 시각(지금)보다 뒤의 사용자 말
  writeTranscript(w, [typed('승인', soon)]);
  // 번호 둘에 짝이 없다
  const refused = assertRefused(runSpec(w, ['approve', w.spec, '승인']), /검수 1\("출석을 몇 분 뒤에 닫을까요\?"\), 검수 2\("결석 사유를 학생도 볼 수 있나요\?"\)에 명세의 짝이 없다/);
  assert.doesNotMatch(refused, /\n/);
  denied(pre(w, workerCall(brief(w))), '기록이 없으니 worker도 막힌다');
  // 짝을 달면 승인이 기록되고 worker를 부를 수 있다
  const paired = USER_BASE.replace('- F2 출석은 시작 10분 뒤에 닫는다 [사용자]', '- F2 출석은 시작 10분 뒤에 닫는다 [사용자: 검수 1]').replace('## 확인 필요\n', '## 확인 필요\n- 검수 2: 사용자가 바빠서 묻지 못했다\n');
  assert.notEqual(paired, USER_BASE);
  writeFileSync(w.spec, paired);
  assert.equal(runSpec(w, ['approve', w.spec, '승인']).status, 0);
  passed(pre(w, workerCall(brief(w))));
  // 승인 뒤 [사용자] 줄을 바꾸면 막힌다. [AI 가정] 줄과 확인 필요를 고치는 것은 막지 않는다
  writeFileSync(w.spec, paired.replace('- 검수 2: 사용자가 바빠서 묻지 못했다', '- 검수 2: 묻지 못했다. 다음 판에 묻는다').replace('한국어 사용자라서', '한국어를 쓰는 사용자라서'));
  passed(pre(w, workerCall(brief(w))));
  writeFileSync(w.spec, paired.replace('시작 10분 뒤에 닫는다 [사용자: 검수 1]', '시작 15분 뒤에 닫는다 [사용자: 검수 1]'));
  assert.match(denied(pre(w, workerCall(brief(w)))), /F2 바뀜\("출석은 시작 10분 뒤에 닫는다 \[사용자: 검수 1\]" → "출석은 시작 15분 뒤에 닫는다 \[사용자: 검수 1\]"\)/);
  assert.deepEqual(errorLines(w), []);
});

test('(e) only [AI 가정] lines changed: the call goes through, and so do the other status and wording changes that are not [사용자] lines', () => {
  const w = approvalWorld({ spec: USER_BASE });
  grantApproval(w);
  for (const edit of [
    (t) => t.replace('화면 문구는 한국어 — 한국어 사용자라서', '화면 문구는 영어 — 해외 사용자라서'),
    (t) => t.replace('## 공통 규칙\n', '## 공통 규칙\n- R8 AI가 더한 규칙 — 이유 [AI 가정]\n'),
    (t) => t.replace('- F3 화면 문구는 한국어 — 한국어 사용자라서 [AI 가정]\n', ''),
    (t) => t.replace('status: building', 'status: verifying').replace('## 결정 기록\n', '## 결정 기록\n- Ruling: 정했다 — 이유 — 잃는 것\n'),
  ]) {
    writeFileSync(w.spec, edit(USER_BASE));
    passed(pre(w, workerCall(brief(w))));
  }
  assert.deepEqual(errorLines(w), []);
});

test('(f) an old spec (pact: 1, no record) is not asked for the [사용자] lines either, whatever they say', () => {
  const old = approvalWorld({ spec: USER_BASE.replace('pact: 2', 'pact: 1') });
  passed(pre(old, workerCall(brief(old))));
  writeFileSync(old.spec, USER_EDITS.글[0](USER_BASE).replace('pact: 2', 'pact: 1'));
  passed(pre(old, workerCall(brief(old))));
  assert.deepEqual(errorLines(old), []);
});

test('(i) a hook that cannot read the record is not a hook that blocks: it passes the call and logs the error', () => {
  const w = approvalWorld();
  mkdirSync(path.join(w.run, 'approvals.jsonl'), { recursive: true }); // 파일 자리에 폴더
  const r = pre(w, workerCall(brief(w)));
  passed(r);
  const lines = errorLines(w);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /\[PreToolUse\]/);
  assert.match(lines[0], /EISDIR/);
});

// ---------- (j) approve·delegate·set-status를 누가 부를 수 있나 ----------

const SPEC_CLI_PATH = path.join(ROOT, 'scripts', 'spec.mjs');
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('(j) a sub-agent running spec.mjs approve, delegate or set-status through Bash is denied; looking at a spec is not', () => {
  const w = approvalWorld();
  const forms = [
    (sub, rest = '') => `node ${SPEC_CLI_PATH} ${sub} ${w.spec} ${rest}`,
    (sub, rest = '') => `node "${SPEC_CLI_PATH}" ${sub} "${w.spec}" ${rest}`,
    (sub, rest = '') => `cd ${w.project} && node plugins/pact/scripts/spec.mjs   ${sub} ${rest}`,
    (sub, rest = '') => `bash -c 'node ${SPEC_CLI_PATH} ${sub} ${w.spec} ${rest}'`,
    (sub, rest = '') => `node ${SPEC_CLI_PATH} ${sub} ${w.spec} ${rest} | cat`,
  ];
  for (const form of forms) {
    for (const [sub, rest] of [['approve', '"승인"'], ['delegate', '"끝까지 알아서 해"'], ['set-status', 'building'], ['set-status', 'approved']]) {
      const reason = denied(pre(w, bash(form(sub, rest)), SUB), form(sub, rest));
      assert.match(reason, /하위 에이전트는 승인·위임 기록과 status를 바꾸지 않는다/);
      assert.match(reason, /메인 세션/);
    }
  }
  // 읽기와 검사는 된다
  for (const sub of ['status', 'lint', 'run-dir', 'new']) passed(pre(w, bash(`node ${SPEC_CLI_PATH} ${sub} ${w.spec}`), SUB), sub);
  passed(pre(w, bash(`node ${ROOT}/scripts/verification.mjs check ${w.spec} ${w.project}`), SUB));
  // scripts/ 없이 spec.mjs만 불러도 같다
  denied(pre(w, bash(`node /x/y/spec.mjs approve ${w.spec} "승인"`), SUB), 'scripts/ 없는 경로');
  denied(pre(w, bash(`./spec.mjs set-status ${w.spec} building`), SUB), '직접 실행');
  // 다른 실행 꼴: node 경로, 환경 변수 지정, bun, 백그라운드, 직접 실행 앞의 명령과 환경 변수
  for (const command of [
    `/usr/local/bin/node /p/spec.mjs approve ${w.spec} "승인"`,
    `NODE_NO_WARNINGS=1 node ./scripts/spec.mjs delegate ${w.spec} "끝까지 알아서 해"`,
    `bun spec.mjs approve ${w.spec} "승인"`,
    `nohup node spec.mjs set-status ${w.spec} approved &`,
    `bash -lc "cd ${w.project} && node scripts/spec.mjs approve ${w.spec} 승인"`,
    `cd ${w.project} && ./spec.mjs set-status ${w.spec} building`,
    `ls; HOME=/x ./spec.mjs approve ${w.spec} "승인"`,
    `FOO="a b" ./scripts/spec.mjs delegate ${w.spec} x`,
  ]) denied(pre(w, bash(command), SUB), command);
  // agent_id가 빈 문자열이면 하위 에이전트로 보지 않는다
  passed(pre(w, bash(`node ${SPEC_CLI_PATH} set-status ${w.spec} verifying`), { agent_id: '' }));
});

test('(j) the main session may run approve, delegate and set-status through Bash', () => {
  const w = approvalWorld();
  for (const [sub, rest] of [['approve', '"승인"'], ['delegate', '"끝까지 알아서 해"'], ['set-status', 'building']]) {
    passed(pre(w, bash(`node ${SPEC_CLI_PATH} ${sub} ${w.spec} ${rest}`)), sub);
  }
  passed(pre(w, bash(`cd ${w.project} && node "${SPEC_CLI_PATH}" approve ${w.spec} "좋아, 만들어"`)));
});

test('(j) even the main session is denied when approve or delegate is run with the environment overridden (HOME, CLAUDE_CODE_SESSION_ID, CLAUDE_CONFIG_DIR …)', () => {
  const w = approvalWorld();
  const cmd = (sub = 'approve') => `node ${SPEC_CLI_PATH} ${sub} ${w.spec} "승인"`;
  const overridden = [
    `HOME=/tmp/x ${cmd()}`,
    `HOME=/tmp/x ${cmd('delegate')}`,
    `CLAUDE_CODE_SESSION_ID=fake-session ${cmd()}`,
    `CLAUDE_CONFIG_DIR=/tmp/x ${cmd()}`,
    `HOME=/tmp/x CLAUDE_CODE_SESSION_ID=fake ${cmd()}`,
    `export HOME=/tmp/x; ${cmd()}`,
    `export CLAUDE_CODE_SESSION_ID=fake && ${cmd('delegate')}`,
    `cd ${w.project} && HOME="/tmp/my home" ${cmd()}`,
    `env HOME=/tmp/x ${cmd()}`,
    `env -i HOME=/tmp/x CLAUDE_CODE_SESSION_ID=fake ${cmd()}`,
    `bash -c 'HOME=/tmp/x ${cmd()}'`,
    `USERPROFILE=/tmp/x ${cmd()}`,
    `XDG_CONFIG_HOME=/tmp/x ${cmd()}`,
    `NODE_OPTIONS="--require /tmp/fake.js" ${cmd()}`,
    `declare -x HOME=/tmp/x; ${cmd()}`,
    `CLAUDE_FAKE=1 ${cmd()}`,
  ];
  for (const command of overridden) {
    const reason = denied(pre(w, bash(command)), command);
    assert.match(reason, /환경 변수/, command);
    assert.match(reason, /환경 변수 없이 spec\.mjs (approve|delegate)를 다시 실행한다/, command);
  }
  // 이름을 알려 준다
  assert.match(denied(pre(w, bash(`CLAUDE_CODE_SESSION_ID=x HOME=/y ${cmd()}`))), /CLAUDE_CODE_SESSION_ID, HOME/);
  // 직접 실행하는 꼴도 같다
  for (const command of [`HOME=/tmp/x ./spec.mjs approve ${w.spec} "승인"`, `export HOME=/tmp/x; ./scripts/spec.mjs delegate ${w.spec} "x"`, `cd ${w.project} && CLAUDE_CODE_SESSION_ID=f ./spec.mjs approve ${w.spec} 승인`]) {
    assert.match(denied(pre(w, bash(command)), command), /환경 변수 없이 spec\.mjs (approve|delegate)를 다시 실행한다/, command);
  }
  // 막지 않는 것: 명령 뒤에 있는 글, 다른 이름의 변수, approve·delegate가 아닌 명령, 하위 에이전트가 아닌 일반 환경 변수
  const fine = [
    `${cmd()} && HOME=/tmp/x ls`,
    `node ${SPEC_CLI_PATH} approve ${w.spec} "HOME=/tmp/x 라고 쓰지 마"`,
    `QUOTE=승인 ${cmd()}`,
    `LANG=ko_KR.UTF-8 ${cmd()}`,
    `HOME=/tmp/x node ${SPEC_CLI_PATH} set-status ${w.spec} building`,
    `HOME=/tmp/x node ${SPEC_CLI_PATH} lint ${w.spec}`,
  ];
  for (const command of fine) passed(pre(w, bash(command)), command);
});

test('(j) the documented way to pass the words, a quoted heredoc on standard input, is read like any other call: main passes, sub-agent and an overridden environment are denied', () => {
  const w = approvalWorld();
  const heredoc = (prefix = '', sub = 'approve') => `${prefix}node ${SPEC_CLI_PATH} ${sub} ${w.spec} - <<'EOF'\n\`rm -rf\` 말고 $HOME 은 그대로 이대로 승인\nEOF`;
  for (const sub of ['approve', 'delegate']) {
    passed(pre(w, bash(heredoc('', sub))), `main ${sub}`);
    denied(pre(w, bash(heredoc('', sub)), SUB), `sub-agent ${sub}`);
    assert.match(denied(pre(w, bash(heredoc('HOME=/tmp/x ', sub))), `env ${sub}`), /환경 변수 없이 spec\.mjs/);
    assert.match(denied(pre(w, bash(`cd ${w.project} && CLAUDE_CODE_SESSION_ID=f ${heredoc('', sub)}`))), /CLAUDE_CODE_SESSION_ID/);
  }
});

test('(j) a sub-agent that overrides the environment is denied for being a sub-agent first', () => {
  const w = approvalWorld();
  const reason = denied(pre(w, bash(`HOME=/tmp/x node ${SPEC_CLI_PATH} approve ${w.spec} "승인"`), SUB));
  assert.match(reason, /하위 에이전트는/);
});

test('(j) a Bash command that only mentions spec.mjs without pact calls passes: nothing is read or written', () => {
  const w = approvalWorld();
  const before = tree(w.root);
  for (const command of [
    'grep -n "spec.mjs" README.md', 'ls scripts/spec.mjs.bak', 'cat spec.mjs.md', 'node other-spec.mjs approve x',
    // 글 속에서 이름만 언급한 것은 호출이 아니다: 이 플러그인을 고치는 하위 에이전트의 커밋 메시지와 검색이 막히면 안 된다
    'git commit -m "feat(pact): spec.mjs approve·delegate를 더한다"',
    'git commit -m "$(cat <<\'EOF\'\nfeat(pact): spec.mjs approve와 set-status를 고친다\n\n- spec.mjs set-status building은 기록을 본다\nEOF\n)"',
    'echo "spec.mjs approve"', 'grep -rn "spec.mjs set-status" skills/', 'sed -n 1,5p docs/spec.mjs.set-status.md',
  ]) {
    passed(pre(w, bash(command), SUB), command);
    passed(pre(w, bash(command)), command);
  }
  assert.deepEqual(tree(w.root), before);
});

// ---------- 결과·기록 파일 잠금 (F1, R5, R6, R14) ----------

const VERIFIER_CALLER = { agent_id: 'agent-v1', agent_type: 'pact:verifier' };
const WORKER_CALLER = { agent_id: 'agent-w1', agent_type: 'pact:worker' };
const fileCall = (tool_name, file) => ({
  tool_name,
  tool_input: tool_name === 'NotebookEdit' ? { notebook_path: file } : { file_path: file, content: 'x', old_string: 'a', new_string: 'b', edits: [] },
});
const FILE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('lock (a) the main session is denied on results.json and results-round1.json through Write, Edit, MultiEdit and NotebookEdit, with why and what to do on one line', () => {
  const w = busyWorld();
  const before = tree(w.root);
  for (const name of ['results.json', 'results-round1.json']) {
    for (const tool of FILE_TOOLS) {
      const reason = denied(pre(w, fileCall(tool, path.join(w.run, name))), `${tool} ${name}`);
      assert.match(reason, new RegExp(`검수 결과\\(${escapeRe(name)}\\)는 verifier만 쓴다`), `${tool} ${name}`);
      assert.match(reason, name === 'results.json' ? /build로 되돌려 고치고 verifier로 다시 검수한다\. 보고 칸.*summary\.json에 쓴다/ : /snapshot.*results-round<n>\.json/, `${tool} ${name}`);
    }
  }
  assert.deepEqual(tree(w.root), before, '막으면서 아무것도 만들거나 바꾸지 않는다');
  assert.equal(existsSync(w.data), false, '막는 것은 오류가 아니다: 오류 기록도 없다');
});

test('lock (b) the verifier may write results.json and results-round files and nothing else locked; a worker, a reviewer, a spec-checker and another plugin\'s agent may write none', () => {
  const w = busyWorld();
  for (const name of ['results.json', 'results-round1.json']) {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) passed(pre(w, fileCall(tool, path.join(w.run, name)), VERIFIER_CALLER), `verifier ${tool} ${name}`);
  }
  // agent_type만 있고 agent_id가 없는 입력은 `claude --agent pact:verifier`로 연 대화다: 그것이 verifier다
  passed(pre(w, fileCall('Write', path.join(w.run, 'results.json')), { agent_type: 'pact:verifier' }), 'agent_type만');
  for (const name of ['verification.json', 'approvals.jsonl', 'log/subagents.jsonl']) {
    for (const tool of FILE_TOOLS) denied(pre(w, fileCall(tool, path.join(w.run, name)), VERIFIER_CALLER), `verifier ${tool} ${name}`);
  }
  assert.match(denied(pre(w, fileCall('Write', path.join(w.run, 'verification.json')), VERIFIER_CALLER)), /검수 기록\(verification\.json\)은 verification\.mjs snapshot만 쓴다.*snapshot은 메인 세션이 돌린다/);
  assert.match(denied(pre(w, fileCall('Write', path.join(w.run, 'verification.json')))), /검수 기록\(verification\.json\)은 verification\.mjs snapshot만 쓴다.*snapshot을 다시 실행한다/);
  for (const agent_type of ['pact:worker', 'pact:reviewer', 'pact:spec-checker', 'tiers:worker', 'Explore', 'pact:verifiers', 'pact:verifier-2', 'notpact:verifier', 'verifier']) {
    const caller = { agent_id: 'agent-x', agent_type };
    for (const tool of ['Write', 'Edit']) assert.match(denied(pre(w, fileCall(tool, path.join(w.run, 'results.json')), caller), `${agent_type} ${tool}`), /verifier만 쓴다/);
    denied(pre(w, fileCall('Write', path.join(w.run, 'results-round2.json')), caller), `${agent_type} round`);
  }
  // 에이전트 종류가 없는 하위 에이전트도 verifier가 아니다
  denied(pre(w, fileCall('Write', path.join(w.run, 'results.json')), { agent_id: 'agent-x' }));
  // verifier라도 잠기지 않은 것은 누구나 쓴다
  for (const name of ['summary.json', 'report.html', 'plan.md', 'shots/S1-1.jpg', 'tasks/1-report.md']) {
    for (const caller of [{}, VERIFIER_CALLER, WORKER_CALLER]) passed(pre(w, fileCall('Write', path.join(w.run, name)), caller), `${name} ${JSON.stringify(caller)}`);
  }
});

test('lock (c) Bash: write forms that target results.json are denied for the main session; reading and pact script calls pass; a write form next to a pact script call is still caught', () => {
  const w = busyWorld();
  const R = w.run;
  const before = tree(w.root);
  const writes = [
    `python3 -c "import json; json.dump({}, open('${R}/results.json','w'))"`,
    `python3 - <<'EOF'\nimport json\np='${R}/results.json'\nd=json.load(open(p))\nd['headline']='x'\njson.dump(d, open(p,'w'), ensure_ascii=False)\nEOF`,
    `node -e "const fs=require('fs'); fs.writeFileSync('${R}/results.json', '{}')"`,
    `sed -i '' 's/a/b/' ${R}/results.json`, `perl -pi -e 's/a/b/' ${R}/results.json`,
    `echo x > ${R}/results.json`, `echo x >> ${R}/results-round1.json`, `cat > ${R}/results.json <<'EOF'\n{}\nEOF`,
    `cp /tmp/a ${R}/results.json`, `cp ${R}/results.json ${R}/results-round1.json`, `mv /tmp/a ${R}/results.json`, `rm ${R}/results.json`, `truncate -s 0 ${R}/results.json`, `touch ${R}/results-round3.json`,
    `jq '.headline="x"' ${R}/results.json > ${R}/results.json`, `jq '.headline="x"' ${R}/results.json > /tmp/r.json && mv /tmp/r.json ${R}/results.json`, `jq . /tmp/a.json | tee ${R}/results.json`,
    `cd ${R} && echo x > results.json`, `RUN=${R}; echo x > $RUN/results.json`, `bash -c "echo x > ${R}/results.json"`,
    `node ${ROOT}/scripts/verification.mjs snapshot ${w.spec} ${R}/wt ui && echo x > ${R}/results.json`,
    `node ${ROOT}/scripts/report.mjs ${R} && cp /tmp/a ${R}/results.json`,
  ];
  for (const command of writes) {
    const reason = denied(pre(w, bash(command)), command);
    assert.match(reason, /verifier만 쓴다/, command);
  }
  const reads = [
    `cat ${R}/results.json`, `jq . ${R}/results.json`, `jq '.scenarios | length' ${R}/results.json`, `grep headline ${R}/results.json`, `cat ${R}/results.json > /tmp/copy.json`, `cp ${R}/results.json /tmp/backup.json`,
    `ls -la ${R}`, `python3 -c "import json; print(json.load(open('${R}/results.json'))['scenarios'])"`, `node -e "console.log(require('${R}/results.json').scenarios.length)"`,
    `echo x > ${R}/summary.json`, `python3 -c "import json; json.dump({}, open('${R}/summary.json','w'))"`,
    `node ${ROOT}/scripts/verification.mjs snapshot ${w.spec} ${R}/wt ui`, `node ${ROOT}/scripts/verification.mjs check ${w.spec} ${R}/wt`, `node ${ROOT}/scripts/verification.mjs finish ${w.spec} ${w.project}`,
    `node ${ROOT}/scripts/report.mjs ${R}`, `node /somewhere/else/scripts/report.mjs ${R} 2>&1 | tail -3`,
    `git commit -m "echo x > ${R}/results.json 를 막는다"`,
  ];
  for (const command of reads) passed(pre(w, bash(command)), command);
  assert.deepEqual(tree(w.root), before);
  // 같은 호출을 verifier가 하면 results.json 쓰기는 통과하고, 잠긴 다른 파일은 그대로 막힌다
  for (const command of writes.slice(0, 8)) passed(pre(w, bash(command), VERIFIER_CALLER), `verifier ${command}`);
  denied(pre(w, bash(`echo x > ${R}/verification.json`), VERIFIER_CALLER));
  denied(pre(w, bash(`python3 -c "open('${R}/log/subagents.jsonl','a')"`), VERIFIER_CALLER));
  // 하위 에이전트(worker)도 메인과 같다
  denied(pre(w, bash(`echo x > ${R}/results.json`), WORKER_CALLER));
  passed(pre(w, bash(`cat ${R}/results.json`), WORKER_CALLER));
});

test('lock (c) Bash: a command that runs inside the run dir is a pact call even when it does not say .pact/', () => {
  const w = busyWorld();
  const inRun = (command, cwd = w.run) => runHook(w, { hook_event_name: 'PreToolUse', session_id: 's', cwd, ...bash(command) });
  assert.match(denied(inRun('echo x > results.json')), /verifier만 쓴다/);
  denied(inRun('sed -i "" s/a/b/ results.json'));
  denied(inRun('cp /tmp/a results-round1.json'));
  denied(inRun('python3 -c "open(\'results.json\',\'w\')"'));
  passed(inRun('cat results.json | jq .'));
  passed(inRun('echo x > summary.json'));
  passed(inRun('echo x > results.json', path.join(w.run, 'wt')), 'worktree 안');
  passed(inRun('echo x > results.json', w.project), '프로젝트 맨 위: pact 호출이 아니다');
  passed(inRun('echo x > results.json', w.root), '프로젝트가 아닌 곳');
  assert.equal(existsSync(w.data), false);
});

test('lock (d) approvals.jsonl and log/ are written by nobody but the hook and the scripts: not the main session, a worker or the verifier, through any tool', () => {
  const w = busyWorld();
  const R = w.run;
  const callers = [{}, WORKER_CALLER, VERIFIER_CALLER, { agent_id: 'agent-r', agent_type: 'pact:reviewer' }];
  for (const caller of callers) {
    for (const name of ['approvals.jsonl', 'log/subagents.jsonl', 'log/other.log']) {
      for (const tool of FILE_TOOLS) denied(pre(w, fileCall(tool, path.join(R, name)), caller), `${tool} ${name} ${JSON.stringify(caller)}`);
    }
    for (const command of [
      `echo x >> ${R}/approvals.jsonl`, `echo x > ${R}/log/subagents.jsonl`, `echo '{"kind":"approve"}' | tee -a ${R}/approvals.jsonl`, `sed -i '' '$d' ${R}/log/subagents.jsonl`,
      `rm ${R}/approvals.jsonl`, `rm -rf ${R}/log`, `cp /tmp/a ${R}/approvals.jsonl`, `mv /tmp/a ${R}/log/subagents.jsonl`, `truncate -s 0 ${R}/log/subagents.jsonl`, `touch ${R}/log/x`,
      `python3 -c "open('${R}/approvals.jsonl','a').write('x')"`, `node -e "require('fs').appendFileSync('${R}/log/subagents.jsonl','x')"`,
      `cd ${R} && echo x >> approvals.jsonl`, `cd ${R}/log && echo x > subagents.jsonl`,
    ]) denied(pre(w, bash(command), caller), `${command} ${JSON.stringify(caller)}`);
    passed(pre(w, bash(`cat ${R}/approvals.jsonl ${R}/log/subagents.jsonl | jq .`), caller), '읽기');
    passed(pre(w, bash(`grep -c . ${R}/log/subagents.jsonl`), caller), '읽기');
  }
  const approvals = denied(pre(w, fileCall('Write', path.join(R, 'approvals.jsonl'))));
  assert.match(approvals, /승인 기록\(approvals\.jsonl\)은 spec\.mjs approve·delegate만 쓴다.*spec\.mjs approve/);
  const log = denied(pre(w, fileCall('Edit', path.join(R, 'log', 'subagents.jsonl'))));
  assert.match(log, /log\/ 밑의 기록\(log\/subagents\.jsonl\)은 훅이.*훅과 pact 스크립트만 쓴다.*hook-error\.log를 보고 사용자에게 알린다\. 다른 기록은 log\/ 밖에 둔다/);
  // 잠그는 것이 스크립트를 멈추지는 않는다: 같은 파일을 스크립트가 쓰는 길은 그대로다
  assert.equal(existsSync(path.join(R, 'log', 'subagents.jsonl')), true);
});

test('lock (e) the worktree, other projects, a .pact/ with no spec, and files that are not locked are never touched, even by the main session', () => {
  const w = busyWorld();
  mkdirSync(path.join(w.run, 'wt', 'sub', 'log'), { recursive: true });
  const other = path.join(w.root, 'other');
  mkdirSync(path.join(other, '.pact', ID, 'log'), { recursive: true }); // 다른 프로젝트: 명세가 없다
  const bare = path.join(w.root, 'bare');
  mkdirSync(path.join(bare, '.pact', 'tmp-run'), { recursive: true }); // 시험이나 개발 중 임시 .pact/
  for (const caller of [{}, WORKER_CALLER]) {
    for (const file of [
      path.join(w.run, 'wt', 'results.json'), path.join(w.run, 'wt', 'sub', 'log', 'x.log'), path.join(w.run, 'wt', 'plugins', 'pact', 'approvals.jsonl'), path.join(w.run, 'wt', 'verification.json'),
      path.join(w.run, 'wt', '.pact', ID, 'results.json'), path.join(w.run, 'tasks', 'x', '.pact', 'r2', 'results.json'),
      path.join(other, '.pact', ID, 'results.json'), path.join(other, '.pact', ID, 'log', 'subagents.jsonl'), path.join(bare, '.pact', 'tmp-run', 'results.json'), path.join(bare, '.pact', 'tmp-run', 'approvals.jsonl'),
      path.join(w.run, 'results.json.bak'), path.join(w.run, 'items.json'), path.join(w.run, 'logs', 'x'),
    ]) {
      for (const tool of ['Write', 'Edit']) passed(pre(w, fileCall(tool, file), caller), `${tool} ${file}`);
    }
    for (const command of [
      `echo x > ${w.run}/wt/results.json`, `cd ${w.run}/wt && echo x > results.json`, `rm -rf ${w.run}/wt/sub/log`, `cp /tmp/a ${w.run}/wt/approvals.jsonl`,
      `echo x > ${other}/.pact/${ID}/results.json`, `rm ${other}/.pact/${ID}/log/subagents.jsonl`, `echo x > ${bare}/.pact/tmp-run/results.json`, `python3 -c "open('${bare}/.pact/tmp-run/results.json','w')"`,
      `cd ${w.run}/wt/sub && python3 -c "import os; open(os.path.join('/tmp/q','log'),'w'); open('results.json','w')"`,
    ]) passed(pre(w, bash(command), caller), command);
  }
  // 명세를 지우면 그 판의 잠금도 풀린다(명세가 있는 판에만 건다)
  rmSync(w.spec);
  passed(pre(w, fileCall('Write', path.join(w.run, 'results.json'))), '명세가 없는 판');
  writeSpec(w.project, ID);
  denied(pre(w, fileCall('Write', path.join(w.run, 'results.json'))), '명세가 다시 생기면 걸린다');
});

test('lock (R5) an old spec (pact: 1) is locked the same way, and so is an old run folder without the date', () => {
  const old = busyWorld();
  writeFileSync(old.spec, specText({ pact: 1, status: 'building' }));
  denied(pre(old, fileCall('Write', path.join(old.run, 'results.json'))), 'pact: 1 명세');
  denied(pre(old, bash(`echo x > ${old.run}/log/subagents.jsonl`)), 'pact: 1 Bash');
  passed(pre(old, fileCall('Write', path.join(old.run, 'results.json')), VERIFIER_CALLER), 'pact: 1 verifier');
  const undated = path.join(old.project, '.pact', '출결-관리');
  mkdirSync(undated, { recursive: true });
  denied(pre(old, fileCall('Write', path.join(undated, 'results.json'))), '날짜 없는 옛 실행 폴더');
  denied(pre(old, bash(`cp /tmp/a ${undated}/results-round1.json`)), '날짜 없는 옛 실행 폴더 Bash');
  passed(pre(old, fileCall('Write', path.join(undated, 'summary.json'))));
});

test('lock: a call with odd input is passed, never blocked, and a relative path with no usable cwd is read from the hook\'s own cwd', () => {
  const w = busyWorld();
  for (const input of [
    { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 42 } },
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: ['echo'] }, cwd: w.run },
    { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: null },
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo x > results.json' }, cwd: 42 },
    { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'results.json' } },
  ]) {
    const r = runHook(w, input);
    assert.equal(r.stdout, '', JSON.stringify(input));
  }
  assert.equal(existsSync(w.data), false, '이상한 입력은 오류도 아니다');
});

// ---------- 검토 반영 ----------

test('lock (derived paths): the main session reads results.json and writes summary.json or plan.md next to it, the verifier writes shots next to verification.json: all pass; the locked file itself is still denied', () => {
  const w = busyWorld();
  const R = w.run;
  const heredoc = (code) => `python3 - <<'EOF'\n${code}\nEOF`;
  for (const command of [
    heredoc(`import json\nfrom pathlib import Path\nres = Path('${R}/results.json')\nd = json.loads(res.read_text())\n(res.parent / 'summary.json').write_text(json.dumps({'headline': '다 됐다', 'todo': [], 'changes': [], 'decision': {}}))`),
    heredoc(`import json, os\nres = '${R}/results.json'\nd = json.load(open(res))\njson.dump({'todo': []}, open(os.path.join(os.path.dirname(res), 'summary.json'), 'w'))`),
    heredoc(`import os\nres = '${R}/results.json'\nopen(os.path.join(os.path.dirname(res), 'plan.md'), 'a').write('\\n## verify\\n')`),
    heredoc(`src = '${R}/results.json'\nopen(src.replace('results.json', 'summary.json'), 'w').write('{}')`),
    `node -e "const fs=require('fs'), path=require('path'); const res='${R}/results.json'; fs.writeFileSync(path.join(path.dirname(res),'summary.json'), '{}')"`,
  ]) passed(pre(w, bash(command)), command);
  passed(pre(w, bash(heredoc(`import os\nv = '${R}/verification.json'\nopen(os.path.join(os.path.dirname(v), 'shots', 'S1-1.txt'), 'w').write('x')`)), VERIFIER_CALLER), 'verifier의 shots 쓰기');
  // 잠긴 파일 자체나 그 이름을 이은 것은 그대로 막힌다
  for (const command of [
    heredoc(`from pathlib import Path\nres = Path('${R}/results.json')\n(res.parent / 'results.json').write_text('{}')`),
    heredoc(`import os\nRUN = '${R}'\nopen(os.path.join(RUN, 'results.json'), 'w').write('{}')`),
    heredoc(`RD = '${R}'\nopen(f'{RD}/results.json', 'w').write('{}')`),
    heredoc(`from pathlib import Path\np = Path('${R}/results.json')\np.open('w').write('{}')`),
  ]) assert.match(denied(pre(w, bash(command)), command), /검수 결과\(results\.json\)는 verifier만 쓴다/);
});

test('lock (review): the name is compared without regard to case, $PWD is the cwd, and a command that rewrites the whole results.json is read', () => {
  const w = busyWorld();
  const R = w.run;
  for (const name of ['RESULTS.JSON', 'Results-Round1.json', 'VERIFICATION.JSON', 'Approvals.jsonl', 'LOG/subagents.jsonl']) {
    denied(pre(w, fileCall('Write', path.join(R, name))), `Write ${name}`);
    denied(pre(w, bash(`echo x > ${R}/${name}`)), `echo > ${name}`);
  }
  denied(pre(w, fileCall('Write', path.join(w.project, '.PACT', ID, 'results.json'))), '.PACT');
  passed(pre(w, fileCall('Write', path.join(R, 'SUMMARY.JSON'))), 'SUMMARY.JSON');
  const inRun = (command, cwd) => runHook(w, { hook_event_name: 'PreToolUse', session_id: 's', cwd, ...bash(command) });
  denied(inRun('echo x > $PWD/results.json', R));
  denied(inRun('echo x > "${PWD}/log/subagents.jsonl"', R));
  passed(inRun('echo x > $PWD/results.json', path.join(R, 'wt')), 'worktree 안의 $PWD');
  passed(inRun('echo x > $PWD/results.json', w.project), '프로젝트 맨 위의 $PWD');
  // 통째로 다시 쓰는 글(수백 KB)도 읽는다. 지난 상한은 20만 자였다
  const json = JSON.stringify({ scenarios: Array.from({ length: 3000 }, (_, i) => ({ id: `S${i}`, title: `시나리오 ${i} "인용" (괄호)`, steps: [{ action: 'a'.repeat(40), output: 'o'.repeat(60) }] })) });
  assert.ok(json.length > 200_000);
  denied(pre(w, bash(`cat > ${R}/results.json <<'EOF'\n${json}\nEOF`)), 'cat 으로 통째로 다시 쓰기');
  passed(pre(w, bash(`cat > ${R}/results.json <<'EOF'\n${json}\nEOF`), VERIFIER_CALLER), 'verifier는 같은 것을 쓴다');
});

test('lock (review): what to do instead fits the caller: a sub-agent is told to hand the matter to the main session, and log/ says to keep other records outside log/', () => {
  const w = busyWorld();
  const R = w.run;
  const say = (call, caller) => denied(pre(w, call, caller));
  const approvals = fileCall('Write', path.join(R, 'approvals.jsonl'));
  assert.match(say(approvals, {}), /사용자가 승인한 말을 그대로 넣어 spec\.mjs approve로 기록한다/);
  assert.match(say(approvals, WORKER_CALLER), /메인 세션이 사용자 말을 받아 spec\.mjs approve로 기록한다.*답장에 적어 메인 세션에 넘긴다/);
  assert.doesNotMatch(say(approvals, WORKER_CALLER), /사용자가 승인한 말을 그대로 넣어/);
  assert.match(say(bash(`echo x >> ${R}/approvals.jsonl`), WORKER_CALLER), /메인 세션이 사용자 말을 받아/);
  const verification = fileCall('Write', path.join(R, 'verification.json'));
  assert.match(say(verification, {}), /worktree를 커밋하고 snapshot을 다시 실행한다/);
  assert.match(say(verification, VERIFIER_CALLER), /snapshot은 메인 세션이 돌린다.*답장에 적어 메인 세션에 넘긴다/);
  const results = fileCall('Write', path.join(R, 'results.json'));
  assert.match(say(results, {}), /build로 되돌려 고치고 verifier로 다시 검수한다/);
  assert.match(say(results, WORKER_CALLER), /답장에 적어 메인 세션에 넘긴다/);
  assert.doesNotMatch(say(results, WORKER_CALLER), /build로 되돌려/);
  const log = fileCall('Write', path.join(R, 'log', 'subagents.jsonl'));
  assert.match(say(log, {}), /hook-error\.log를 보고 사용자에게 알린다\. 다른 기록은 log\/ 밖에 둔다/);
  assert.match(say(log, WORKER_CALLER), /hook-error\.log를 보고 답장에 적어 메인 세션에 알린다\. 다른 기록은 log\/ 밖에 둔다/);
});

test('lock (R7): when the lock module itself is broken, the hook passes the call, exits 0, and logs one error line', () => {
  const w = busyWorld();
  const plugin = path.join(w.root, 'plugin-copy'); // 훅과 scripts를 베껴 locks.mjs만 깬다
  cpSync(path.join(ROOT, 'hooks'), path.join(plugin, 'hooks'), { recursive: true });
  cpSync(path.join(ROOT, 'scripts'), path.join(plugin, 'scripts'), { recursive: true });
  writeFileSync(path.join(plugin, 'scripts', 'locks.mjs'), 'export const broken = ;\n');
  const hook = (input) => spawnSync(process.execPath, [path.join(plugin, 'hooks', 'guard.mjs')], { input: JSON.stringify(input), encoding: 'utf8', cwd: w.root, env: baseEnv(w) });
  const locked = { hook_event_name: 'PreToolUse', session_id: 's', cwd: w.project, tool_name: 'Write', tool_input: { file_path: path.join(w.run, 'results.json'), content: '{}' } };
  const r = hook(locked);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', '고장난 훅은 막지 않는다');
  const lines = errorLines(w);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /\[PreToolUse\]/);
  assert.match(lines[0], /SyntaxError/);
  // 같은 복사본에서 잠금과 상관없는 호출은 모듈을 부르지도 않는다
  assert.equal(hook({ ...locked, tool_input: { file_path: path.join(w.root, 'other.txt') } }).stdout, '');
  assert.equal(errorLines(w).length, 1);
  // 고장나지 않은 훅은 같은 호출을 막는다
  denied(pre(w, locked));
});

// ---------- worker 걱정 붙이기 (F6, R16) ----------
// 걱정은 보고서 파일이 아니라 훅이 남긴 log/의 worker 답에서 가져온다. 시험도 같은 길로 기록을 만든다(SubagentStop 입력을 훅에 넣는다).

const reviewWorld = () => {
  const w = world();
  mkdirSync(w.run, { recursive: true });
  return w;
};
const workerBrief = (w, n) => `## 목표\n훅을 넣는다\n## 맥락\nrun-dir: ${w.run} , 작업 번호 ${n}. 보고서는 이 run-dir의 tasks/${n}-report.md.\nworktree: ${w.run}/wt\n## 범위\n…`;
const workerAnswer = (w, n, concerns) => [
  '## 상태: DONE', '## 바꾼 파일', '- hooks/guard.mjs — 훅', '## 확인', '- node --test tests/ → 통과 459, 실패 0', '## 정한 것', '- 없음',
  '## 걱정·위험', ...concerns, `보고서: ${w.run}/tasks/${n}-report.md`,
].join('\n');
const workerStops = (w, n, concerns, extra = {}) => stop(w, stopInput(w, 'pact:worker', workerBrief(w, n), workerAnswer(w, n, concerns), extra));
const reviewerBrief = (w, n) => `pact build 작업 ${n}을 검토해 줘.\n\n- worktree: ${w.run}/wt\n- base SHA: abc123\n- head SHA: def456\n- worker 보고서: ${w.run}/tasks/${n}-report.md\n\n## 관련 명세 항목\n- F6 worker 보고의 걱정이 reviewer 작업 지시에 저절로 붙는다 [사용자]`;
const reviewerStops = (w, n, agent_id, message = '## 판정: 고칠 것 있음') => stop(w, stopInput(w, 'pact:reviewer', reviewerBrief(w, n), message, { agent_id }));
const reviewerCall = (prompt, extra = {}) => ({ tool_name: 'Agent', tool_input: { subagent_type: 'pact:reviewer', description: '작업 2 검토', prompt, ...extra } });
const messageCall = (to, message, extra = {}) => ({ tool_name: 'SendMessage', tool_input: { to, summary: '두 번째 검토', message, ...extra } });

// 걱정이 붙어 통과한 출력: 막지 않고(allow) 바뀐 입력(updatedInput)만 낸다. 바뀐 입력을 돌려준다.
function attached(r, label = '') {
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput'], label);
  assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), ['hookEventName', 'permissionDecision', 'updatedInput'], label);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse', label);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow', label);
  assert.equal(r.stderr, '', label);
  return out.hookSpecificOutput.updatedInput;
}
const concernOf = (text) => text.split('\n\n## worker 걱정\n')[1];

test('(a) the main session calls pact:reviewer for task 2: the two worry lines of the latest worker reply are appended to the prompt as "## worker 걱정", and every other field stays as it was', () => {
  const w = reviewWorld();
  const concerns = ['- 실제 Claude Code에서는 안 돌려 봤다(R18 몫).', '- 작업 번호가 null인 worker가 123개 중 35개라 null은 "못 찾음"으로 다뤘다.'];
  workerStops(w, 2, concerns);
  const call = reviewerCall(reviewerBrief(w, 2), { model: 'opus', run_in_background: true });
  const before = tree(w.root);
  const updated = attached(pre(w, call));
  assert.equal(updated.prompt, `${call.tool_input.prompt}\n\n## worker 걱정\n${concerns.join('\n')}`);
  assert.ok(updated.prompt.startsWith(call.tool_input.prompt), '지시 본문은 그대로이고 끝에 붙는다');
  assert.deepEqual(Object.keys(updated), Object.keys(call.tool_input), 'tool_input의 칸이 늘거나 줄지 않는다');
  assert.deepEqual({ ...updated, prompt: 0 }, { ...call.tool_input, prompt: 0 }, 'prompt 말고는 그대로다');
  assert.deepEqual(tree(w.root), before, '아무 파일도 만들거나 고치지 않는다');
  assert.deepEqual(errorLines(w), []);
});

test('(a) the worry text is the whole field as written: lines, blank lines and nested items, without the report line', () => {
  const w = reviewWorld();
  workerStops(w, 2, ['- 첫째 걱정', '  - 둘째 줄 설명', '', '- 셋째 걱정']);
  const updated = attached(pre(w, reviewerCall(reviewerBrief(w, 2))));
  assert.equal(concernOf(updated.prompt), '- 첫째 걱정\n  - 둘째 줄 설명\n\n- 셋째 걱정');
  assert.doesNotMatch(updated.prompt, /\n보고서: .*\/tasks\/2-report\.md$/, '답의 마지막 줄 `보고서: …`는 붙이지 않는다');
});

test('(a) the task number is read from the prompt the way the log reads it: a "작업 번호 n" wins over the report paths of earlier tasks listed beside it', () => {
  const w = reviewWorld();
  workerStops(w, 1, ['- 작업 1의 걱정']);
  workerStops(w, 2, ['- 작업 2의 걱정']);
  const prompt = `작업 번호 2를 검토해 줘.\n앞 작업 보고서: ${w.run}/tasks/1-report.md\nworker 보고서: ${w.run}/tasks/2-report.md`;
  assert.equal(concernOf(attached(pre(w, reviewerCall(prompt))).prompt), '- 작업 2의 걱정');
});

test('(a) only the main session is given the concerns: a sub-agent calling pact:reviewer is left alone, and so is every other kind of Agent call', () => {
  const w = reviewWorld();
  workerStops(w, 2, ['- 걱정 하나']);
  const prompt = reviewerBrief(w, 2);
  passed(pre(w, reviewerCall(prompt), SUB), '하위 에이전트');
  passed(pre(w, reviewerCall(prompt), { agent_id: 'agent-9', agent_type: 'pact:reviewer' }), 'reviewer라는 하위 에이전트');
  for (const subagent_type of ['pact:verifier', 'pact:spec-checker', 'tiers:worker', 'Explore', 'pact:reviewers', 'reviewer']) {
    passed(pre(w, { tool_name: 'Agent', tool_input: { subagent_type, prompt } }), subagent_type);
  }
  passed(pre(w, { tool_name: 'Agent', tool_input: { prompt } }), 'subagent_type 없음');
  assert.ok(concernOf(attached(pre(w, reviewerCall(prompt))).prompt), '메인 세션이면 붙는다');
});

test('(b) a worry field that says "없음", is empty, or is missing passes the call unchanged: no output at all', () => {
  for (const [label, lines] of Object.entries({
    '- 없음': ['- 없음'], 없음: ['없음'], '없음.': ['- 없음.'], 굵게: ['- **없음**'], '빈 칸': [], '빈 줄만': ['', ''], '목록 표시만': ['-'],
  })) {
    const w = reviewWorld();
    workerStops(w, 2, lines);
    passed(pre(w, reviewerCall(reviewerBrief(w, 2))), label);
    assert.deepEqual(errorLines(w), [], label);
  }
  // 칸이 아예 없는 답(BLOCKED)과 빈 답
  const w = reviewWorld();
  stop(w, stopInput(w, 'pact:worker', workerBrief(w, 2), 'BLOCKED: 질문이 있다\n1. 결정할 것: 이름\n   - 기본값: 가'));
  passed(pre(w, reviewerCall(reviewerBrief(w, 2))), 'BLOCKED');
  const e = reviewWorld();
  stop(e, stopInput(e, 'pact:worker', workerBrief(e, 2), undefined));
  passed(pre(e, reviewerCall(reviewerBrief(e, 2))), '빈 답');
  // '없음'으로 시작해도 이어서 말하면 걱정이다
  const m = reviewWorld();
  workerStops(m, 2, ['- 없음. 다만 Node 18에서는 못 돌렸다']);
  assert.equal(concernOf(attached(pre(m, reviewerCall(reviewerBrief(m, 2)))).prompt), '- 없음. 다만 Node 18에서는 못 돌렸다');
});

test('(c) a prompt with no task number, or with several report paths, or with a number no worker record has, passes unchanged; the same for a run the prompt does not name', () => {
  const w = reviewWorld();
  workerStops(w, 2, ['- 걱정 하나']);
  passed(pre(w, reviewerCall(`run-dir: ${w.run}\n작업을 검토해 줘.`)), '작업 번호 없음');
  passed(pre(w, reviewerCall(`${w.run}/tasks/1-report.md 와 ${w.run}/tasks/2-report.md`)), '보고서 경로가 여럿');
  passed(pre(w, reviewerCall(reviewerBrief(w, 3))), '3번의 worker 기록이 없다');
  // 번호는 있어도 판을 글로 못 찾는다. cwd 프로젝트에 진행 중 명세가 있어도 짐작하지 않는다
  writeSpec(w.project, ID);
  passed(pre(w, reviewerCall('작업 번호 2를 검토해 줘.')), '경로가 없다');
  passed(pre(w, reviewerCall(undefined)), 'prompt가 없다');
  passed(pre(w, reviewerCall('')), 'prompt가 비었다');
  passed(pre(w, { tool_name: 'Agent', tool_input: { subagent_type: 'pact:reviewer', prompt: { text: reviewerBrief(w, 2) } } }), 'prompt가 글이 아니다');
  // worker 기록이 아직 없는 판
  const fresh = reviewWorld();
  passed(pre(fresh, reviewerCall(reviewerBrief(fresh, 2))), '기록이 없다');
  assert.deepEqual(errorLines(w), []);
  assert.deepEqual(errorLines(fresh), []);
});

test('(c) records that cannot be tied to the task are not used: a worker record with no task number, another task\'s record, another run\'s record, another agent\'s record', () => {
  const w = reviewWorld();
  const other = path.join(w.project, '.pact', '2026-10-30-다른-판');
  mkdirSync(other, { recursive: true });
  const record = (agent_type, task, message) => ({ time: '2026-10-29T01:00:00.000Z', agent_type, agent_id: 'a', task, message });
  appendRecord(w.run, record('pact:worker', null, workerAnswer(w, 2, ['- 번호를 모르는 답의 걱정'])));
  appendRecord(w.run, record('pact:worker', 3, workerAnswer(w, 3, ['- 작업 3의 걱정'])));
  appendRecord(w.run, record('pact:reviewer', 2, workerAnswer(w, 2, ['- reviewer 기록의 글'])));
  appendRecord(w.run, record('tiers:worker', 2, workerAnswer(w, 2, ['- 다른 플러그인 worker의 글'])));
  appendRecord(other, record('pact:worker', 2, workerAnswer({ run: other }, 2, ['- 다른 판 작업 2의 걱정'])));
  passed(pre(w, reviewerCall(reviewerBrief(w, 2))));
  assert.equal(concernOf(attached(pre(w, reviewerCall(reviewerBrief(w, 3)))).prompt), '- 작업 3의 걱정', '번호가 맞는 기록은 쓴다');
  // 다른 판을 가리키는 글이면 그 판의 기록을 쓴다
  const prompt = `worker 보고서: ${other}/tasks/2-report.md`;
  assert.equal(concernOf(attached(pre(w, reviewerCall(prompt))).prompt), '- 다른 판 작업 2의 걱정');
});

test('(d) a prompt that already has a worker worry section is not given a second one, at any heading level and in the wording the main session used by hand', () => {
  const w = reviewWorld();
  workerStops(w, 2, ['- 걱정 하나']);
  for (const heading of ['## worker 걱정', '### worker 걱정', '## worker가 남긴 걱정(상태 DONE_WITH_CONCERNS)']) {
    passed(pre(w, reviewerCall(`${reviewerBrief(w, 2)}\n\n${heading}\n- 메인 세션이 옮긴 걱정`)), heading);
  }
  passed(pre(w, reviewerCall(`## worker 걱정\n- 맨 앞에 있다\n\n${reviewerBrief(w, 2)}`)), '맨 앞');
  // 칸이 아닌 것은 붙는다: 제목이 아닌 말, reviewer 답의 `## worker 걱정 처리` 제목
  assert.ok(attached(pre(w, reviewerCall(`${reviewerBrief(w, 2)}\n앞서 worker 걱정을 봤다.`))).prompt.endsWith('\n- 걱정 하나'));
  assert.ok(attached(pre(w, reviewerCall(`${reviewerBrief(w, 2)}\n\n## worker 걱정 처리\n- 앞 검토 때 쓴 것`))).prompt.endsWith('\n- 걱정 하나'));
});

test('(e) with two worker replies for one task the latest one\'s worry is used, other tasks\' replies are never mixed in, and a later reply with no worry does not bring the earlier one back', () => {
  const w = reviewWorld();
  workerStops(w, 2, ['- 첫 답의 걱정']);
  workerStops(w, 3, ['- 작업 3의 걱정']);
  workerStops(w, 2, ['- 고친 뒤의 걱정']); // SendMessage로 돌아온 같은 worker의 답
  assert.equal(concernOf(attached(pre(w, reviewerCall(reviewerBrief(w, 2)))).prompt), '- 고친 뒤의 걱정');
  assert.equal(concernOf(attached(pre(w, reviewerCall(reviewerBrief(w, 3)))).prompt), '- 작업 3의 걱정');
  workerStops(w, 2, ['- 없음']);
  passed(pre(w, reviewerCall(reviewerBrief(w, 2))), '가장 최근 답에 걱정이 없다');
  assert.equal(concernOf(attached(pre(w, reviewerCall(reviewerBrief(w, 3)))).prompt), '- 작업 3의 걱정', '작업 3은 그대로다');
});

test('(f) SendMessage to the agent id the log holds as the reviewer of task 2: the worry of the latest worker reply of that task (the one after the fix) is appended to the message', () => {
  const w = reviewWorld();
  workerStops(w, 2, ['- 첫 답의 걱정'], { agent_id: 'agent-w2' });
  reviewerStops(w, 2, 'agent-r2');
  workerStops(w, 2, ['- 고친 뒤의 걱정 하나', '- 고친 뒤의 걱정 둘'], { agent_id: 'agent-w2' }); // SendMessage로 돌아온 같은 worker의 답
  workerStops(w, 3, ['- 작업 3의 걱정'], { agent_id: 'agent-w3' });
  const call = messageCall('agent-r2', '고쳤습니다. 커밋 범위 abc123..def456을 다시 봐 주세요.', { notify_when_idle: false });
  const before = tree(w.root);
  const updated = attached(pre(w, call));
  assert.equal(updated.message, `${call.tool_input.message}\n\n## worker 걱정\n- 고친 뒤의 걱정 하나\n- 고친 뒤의 걱정 둘`);
  assert.deepEqual(Object.keys(updated), Object.keys(call.tool_input));
  assert.deepEqual({ ...updated, message: 0 }, { ...call.tool_input, message: 0 }, 'message 말고는 그대로다(to, summary, notify_when_idle)');
  assert.deepEqual(tree(w.root), before, '아무 파일도 만들거나 고치지 않는다');
  assert.deepEqual(errorLines(w), []);
  // 같은 reviewer가 두 번째 검토를 끝낸 뒤에도 기록은 같은 id의 가장 최근 줄로 읽는다
  reviewerStops(w, 2, 'agent-r2', '## 판정: 통과');
  assert.equal(concernOf(attached(pre(w, call)).message), '- 고친 뒤의 걱정 하나\n- 고친 뒤의 걱정 둘');
});

test('(f) a SendMessage that is not to a logged reviewer passes unchanged: an unknown id, a name, a worker\'s id, a reviewer whose task is unknown', () => {
  const w = reviewWorld();
  workerStops(w, 2, ['- 걱정 하나'], { agent_id: 'agent-w2' });
  reviewerStops(w, 2, 'agent-r2');
  stop(w, stopInput(w, 'pact:reviewer', `run-dir: ${w.run}\n검토해 줘`, '## 판정: 통과', { agent_id: 'agent-rx' })); // 보고서 경로도 작업 번호도 없는 지시
  stop(w, stopInput(w, 'pact:spec-checker', w.spec, '## 사용자만 답할 수 있음\n없음', { agent_id: 'agent-s1' }));
  const before = tree(w.root);
  for (const to of ['agent-unknown', 'reviewer', 'main', 'worker [3fa9c1]', 'agent-w2', 'agent-rx', 'agent-s1', 'agent-r', 'AGENT-R2', 'agent-r2 ', ' agent-r2', '', '*']) {
    passed(pre(w, messageCall(to, '다시 봐 주세요.')), JSON.stringify(to));
  }
  for (const to of [undefined, null, 7, ['agent-r2'], { id: 'agent-r2' }]) {
    passed(pre(w, { tool_name: 'SendMessage', tool_input: { to, message: '다시 봐 주세요.' } }), JSON.stringify(to));
  }
  passed(pre(w, { tool_name: 'SendMessage', tool_input: { message: '다시 봐 주세요.' } }), 'to 없음');
  passed(pre(w, { tool_name: 'SendMessage' }), 'tool_input 없음');
  assert.deepEqual(tree(w.root), before);
  assert.deepEqual(errorLines(w), []);
  assert.ok(concernOf(attached(pre(w, messageCall('agent-r2', '다시 봐 주세요.'))).message), '같은 판에서 reviewer의 id에는 붙는다');
});

test('(f) a message that is empty or not text (a pure idle-notice request), one that already has the section, a worry that is "없음", and a sub-agent sender all pass unchanged', () => {
  const w = reviewWorld();
  workerStops(w, 2, ['- 걱정 하나']);
  reviewerStops(w, 2, 'agent-r2');
  for (const message of ['', '  \n', undefined, null, 7, { text: '고쳤습니다' }, ['고쳤습니다']]) {
    passed(pre(w, { tool_name: 'SendMessage', tool_input: { to: 'agent-r2', notify_when_idle: true, message } }), JSON.stringify(message));
  }
  passed(pre(w, { tool_name: 'SendMessage', tool_input: { to: 'agent-r2', notify_when_idle: true } }), 'message 없음');
  passed(pre(w, messageCall('agent-r2', '다시.\n\n## worker 걱정\n- 메인 세션이 옮긴 걱정')), '이미 있다');
  passed(pre(w, messageCall('agent-r2', '다시 봐 주세요.'), SUB), '하위 에이전트');
  workerStops(w, 2, ['- 없음']);
  passed(pre(w, messageCall('agent-r2', '다시 봐 주세요.')), '가장 최근 worker 답에 걱정이 없다');
  const fresh = reviewWorld();
  reviewerStops(fresh, 2, 'agent-r2'); // 그 작업의 worker 기록이 없다
  passed(pre(fresh, messageCall('agent-r2', '다시 봐 주세요.')), 'worker 기록 없음');
  assert.deepEqual(errorLines(w), []);
});

test('(f) a message that names another task than the reviewer\'s own passes unchanged: a reviewer used again for a second task must not be given the first task\'s worry', () => {
  const w = reviewWorld();
  workerStops(w, 2, ['- 작업 2의 걱정']);
  workerStops(w, 3, ['- 작업 3의 걱정']);
  reviewerStops(w, 2, 'agent-r2');
  passed(pre(w, messageCall('agent-r2', `이번에는 작업 번호 3을 검토해 주세요. worker 보고서: ${w.run}/tasks/3-report.md`)), '작업 번호 3');
  passed(pre(w, messageCall('agent-r2', `${w.run}/tasks/3-report.md를 검토해 주세요.`)), '보고서 경로 3');
  // 같은 작업을 말하거나, 작업을 말하지 않거나, 번호가 여럿이면(어느 작업을 말하는지 모른다) reviewer 기록의 작업 번호로 붙는다
  const asked = (message) => concernOf(attached(pre(w, messageCall('agent-r2', message))).message);
  assert.equal(asked('작업 번호 2를 고쳤습니다.'), '- 작업 2의 걱정');
  assert.equal(asked(`${w.run}/tasks/2-report.md를 고쳤습니다.`), '- 작업 2의 걱정');
  assert.equal(asked('고쳤습니다. 다시 봐 주세요.'), '- 작업 2의 걱정');
  assert.equal(asked(`앞 보고서 ${w.run}/tasks/1-report.md 와 ${w.run}/tasks/3-report.md도 봤습니다.`), '- 작업 2의 걱정');
});

test('(f) the run is found from the main session\'s cwd (the project, a folder under it, the worktree) or from a path in the message; from nowhere the call passes', () => {
  const w = reviewWorld();
  workerStops(w, 2, ['- 걱정 하나']);
  reviewerStops(w, 2, 'agent-r2');
  const sub = path.join(w.project, 'plugins', 'pact');
  const wt = path.join(w.run, 'wt', 'plugins', 'pact');
  const elsewhere = path.join(w.root, 'elsewhere');
  for (const dir of [sub, wt, elsewhere]) mkdirSync(dir, { recursive: true });
  const at = (cwd, call) => runHook(w, { hook_event_name: 'PreToolUse', session_id: 's', cwd, ...call });
  for (const cwd of [w.project, sub, wt]) assert.equal(concernOf(attached(at(cwd, messageCall('agent-r2', '다시 봐 주세요.')), cwd).message), '- 걱정 하나', cwd);
  passed(at(elsewhere, messageCall('agent-r2', '다시 봐 주세요.')), '프로젝트 밖이고 글에도 판이 없다');
  const named = `${w.run}/tasks/2-report.md를 고쳤습니다.`;
  assert.equal(attached(at(elsewhere, messageCall('agent-r2', named))).message, `${named}\n\n## worker 걱정\n- 걱정 하나`, '글이 판을 가리키면 프로젝트 밖에서도 된다');
});

test('(f) another run\'s reviewer id is found in the same project, and a SendMessage in a conversation that has nothing to do with pact reads nothing and writes nothing', () => {
  const w = reviewWorld();
  const earlier = path.join(w.project, '.pact', '2026-10-01-앞-판');
  mkdirSync(earlier, { recursive: true });
  const worker = { time: '2026-10-01T01:00:00.000Z', agent_type: 'pact:worker', agent_id: 'agent-w1', task: 4, message: workerAnswer({ run: earlier }, 4, ['- 앞 판의 걱정']) };
  appendRecord(earlier, worker);
  appendRecord(earlier, { ...worker, agent_type: 'pact:reviewer', agent_id: 'agent-r4', message: '## 판정: 고칠 것 있음' });
  workerStops(w, 2, ['- 이 판의 걱정']);
  assert.equal(concernOf(attached(pre(w, messageCall('agent-r4', '다시 봐 주세요.'))).message), '- 앞 판의 걱정', '그 reviewer가 있는 판의 worker 답을 쓴다');
  // pact 프로젝트가 아닌 곳: 읽거나 쓰지 않는다
  const plain = world();
  rmSync(path.join(plain.project, 'docs'), { recursive: true });
  const before = tree(plain.root);
  passed(runHook(plain, { hook_event_name: 'PreToolUse', session_id: 's', cwd: plain.project, ...messageCall('agent-r4', '다시 봐 주세요.') }));
  assert.deepEqual(tree(plain.root), before);
  assert.equal(existsSync(plain.data), false, '플러그인 데이터 폴더도 만들지 않는다');
});

test('(R7) when the log cannot be read the hook passes the call and logs one error line, for the reviewer brief and for the message', () => {
  const w = reviewWorld();
  mkdirSync(path.join(w.run, 'log', 'subagents.jsonl'), { recursive: true }); // 파일 자리에 폴더
  passed(pre(w, reviewerCall(reviewerBrief(w, 2))));
  let lines = errorLines(w);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /\[PreToolUse\]/);
  assert.match(lines[0], /EISDIR/);
  passed(pre(w, messageCall('agent-r2', '다시 봐 주세요.')));
  lines = errorLines(w);
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[1], /EISDIR/);
  // 기록을 읽지 않는 호출은 읽을 수 없는 기록이 있어도 오류를 내지 않는다: id 꼴이 아닌 to, 글이 없거나 비었거나 이미 칸이 있는 글, 하위 에이전트가 보내는 글
  for (const to of ['worker [3fa9c1]', 'agent-r2 ', '', '*']) passed(pre(w, messageCall(to, '다시 봐 주세요.')), JSON.stringify(to));
  passed(pre(w, { tool_name: 'SendMessage', tool_input: { to: 'agent-r2', notify_when_idle: true } }));
  passed(pre(w, messageCall('agent-r2', '  ')));
  passed(pre(w, messageCall('agent-r2', '다시.\n\n## worker 걱정\n- 메인 세션이 옮긴 걱정')));
  passed(pre(w, messageCall('agent-r2', '다시 봐 주세요.'), SUB));
  passed(pre(w, reviewerCall(`${reviewerBrief(w, 2)}\n\n## worker 걱정\n- 메인 세션이 옮긴 걱정`)));
  passed(pre(w, reviewerCall(`run-dir: ${w.run}\n작업을 검토해 줘.`)));
  assert.equal(errorLines(w).length, 2, '위 호출들은 기록을 읽지 않았다');
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
