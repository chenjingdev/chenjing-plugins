import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge, explain, replyOf, countQuestions, hitLimit, wrappedUp, mapBranches } from './behavior/judge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
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

test('firstReplyBranches counts map lines with two or more ideas in the first reply', () => {
  const map = [
    '질문 없이 바로 명세로 가도 돼요.',
    '- 시간 모으기: 되는 시간 고르기 · 안 되는 시간 빼기 · 선호 표시',
    '- 겹치는 시간: 다 되는 시간 · 한 명만 빠지는 시간',
    '- 확정과 알림: 확정 버튼, 캘린더 초대',
    '* **공유 (제안)**: 링크 · QR',
    '- 반복 회의: 매주 같은 시간 / 다음 회차 자동',
    '- 쓰는 사람: 6명',
    '어느 갈래부터 볼까요?',
  ].join('\n');
  assert.equal(mapBranches(map), 5, 'a one-idea line is not a branch');
  assert.equal(judge({ kind: 'firstReplyBranches', min: 5 }, T([say(map)], [say('a')]), tmp(), tmp()), true);
  assert.equal(judge({ kind: 'firstReplyBranches', min: 5 }, T([say('언제 쓰세요?')], [say(map)]), tmp(), tmp()), false);
});

test('repliesMatchingMax counts the turns whose reply matches', () => {
  const pattern = '(틀린 거나|틀리거나) 빠진';
  const twice = T([say('기본안은 A예요. 틀리거나 빠진 게 있어요?')], [say('B로 갈게요.')], [say('기본안은 C예요. 틀린 거나 빠진 게 있어요?')]);
  assert.equal(judge({ kind: 'repliesMatchingMax', pattern, max: 1 }, twice, tmp(), tmp()), false);
  assert.equal(judge({ kind: 'repliesMatchingMax', pattern, max: 2 }, twice, tmp(), tmp()), true);
});

test('the confirm-question pattern in the scenarios catches single-default confirms, not choice questions', () => {
  const scenario = JSON.parse(readFileSync(path.join(here, 'behavior', 'scenarios', 'wide-first.json'), 'utf8'));
  const re = new RegExp(scenario.checks.find((c) => c.kind === 'repliesMatchingMax').pattern, 'm');
  for (const confirm of ['기본안은 A예요. 틀리거나 빠진 게 있어요?', '추천은 2번이에요. 괜찮을까요?', '이렇게 정리했어요.\n이게 맞나요?', '이대로 갈까요?']) {
    assert.ok(re.test(confirm), confirm);
  }
  for (const choice of ['어느 방식이 팀에 맞을까요?', '팀이 평소 뭘로 소통하는지에 달린 문제인데, 어느 쪽이 맞을까요?', '어느 갈래부터 내려가 볼까요?']) {
    assert.ok(!re.test(choice), choice);
  }
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
  writeFileSync(file, SPEC(`<details><summary>나머지 가정</summary>\n\n${'- R9 규칙 [AI 가정]\n'.repeat(40)}</details>\n`));
  assert.equal(judge({ kind: 'specMaxLines', max: 40 }, [], work, tmp()), true, 'folded lines are off-screen');
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

test('spec checks also find a spec written under a new app folder, but not the worktree copy', () => {
  const work = tmp();
  mkdirSync(path.join(work, 'app', 'docs', 'pact'), { recursive: true });
  writeFileSync(path.join(work, 'app', 'docs', 'pact', '2026-10-10-회의.md'), SPEC());
  assert.equal(judge({ kind: 'specLint' }, [], work, tmp()), true);
  mkdirSync(path.join(work, '.pact', 'x', 'wt', 'docs', 'pact'), { recursive: true });
  writeFileSync(path.join(work, '.pact', 'x', 'wt', 'docs', 'pact', 'bad.md'), 'not a spec');
  assert.equal(judge({ kind: 'specLint' }, [], work, tmp()), true, 'worktree copy is ignored');
});

test('explain: judge is explain().pass, and a failed question count lists the question sentences', () => {
  const t = T([say('누가 써요? 언제 쓰세요?\n- 예: "다들 돼요?" 돌리기\n어디서요?')]);
  const check = { kind: 'firstReplyQuestionCount', max: 1 };
  const r = explain(check, t, tmp(), tmp());
  assert.equal(r.pass, false);
  assert.equal(judge(check, t, tmp(), tmp()), r.pass);
  assert.equal(r.reason, '물음표 3 > 1');
  assert.deepEqual(r.match, [
    { turn: 0, text: '누가 써요?' },
    { turn: 0, text: '언제 쓰세요?' },
    { turn: 0, text: '어디서요?' },
  ]);
  for (const m of r.match) assert.ok(replyOf(t, 0).includes(m.text), 'text is verbatim from the reply');
  const ok = explain({ kind: 'firstReplyQuestionCount', max: 5 }, t, tmp(), tmp());
  assert.equal(ok.pass, true);
  assert.ok(ok.reason.length > 0, 'a passing check still has a reason');
});

test('explain: questionsBeforeWrapOffer reports the asking turns with their question sentences', () => {
  const t = T([say('a 인가요?')], [say('설명만.')], [say('b 인가요? c 인가요?')], [say('이 정도면 정리해도 될까요?')]);
  const r = explain({ kind: 'questionsBeforeWrapOffer', max: 1 }, t, tmp(), tmp());
  assert.equal(r.pass, false);
  assert.equal(r.reason, '질문한 턴 2 > 1');
  assert.deepEqual(r.match, [
    { turn: 0, text: 'a 인가요?' },
    { turn: 2, text: 'b 인가요?' },
    { turn: 2, text: 'c 인가요?' },
  ]);
});

test('explain: a forbidden pattern reports the turn and the matching line', () => {
  const t = T([say('시작할게요.')], [say('좋아요.\nReact로 할까요?\n끝.')]);
  const r = explain({ kind: 'replyNotMatch', pattern: '(React|Vue).*\\?', turn: 1 }, t, tmp(), tmp());
  assert.equal(r.pass, false);
  assert.equal(r.reason, '턴 1 답에 금지 패턴이 걸림');
  assert.deepEqual(r.match, [{ turn: 1, text: 'React로 할까요?' }]);
  const clean = explain({ kind: 'replyNotMatch', pattern: 'Vue' }, t, tmp(), tmp());
  assert.equal(clean.pass, true);
  assert.deepEqual(clean.match, []);
  const miss = explain({ kind: 'replyMatch', pattern: '정할게요' }, t, tmp(), tmp());
  assert.equal(miss.pass, false);
  assert.equal(miss.reason, '패턴을 찾지 못함');
  assert.deepEqual(miss.match, []);
});

test('explain: repliesMatchingMax lists the matching line of every matching turn', () => {
  const pattern = '틀리거나 빠진';
  const t = T([say('A예요.\n틀리거나 빠진 게 있어요?')], [say('B.')], [say('틀리거나 빠진 게 있어요?')]);
  const r = explain({ kind: 'repliesMatchingMax', pattern, max: 1 }, t, tmp(), tmp());
  assert.equal(r.pass, false);
  assert.match(r.reason, /2 > 1/);
  assert.deepEqual(r.match.map((m) => m.turn), [0, 2]);
  assert.equal(r.match[0].text, '틀리거나 빠진 게 있어요?');
});

test('explain: firstReplyBranches reports the count and the branch lines', () => {
  const map = '- 시간: 가 · 나\n- 확정: 다 · 라\n- 하나: 마\n끝';
  const r = explain({ kind: 'firstReplyBranches', min: 5 }, T([say(map)]), tmp(), tmp());
  assert.equal(r.pass, false);
  assert.equal(r.reason, '갈래 2 < 5');
  assert.deepEqual(r.match, [
    { turn: 0, text: '- 시간: 가 · 나' },
    { turn: 0, text: '- 확정: 다 · 라' },
  ]);
});

test('explain: skill and agent checks give a reason and no match', () => {
  const r = explain({ kind: 'skillInvoked', name: 'pact:pact' }, T([say('a')]), tmp(), tmp());
  assert.deepEqual(r, { pass: false, reason: 'pact:pact 스킬을 부르지 않음', match: [] });
  const a = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'pact:worker' } }] } };
  const g = explain({ kind: 'agentNotInvoked', name: 'pact:worker' }, T([a]), tmp(), tmp());
  assert.equal(g.pass, false);
  assert.deepEqual(g.match, []);
  assert.ok(g.reason.includes('pact:worker'));
});

test('explain: file checks name the file and leave match empty', () => {
  const fixture = tmp();
  writeFileSync(path.join(fixture, 'index.html'), 'a');
  const work = tmp();
  writeFileSync(path.join(work, 'index.html'), 'a');
  const same = explain({ kind: 'fileChanged', path: 'index.html' }, [], work, fixture);
  assert.deepEqual(same, { pass: false, reason: 'index.html가 바뀌지 않음', match: [] });
  mkdirSync(path.join(work, 'docs', 'pact'), { recursive: true });
  writeFileSync(path.join(work, 'docs', 'pact', 'x.md'), 'x');
  writeFileSync(path.join(work, 'docs', 'pact', 'y.md'), 'y');
  const made = explain({ kind: 'noFileCreated', glob: 'docs/pact/**' }, [], work, fixture);
  assert.deepEqual(made, { pass: false, reason: '새로 생긴 파일: docs/pact/x.md, docs/pact/y.md', match: [] });
});

test('explain: spec checks give numbers or the first lint error, with no match', () => {
  const work = tmp();
  const none = explain({ kind: 'specMaxLines', max: 40 }, [], work, tmp());
  assert.deepEqual(none, { pass: false, reason: '명세 파일 없음', match: [] });
  mkdirSync(path.join(work, 'docs', 'pact'), { recursive: true });
  const file = path.join(work, 'docs', 'pact', '2026-10-10-회의.md');
  writeFileSync(file, SPEC('x\n'.repeat(40)));
  const lines = SPEC('x\n'.repeat(40)).trimEnd().split('\n').length;
  const long = explain({ kind: 'specMaxLines', max: 40 }, [], work, tmp());
  assert.equal(long.pass, false);
  assert.equal(long.reason, `펼친 줄 ${lines} > 40`);
  assert.deepEqual(long.match, []);
  const many = Array.from({ length: 6 }, (_, i) => `- R${i + 2} 규칙 [AI 가정]\n`).join('');
  writeFileSync(file, SPEC(many));
  const ai = explain({ kind: 'specOpenAiAssumptionsMax', max: 5 }, [], work, tmp());
  assert.equal(ai.reason, '펼친 AI 가정 7 > 5');
  writeFileSync(file, SPEC().replace(' [사용자]', ''));
  const lint = explain({ kind: 'specLint' }, [], work, tmp());
  assert.equal(lint.pass, false);
  assert.equal(lint.reason, 'F1: 태그가 없습니다 ([사용자] 또는 [AI 가정])');
  assert.deepEqual(lint.match, []);
});
