import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TranscriptIndex, answerOf, promptKind } from '../plugin/lib/transcript.mjs';
import { user, toolResult, say, tool, done, title, queued, jsonl } from './fixtures/transcript.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-transcript-'));
let k = 0;
function indexOf(entries) {
  const file = path.join(dir, `t${++k}.jsonl`);
  fs.writeFileSync(file, jsonl(entries));
  const ix = new TranscriptIndex(file);
  ix.update();
  return { ix, file };
}

test('질문과 답 한 턴', () => {
  const { ix } = indexOf([title('설정 이전'), user('설정 파일 옮겨 줘'), say('옮겼습니다.'), done()]);
  const [p] = ix.pages();
  assert.equal(ix.title, '설정 이전');
  assert.equal(p.prompt, '설정 파일 옮겨 줘');
  assert.equal(p.answer, '옮겼습니다.');
  assert.equal(p.status, 'done');
  assert.equal(p.durationMs, 4200);
});

test('도구 호출 사이 중간 글은 빼고 마지막 글을 답으로 본다', () => {
  const { ix } = indexOf([user('로그 봐 줘'), say('확인해 보겠습니다.', 'tool_use'), tool(), toolResult(), say('오류는 없습니다.'), done()]);
  const [p] = ix.pages();
  assert.equal(p.answer, '오류는 없습니다.');
  assert.equal(p.tools, 1);
});

test('긴 답 뒤에 도구를 부르고 짧게 끝나면 긴 답도 보인다', () => {
  const long = '분석 결과입니다. '.repeat(80);
  const { ix } = indexOf([user('분석해 줘'), say(long, 'tool_use'), tool('Write'), toolResult(), say('메모에도 적어 두었습니다.'), done()]);
  const [p] = ix.pages();
  assert.ok(p.answer.startsWith('분석 결과입니다.'));
  assert.ok(p.answer.endsWith('메모에도 적어 두었습니다.'));
  assert.equal(answerOf(['', '짧은 글']), '짧은 글');
  assert.equal(answerOf(['']), '');
});

test('Esc 중단, 오류, 이미지 질문', () => {
  const { ix } = indexOf([
    user('빌드 돌려 줘'), tool(), toolResult(), user('[Request interrupted by user for tool use]'),
    user([{ type: 'text', text: '이 화면 봐 줘' }, { type: 'image', source: {} }]), say('API Error: 529 overloaded', 'end_turn', { isApiErrorMessage: true }),
  ]);
  const [a, b] = ix.pages();
  assert.equal(a.status, 'interrupted');
  assert.equal(b.prompt, '이 화면 봐 줘\n[이미지 1개]');
  assert.equal(b.status, 'error');
});

test('로컬 명령·메타 줄·요약·곁가지는 턴이 아니다. 답이 있는 명령과 작업 알림은 턴이다', () => {
  const { ix } = indexOf([
    user('<local-command-caveat>Caveat: ...</local-command-caveat>', { isMeta: true }),
    user('<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args></command-args>'),
    user('<local-command-stdout>Set effort level to max</local-command-stdout>'),
    user('이전 대화 요약입니다', { isCompactSummary: true }),
    user('곁가지 질문', { isSidechain: true }),
    user('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>src</command-args>'),
    say('리뷰 결과 문제 없음.'), done(),
    user('<task-notification>\n<task-id>x1</task-id>\n<summary>빌드 작업 끝남</summary>\n</task-notification>'),
    say('백그라운드 빌드가 끝났습니다.'), done(),
  ]);
  const pages = ix.pages();
  assert.deepEqual(pages.map((p) => [p.kind, p.prompt]), [['command', '/review src'], ['notification', '빌드 작업 끝남']]);
});

test('작업 중에 친 말은 그 턴에 붙는다', () => {
  const { ix } = indexOf([user('테스트 고쳐 줘'), tool(), queued('아 그리고 린트도'), queued('<task-notification>...', 'task-notification'), toolResult(), say('둘 다 고쳤습니다.'), done()]);
  const [p] = ix.pages();
  assert.deepEqual(p.extra, ['아 그리고 린트도']);
});

test('작업 중인 턴과 끝난 턴', () => {
  const { ix, file } = indexOf([user('첫 질문'), say('첫 답'), done(), user('둘째 질문'), say('보는 중입니다.', 'tool_use'), tool()]);
  let pages = ix.pages();
  assert.equal(pages[1].status, 'running');
  fs.appendFileSync(file, jsonl([toolResult(), say('둘째 답'), done()]));
  assert.equal(ix.update(), true);
  pages = ix.pages();
  assert.equal(pages[1].status, 'done');
  assert.equal(pages[1].answer, '둘째 답');
});

test('끝 표시가 없어도 end_turn이면 끝난 턴이다', () => {
  const { ix } = indexOf([user('질문'), say('답')]);
  assert.equal(ix.pages()[0].status, 'done');
});

test('줄 중간까지만 쓰인 기록은 다음 읽기 때 잇는다(한글이 바이트 중간에서 잘려도)', () => {
  const file = path.join(dir, 'partial.jsonl');
  const line = JSON.stringify(user('한글 질문입니다'));
  const bytes = Buffer.from(`${line}\n${JSON.stringify(say('한글 답입니다'))}\n`);
  const cut = Buffer.from(line).length + 12; // 둘째 줄 중간(한글 바이트 안쪽일 수 있다)
  fs.writeFileSync(file, bytes.subarray(0, cut));
  const ix = new TranscriptIndex(file);
  ix.update();
  assert.equal(ix.pages()[0].answer, '');
  fs.appendFileSync(file, bytes.subarray(cut));
  assert.equal(ix.update(), true);
  assert.equal(ix.pages()[0].answer, '한글 답입니다');
});

test('파일이 바뀌면(새 inode) 처음부터 다시 읽는다', () => {
  const { ix, file } = indexOf([user('옛 질문'), say('옛 답')]);
  fs.rmSync(file);
  fs.writeFileSync(file, jsonl([user('새 질문'), say('새 답')]));
  ix.update();
  assert.deepEqual(ix.pages().map((p) => p.prompt), ['새 질문']);
});

test('도구 결과 안의 글자는 턴을 만들지 않는다', () => {
  assert.equal(promptKind('[Request interrupted by user]'), 'interrupt');
  assert.equal(promptKind('<system-reminder>x</system-reminder>'), null);
  const { ix } = indexOf([user('질문'), tool(), toolResult(), say('답')]);
  assert.equal(ix.pages().length, 1);
});
