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
import { LOGGED_AGENTS, readRecords, latestSpecCheckerReply, latestWorkerReply, latestVerifierFingerprint } from '../scripts/run-log.mjs';
import { grantApproval, specText, typed, writeTranscript, SESSION } from './approval-world.mjs';

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
  assert.match(reason, /spec\.mjs approve <명세> "<사용자 말>"/);
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
  const w = approvalWorld();
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
  assert.match(denied(pre(w, fileCall('Write', path.join(w.run, 'verification.json')), VERIFIER_CALLER)), /검수 기록\(verification\.json\)은 verification\.mjs snapshot만 쓴다.*snapshot을 다시 실행한다/);
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
  assert.match(log, /log\/ 밑의 기록\(log\/subagents\.jsonl\)은 훅이.*훅과 pact 스크립트만 쓴다.*hook-error\.log를 보고 사용자에게 알린다/);
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
