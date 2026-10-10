import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { judge, replyOf, countQuestions, hitLimit, wrappedUp } from './behavior/judge.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'pact-judge-'));
const say = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const skill = (name) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: name } }] } });
const done = (text) => ({ type: 'result', result: text });
// transcript = 턴 배열, 턴 = stream-json 이벤트 배열
const T = (...turns) => turns;

test('replyOf joins every assistant text of a turn', () => {
  const t = T([say('pact · probe'), skill('pact:pact'), say('언제 쓰세요?'), done('언제 쓰세요?')]);
  assert.equal(replyOf(t, 0), 'pact · probe\n언제 쓰세요?');
  assert.equal(replyOf(t, -1), 'pact · probe\n언제 쓰세요?');
});

test('countQuestions counts ? and ？ outside code', () => {
  assert.equal(countQuestions('뭐예요? 언제요？ `a?b`\n```\nx?\n```'), 2);
  assert.equal(countQuestions('바꿨어요.'), 0);
});

test('a ? inside a quoted example is not a question to the user', () => {
  assert.equal(countQuestions('언제였어요? (예: 메신저로 "다들 언제 돼요?" 돌리기)'), 1);
  assert.equal(countQuestions('“이런 앱 있었으면?” 하고 느낀 순간이 있었나요?'), 1);
});

test('hitLimit spots a usage-limit reply so the run is not counted as a failure', () => {
  const limited = [[{ type: 'result', result: "You've hit your session limit · resets 4pm (Asia/Seoul)" }]];
  assert.equal(hitLimit(limited), true);
  assert.equal(hitLimit([[say('질문?'), done('질문?')]]), false);
});

test('firstReplyQuestionCount looks at the first turn only', () => {
  const t = T([say('누가 써요?')], [say('언제? 어디서?')]);
  assert.equal(judge({ kind: 'firstReplyQuestionCount', max: 1 }, t, tmp(), tmp()), true);
  assert.equal(judge({ kind: 'firstReplyQuestionCount', max: 0 }, t, tmp(), tmp()), false);
});

test('replyNotMatch and replyMatch check the last turn by default, or a given turn', () => {
  const t = T([say('React로 할까요?')], [say('이렇게 정할게요: 주 단위 달력.')]);
  assert.equal(judge({ kind: 'replyNotMatch', pattern: '(React|Vue).*\\?' }, t, tmp(), tmp()), true);
  assert.equal(judge({ kind: 'replyNotMatch', pattern: '(React|Vue).*\\?', turn: 0 }, t, tmp(), tmp()), false);
  assert.equal(judge({ kind: 'replyMatch', pattern: '정할게요' }, t, tmp(), tmp()), true);
  assert.equal(judge({ kind: 'replyNotMatch', pattern: '맞(나요|죠)\\?$' }, T([say('이거 맞죠?\n다음')]), tmp(), tmp()), false);
});

test('skillInvoked finds a Skill tool call anywhere', () => {
  assert.equal(judge({ kind: 'skillInvoked', name: 'pact:pact' }, T([say('a')], [skill('pact:pact')]), tmp(), tmp()), true);
  assert.equal(judge({ kind: 'skillInvoked', name: 'pact:pact' }, T([skill('debug')]), tmp(), tmp()), false);
});

test('questionsBeforeWrapOffer counts asking turns until the wrap-up offer', () => {
  const asking = Array.from({ length: 5 }, (_, i) => [say(`질문 ${i}?`)]);
  const offered = [...asking, [say('이 정도면 정리해도 될까요?')], [say('또?')], [say('또?')]];
  assert.equal(judge({ kind: 'questionsBeforeWrapOffer', max: 6 }, offered, tmp(), tmp()), true);
  const never = Array.from({ length: 8 }, () => [say('질문?')]);
  assert.equal(judge({ kind: 'questionsBeforeWrapOffer', max: 6 }, never, tmp(), tmp()), false);
  const short = [[say('질문?')], [say('명세를 썼어요.')]];
  assert.equal(judge({ kind: 'questionsBeforeWrapOffer', max: 6 }, short, tmp(), tmp()), true);
  // 정리 제안 없이 체크리스트 단계로 넘어가면 그 뒤의 체크리스트·스케치·승인 질문은 대화 질문이 아니다
  const checklist = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node x/scripts/checklist.mjs render a b' } }] } };
  const movedOn = [[say('a?')], [say('b?')], [say('c?')], [checklist, say('기능 범위예요. 다 포함할까요?')], [say('어느 쪽?')], [say('승인할까요?')], [say('시작할까요?')], [say('또?')]];
  assert.equal(judge({ kind: 'questionsBeforeWrapOffer', max: 6 }, movedOn, tmp(), tmp()), true);
});

test('noFileCreated and fileChanged compare the work dir with the fixture', () => {
  const fixture = tmp();
  writeFileSync(path.join(fixture, 'index.html'), '<button>a</button>');
  const work = tmp();
  writeFileSync(path.join(work, 'index.html'), '<button>a</button>');
  assert.equal(judge({ kind: 'fileChanged', path: 'index.html' }, [], work, fixture), false);
  assert.equal(judge({ kind: 'noFileCreated', glob: 'docs/pact/**' }, [], work, fixture), true);
  writeFileSync(path.join(work, 'index.html'), '<button style="color:blue">a</button>');
  mkdirSync(path.join(work, 'docs', 'pact'), { recursive: true });
  writeFileSync(path.join(work, 'docs', 'pact', 'x.md'), 'x');
  assert.equal(judge({ kind: 'fileChanged', path: 'index.html' }, [], work, fixture), true);
  assert.equal(judge({ kind: 'noFileCreated', glob: 'docs/pact/**' }, [], work, fixture), false);
});

const SPEC = (extra = '') => `---
pact: 1
topic: 회의
status: draft
created: 2026-10-10
---
# 회의
## 목적
## 범위
## 하지 않는 것
## 기능
- F1 가능한 시간 고르기 [사용자]
## 공통 규칙
- R1 시간대는 서울 [AI 가정]
${extra}## 구조 판정
## 확인 필요
## 결정 기록
`;

test('spec checks: a clean short spec passes, lint errors, length and open assumptions fail', () => {
  const work = tmp();
  assert.equal(judge({ kind: 'specLint' }, [], work, tmp()), false, 'no spec at all fails');
  mkdirSync(path.join(work, 'docs', 'pact'), { recursive: true });
  const file = path.join(work, 'docs', 'pact', '2026-10-10-회의.md');
  writeFileSync(file, SPEC());
  assert.equal(judge({ kind: 'specLint' }, [], work, tmp()), true);
  assert.equal(judge({ kind: 'specMaxLines', max: 40 }, [], work, tmp()), true);
  assert.equal(judge({ kind: 'specOpenAiAssumptionsMax', max: 5 }, [], work, tmp()), true);

  const many = Array.from({ length: 6 }, (_, i) => `- R${i + 2} 규칙 [AI 가정]\n`).join('');
  writeFileSync(file, SPEC(many));
  assert.equal(judge({ kind: 'specOpenAiAssumptionsMax', max: 5 }, [], work, tmp()), false);
  writeFileSync(file, SPEC(`<details><summary>나머지 가정</summary>\n\n${many}\n</details>\n`));
  assert.equal(judge({ kind: 'specOpenAiAssumptionsMax', max: 5 }, [], work, tmp()), true);
  writeFileSync(file, SPEC('x\n'.repeat(40)));
  assert.equal(judge({ kind: 'specMaxLines', max: 40 }, [], work, tmp()), false);
  writeFileSync(file, SPEC().replace(' [사용자]', ''));
  assert.equal(judge({ kind: 'specLint' }, [], work, tmp()), false);
});

test('an unknown check kind throws so a typo in a scenario is not a silent pass', () => {
  assert.throws(() => judge({ kind: 'nope' }, [], tmp(), tmp()));
});

test('wrappedUp marks the turn where the conversation ended', () => {
  const t = T([say('누가 써요?')], [say('이 정도면 정리해도 될까요?')]);
  assert.equal(wrappedUp(t, 0), false);
  assert.equal(wrappedUp(t, 1), true);
});

test('agentNotInvoked fails when a build agent was dispatched', () => {
  const agent = (type) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: type } }] } });
  assert.equal(judge({ kind: 'agentNotInvoked', name: 'pact:worker' }, T([agent('pact:spec-checker')]), tmp(), tmp()), true);
  assert.equal(judge({ kind: 'agentNotInvoked', name: 'pact:worker' }, T([say('a')], [agent('pact:worker')]), tmp(), tmp()), false);
});
