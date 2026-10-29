import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AGENT, LOGGED_AGENTS, logFile, appendRecord, readRecords, latestRecord, latestSpecCheckerReply, latestWorkerReply,
  latestVerifierFingerprint, resultsSha256, firstUserPrompt, recordStop, findAgentRecord,
} from '../scripts/run-log.mjs';
import { withConcerns } from '../scripts/concerns.mjs';

const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pact-runlog-'));
  made.push(dir);
  return dir;
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rec = (agent_type, extra = {}) => ({ time: '2026-10-29T00:00:00.000Z', agent_type, agent_id: 'a', task: null, message: '', ...extra });

test('the four pact agents are logged, with the pact: prefix', () => {
  assert.deepEqual(LOGGED_AGENTS, ['pact:spec-checker', 'pact:reviewer', 'pact:worker', 'pact:verifier']);
  assert.equal(AGENT.worker, 'pact:worker');
});

test('appendRecord creates log/ and appends one line per stop without overwriting', () => {
  const run = tmp();
  assert.equal(logFile(run), path.join(run, 'log', 'subagents.jsonl'));
  assert.deepEqual(readRecords(run), [], '기록이 없으면 빈 배열');
  appendRecord(run, rec(AGENT.worker, { task: 1, message: '첫째\n줄바꿈 있음' }));
  appendRecord(run, rec(AGENT.worker, { task: 1, message: '둘째' }));
  const lines = readFileSync(logFile(run), 'utf8').split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '');
  assert.equal(JSON.parse(lines[0]).message, '첫째\n줄바꿈 있음', '한 줄에 한 기록: 줄바꿈은 이스케이프된다');
  assert.deepEqual(readRecords(run).map((r) => r.message), ['첫째\n줄바꿈 있음', '둘째']);
});

test('readRecords skips broken lines, so a line cut short does not hide the earlier records', () => {
  const run = tmp();
  appendRecord(run, rec(AGENT.specChecker, { message: '앞' }));
  appendFileSync(logFile(run), '{"time":"2026-10-29T00:00:01.000Z","agent_type":"pact:wor\n');
  appendFileSync(logFile(run), '\n\n[1,2]\n"문자열"\n');
  appendRecord(run, rec(AGENT.specChecker, { message: '뒤' }));
  assert.deepEqual(readRecords(run).map((r) => r.message), ['앞', '뒤']);
});

test('the readers return the latest spec-checker reply, the latest reply of worker task n, and the latest verifier fingerprint', () => {
  const run = tmp();
  appendRecord(run, rec(AGENT.specChecker, { time: '2026-10-29T01:00:00.000Z', message: '검수 1' }));
  appendRecord(run, rec(AGENT.worker, { task: 1, message: '작업 1 첫 답' }));
  appendRecord(run, rec(AGENT.worker, { task: 2, message: '작업 2 답' }));
  appendRecord(run, rec(AGENT.reviewer, { task: 1, message: '검토' }));
  appendRecord(run, rec(AGENT.worker, { task: 1, message: '작업 1 고친 답' }));
  appendRecord(run, rec(AGENT.specChecker, { time: '2026-10-29T02:00:00.000Z', message: '검수 2' }));
  appendRecord(run, rec(AGENT.verifier, { message: '검수', results_sha256: 'a'.repeat(64) }));
  appendRecord(run, rec(AGENT.verifier, { time: '2026-10-29T03:00:00.000Z', message: '다시 검수', results_sha256: 'b'.repeat(64) }));

  const checker = latestSpecCheckerReply(run);
  assert.equal(checker.message, '검수 2');
  assert.equal(checker.time, '2026-10-29T02:00:00.000Z');
  assert.equal(latestWorkerReply(run, 1).message, '작업 1 고친 답');
  assert.equal(latestWorkerReply(run, '2').message, '작업 2 답', '문자열 번호도 받는다');
  assert.equal(latestWorkerReply(run, 3), null);
  assert.equal(latestRecord(run, AGENT.reviewer).message, '검토');
  const fingerprint = latestVerifierFingerprint(run);
  assert.equal(fingerprint.results_sha256, 'b'.repeat(64));
  assert.equal(fingerprint.time, '2026-10-29T03:00:00.000Z');

  const empty = tmp();
  assert.equal(latestSpecCheckerReply(empty), null);
  assert.equal(latestWorkerReply(empty, 1), null);
  assert.equal(latestVerifierFingerprint(empty), null);
});

test('findAgentRecord finds the latest record of an agent id of one type across the runs of a project, and the run it is in', () => {
  const project = tmp();
  const runA = path.join(project, '.pact', '2026-10-28-가');
  const runB = path.join(project, '.pact', '2026-10-29-나');
  appendRecord(runA, rec(AGENT.reviewer, { agent_id: 'r-old', task: 1, message: '가 판의 검토' }));
  appendRecord(runB, rec(AGENT.worker, { agent_id: 'w-1', task: 2, message: '작업 2' }));
  appendRecord(runB, rec(AGENT.reviewer, { agent_id: 'r-1', task: 2, message: '첫 검토' }));
  appendRecord(runB, rec(AGENT.reviewer, { agent_id: 'r-other', task: 3, message: '다른 검토' }));
  appendRecord(runB, rec(AGENT.reviewer, { agent_id: 'r-1', task: 2, message: '두 번째 검토' })); // SendMessage로 돌아온 같은 reviewer
  const hit = findAgentRecord(project, 'r-1', AGENT.reviewer);
  assert.equal(hit.runDir, runB);
  assert.equal(hit.record.message, '두 번째 검토', '가장 최근 기록이다');
  assert.equal(hit.record.task, 2);
  assert.equal(findAgentRecord(project, 'r-old', AGENT.reviewer).runDir, runA, '다른 판의 것도 찾는다');
  assert.equal(findAgentRecord(project, 'w-1', AGENT.worker).record.message, '작업 2');
  assert.equal(findAgentRecord(project, 'w-1', AGENT.reviewer), null, '종류가 다르면 그 id가 있어도 없다');
  assert.equal(findAgentRecord(project, 'r-', AGENT.reviewer), null, 'id는 통째로 같아야 한다');
  assert.equal(findAgentRecord(project, 'r-1 ', AGENT.reviewer), null);
  assert.equal(findAgentRecord(project, 'unknown', AGENT.reviewer), null);
});

test('findAgentRecord has nothing to find without a .pact folder, a log, an id or a project, skips folders and files that are not runs, and reads past broken lines', () => {
  const project = tmp();
  assert.equal(findAgentRecord(project, 'r-1', AGENT.reviewer), null, '.pact가 없다');
  const run = path.join(project, '.pact', '2026-10-29-가');
  mkdirSync(run, { recursive: true });
  assert.equal(findAgentRecord(project, 'r-1', AGENT.reviewer), null, 'log/가 없다');
  writeFileSync(path.join(project, '.pact', '.gitignore'), '*\n');
  writeFileSync(path.join(project, '.pact', 'notes.md'), '실행 폴더가 아닌 파일');
  mkdirSync(path.join(project, '.pact', '.hidden', 'log'), { recursive: true });
  writeFileSync(path.join(project, '.pact', '.hidden', 'log', 'subagents.jsonl'), `${JSON.stringify(rec(AGENT.reviewer, { agent_id: 'r-1', task: 1 }))}\n`);
  assert.equal(findAgentRecord(project, 'r-1', AGENT.reviewer), null, '점으로 시작하는 폴더는 판이 아니다');
  appendRecord(run, rec(AGENT.reviewer, { agent_id: 'r-1', task: 1 }));
  appendFileSync(logFile(run), '{"agent_id":"r-1","agent_type":"pact:rev\n[1,2]\n"r-1"\n'); // 깨진 줄과 객체가 아닌 줄
  assert.equal(findAgentRecord(project, 'r-1', AGENT.reviewer).runDir, run);
  for (const [dir, id, type] of [[undefined, 'r-1', AGENT.reviewer], [null, 'r-1', AGENT.reviewer], ['', 'r-1', AGENT.reviewer], [project, '', AGENT.reviewer], [project, undefined, AGENT.reviewer], [project, 42, AGENT.reviewer], [project, 'r-1', undefined]]) {
    assert.equal(findAgentRecord(dir, id, type), null, JSON.stringify([dir, id, type]));
  }
  assert.equal(findAgentRecord(path.join(project, 'nope'), 'r-1', AGENT.reviewer), null, '없는 프로젝트');
});

test('findAgentRecord throws when a log it must read cannot be read, as readRecords does, instead of reporting "not found"', () => {
  const project = tmp();
  mkdirSync(path.join(project, '.pact', '2026-10-29-가', 'log', 'subagents.jsonl'), { recursive: true }); // 파일 자리에 폴더
  assert.throws(() => findAgentRecord(project, 'r-1', AGENT.reviewer), /EISDIR/);
});

test('a later verifier stop with no results.json is the latest fingerprint: it must not fall back to an older one', () => {
  const run = tmp();
  appendRecord(run, rec(AGENT.verifier, { results_sha256: 'a'.repeat(64) }));
  appendRecord(run, rec(AGENT.verifier, { results_sha256: null }));
  const fingerprint = latestVerifierFingerprint(run);
  assert.notEqual(fingerprint, null);
  assert.equal(fingerprint.results_sha256, null);
});

test('resultsSha256 hashes the bytes of results.json, is null when missing, and throws when it cannot be read', () => {
  const run = tmp();
  assert.equal(resultsSha256(run), null);
  const bytes = Buffer.from('{"scenarios":[]}\n한글');
  writeFileSync(path.join(run, 'results.json'), bytes);
  assert.equal(resultsSha256(run), sha(bytes));
  writeFileSync(path.join(run, 'results.json'), '{"scenarios":[1]}\n');
  assert.notEqual(resultsSha256(run), sha(bytes), '파일이 바뀌면 지문도 바뀐다');
  const broken = tmp();
  mkdirSync(path.join(broken, 'results.json'));
  assert.throws(() => resultsSha256(broken), /EISDIR/);
});

const transcript = (dir, lines) => {
  const file = path.join(dir, `agent-${Math.random().toString(16).slice(2)}.jsonl`);
  writeFileSync(file, `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);
  return file;
};
const user = (content) => ({ type: 'user', message: { role: 'user', content } });

test('firstUserPrompt reads the first human message: a string, or the text blocks of an array', () => {
  const dir = tmp();
  assert.deepEqual(firstUserPrompt(transcript(dir, [user('첫 지시'), user('두 번째')])), { text: '첫 지시' });
  assert.deepEqual(
    firstUserPrompt(transcript(dir, [user([{ type: 'tool_result', content: 'x' }, { type: 'text', text: '앞' }, { type: 'text', text: '뒤' }])])),
    { text: '앞\n뒤' },
  );
  // 앞에 사람 메시지가 아닌 기록(fork 참조, 첨부, 깨진 줄)이 있어도 건너뛴다
  const mixed = transcript(dir, [{ type: 'fork-context-ref', id: 'x' }, 'not json', '', { type: 'attachment', attachment: {} }, { type: 'assistant', message: { content: 'x' } }, user('진짜 첫 지시')]);
  assert.deepEqual(firstUserPrompt(mixed), { text: '진짜 첫 지시' });
});

test('firstUserPrompt reads a very long first line across read chunks and keeps multi-byte characters whole', () => {
  const dir = tmp();
  const long = '가나다라마바사'.repeat(30000); // 약 630KB: 64KB 단위 읽기를 여러 번 넘고, 글자가 단위 경계에 걸린다
  assert.equal(firstUserPrompt(transcript(dir, [user(long), user('둘째')])).text, long);
});

test('firstUserPrompt gives a reason instead of throwing when there is nothing to read', () => {
  const dir = tmp();
  assert.match(firstUserPrompt(undefined).error, /agent_transcript_path/);
  assert.match(firstUserPrompt('').error, /agent_transcript_path/);
  assert.match(firstUserPrompt(path.join(dir, 'missing.jsonl')).error, /ENOENT/);
  assert.match(firstUserPrompt(dir).error, /EISDIR/);
  assert.match(firstUserPrompt(transcript(dir, [{ type: 'assistant', message: { content: 'x' } }])).error, /첫 지시를 찾지 못/);
  assert.equal(firstUserPrompt(transcript(dir, [])).text, null);
  // 앞 50줄 안에 사람 메시지가 없으면 더 찾지 않는다
  const late = transcript(dir, [...Array.from({ length: 5 }, () => ({ type: 'attachment' })), user('늦은 지시')]);
  assert.equal(firstUserPrompt(late, { maxLines: 3 }).text, null);
  assert.equal(firstUserPrompt(late, { maxLines: 6 }).text, '늦은 지시');
});

test('recordStop ignores agents that are not pact agents without reading anything', () => {
  const dir = tmp();
  for (const agent_type of ['tiers:worker', 'Explore', 'worker', 'pact:workers', 'notpact:worker', 'pact', '', undefined]) {
    assert.equal(recordStop({ agent_type, agent_transcript_path: path.join(dir, 'nope.jsonl'), cwd: dir, last_assistant_message: 'x' }), null);
  }
  assert.equal(recordStop(undefined), null);
});

test('recordStop writes under the run-dir named in the first instruction and reports problems as data', () => {
  const project = tmp();
  const id = '2026-10-29-출결-관리';
  const run = path.join(project, '.pact', id);
  mkdirSync(run, { recursive: true });
  const file = transcript(tmp(), [user(`run-dir: ${run} , 작업 번호 3`)]);
  const now = new Date('2026-10-29T12:34:56.789Z');
  const out = recordStop({ agent_type: AGENT.worker, agent_id: 'abc', agent_transcript_path: file, cwd: tmp(), last_assistant_message: `끝\n보고서: ${run}/tasks/3-report.md` }, { now });
  assert.equal(out.runDir, run);
  assert.deepEqual(out.problems, []);
  assert.deepEqual(readRecords(run), [{ time: '2026-10-29T12:34:56.789Z', agent_type: 'pact:worker', agent_id: 'abc', task: 3, message: `끝\n보고서: ${run}/tasks/3-report.md` }]);

  // 못 찾으면 쓰지 않고 까닭을 한 줄로 돌려준다
  const lost = recordStop({ agent_type: AGENT.reviewer, agent_transcript_path: path.join(project, 'missing.jsonl'), cwd: tmp(), last_assistant_message: '판정' });
  assert.equal(lost.runDir, null);
  assert.equal(lost.problems.length, 1);
  assert.match(lost.problems[0], /실행 폴더를 찾지 못/);
  assert.match(lost.problems[0], /pact:reviewer/);
  assert.match(lost.problems[0], /ENOENT/);
  assert.doesNotMatch(lost.problems[0], /\n/);
});

test('recordStop reads a reviewer\'s run and task from the brief before the worry section the hook appended, so words in the worries change neither', () => {
  const project = tmp();
  const run = path.join(project, '.pact', '2026-10-29-출결-관리');
  const other = path.join(project, '.pact', '2026-10-30-다른-판');
  mkdirSync(run, { recursive: true });
  mkdirSync(other, { recursive: true });
  const brief = `worker 보고서: ${run}/tasks/5-report.md\nbase abc123 head def456`;
  // 걱정 글이 다른 작업 번호와 보고서 경로를 말하고, 다른 판의 경로를 더 많이 말한다
  const worries = `- 작업 번호 3의 보고서 ${run}/tasks/3-report.md는 안 고쳤다\n- ${other}/tasks/1-report.md와 ${other}/tasks/2-report.md, ${other}/tasks/9-report.md도 봤다`;
  const stopWith = (agent_type, prompt, message) => recordStop({ agent_type, agent_id: 'x-1', agent_transcript_path: transcript(tmp(), [user(prompt)]), cwd: tmp(), last_assistant_message: message });

  const out = stopWith(AGENT.reviewer, withConcerns(brief, worries), '## 판정: 고칠 것 있음');
  assert.equal(out.runDir, run, '걱정 글 속 다른 판의 경로가 판을 바꾸지 않는다');
  assert.equal(out.record.task, 5, '걱정 글 속 작업 번호와 보고서 경로가 작업 번호를 바꾸지 않는다');
  assert.deepEqual(readRecords(run).map((r) => r.task), [5]);
  assert.equal(readRecords(other).length, 0);

  // 붙은 칸이 없는 지시는 전과 같다
  assert.equal(stopWith(AGENT.reviewer, brief, '## 판정: 통과').record.task, 5);
  // 메인 세션이 손으로 쓴 칸이라 뒤에 다른 제목이 이어지면 그 글도 읽는다
  const byHand = `run-dir: ${run}\n\n## worker 걱정\n- 손으로 쓴 걱정\n\n## 작업\n작업 번호 6`;
  assert.equal(stopWith(AGENT.reviewer, byHand, '## 판정: 통과').record.task, 6);
  // worker의 첫 지시는 훅이 건드리지 않는다: 같은 모양의 글을 자르지 않고 읽는다
  const workerBrief = `run-dir: ${run}\n\n## worker 걱정\n작업 번호 4`;
  assert.equal(stopWith(AGENT.worker, workerBrief, '끝').record.task, 4);
});

test('the line for a run that could not be found also names the agent and its transcript, so the stop can be traced', () => {
  const missing = path.join(tmp(), 'missing.jsonl');
  const lost = recordStop({ agent_type: AGENT.worker, agent_id: 'agent-7', agent_transcript_path: missing, cwd: tmp(), last_assistant_message: '끝' });
  assert.equal(lost.runDir, null);
  assert.equal(lost.problems.length, 1);
  assert.match(lost.problems[0], /agent_id: agent-7/);
  assert.ok(lost.problems[0].includes(`agent_transcript_path: ${missing}`), lost.problems[0]);
  assert.doesNotMatch(lost.problems[0], /\n/);
  // 두 값이 입력에 없어도 줄은 같은 모양이다
  const bare = recordStop({ agent_type: AGENT.verifier, cwd: tmp(), last_assistant_message: '통과' });
  assert.match(bare.problems[0], /agent_id: 없음/);
  assert.match(bare.problems[0], /agent_transcript_path: 없음/);
});
