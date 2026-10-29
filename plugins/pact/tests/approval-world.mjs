// 승인·위임 시험이 같이 쓰는 놀이터. 테스트 파일이 아니다(이름이 *.test.mjs가 아니라 node --test가 돌리지 않는다).
// 진짜 ~/.claude 밑에는 아무것도 쓰지 않는다: 가짜 HOME에 손으로 만든 대화 기록(JSONL)을 두고,
// 스크립트는 자식 프로세스로 돌리며 HOME과 CLAUDE_CODE_SESSION_ID만 가짜로 준다(덮어쓰는 옵션은 스크립트에 없다).
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendRecord } from '../scripts/run-log.mjs';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SPEC_CLI = path.join(ROOT, 'scripts', 'spec.mjs');
export const SESSION = '0f6c1c1e-6a3d-4a53-9a8f-111111111111';
export const ID = '2026-10-29-출결-관리';

const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

export const tmp = (prefix = 'pact-approval-') => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

// 2026-10-29 01:<분>:00Z. 분이 클수록 나중이다.
export const T = (minute, second = 0) => new Date(Date.UTC(2026, 9, 29, 1, minute, second)).toISOString();

// 기본 명세: 위험 표시가 없고, [사용자] 줄은 F1 하나(케이스 하나), [AI 가정] 줄은 R1 하나다. features·rules·confirm으로 줄을 더한다.
export const specText = ({ pact = 2, status = 'draft', features = '', rules = '', confirm = '', log = '' } = {}) => `---
pact: ${pact}
topic: 출결
status: ${status}
created: 2026-10-29
---
# 출결
## 목적
교수자가 출석을 빨리 확인한다.
## 범위
웹 화면 하나.
## 하지 않는 것
출석 처리 자체.
## 기능
- F1 오늘 수업 출석 현황 보기 [사용자]
  - 케이스: 수업 0건 → 빈 상태 문구
${features}## 공통 규칙
- R1 출석 기록은 학기 동안 보관한다 [AI 가정]
${rules}## 구조 판정
## 확인 필요
${confirm}## 결정 기록
${log}`;

// 판 하나: 프로젝트(명세와 실행 폴더), 가짜 HOME, 대화 기록 자리
export function makeWorld({ pact = 2, status = 'draft', features, rules, confirm, log, id = ID, sessionId = SESSION, specBody } = {}) {
  const root = tmp();
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  mkdirSync(path.join(project, 'docs', 'pact'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const spec = path.join(project, 'docs', 'pact', `${id}.md`);
  writeFileSync(spec, specBody ?? specText({ pact, status, features, rules, confirm, log }));
  return {
    root, project, home, spec, id, sessionId,
    run: path.join(project, '.pact', id),
    transcriptDir: path.join(home, '.claude', 'projects', '-fake-project'),
    transcript: path.join(home, '.claude', 'projects', '-fake-project', `${sessionId}.jsonl`),
  };
}

// ---------- 대화 기록 줄 만들기 ----------
const base = (time) => ({ uuid: randomUUID(), timestamp: time, sessionId: SESSION, isSidechain: false });

// 사람이 친 말(진짜 기록에서 본 모양)
export const typed = (text, time, extra = {}) => ({
  type: 'user', ...base(time), message: { role: 'user', content: text }, origin: { kind: 'human' }, promptSource: 'typed', ...extra,
});
// origin 칸이 없는 옛 기록과 claude -p(sdk)의 말
export const legacyUser = (text, time, extra = {}) => ({ type: 'user', ...base(time), message: { role: 'user', content: text }, ...extra });
// 그림이 붙은 사람 말: 글과 그림 블록의 배열
export const typedWithImage = (text, time) => ({
  type: 'user', ...base(time), message: { role: 'user', content: [{ type: 'text', text }, { type: 'image', source: { type: 'base64' } }] },
  origin: { kind: 'human' }, promptSource: 'typed',
});
// AskUserQuestion의 답: 줄의 toolUseResult.answers(질문 → 답)
export const answers = (map, time) => ({
  type: 'user', ...base(time),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: `Your questions have been answered: ${JSON.stringify(map)}` }] },
  toolUseResult: { questions: Object.keys(map).map((question) => ({ question, options: [] })), answers: map, annotations: {} },
});
// 에이전트가 일하는 도중에 사용자가 친 말: user 줄이 아니라 attachment 줄로만 남는다(이 컴퓨터의 진짜 기록에서 본 모양)
export const queuedCommand = (prompt, time, extra = {}) => ({
  type: 'attachment', ...base(time),
  attachment: {
    type: 'queued_command', prompt, source_uuid: randomUUID(), delivery_id: randomUUID(), commandMode: 'prompt',
    origin: { kind: 'human' }, timestamp: time, humanTurn: true, ...extra,
  },
});
// 같은 꼴이지만 하위 에이전트·작업이 보낸 알림(commandMode와 origin이 task-notification)
export const queuedNotification = (text, time) => queuedCommand(`<task-notification>\n<summary>${text}</summary>\n</task-notification>`, time, {
  commandMode: 'task-notification', origin: { kind: 'task-notification', producer: 'session-task' },
});
// 다른 세션이 보낸 말(origin이 peer)
export const queuedPeer = (text, time, tag = 'agent-message') => queuedCommand(`<${tag} from="uds:/tmp/cc-socks/1.sock">${text}</${tag}>`, time, { origin: { kind: 'peer' } });
export const hookAttachment = (time) => ({ type: 'attachment', ...base(time), attachment: { type: 'hook_success', hookName: 'SessionStart', content: '승인' } });
export const assistant = (text, time) => ({ type: 'assistant', ...base(time), message: { role: 'assistant', content: [{ type: 'text', text }] } });
export const toolResult = (text, time) => ({
  type: 'user', ...base(time), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: text }] },
  toolUseResult: { stdout: text, stderr: '', interrupted: false },
});
export const taskNotification = (text, time) => ({
  type: 'user', ...base(time), message: { role: 'user', content: `<task-notification>\n<summary>${text}</summary>\n</task-notification>` },
  origin: { kind: 'task-notification' }, promptSource: 'system',
});
export const compactSummary = (text, time) => ({
  type: 'user', ...base(time), message: { role: 'user', content: `This session is being continued from a previous conversation.\n사용자가 "${text}"라고 했다.` },
  isCompactSummary: true, isVisibleInTranscriptOnly: true,
});
export const commandMessage = (text, time) => ({
  type: 'user', ...base(time), message: { role: 'user', content: `<command-message>${text}</command-message>\n<command-name>/x</command-name>` },
  origin: { kind: 'human' },
});
// 사람이 친 슬래시 명령의 줄(진짜 기록에서 본 모양): 글은 <command-message>와 <command-name>, 인자가 있으면 끝에 <command-args>이고 origin은 human이다.
// args를 안 주면 <command-args> 줄이 없다(인자 없이 부른 명령).
export const commandLine = (name, args, time, extra = {}) => ({
  type: 'user', ...base(time),
  message: { role: 'user', content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>${args === undefined ? '' : `\n<command-args>${args}</command-args>`}` },
  origin: { kind: 'human' }, ...extra,
});
// origin 칸이 없는 내장 명령(/effort, /mcp …)의 줄: 태그 순서가 다르고 들여쓰기가 있고 <command-args>가 비었거나 글이 있다
export const builtinCommand = (name, args, time) => ({
  type: 'user', ...base(time),
  message: { role: 'user', content: `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>` },
});
// 모델이 Skill 도구로 스킬을 부른 줄: assistant의 tool_use로만 남고 뒤에 <command-name>이 든 user 줄이 없다
export const skillToolUse = (skill, args, time) => ({
  type: 'assistant', ...base(time),
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_skill', name: 'Skill', input: { skill, args } }] },
});
// 부른 스킬의 본문을 펼쳐 넣은 줄: isMeta이고 인자가 `ARGUMENTS:` 뒤에 다시 든다
export const skillBody = (args, time) => ({
  type: 'user', ...base(time),
  message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: /x/pact\n\nARGUMENTS: ${args}` }] },
  isMeta: true,
});
export const systemReminder = (text, time) => ({
  type: 'user', ...base(time), message: { role: 'user', content: `<system-reminder>\n${text}\n</system-reminder>` }, isMeta: true,
});
export const peerMessage = (text, time) => ({
  type: 'user', ...base(time), message: { role: 'user', content: `Another Claude session sent a message:\n${text}` },
  origin: { kind: 'peer' }, promptSource: 'system', isMeta: true,
});

export function writeTranscript(world, records, file = world.transcript) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`);
  return file;
}

// spec-checker가 돌려주는 답(agents/spec-checker.md의 형식). questions가 비면 '사용자만 답할 수 있음'은 "없음"이다.
// 있으면 검수 1, 검수 2 … 번호가 붙어 온다.
export const checkerReply = (questions = []) => [
  '## 이미 답이 있음', '- 없음', '',
  '## 사소함 — AI가 정함', '- 없음', '',
  '## 사용자만 답할 수 있음',
  ...(questions.length ? questions.map((question, i) => `검수 ${i + 1}. ${question} (기본안: 지금 그대로) — 답에 따라 화면이 달라진다`) : ['없음']),
  '', '질문 라운드는 이것 한 번뿐입니다.',
].join('\n');

// spec-checker가 끝났다는 기록(훅이 남기는 log/subagents.jsonl 한 줄). message를 안 주면 사용자만 답할 수 있는 항목이 없다는 답이다.
export function addCheckerRecord(world, time, { message = checkerReply() } = {}) {
  appendRecord(world.run, { time, agent_type: 'pact:spec-checker', agent_id: 'agent-c', task: null, message });
}

// ---------- 스크립트 돌리기 ----------
export function cliEnv(world, extra = {}) {
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR; // 시험을 돌리는 사람의 진짜 설정 폴더가 끼어들면 안 된다
  Object.assign(env, { HOME: world.home, CLAUDE_CODE_SESSION_ID: world.sessionId }, extra);
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}

export function runCli(script, world, args, { env, cwd, input } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: cliEnv(world, env), cwd: cwd ?? world.root, ...(input === undefined ? {} : { input }) });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
export const runSpec = (world, args, options) => runCli(SPEC_CLI, world, args, options);

export const specStatus = (world) => /^status:\s*(\S+)/m.exec(readFileSync(world.spec, 'utf8'))?.[1];
export function approvalEntries(world) {
  const file = path.join(world.run, 'approvals.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

// 한 줄(까닭과 대신 할 일)로 거절했는지: 종료 코드 1, stderr 한 줄
export function assertRefused(r, pattern, label = '') {
  assert.equal(r.status, 1, `${label} 종료 코드 1이어야 한다: ${r.stdout}${r.stderr}`);
  const lines = r.stderr.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `${label} 까닭은 한 줄이어야 한다: ${r.stderr}`);
  if (pattern) assert.match(lines[0], pattern, label);
  return lines[0];
}

// 승인(또는 위임)을 스크립트로 받아 놓는다: 대화 기록에 그 말을 두고, spec-checker 기록을 남기고, 명령을 돌린다.
// 훅 시험처럼 "승인 기록이 있는 판"이 필요할 때 쓴다. 이미 있는 대화 기록 줄은 지우지 않고 더한다.
// 위임은 spec-checker 기록이 없어도 되지만(approval.test), 완료 검사까지 가는 시험은 있어야 하니 checker: true로 남긴다.
// 다시 기록할 때(F3)는 checker: false와 더 늦은 time으로 부른다: 앞 기록의 메시지보다 새 말이어야 한다.
export function grantApproval(world, {
  kind = 'approve', text = kind === 'approve' ? '승인' : '끝까지 알아서 해', extra = [], checker = kind === 'approve',
  time = kind === 'approve' ? T(10) : T(1), checkerMessage,
} = {}) {
  if (checker) addCheckerRecord(world, T(5), checkerMessage === undefined ? {} : { message: checkerMessage });
  const prior = existsSync(world.transcript) ? readFileSync(world.transcript, 'utf8').split('\n').filter(Boolean) : [];
  writeTranscript(world, [...prior, ...extra, typed(text, time)]);
  const r = runSpec(world, [kind, world.spec, text]);
  assert.equal(r.status, 0, `${kind} 성공해야 한다: ${r.stdout}${r.stderr}`);
  return approvalEntries(world);
}
