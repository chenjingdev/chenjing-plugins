// worker 답의 `## 걱정·위험` 칸을 읽고 reviewer 글 끝에 붙이는 글 도구(scripts/concerns.mjs)의 시험.
// 답 모양은 이 컴퓨터의 진짜 pact:worker 답 122개(제목은 모두 `## 걱정·위험`, 119개가 마지막 줄 `보고서: …`로 끝나고,
// 15개는 칸 안에 빈 줄이 있고, 2개는 보고서 줄 없이 답이 끝나고, 1개는 다음 제목으로 끝난다)를 따른다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONCERNS_HEADING, concernsOf, hasConcernsSection, withConcerns } from '../scripts/concerns.mjs';

const REPORT = '보고서: /p/.pact/2026-10-29-x/tasks/2-report.md';
// worker 답 한 편: 머리말, 칸들, 마지막 줄. concerns는 `## 걱정·위험` 아래 줄들이다.
const reply = (concerns, { tail = [REPORT], head = ['끝냈습니다.', ''] } = {}) => [
  ...head, '## 상태: DONE', '## 바꾼 파일', '- hooks/guard.mjs — 훅', '## 확인', '- node --test tests/ → 통과 459, 실패 0', '## 정한 것', '- 없음',
  '## 걱정·위험', ...concerns, ...tail,
].join('\n');

test('concernsOf returns the lines of the 걱정·위험 field as written, without the report line that ends the reply', () => {
  const concerns = ['- 실제 Claude Code에서는 안 돌려 봤다(R18 몫).', '- 작업 번호가 null인 worker가 123개 중 35개라 null은 "못 찾음"으로 다뤘다.'];
  assert.equal(concernsOf(reply(concerns)), concerns.join('\n'));
  // 한 줄이 길어도, 마크다운 꾸밈이 들어 있어도 그대로다
  const long = [`- **7번**: ${'긴 설명 '.repeat(80)}`, '- `desiredSize`가 내려가지 않는다.'];
  assert.equal(concernsOf(reply(long)), long.join('\n'));
});

test('concernsOf is null when the field says "없음", is empty, or is only list marks, in the forms the real replies use', () => {
  for (const lines of [
    ['- 없음'], ['없음'], ['- 없음.'], ['- **없음**'], ['_없음_'], ['- 해당 없음'], ['- 없습니다.'], ['- 없다'], ['- None'], ['- n/a'], ['* 없음'], ['1. 없음'],
    ['- 없음', '- 없음'], ['', '- 없음', ''],
    [], [''], ['', ''], ['-'], ['- ', '-'],
  ]) {
    assert.equal(concernsOf(reply(lines)), null, JSON.stringify(lines));
  }
  assert.equal(concernsOf(reply(['- 없음'], { tail: [] })), null, '보고서 줄 없이 답이 끝나도 같다');
});

test('concernsOf keeps a field that starts with 없음 but goes on to say something, and a field that mixes 없음 with a real line', () => {
  for (const lines of [
    ['- 없음. 처리 쪽 `process.mjs`의 "더 파 보기에 조건이 없어요" 실패는 이미 대기열에 있던 옛 항목 방어로 그대로 뒀습니다.'], // 진짜 답
    ['- 없음 (다만 Node 18에서는 못 돌렸다)'],
    ['- 없음에 가깝지만 링크 경로에서는 훅이 안 돈다'],
    ['- 없음', '- 다만 R18은 못 봤다'],
    ['- Nothing new. The earlier ones stay: README line 133 is stale.'], // 진짜 답
  ]) {
    assert.equal(concernsOf(reply(lines)), lines.join('\n'), JSON.stringify(lines));
  }
});

test('concernsOf is null for a reply that has no such field: a BLOCKED reply, a half-written one, empty or not text', () => {
  assert.equal(concernsOf('BLOCKED: 질문이 있다\n1. 결정할 것: 이름\n   - 선택지 가, 나\n   - 기본값: 가'), null);
  assert.equal(concernsOf("You've hit your session limit · resets 4:40am (Asia/Seoul)"), null);
  assert.equal(concernsOf('## 상태: DONE\n## 바꾼 파일\n- a — b\n보고서: /x/tasks/1-report.md'), null);
  for (const value of ['', undefined, null, 42, {}, []]) assert.equal(concernsOf(value), null, String(value));
});

test('a blank line inside the field is part of it; the field ends at the report line, at the next heading, or with the reply', () => {
  // 진짜 답 15개가 칸 안에 빈 줄을 둔다
  const paragraphs = ['- 첫째 걱정', '', '둘째 걱정은 한 문단이다.', '', '- 셋째 걱정'];
  assert.equal(concernsOf(reply(paragraphs)), paragraphs.join('\n'));
  // 칸 앞뒤의 빈 줄은 떼고, 칸 안 줄의 앞 공백은 그대로 둔다
  assert.equal(concernsOf(reply(['', '- 가', '  - 가의 하위 항목', '', ''])), '- 가\n  - 가의 하위 항목');
  // 보고서 줄 없이 답이 끝나는 진짜 답 둘: 끝까지가 칸이다
  const noReport = ['- 걱정 하나', '', '보고서(`T4-report.md`)는 이번에 갱신하지 않았다.'];
  assert.equal(concernsOf(reply(noReport, { tail: [] })), noReport.join('\n'));
  // 다음 제목에서 끝난다(진짜 답 하나가 칸 뒤에 `## 뒤 작업이 쓸 곳`을 둔다)
  assert.equal(concernsOf(reply(['- 걱정 하나'], { tail: ['## 뒤 작업이 쓸 곳', '- ctx.signIns', REPORT] })), '- 걱정 하나');
  // 보고서 줄에 덧붙은 말이 있어도 그 줄에서 끝난다(진짜 답에 많다). 굵게 쓴 보고서 줄도 같다
  for (const tail of ['보고서: /x/tasks/2-report.md (끝의 "## 검토 뒤 고침")', '보고서：/x/tasks/2-report.md', '**보고서:** /x/tasks/2-report.md', '  보고서: /x/tasks/2-report.md']) {
    assert.equal(concernsOf(reply(['- 걱정 하나'], { tail: [tail] })), '- 걱정 하나', tail);
  }
  // `보고서`로 시작해도 콜론이 없으면 걱정 글이다
  assert.equal(concernsOf(reply(['- 걱정 하나', '보고서에 적지 못한 것이 있다'], { tail: [REPORT] })), '- 걱정 하나\n보고서에 적지 못한 것이 있다');
});

test('the field heading is read at any level and with emphasis; text after a colon on the heading line is the first line of the field', () => {
  for (const heading of ['### 걱정·위험', '# 걱정·위험', '###### 걱정·위험', '## **걱정·위험**', '## __걱정·위험__', '##걱정·위험', '## 걱정 · 위험', '## 걱정/위험', '  ## 걱정·위험', '## 걱정·위험 ']) {
    const text = `## 상태: DONE\n${heading}\n- 걱정 하나\n${REPORT}`;
    assert.equal(concernsOf(text), '- 걱정 하나', heading);
  }
  assert.equal(concernsOf(`## 걱정·위험: 없음\n${REPORT}`), null);
  assert.equal(concernsOf(`## 걱정·위험：없음\n${REPORT}`), null);
  assert.equal(concernsOf(`## 걱정·위험: 링크 경로에서는 훅이 안 돈다\n- 둘째\n${REPORT}`), '링크 경로에서는 훅이 안 돈다\n- 둘째');
  // 제목 뒤에 콜론이 없는 말은 칸 글이 아니다
  assert.equal(concernsOf(`## 걱정되는 점\n- 걱정 하나\n${REPORT}`), '- 걱정 하나');
});

test('only a heading line starts the field: the words in prose, in the status line or in a list item do not', () => {
  // 진짜 답이 머리말에서 칸 이름을 말한다("아래 `걱정·위험` 두 줄에 적었습니다")
  const text = [
    'DONE_WITH_CONCERNS 상태로 끝났습니다. 마음에 걸리는 점은 아래 `걱정·위험` 두 줄에 적었습니다.', '',
    '## 상태: DONE', '## 바꾼 파일', '- 걱정·위험 칸을 읽는 함수를 더했다', '## 확인', '- 걱정·위험 시험 통과', '## 정한 것', '- 없음', '## 걱정·위험', '- 진짜 걱정', REPORT,
  ].join('\n');
  assert.equal(concernsOf(text), '- 진짜 걱정');
  // 제목이 없고 말만 있으면 칸이 없는 것이다
  assert.equal(concernsOf('끝냈습니다. 걱정·위험: 없음\n- 걱정 하나\n'), null);
  // `#` 제목 표시가 없는 줄은 칸 이름으로 시작해도 칸이 아니다(굵은 글씨 이름, 이름만 쓴 줄, 콜론으로 이은 줄)
  for (const line of ['걱정·위험: 시험을 못 돌렸다', '**걱정·위험**', '걱정·위험', '걱정되는 것은 링크 경로다.', '- 걱정·위험: 시험을 못 돌렸다']) {
    assert.equal(concernsOf(`## 상태: DONE\n${line}\n- 걱정 하나\n${REPORT}`), null, line);
  }
});

test('when the reply has two such headings the last one is the field', () => {
  const text = ['## 걱정·위험', '- 앞의 것(인용)', '', '## 정한 것', '- 없음', '## 걱정·위험', '- 진짜 걱정', REPORT].join('\n');
  assert.equal(concernsOf(text), '- 진짜 걱정');
});

test('Windows line ends are read the same way', () => {
  assert.equal(concernsOf(reply(['- 가', '- 나']).replace(/\n/g, '\r\n')), '- 가\n- 나');
  assert.equal(concernsOf(reply(['- 없음']).replace(/\n/g, '\r\n')), null);
});

test('hasConcernsSection sees a worker-worry heading at any level, also the one the main session wrote by hand, but not the reviewer\'s own answer heading or plain mentions', () => {
  for (const heading of [
    '## worker 걱정', '### worker 걱정', '# worker 걱정', '## worker  걱정', '##worker 걱정', '## Worker 걱정', '  ## worker 걱정',
    '## worker가 남긴 걱정(상태 DONE_WITH_CONCERNS)', // 이 판 작업 1에서 메인 세션이 손으로 단 제목
    '## worker 걱정 (훅이 붙임)',
  ]) {
    assert.equal(hasConcernsSection(`지시\n\n${heading}\n- 걱정`), true, heading);
    assert.equal(hasConcernsSection(`${heading}\n- 걱정`), true, `${heading} (맨 앞)`);
  }
  for (const text of [
    '', undefined, null, '지시만 있다', '## 걱정·위험\n- 걱정', '## worker 보고서\n- 경로',
    '## worker 걱정 처리\n- 앞 검토 때 쓴 것', // reviewer 답의 칸 제목이다. 붙은 걱정이 아니다
    '앞서 worker 걱정을 봤다.', '- worker 걱정은 훅이 붙인다', '`## worker 걱정`을 붙인다', 'worker 걱정\n- 제목 표시가 없다',
  ]) {
    assert.equal(hasConcernsSection(text), false, JSON.stringify(text));
  }
});

test('withConcerns appends the heading and the lines after one blank line, keeping the original text as it was', () => {
  assert.equal(CONCERNS_HEADING, '## worker 걱정');
  const lines = '- 걱정 하나\n- 걱정 둘';
  assert.equal(withConcerns('지시 본문', lines), `지시 본문\n\n## worker 걱정\n${lines}`);
  assert.equal(withConcerns('지시 본문\n', lines), `지시 본문\n\n## worker 걱정\n${lines}`, '끝 줄바꿈이 하나면 빈 줄 하나만 더한다');
  assert.equal(withConcerns('지시 본문\n\n', lines), `지시 본문\n\n## worker 걱정\n${lines}`, '이미 빈 줄이 있으면 더하지 않는다');
  assert.equal(withConcerns('지시 본문  ', lines), `지시 본문  \n\n## worker 걱정\n${lines}`, '원래 글은 한 글자도 바꾸지 않는다');
  assert.equal(withConcerns('', lines), `## worker 걱정\n${lines}`);
  assert.equal(withConcerns(undefined, lines), `## worker 걱정\n${lines}`);
  assert.ok(withConcerns('지시', lines).endsWith(lines), '걱정 글로 끝난다');
  // 붙인 글은 붙은 칸으로 읽힌다: 같은 글에 다시 붙이지 않는다
  assert.equal(hasConcernsSection(withConcerns('지시', lines)), true);
});
