// 사용자만 답할 수 있음 항목의 짝(F5, R11)과 승인 뒤 바뀐 [사용자] 줄(F3, R4, R12)의 시험.
// 명세 글을 읽는 함수(spec.mjs), spec-checker 답을 읽는 함수(approval.mjs), approve·delegate와 시작 관문(checkStart)을 본다.
// 훅·snapshot·완료 검사·보고서에서 같은 규칙이 도는지는 hooks·verification·report 시험이 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  T, typed, makeWorld, writeTranscript, addCheckerRecord, checkerReply, runSpec, specStatus, approvalEntries, assertRefused, grantApproval, specText,
} from './approval-world.mjs';
import { lintSpec, parseSpec, userLinesOf, reviewMarks } from '../scripts/spec.mjs';
import {
  parseReviewReply, pairingProblem, diffUserLines, userLineDrift, driftProblem, describeChange, plainLines, questionOf, checkStart, refusalLine,
} from '../scripts/approval.mjs';

const QUESTIONS = ['출석을 몇 분 뒤에 닫을까요?', '결석 사유를 학생도 볼 수 있나요?'];
const TWO = checkerReply(QUESTIONS); // 검수 1·2

// ---------- 명세에서 [사용자] 줄과 검수 번호의 짝 읽기 ----------

const SAMPLE = `---
pact: 2
topic: 출결
status: building
---
# 출결
## 목적
- F9 목적 칸의 줄은 항목이 아니다 [사용자]
## 기능
- F1 오늘 수업 출석 현황 보기 [사용자]
  - 케이스: 수업 0건 → 빈 상태 문구
- F2 출석은 시작 10분 뒤에 닫는다 [사용자: 검수 1]
- F3 화면 문구는 한국어 — 쓰는 사람이 한국어 사용자라서 [AI 가정]
  - 케이스: 글자가 넘침 → 말줄임
- F4 지난 학기 기록은 비운다 [위험: 지우기] [사용자]
## 공통 규칙
- R1 출석 기록은 학기 동안 보관한다 [AI 가정: 검수 2 맡김]

<details><summary>그 밖의 AI 가정 1개</summary>

- R2 결과는 표로 보인다 [사용자]
  - 케이스: 결과가 없음 → 빈 표

</details>

## 확인 필요
- 검수 3: 위임이라 기본안으로 정함
## 결정 기록
`;

test('userLinesOf: the F and R lines tagged [사용자] or [사용자: …] with their cases, folded ones too, and nothing else', () => {
  assert.deepEqual(userLinesOf(SAMPLE), {
    F1: ['- F1 오늘 수업 출석 현황 보기 [사용자]', '- 케이스: 수업 0건 → 빈 상태 문구'],
    F2: ['- F2 출석은 시작 10분 뒤에 닫는다 [사용자: 검수 1]'],
    F4: ['- F4 지난 학기 기록은 비운다 [위험: 지우기] [사용자]'],
    R2: ['- R2 결과는 표로 보인다 [사용자]', '- 케이스: 결과가 없음 → 빈 표'],
  }, 'F3(AI 가정)과 그 케이스, R1(AI 가정: 검수 2 맡김), 목적 칸의 줄은 들어가지 않는다');
  assert.deepEqual(userLinesOf(''), {});
  assert.deepEqual(userLinesOf(undefined), {});
  assert.deepEqual(userLinesOf(specText({ pact: 2 })), { F1: ['- F1 오늘 수업 출석 현황 보기 [사용자]', '- 케이스: 수업 0건 → 빈 상태 문구'] });
});

test('userLinesOf ignores spacing, indentation and line endings, and keeps a repeated number apart instead of dropping it', () => {
  const plain = '## 기능\n- F1 오늘 수업 보기 [사용자]\n  - 케이스: 없음 → 빈 화면\n## 공통 규칙\n';
  const messy = '## 기능\r\n-   F1  오늘   수업 보기 [사용자]   \r\n      -   케이스:  없음 → 빈 화면 \r\n## 공통 규칙\r\n';
  assert.deepEqual(userLinesOf(messy), userLinesOf(plain), '공백·들여쓰기·줄 끝이 달라진 것은 바뀐 것이 아니다');
  assert.deepEqual(userLinesOf('## 기능\n- F1 하나 [사용자]\n- F1 또 하나 [사용자]\n- F1 셋 [사용자]\n'), {
    F1: ['- F1 하나 [사용자]'], 'F1#2': ['- F1 또 하나 [사용자]'], 'F1#3': ['- F1 셋 [사용자]'],
  });
  // 태그가 없거나 알 수 없는 줄은 [사용자] 줄이 아니다
  assert.deepEqual(userLinesOf('## 기능\n- F1 태그 없음\n- F2 이상한 태그 [사용자님]\n- F3 AI [AI 가정]\n'), {});
});

test('reviewMarks: [사용자: 검수 n], [AI 가정: 검수 n 맡김] and the ## 확인 필요 lines are the three pairs', () => {
  const marks = reviewMarks(SAMPLE);
  assert.deepEqual([...marks.answered], [1]);
  assert.deepEqual([...marks.delegated], [2]);
  assert.deepEqual([...marks.notAsked], [[3, '위임이라 기본안으로 정함']]);
  const none = reviewMarks(specText());
  assert.deepEqual([[...none.answered], [...none.delegated], [...none.notAsked]], [[], [], []]);
});

test('reviewMarks reads a tag with several numbers on the lines of the F and R items: the head line and its cases, folded items too, with the risk mark on either side', () => {
  const body = (line) => `## 기능\n${line}\n## 공통 규칙\n## 확인 필요\n## 결정 기록\n`;
  assert.deepEqual([...reviewMarks(body('- F1 보기 [사용자: 검수 1, 3]')).answered], [1, 3]);
  assert.deepEqual([...reviewMarks(body('- F1 보기 [사용자: 검수 1·2]')).answered], [1, 2]);
  assert.deepEqual([...reviewMarks(body('- F1 보기 [사용자: 검수 4/5]')).answered], [4, 5]);
  assert.deepEqual([...reviewMarks(body('- F1 보기 [사용자]\n  - 케이스: 없음 → 빈 화면 [사용자: 검수 7]')).answered], [7], '케이스 줄의 태그도 읽는다');
  assert.deepEqual([...reviewMarks(body('- F1 보기 [위험: 공개] [AI 가정: 검수 8 맡김]')).delegated], [8]);
  assert.deepEqual([...reviewMarks(body('- F1 보기 [AI 가정: 검수 8 맡김] [위험: 공개]')).delegated], [8], '위험 표시가 태그 뒤에 와도 같다');
  assert.deepEqual([...reviewMarks(body('- F1 보기 [사용자]\n  - 케이스: 없음 → 빈 화면 [위험: 지우기] [사용자: 검수 9]')).answered], [9]);
  assert.deepEqual([...reviewMarks('## 기능\n## 공통 규칙\n<details><summary>그 밖의 AI 가정 1개</summary>\n\n- R2 접힌 규칙 [AI 가정]\n  - 케이스: 가 → 나 [사용자: 검수 6]\n\n</details>\n').answered], [6], '접힌 칸의 케이스 줄도 읽는다');
  // 번호가 아닌 것은 읽지 않는다
  for (const line of ['- F1 보기 [사용자: 10/8 회의]', '- F1 보기 [사용자]', '- F1 보기 [사용자: 검수]', '- F1 보기 [사용자: 검수 하나]', '- F1 보기 [AI 가정: 검수 2]']) {
    const marks = reviewMarks(body(line));
    assert.deepEqual([[...marks.answered], [...marks.delegated]], [[], []], line);
  }
});

test('reviewMarks counts only what the lint reads as a tag on an F or R line: not the purpose and scope sections, not the middle of a line, not a full-width colon', () => {
  const spec = (...parts) => `## 목적\n${parts[0] ?? ''}\n## 범위\n${parts[1] ?? ''}\n## 하지 않는 것\n${parts[2] ?? ''}\n## 기능\n${parts[3] ?? ''}\n## 공통 규칙\n${parts[4] ?? ''}\n## 구조 판정\n${parts[5] ?? ''}\n## 확인 필요\n## 결정 기록\n`;
  const nobody = (text, label) => {
    const marks = reviewMarks(text);
    assert.deepEqual([[...marks.answered], [...marks.delegated]], [[], []], label);
    return marks;
  };
  // 목적·범위·하지 않는 것·구조 판정 칸의 태그와 맨 앞이 F·R 항목이 아닌 줄
  nobody(spec('교수자가 출석을 확인한다 [사용자: 검수 1]'), '목적');
  nobody(spec('', '웹 화면 하나 [사용자: 검수 1]'), '범위');
  nobody(spec('', '', '- 출석 처리 자체 [AI 가정: 검수 1 맡김]'), '하지 않는 것');
  nobody(spec('', '', '', '', '', '- 고른 스케치 [사용자: 검수 1]'), '구조 판정');
  nobody(spec('', '', '', '검수 1에 답하신 대로 [사용자: 검수 1]'), '기능 칸의 항목이 아닌 줄');
  // 줄 가운데: lint도 줄 끝의 [..]만 태그로 읽는다
  nobody(spec('', '', '', '- F1 결석 사유 [사용자: 검수 1] 보기 — 이유 [AI 가정]\n'), '줄 가운데');
  nobody(spec('', '', '', '', '- R1 규칙 [AI 가정: 검수 1 맡김] 이라고 한다 [AI 가정]\n'), '줄 가운데 맡김');
  // 전각 콜론: lint는 알 수 없는 태그로 알리니 짝도 F3 줄도 아니다. 어느 쪽인지 알리려고 따로 모아 둔다
  const wide = nobody(spec('', '', '', '- F1 결석 사유 [사용자： 검수 1]\n', '- R1 규칙 [AI 가정： 검수 2 맡김]\n'), '전각 콜론');
  assert.deepEqual([...wide.fullwidth].sort(), [1, 2]);
  assert.deepEqual(userLinesOf(spec('', '', '', '- F1 결석 사유 [사용자： 검수 1]\n')), {}, '전각 콜론의 태그는 [사용자] 줄도 아니다');
  assert.ok(lintSpec(spec('', '', '', '- F1 결석 사유 [사용자： 검수 1]\n', '- R1 규칙\n')).includes('F1: 알 수 없는 태그 [사용자： 검수 1]'));
  // 같은 줄이 정상이면 읽는다
  const fine = reviewMarks(spec('', '', '', '- F1 결석 사유 [사용자: 검수 1]\n', '- R1 규칙 [AI 가정: 검수 2 맡김]\n'));
  assert.deepEqual([[...fine.answered], [...fine.delegated], [...fine.fullwidth]], [[1], [2], []]);
});

test('reviewMarks: an example in backticks, a tag in the decision log, and a bare "- 검수 n:" with no reason are not pairs', () => {
  const spec = `## 기능
- F1 보기 [사용자]
## 공통 규칙
- R1 번호는 \`[사용자: 검수 4]\`처럼 단다 [AI 가정]
## 확인 필요
- 검수 5:
- 검수 6:
- 검수 7 까닭만 있고 콜론이 없다
- 검수 8: 까닭이 있다
- 검수 2·3: 둘을 한 줄로
* 검수 9: 별표 목록도 읽는다
- 검수 10：전각 콜론도 읽는다
## 결정 기록
- Ruling: 옛 줄 [사용자: 검수 11] 은 기록일 뿐이다
`;
  const marks = reviewMarks(spec);
  assert.deepEqual([...marks.answered], [], '백틱 안과 결정 기록의 태그는 읽지 않는다');
  assert.deepEqual([...marks.notAsked.keys()], [8, 2, 3, 9, 10], '까닭이 없거나 콜론이 없는 줄은 짝이 아니다');
  assert.equal(marks.notAsked.get(3), '둘을 한 줄로');
});

test('reviewMarks reads the 확인 필요 lines folded in a <details> block, and only inside that section', () => {
  const spec = `## 기능
- F1 보기 [사용자]
## 공통 규칙
## 확인 필요
<details><summary>묻지 않은 검수 항목 2개</summary>

- 검수 2: 위임이라 기본안으로 정함
- 검수 3: 위임이라 기본안으로 정함

</details>

## 결정 기록
- 검수 4: 결정 기록에 있는 줄은 짝이 아니다
`;
  assert.deepEqual([...reviewMarks(spec).notAsked.keys()], [2, 3]);
  const w = makeWorld({ confirm: '<details><summary>묻지 않은 검수 항목</summary>\n\n- 검수 1: 위임이라 기본안으로 정함\n- 검수 2: 위임이라 기본안으로 정함\n\n</details>\n\n' });
  addCheckerRecord(w, T(5), { message: TWO });
  writeTranscript(w, [typed('승인', T(10))]);
  assert.equal(runSpec(w, ['approve', w.spec, '승인']).status, 0, '접어 둔 줄도 짝이다');
});

test('the tags with a review number are tags the lint reads, in files and through the CLI: nothing is printed', () => {
  const w = makeWorld({ features: '- F2 출석은 10분 뒤에 닫는다 [사용자: 검수 1]\n', rules: '- R2 결석 사유는 선생님만 본다 — 맡겼다 [AI 가정: 검수 2 맡김]\n- R3 다른 번호도 된다 [위험: 공개] [사용자: 검수 3]\n', confirm: '- 검수 4: 묻지 않았다\n' });
  assert.deepEqual(lintSpec(readFileSync(w.spec, 'utf8')), []);
  const lint = runSpec(w, ['lint', w.spec]);
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  assert.equal(lint.stdout, '');
  assert.equal(parseSpec(readFileSync(w.spec, 'utf8')).items.find((i) => i.id === 'F2').tag, '사용자');
  assert.equal(parseSpec(readFileSync(w.spec, 'utf8')).items.find((i) => i.id === 'R2').tag, 'AI 가정');
});

// ---------- F5가 짝으로 세는 줄은 F3가 지킨다 ----------

// 검토자가 든 어긋남 그대로: [AI 가정] 기능의 케이스 줄에 사용자의 답이 달렸다
const AI_CASE = '- F3 결석 사유 보기 — 기본은 선생님만 [AI 가정]\n  - 케이스: 학생이 봄 → 안 보임 [사용자: 검수 2]\n';

test('a [사용자: 검수 n] answer on the case line of an [AI 가정] item is a pair, and F3 keeps that one line: the [AI 가정] head line is not kept', () => {
  const spec = specText({ status: 'building', features: AI_CASE });
  assert.deepEqual([...reviewMarks(spec).answered], [2]);
  const kept = userLinesOf(spec);
  assert.deepEqual(kept, {
    F1: ['- F1 오늘 수업 출석 현황 보기 [사용자]', '- 케이스: 수업 0건 → 빈 상태 문구'],
    'F3/1': ['- 케이스: 학생이 봄 → 안 보임 [사용자: 검수 2]'],
  }, '머리 줄은 담지 않고, [사용자] 태그가 붙은 케이스 줄만 그 줄 하나로 담는다');
  // 케이스 줄을 바꾸면 바뀐 것이다(전에는 userLineDrift가 null이었다)
  const recorded = { user_lines: kept };
  const drift = userLineDrift(spec.replace('→ 안 보임', '→ 이름만 보임'), recorded);
  assert.deepEqual(drift?.changes.map(({ id, kind }) => ({ id, kind })), [{ id: 'F3/1', kind: 'changed' }]);
  assert.deepEqual(drift.changes[0].before, ['- 케이스: 학생이 봄 → 안 보임 [사용자: 검수 2]']);
  assert.deepEqual(drift.changes[0].after, ['- 케이스: 학생이 봄 → 이름만 보임 [사용자: 검수 2]']);
  // 머리 줄만 바꾸면 통과한다: [AI 가정] 항목은 AI가 알아서 고친다
  assert.equal(userLineDrift(spec.replace('기본은 선생님만', '기본은 담임만'), recorded), null);
  assert.equal(userLineDrift(spec.replace('— 기본은 선생님만 [AI 가정]', '— 기본은 담임만 — 이유가 바뀜 [AI 가정: 검수 5 맡김]'), recorded), null);
});

test('the user line kept under an [AI 가정] item is told apart by its order among the [사용자] lines of that item, so adding or changing the AI lines around it is not a change', () => {
  const spec = specText({ status: 'building', features: '- F3 결석 사유 보기 [AI 가정]\n  - 케이스: 교사가 봄 → 보임\n  - 케이스: 학생이 봄 → 안 보임 [사용자: 검수 2]\n  - 케이스: 학부모가 봄 → 안 보임 [사용자]\n' });
  const kept = userLinesOf(spec);
  assert.deepEqual(Object.keys(kept).filter((key) => key.includes('/')), ['F3/1', 'F3/2']);
  assert.deepEqual(kept['F3/1'], ['- 케이스: 학생이 봄 → 안 보임 [사용자: 검수 2]']);
  assert.deepEqual(kept['F3/2'], ['- 케이스: 학부모가 봄 → 안 보임 [사용자]']);
  const recorded = { user_lines: kept };
  for (const [label, edit] of Object.entries({
    '앞에 AI 케이스 줄을 더함': (t) => t.replace('  - 케이스: 교사가 봄 → 보임\n', '  - 케이스: 새 케이스 → 새 동작\n  - 케이스: 교사가 봄 → 보임\n'),
    'AI 케이스 줄을 바꿈': (t) => t.replace('교사가 봄 → 보임', '교사가 봄 → 이름만 보임'),
    'AI 케이스 줄을 뺌': (t) => t.replace('  - 케이스: 교사가 봄 → 보임\n', ''),
    '두 줄 사이에 AI 케이스 줄을 더함': (t) => t.replace('  - 케이스: 학부모가 봄', '  - 케이스: 관리자가 봄 → 보임\n  - 케이스: 학부모가 봄'),
    '머리 줄을 바꿈': (t) => t.replace('결석 사유 보기', '결석 사유 화면 보기'),
  })) {
    const now = edit(spec);
    assert.notEqual(now, spec, label);
    assert.equal(userLineDrift(now, recorded), null, label);
  }
  // [사용자] 줄 자체가 바뀌거나 빠지거나 더해지면 바뀐 것이다
  for (const [label, edit, expected] of [
    ['앞 [사용자] 줄의 글', (t) => t.replace('학생이 봄 → 안 보임', '학생이 봄 → 보임'), [{ id: 'F3/1', kind: 'changed' }]],
    ['뒤 [사용자] 줄의 글', (t) => t.replace('학부모가 봄 → 안 보임', '학부모가 봄 → 보임'), [{ id: 'F3/2', kind: 'changed' }]],
    ['번호 태그를 지움', (t) => t.replace('안 보임 [사용자: 검수 2]', '안 보임 [사용자]'), [{ id: 'F3/1', kind: 'changed' }]],
    ['[AI 가정]으로 바꿈', (t) => t.replace('학부모가 봄 → 안 보임 [사용자]', '학부모가 봄 → 안 보임 [AI 가정]'), [{ id: 'F3/2', kind: 'removed' }]],
    ['줄을 뺌', (t) => t.replace('  - 케이스: 학생이 봄 → 안 보임 [사용자: 검수 2]\n', ''), [{ id: 'F3/1', kind: 'changed' }, { id: 'F3/2', kind: 'removed' }]],
    ['[사용자] 줄을 더함', (t) => t.replace('  - 케이스: 교사가 봄 → 보임\n', '  - 케이스: 교사가 봄 → 보임 [사용자]\n'), [{ id: 'F3/1', kind: 'changed' }, { id: 'F3/2', kind: 'changed' }, { id: 'F3/3', kind: 'added' }]],
    ['머리 줄을 [사용자]로', (t) => t.replace('결석 사유 보기 [AI 가정]', '결석 사유 보기 [사용자]'), [{ id: 'F3', kind: 'added' }, { id: 'F3/1', kind: 'removed' }, { id: 'F3/2', kind: 'removed' }]],
  ]) {
    const now = edit(spec);
    assert.notEqual(now, spec, label);
    const drift = userLineDrift(now, recorded);
    assert.ok(drift?.changes, `${label}: 바뀐 것이다`);
    assert.deepEqual(drift.changes.map(({ id, kind }) => ({ id, kind })).sort((a, b) => a.id.localeCompare(b.id)), expected, label);
  }
});

test('whatever F5 counts as a [사용자: 검수 n] answer, F3 keeps: changing the line that carries the tag is a change, wherever the tag is (head line, case line, under an [AI 가정] item, folded, with a risk mark)', () => {
  const answers = [
    ['머리 줄', '- F1 보기 [사용자: 검수 1]\n', (t) => t.replace('F1 보기', 'F1 화면 보기')],
    ['[사용자] 항목의 케이스 줄', '- F1 보기 [사용자]\n  - 케이스: 가 → 나 [사용자: 검수 2]\n', (t) => t.replace('가 → 나', '가 → 다')],
    ['[AI 가정] 항목의 케이스 줄', '- F1 보기 [AI 가정]\n  - 케이스: 가 → 나 [사용자: 검수 3]\n', (t) => t.replace('가 → 나', '가 → 다')],
    ['한 태그에 번호 둘', '- F1 보기 [사용자: 검수 4, 5]\n', (t) => t.replace('F1 보기', 'F1 화면 보기')],
    ['위험 표시가 앞', '- F1 보기 [위험: 공개] [사용자: 검수 6]\n', (t) => t.replace('F1 보기', 'F1 화면 보기')],
    ['위험 표시가 뒤', '- F1 보기 [사용자: 검수 7] [위험: 공개]\n', (t) => t.replace('F1 보기', 'F1 화면 보기')],
    ['[AI 가정] 항목의 케이스 줄과 위험 표시', '- F1 보기 [AI 가정]\n  - 케이스: 가 → 나 [위험: 지우기] [사용자: 검수 8]\n', (t) => t.replace('가 → 나', '가 → 다')],
  ];
  for (const [label, features, edit] of answers) {
    const spec = specText({ status: 'building', features });
    const marks = reviewMarks(spec);
    assert.ok(marks.answered.size >= 1, `${label}: 짝으로 읽힌다`);
    const recorded = { user_lines: userLinesOf(spec) };
    // F5가 짝으로 센 번호마다 그 번호가 든 줄이 F3의 [사용자] 줄에 들어 있다
    for (const n of marks.answered) {
      const kept = Object.values(recorded.user_lines).flat();
      assert.ok(kept.some((line) => new RegExp(`\\[[^\\]]*사용자[^\\]]*검수[^\\]]*\\b${n}\\b`).test(line)), `${label}: 검수 ${n}이 든 줄을 F3가 담는다`);
    }
    const now = edit(spec);
    assert.notEqual(now, spec, label);
    assert.ok(userLineDrift(now, recorded)?.changes?.length, `${label}: 그 줄을 바꾸면 바뀐 것이다`);
  }
});

test('(a) describeChange names a changed, removed or added line under an [AI 가정] item as that item\'s [사용자] line, and shows it without the list marker', () => {
  const line = '- 케이스: 학생이 봄 → 안 보임 [사용자: 검수 2]';
  const next = '- 케이스: 학생이 봄 → 보임 [사용자: 검수 2]';
  assert.equal(describeChange({ id: 'F3/1', kind: 'changed', before: [line], after: [next] }), 'F3의 [사용자] 줄 바뀜("케이스: 학생이 봄 → 안 보임 [사용자: 검수 2]" → "케이스: 학생이 봄 → 보임 [사용자: 검수 2]")');
  assert.equal(describeChange({ id: 'F3/1', kind: 'removed', before: [line], after: [] }), 'F3의 [사용자] 줄 빠짐("케이스: 학생이 봄 → 안 보임 [사용자: 검수 2]")');
  assert.equal(describeChange({ id: 'F3#2/1', kind: 'added', before: [], after: [line] }), 'F3의 [사용자] 줄 더해짐("케이스: 학생이 봄 → 안 보임 [사용자: 검수 2]")');
  assert.equal(plainLines([line], { head: false }), '케이스: 학생이 봄 → 안 보임 [사용자: 검수 2]');
});

test('the full-width colon is the same problem for F5, F3 and the lint: no pair, no [사용자] line, an unknown tag', () => {
  const spec = specText({ status: 'building', features: '- F3 결석 사유 보기 [사용자： 검수 2]\n' });
  assert.deepEqual([...reviewMarks(spec).answered], []);
  assert.ok(!Object.keys(userLinesOf(spec)).some((key) => key.startsWith('F3')), 'F3 줄이 아니다');
  assert.ok(lintSpec(spec).includes('F3: 알 수 없는 태그 [사용자： 검수 2]'));
  const w = makeWorld({ specBody: spec });
  const lint = runSpec(w, ['lint', w.spec]);
  assert.equal(lint.status, 1);
  assert.match(lint.stdout, /F3: 알 수 없는 태그 \[사용자： 검수 2\]/);
});

// ---------- spec-checker 답에서 검수 번호 읽기 ----------

test('parseReviewReply reads the numbers at the start of a line in the 사용자만 답할 수 있음 section, in the forms an agent writes them', () => {
  const sections = (user) => `## 이미 답이 있음\n- 검수 9 — 이 칸의 번호는 읽지 않는다\n\n## 사소함 — AI가 정함\n- F2 [위험: 공개] 표시 빠짐 — 검수 8\n\n## 사용자만 답할 수 있음\n${user}\n\n질문 라운드는 이것 한 번뿐입니다.`;
  for (const [label, user] of [
    ['검수 n.', '검수 1. 출석을 몇 분 뒤에 닫을까요? (기본안: 10분) — 화면이 달라진다\n검수 2. 결석 사유를 학생도 보나요?'],
    ['- 검수 n:', '- 검수 1: 출석을 몇 분 뒤에 닫을까요?\n- 검수 2: 결석 사유를 학생도 보나요?'],
    ['1. 검수 n:', '1. 검수 1: 출석을 몇 분 뒤에 닫을까요?\n2. 검수 2: 결석 사유를 학생도 보나요?'],
    ['굵은 글씨', '**검수 1.** 출석을 몇 분 뒤에 닫을까요?\n**검수 2** 결석 사유를 학생도 보나요?'],
    ['들여쓴 줄', '  검수 1) 출석을 몇 분 뒤에 닫을까요?\n  검수 2) 결석 사유를 학생도 보나요?'],
    ['대괄호', '[검수 1] 출석을 몇 분 뒤에 닫을까요?\n(검수 2) 결석 사유를 학생도 보나요?'],
  ]) {
    const reply = parseReviewReply(sections(user));
    assert.equal(reply.found, true, label);
    assert.equal(reply.none, false, label);
    assert.deepEqual(reply.items.map((i) => i.n), [1, 2], label);
    assert.match(reply.items[0].text, /^출석을 몇 분 뒤에 닫을까요\?/, label);
  }
  // 칸이 끝나는 곳, 줄 가운데의 번호, 같은 번호
  assert.deepEqual(parseReviewReply('## 사용자만 답할 수 있음\n검수 1. 질문\n## 사소함 — AI가 정함\n검수 7. 다른 칸의 것').items.map((i) => i.n), [1]);
  assert.deepEqual(parseReviewReply('## 사용자만 답할 수 있음\n검수 1. 질문 (검수 2와 이어짐)').items.map((i) => i.n), [1]);
  assert.deepEqual(parseReviewReply('## 사용자만 답할 수 있음\n검수 1. 질문\n검수 1. 다시 쓴 질문').items.map((i) => i.n), [1]);
  assert.deepEqual(parseReviewReply('## 사용자만 답할 수 있음\n검수 10. 열 번째\n검수 2. 둘째').items.map((i) => i.n), [10, 2]);
  // 마지막 줄의 고정 문장은 칸 안에 있어도 항목이 아니다
  assert.deepEqual(parseReviewReply('## 사용자만 답할 수 있음\n검수 1. 질문\n\n질문 라운드는 이것 한 번뿐입니다.').items.map((i) => i.n), [1]);
});

test('parseReviewReply: "없음" in the forms an agent writes it, and replies it cannot read', () => {
  for (const message of [
    checkerReply(), '## 사용자만 답할 수 있음\n없음', '## 사용자만 답할 수 있음\n- 없음', '## 사용자만 답할 수 있음\n해당 없음.', '## 사용자만 답할 수 있음\n**없음**',
    '사용자만 답할 수 있음: 없음', '## 사용자만 답할 수 있음: 없음', '### 사용자만 답할 수 있음\n\n없음\n\n질문 라운드는 이것 한 번뿐입니다.',
  ]) {
    assert.deepEqual({ ...parseReviewReply(message), items: undefined }, { found: true, none: true, items: undefined }, message);
    assert.deepEqual(parseReviewReply(message).items, [], message);
    assert.equal(pairingProblem(specText(), { message }), null, message);
  }
  // 칸이 없다, 칸이 비었다, 번호 없이 번호 목록만 있다, 말만 있다
  for (const message of ['', undefined, '## 이미 답이 있음\n- 없음', '## 사용자만 답할 수 있음\n', '## 사용자만 답할 수 있음\n1. 질문 (기본안: …)\n2. 질문', '## 사용자만 답할 수 있음\n모두 명세에 이미 있다']) {
    const reply = parseReviewReply(message);
    assert.equal(reply.none, false, String(message));
    assert.deepEqual(reply.items, [], String(message));
    const problem = pairingProblem(specText(), { time: T(5), message });
    assert.ok(problem, `읽지 못한 답은 거절한다: ${message}`);
    assert.match(problem.reason, /읽지 못했다/);
    // 칸이 없는 것과 칸에서 번호를 못 읽은 것은 까닭이 다르게 나온다
    assert.match(problem.reason, parseReviewReply(message).found ? /칸에서 검수 번호\(검수 1, 검수 2 …\)도 '없음'도 읽지 못했다/ : /'사용자만 답할 수 있음' 칸이 없어 검수 번호를 읽지 못했다/, String(message));
    assert.match(problem.instead, /pact:spec-checker를 다시 불러/);
    assert.match(problem.instead, /검수 n/);
  }
  assert.equal(parseReviewReply('## 이미 답이 있음\n- 없음').found, false);
  assert.equal(parseReviewReply('## 사용자만 답할 수 있음\n').found, true);
});

test('parseReviewReply: a preface line that starts with the section name does not hide the real section; a # heading comes first, and a bare line counts only when a number or "없음" can be read from it', () => {
  const real = [
    '## 이미 답이 있음', '- 없음', '', '## 사소함 — AI가 정함', '- 없음', '', '## 사용자만 답할 수 있음',
    '검수 1. 출석을 몇 분 뒤에 닫을까요? (기본안: 10분) — 화면이 달라진다', '검수 2. 결석 사유를 학생도 볼 수 있나요? (기본안: 선생님만) — 화면이 달라진다', '', '질문 라운드는 이것 한 번뿐입니다.',
  ].join('\n');
  for (const preface of [
    '사용자만 답할 수 있음 2개를 찾았습니다.', '사용자만 답할 수 있음: 2개', '**사용자만 답할 수 있음**이 2개 있습니다.', '사용자만 답할 수 있음에 넣을 것은 둘입니다.',
    '## 사용자만 답할 수 있음 2개를 찾았습니다.', '사용자만 답할 수 있음', '사용자만 답할 수 있음 없는지 살폈습니다.'.replace('없는지 살폈습니다.', '항목이 둘 있습니다.'),
  ]) {
    const message = `${preface}\n\n${real}`;
    const reply = parseReviewReply(message);
    assert.equal(reply.found, true, preface);
    assert.equal(reply.none, false, preface);
    assert.deepEqual(reply.items.map((i) => i.n), [1, 2], `머리말 "${preface}"가 진짜 칸을 가리지 않는다`);
    assert.match(reply.items[0].text, /^출석을 몇 분 뒤에 닫을까요\?/, preface);
    // 승인 쪽에서도 '읽지 못했다'가 아니라 짝이 없는 번호를 알린다
    const problem = pairingProblem(specText(), { time: T(5), message });
    assert.match(problem.reason, /검수 1\(.*\), 검수 2\(.*\)에 명세의 짝이 없다/, preface);
  }
  // 머리말 뒤의 칸이 "없음"이고 머리말은 번호를 못 읽는 말이면 "없음"이다
  const none = '사용자만 답할 수 있음 한 건도 없는지 살폈습니다.\n\n## 이미 답이 있음\n- 없음\n\n## 사용자만 답할 수 있음\n없음\n\n질문 라운드는 이것 한 번뿐입니다.';
  assert.deepEqual({ ...parseReviewReply(none), items: undefined }, { found: true, none: true, items: undefined });
  assert.equal(pairingProblem(specText(), { message: none }), null);
  // # 제목이 없는 답: 맨 줄 꼴 가운데 읽히는 것을 고른다
  const bare = '사용자만 답할 수 있음 한 건도 없는지 살폈습니다.\n\n이미 답이 있음\n- 없음\n\n사용자만 답할 수 있음: 없음\n\n질문 라운드는 이것 한 번뿐입니다.';
  assert.equal(parseReviewReply(bare).none, true);
  const bareItems = '사용자만 답할 수 있음 2개를 찾았습니다.\n\n사용자만 답할 수 있음\n검수 1. 질문 하나\n검수 2. 질문 둘\n\n질문 라운드는 이것 한 번뿐입니다.';
  assert.deepEqual(parseReviewReply(bareItems).items.map((i) => i.n), [1, 2]);
  // # 제목이 있으면 그것이 먼저다: 앞의 맨 줄이 "없음"을 읽혀도 제목 칸의 번호를 따른다
  assert.deepEqual(parseReviewReply(`사용자만 답할 수 있음: 없음\n\n${real}`).items.map((i) => i.n), [1, 2]);
  // 어느 후보에서도 번호나 "없음"을 못 읽으면 읽지 못한 것이다(칸은 있다)
  const unreadable = '사용자만 답할 수 있음 2개를 찾았습니다.\n\n## 사용자만 답할 수 있음\n질문이 둘 있습니다.\n\n질문 라운드는 이것 한 번뿐입니다.';
  const reply = parseReviewReply(unreadable);
  assert.deepEqual({ ...reply, items: reply.items.length }, { found: true, none: false, items: 0 });
  assert.match(pairingProblem(specText(), { message: unreadable }).reason, /칸에서 검수 번호\(검수 1, 검수 2 …\)도 '없음'도 읽지 못했다/);
});

test('pairingProblem lists every number without a pair, with its question, and says the three ways to give it one', () => {
  const none = pairingProblem(specText(), { time: T(5), message: TWO });
  assert.match(none.reason, /검수 1\("출석을 몇 분 뒤에 닫을까요\?"\), 검수 2\("결석 사유를 학생도 볼 수 있나요\?"\)에 명세의 짝이 없다/);
  assert.match(none.instead, /\[사용자: 검수 n\]/);
  assert.match(none.instead, /\[AI 가정: 검수 n 맡김\]/);
  assert.match(none.instead, /기능·규칙 줄이나 그 케이스 줄의 끝에 달고/, '달 곳을 알린다');
  assert.match(none.instead, /## 확인 필요에 "- 검수 n: 안 물은 까닭"/);
  assert.match(none.instead, /위임이라 기본안으로 정함/);
  assert.doesNotMatch(refusalLine(none), /\n/, '한 줄이다');
  const one = pairingProblem(specText({ features: '- F2 닫는 시간 [사용자: 검수 1]\n' }), { time: T(5), message: TWO });
  assert.match(one.reason, /검수 2\(/);
  assert.doesNotMatch(one.reason, /검수 1/);
  assert.equal(pairingProblem(specText({ features: '- F2 닫는 시간 [사용자: 검수 1]\n', rules: '- R2 사유 [AI 가정: 검수 2 맡김]\n' }), { time: T(5), message: TWO }), null);
  assert.equal(pairingProblem(specText({ confirm: '- 검수 1: 묻지 않았다\n- 검수 2: 묻지 않았다\n' }), { time: T(5), message: TWO }), null);
  assert.equal(questionOf('출석을 닫을까요? (기본안: 10분) — 달라진다'), '출석을 닫을까요?');
  assert.equal(questionOf('질문만'), '질문만');
  // 질문이 길면 앞부분만 보인다
  const long = pairingProblem(specText(), { message: checkerReply(['가'.repeat(80)]) });
  assert.ok(long.reason.includes(`검수 1("${'가'.repeat(30)}…")`), long.reason);
});

// ---------- (a) 승인·위임이 짝 빠진 번호를 알리고 거절한다 ----------

const SAY = { approve: '승인', delegate: '끝까지 알아서 해' };
// 번호 1·2를 짚은 spec-checker 답이 있는 판에서 kind를 시도한다
function attempt(kind, options = {}, message = TWO) {
  const w = makeWorld(options);
  addCheckerRecord(w, T(5), { message });
  writeTranscript(w, [typed(SAY[kind], kind === 'approve' ? T(10) : T(1))]);
  return { w, r: runSpec(w, [kind, w.spec, SAY[kind]]) };
}
const PAIR_1 = { features: '- F2 출석은 시작 10분 뒤에 닫는다 [사용자: 검수 1]\n' };

test('(a) approve and delegate refuse and name 검수 2 when only 검수 1 has a pair; nothing is written and the status stays draft', () => {
  for (const kind of ['approve', 'delegate']) {
    const { w, r } = attempt(kind, PAIR_1);
    const before = specText({ ...PAIR_1 });
    const line = assertRefused(r, /검수 2\("결석 사유를 학생도 볼 수 있나요\?"\)에 명세의 짝이 없다/, kind);
    assert.doesNotMatch(line, /검수 1/, `${kind}: 짝이 있는 번호는 알리지 않는다`);
    assert.match(line, /\[사용자: 검수 n\]/);
    assert.equal(specStatus(w), 'draft', kind);
    assert.equal(readFileSync(w.spec, 'utf8'), before, `${kind}: 명세는 그대로다`);
    assert.deepEqual(approvalEntries(w), [], `${kind}: 기록이 생기지 않는다`);
  }
});

test('(a) each of the three pairs for 검수 2 lets approve and delegate through, and the record then carries the [사용자] lines', () => {
  const pairs = {
    '[AI 가정: 검수 2 맡김]': { ...PAIR_1, rules: '- R2 결석 사유는 선생님만 본다 — 사용자가 맡겼다 [AI 가정: 검수 2 맡김]\n' },
    '[사용자: 검수 2]': { features: `${PAIR_1.features}- F3 결석 사유는 학생도 본다 [사용자: 검수 2]\n` },
    '## 확인 필요의 - 검수 2': { ...PAIR_1, confirm: '- 검수 2: 사용자가 바쁘다고 해서 묻지 않았다\n' },
    '위임이라 기본안으로 정함': { ...PAIR_1, confirm: '- 검수 2: 위임이라 기본안으로 정함\n' },
    '한 태그에 번호 둘': { features: '- F2 닫는 시간과 사유 공개 [사용자: 검수 1, 2]\n' },
    '케이스 줄의 태그': { features: `${PAIR_1.features}- F3 결석 사유 보기 [사용자]\n  - 케이스: 학생이 봄 → 이름만 보임 [사용자: 검수 2]\n` },
    '[AI 가정] 항목의 케이스 줄의 태그': { features: `${PAIR_1.features}${AI_CASE}` },
  };
  for (const kind of ['approve', 'delegate']) {
    for (const [label, options] of Object.entries(pairs)) {
      const { w, r } = attempt(kind, options);
      assert.equal(r.status, 0, `${kind} / ${label}: ${r.stderr}`);
      assert.equal(specStatus(w), 'approved', `${kind} / ${label}`);
      const [entry] = approvalEntries(w);
      assert.equal(entry.kind, kind);
      assert.deepEqual(entry.user_lines, userLinesOf(readFileSync(w.spec, 'utf8')), `${kind} / ${label}: 기록에 그때의 [사용자] 줄이 든다`);
      assert.ok('F1' in entry.user_lines, 'F1은 [사용자] 줄이다');
    }
  }
});

test('(a) a pair that only looks like one is not one: no 맡김, a bare "- 검수 2:", the wrong number, an example in backticks, the decision log', () => {
  const lookalikes = {
    '맡김이 없는 [AI 가정: 검수 2]': { ...PAIR_1, rules: '- R2 사유 공개 여부 — AI가 정했다 [AI 가정: 검수 2]\n' },
    '까닭이 빈 - 검수 2:': { ...PAIR_1, confirm: '- 검수 2:\n' },
    '콜론 없는 - 검수 2 묻지 않음': { ...PAIR_1, confirm: '- 검수 2 묻지 않음\n' },
    '번호가 다른 [사용자: 검수 20]': { ...PAIR_1, rules: '- R2 열 번째 질문 [사용자: 검수 20]\n' },
    '번호가 다른 [사용자: 검수 12]': { ...PAIR_1, rules: '- R2 사유 [사용자: 검수 12]\n' },
    '백틱 안의 예시': { ...PAIR_1, rules: '- R2 태그는 `[사용자: 검수 2]`처럼 단다 [AI 가정]\n' },
    '결정 기록의 태그': { ...PAIR_1, log: '- Ruling: 사유 공개 여부는 선생님만 — 이유 — 잃는 것 [사용자: 검수 2]\n' },
  };
  for (const [label, options] of Object.entries(lookalikes)) {
    for (const kind of ['approve', 'delegate']) {
      const { w, r } = attempt(kind, options);
      assertRefused(r, /검수 2/, `${kind} / ${label}`);
      assert.deepEqual(approvalEntries(w), [], `${kind} / ${label}`);
    }
  }
});

test('(a) after the refusal the spec gets its pair and the very same words are accepted: nothing about the quote was spent', () => {
  const { w, r } = attempt('approve', PAIR_1);
  assertRefused(r, /검수 2/);
  writeFileSync(w.spec, specText({ ...PAIR_1, confirm: '- 검수 2: 사용자에게 묻지 못했다\n' }));
  const again = runSpec(w, ['approve', w.spec, '승인']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(approvalEntries(w).length, 1);
  assert.equal(specStatus(w), 'approved');
});

test('(a) approve takes a [사용자: 검수 n] on the case line of an [AI 가정] item as the pair, and the record keeps that line, so a change to it after the approval stops the worker and snapshot', () => {
  const w = makeWorld({ features: `${PAIR_1.features}${AI_CASE}` });
  addCheckerRecord(w, T(5), { message: TWO });
  writeTranscript(w, [typed('승인', T(10))]);
  const r = runSpec(w, ['approve', w.spec, '승인']);
  assert.equal(r.status, 0, r.stderr);
  const [entry] = approvalEntries(w);
  assert.deepEqual(entry.user_lines['F3/1'], ['- 케이스: 학생이 봄 → 안 보임 [사용자: 검수 2]']);
  assert.ok(!('F3' in entry.user_lines), '[AI 가정] 머리 줄은 담지 않는다');
  for (const purpose of ['worker', 'snapshot']) assert.equal(checkStart({ specFile: w.spec, purpose }).ok, true, `${purpose}: 그대로면 통과`);
  // 머리 줄만 고친 것은 통과한다
  const head = readFileSync(w.spec, 'utf8');
  writeFileSync(w.spec, head.replace('기본은 선생님만', '기본은 담임만'));
  for (const purpose of ['worker', 'snapshot']) assert.equal(checkStart({ specFile: w.spec, purpose }).ok, true, `${purpose}: 머리 줄만 바뀜`);
  // 사용자가 답한 케이스 줄을 바꾸면 막힌다
  writeFileSync(w.spec, head.replace('→ 안 보임', '→ 이름만 보임'));
  for (const purpose of ['worker', 'snapshot']) {
    const verdict = checkStart({ specFile: w.spec, purpose });
    assert.equal(verdict.ok, false, purpose);
    assert.match(verdict.reason, /F3의 \[사용자\] 줄 바뀜\("케이스: 학생이 봄 → 안 보임 \[사용자: 검수 2\]" → "케이스: 학생이 봄 → 이름만 보임 \[사용자: 검수 2\]"\)/, purpose);
    assert.match(verdict.instead, /바꿔 달라고 한 사용자 말을 인용해 spec\.mjs approve/);
  }
  // 새 인용으로 다시 승인하면 이어 간다
  writeTranscript(w, [typed('승인', T(10)), typed('학생에게는 이름만 보이게 바꿔 주세요', T(20))]);
  assert.equal(runSpec(w, ['approve', w.spec, '학생에게는 이름만 보이게 바꿔 주세요']).status, 0);
  assert.deepEqual(approvalEntries(w)[1].user_lines['F3/1'], ['- 케이스: 학생이 봄 → 이름만 보임 [사용자: 검수 2]']);
  assert.equal(checkStart({ specFile: w.spec, purpose: 'worker' }).ok, true);
});

test('(a) a tag that is not a pair is refused by approve and delegate: in the purpose or scope section, in the middle of a line, with a full-width colon (the refusal says which)', () => {
  const lookalikes = {
    '목적 칸의 태그': { specBody: specText({ ...PAIR_1 }).replace('교수자가 출석을 빨리 확인한다.', '교수자가 출석을 빨리 확인한다. [사용자: 검수 2]') },
    '범위 칸의 태그': { specBody: specText({ ...PAIR_1 }).replace('웹 화면 하나.', '웹 화면 하나. [AI 가정: 검수 2 맡김]') },
    '줄 가운데의 [사용자: 검수 2]': { ...PAIR_1, rules: '- R2 결석 사유 [사용자: 검수 2] 공개 여부 — 이유 [AI 가정]\n' },
    '줄 가운데의 [AI 가정: 검수 2 맡김]': { ...PAIR_1, rules: '- R2 결석 사유 [AI 가정: 검수 2 맡김] 공개 여부 [AI 가정]\n' },
    '전각 콜론의 [사용자： 검수 2]': { ...PAIR_1, rules: '- R2 결석 사유 공개 여부 [사용자： 검수 2]\n' },
    '전각 콜론의 [AI 가정： 검수 2 맡김]': { ...PAIR_1, rules: '- R2 결석 사유 공개 여부 [AI 가정： 검수 2 맡김]\n' },
  };
  for (const [label, options] of Object.entries(lookalikes)) {
    for (const kind of ['approve', 'delegate']) {
      const { w, r } = attempt(kind, options);
      const line = assertRefused(r, /검수 2\("결석 사유를 학생도 볼 수 있나요\?"\)에 명세의 짝이 없다/, `${kind} / ${label}`);
      assert.deepEqual(approvalEntries(w), [], `${kind} / ${label}`);
      if (label.startsWith('전각')) assert.match(line, /^.*검수 2의 태그는 콜론이 전각\(：\)이라 읽히지 않는다\. 반각 콜론\(:\)으로 고친다\. 물어서 답을 받은 줄에는/, label);
      else assert.doesNotMatch(line, /전각/, label);
    }
  }
  // 반각 콜론으로 고치면 통과한다
  const fixed = attempt('approve', { ...PAIR_1, rules: '- R2 결석 사유 공개 여부 [사용자: 검수 2]\n' });
  assert.equal(fixed.r.status, 0, fixed.r.stderr);
});

// ---------- (b) '없음'이면 통과, 읽지 못하면 거절 ----------

test('(b) a reply with "사용자만 답할 수 있음: 없음" passes approve and delegate, in every form of "없음"', () => {
  for (const message of [
    checkerReply(), '## 사용자만 답할 수 있음\n- 없음', '사용자만 답할 수 있음: 없음', '## 사용자만 답할 수 있음\n해당 없음',
    `## 사소함 — AI가 정함\n- 검수 5. 이 칸의 번호는 읽지 않는다\n\n## 사용자만 답할 수 있음\n없음\n\n질문 라운드는 이것 한 번뿐입니다.`,
  ]) {
    for (const kind of ['approve', 'delegate']) {
      const { w, r } = attempt(kind, {}, message);
      assert.equal(r.status, 0, `${kind}: ${message}: ${r.stderr}`);
      assert.equal(specStatus(w), 'approved');
    }
  }
});

test('(b) a reply with no 사용자만 답할 수 있음 section, an empty one or numbers without 검수 is refused: it cannot be checked, so the checker is asked again', () => {
  for (const message of ['', '## 이미 답이 있음\n- 없음\n\n질문 라운드는 이것 한 번뿐입니다.', '## 사용자만 답할 수 있음\n1. 질문 하나 (기본안: …)\n2. 질문 둘', '## 사용자만 답할 수 있음\n']) {
    for (const kind of ['approve', 'delegate']) {
      const { w, r } = attempt(kind, {}, message);
      const line = assertRefused(r, /읽지 못했다/, `${kind}: ${message}`);
      assert.match(line, /pact:spec-checker를 다시 불러/);
      assert.match(line, kind === 'approve' ? /승인은 그 검수가 끝난 뒤에 다시 받는다\.$/ : /그다음 delegate를 다시 실행한다\.$/);
      assert.equal(specStatus(w), 'draft');
      assert.deepEqual(approvalEntries(w), []);
    }
  }
});

test('(b) only the latest spec-checker record counts, and a delegation with no spec-checker record is still recorded', () => {
  // 앞 기록은 번호가 있고 가장 최근 기록은 없음 → 통과
  const w = makeWorld();
  addCheckerRecord(w, T(2), { message: TWO });
  addCheckerRecord(w, T(5), { message: checkerReply() });
  writeTranscript(w, [typed('승인', T(10))]);
  assert.equal(runSpec(w, ['approve', w.spec, '승인']).status, 0);
  // 앞 기록은 없음이고 가장 최근 기록에 번호가 있다 → 거절
  const v = makeWorld();
  addCheckerRecord(v, T(2), { message: checkerReply() });
  addCheckerRecord(v, T(5), { message: TWO });
  writeTranscript(v, [typed('승인', T(10))]);
  assertRefused(runSpec(v, ['approve', v.spec, '승인']), /검수 1.*검수 2/);
  // 위임은 spec-checker 기록이 아직 없어도 기록된다(완료 검사가 기록을 요구한다)
  const d = makeWorld();
  writeTranscript(d, [typed('끝까지 알아서 해', T(1))]);
  assert.equal(runSpec(d, ['delegate', d.spec, '끝까지 알아서 해']).status, 0);
  assert.equal(approvalEntries(d)[0].kind, 'delegate');
});

// ---------- F3: [사용자] 줄의 지문이 승인 기록에 든다 ----------

const USER_SPEC = (extra = {}) => specText({
  status: 'building',
  features: '- F2 출석은 시작 10분 뒤에 닫는다 [사용자]\n  - 케이스: 10분이 지남 → 닫힘 표시\n- F3 화면 문구는 한국어 — 한국어 사용자라서 [AI 가정]\n',
  rules: '- R2 결석 사유는 선생님만 본다 [사용자]\n',
  ...extra,
});

test('F3: the record keeps the [사용자] lines as they were when the words were quoted: the lines, their cases, and nothing from [AI 가정] lines', () => {
  for (const kind of ['approve', 'delegate']) {
    const w = makeWorld({ specBody: USER_SPEC() });
    grantApproval(w, { kind });
    const [entry] = approvalEntries(w);
    assert.deepEqual(entry.user_lines, {
      F1: ['- F1 오늘 수업 출석 현황 보기 [사용자]', '- 케이스: 수업 0건 → 빈 상태 문구'],
      F2: ['- F2 출석은 시작 10분 뒤에 닫는다 [사용자]', '- 케이스: 10분이 지남 → 닫힘 표시'],
      R2: ['- R2 결석 사유는 선생님만 본다 [사용자]'],
    }, kind);
  }
});

// ---------- F3: 바뀐 줄을 가려낸다 ----------

const lines = (text) => userLinesOf(text);
const BASE = USER_SPEC();
// 승인한 뒤 명세를 이렇게 고쳤다 → 바뀐 줄 목록
const EDITS = {
  글: [(t) => t.replace('출석은 시작 10분 뒤에 닫는다', '출석은 시작 15분 뒤에 닫는다'), [{ id: 'F2', kind: 'changed' }]],
  '케이스 줄': [(t) => t.replace('10분이 지남 → 닫힘 표시', '10분이 지남 → 닫히고 알림'), [{ id: 'F2', kind: 'changed' }]],
  '케이스 줄 더하기': [(t) => t.replace('  - 케이스: 10분이 지남 → 닫힘 표시\n', '  - 케이스: 10분이 지남 → 닫힘 표시\n  - 케이스: 수업이 없음 → 닫지 않음\n'), [{ id: 'F2', kind: 'changed' }]],
  '케이스 줄 빼기': [(t) => t.replace('  - 케이스: 10분이 지남 → 닫힘 표시\n', ''), [{ id: 'F2', kind: 'changed' }]],
  '태그에 번호를 붙임': [(t) => t.replace('시작 10분 뒤에 닫는다 [사용자]', '시작 10분 뒤에 닫는다 [사용자: 검수 1]'), [{ id: 'F2', kind: 'changed' }]],
  '위험 표시 더하기': [(t) => t.replace('결석 사유는 선생님만 본다 [사용자]', '결석 사유는 선생님만 본다 [위험: 공개] [사용자]'), [{ id: 'R2', kind: 'changed' }]],
  '[AI 가정]으로 태그 바꾸기': [(t) => t.replace('결석 사유는 선생님만 본다 [사용자]', '결석 사유는 선생님만 본다 [AI 가정]'), [{ id: 'R2', kind: 'retagged' }]],
  '태그 없애기': [(t) => t.replace('결석 사유는 선생님만 본다 [사용자]', '결석 사유는 선생님만 본다'), [{ id: 'R2', kind: 'retagged' }]],
  '줄 빼기': [(t) => t.replace('- R2 결석 사유는 선생님만 본다 [사용자]\n', ''), [{ id: 'R2', kind: 'removed' }]],
  '[사용자] 줄 더하기': [(t) => t.replace('## 공통 규칙\n', '## 공통 규칙\n- R9 새 규칙 [사용자]\n'), [{ id: 'R9', kind: 'added' }]],
  '[AI 가정] 줄을 [사용자]로': [(t) => t.replace('화면 문구는 한국어 — 한국어 사용자라서 [AI 가정]', '화면 문구는 한국어 — 한국어 사용자라서 [사용자]'), [{ id: 'F3', kind: 'added' }]],
  '둘 이상': [(t) => t.replace('시작 10분', '시작 20분').replace('- R2 결석 사유는 선생님만 본다 [사용자]\n', ''), [{ id: 'F2', kind: 'changed' }, { id: 'R2', kind: 'removed' }]],
};

test('F3: userLineDrift tells a changed line from a removed, retagged or added one, for the text, the cases, the tag, the risk mark, and the [사용자] set', () => {
  const recorded = { user_lines: lines(BASE) };
  assert.equal(userLineDrift(BASE, recorded), null, '그대로면 null');
  for (const [label, [edit, expected]] of Object.entries(EDITS)) {
    const now = edit(BASE);
    assert.notEqual(now, BASE, `${label}: 시험 데이터가 실제로 바뀐다`);
    const drift = userLineDrift(now, recorded);
    assert.ok(drift?.changes, `${label}: 바뀐 것으로 본다`);
    assert.deepEqual(drift.changes.map(({ id, kind }) => ({ id, kind })), expected, label);
  }
  const retagged = userLineDrift(EDITS['[AI 가정]으로 태그 바꾸기'][0](BASE), recorded).changes[0];
  assert.equal(retagged.tag, 'AI 가정');
  assert.deepEqual(retagged.before, ['- R2 결석 사유는 선생님만 본다 [사용자]']);
  assert.equal(userLineDrift(EDITS['태그 없애기'][0](BASE), recorded).changes[0].tag, null);
});

test('F3: what is not a change: spacing and indentation, status, the decision log, other sections, and anything on an [AI 가정] line', () => {
  const recorded = { user_lines: lines(BASE) };
  for (const [label, edit] of Object.entries({
    '공백과 들여쓰기': (t) => t.replace('- F2 출석은', '-   F2  출석은 ').replace('  - 케이스: 10분이 지남', '      -  케이스:  10분이 지남'),
    '줄 끝 공백과 CRLF': (t) => t.replaceAll('\n', '  \r\n'),
    status: (t) => t.replace('status: building', 'status: verifying'),
    '결정 기록': (t) => `${t}- Ruling: 새로 정했다 — 이유 — 잃는 것\n`,
    '목적·범위': (t) => t.replace('교수자가 출석을 빨리 확인한다.', '교수자가 출석을 아주 빨리 확인한다.').replace('웹 화면 하나.', '웹 화면 둘.'),
    '확인 필요': (t) => t.replace('## 확인 필요\n', '## 확인 필요\n- 검수 1: 묻지 않았다\n'),
    '[AI 가정] 줄의 글': (t) => t.replace('화면 문구는 한국어 — 한국어 사용자라서', '화면 문구는 영어 — 해외 사용자라서'),
    '[AI 가정] 줄 더하기': (t) => t.replace('## 공통 규칙\n', '## 공통 규칙\n- R8 AI가 더한 규칙 — 이유 [AI 가정]\n'),
    '[AI 가정] 줄 빼기': (t) => t.replace('- F3 화면 문구는 한국어 — 한국어 사용자라서 [AI 가정]\n', ''),
    '[AI 가정] 줄의 번호 태그': (t) => t.replace('한국어 사용자라서 [AI 가정]', '한국어 사용자라서 [AI 가정: 검수 1 맡김]'),
    '접힌 칸의 [AI 가정]': (t) => t.replace('## 구조 판정', '<details><summary>그 밖의 AI 가정 1개</summary>\n\n- R7 접힌 규칙 — 이유 [AI 가정]\n\n</details>\n\n## 구조 판정'),
  })) {
    const now = edit(BASE);
    assert.notEqual(now, BASE, `${label}: 시험 데이터가 실제로 바뀐다`);
    assert.equal(userLineDrift(now, recorded), null, label);
  }
});

test('F3: a record with no usable [사용자] lines cannot be compared, which is its own problem and not "nothing changed"', () => {
  for (const user_lines of [undefined, null, [], 'F1', { F1: 'text' }, { F1: [1] }]) {
    assert.deepEqual(userLineDrift(BASE, { user_lines }), { unknown: true }, JSON.stringify(user_lines));
    const problem = driftProblem(BASE, { kind: 'approve', user_lines });
    assert.match(problem.reason, /가장 최근 승인 기록에 \[사용자\] 줄이 없어/);
    assert.match(problem.instead, /spec\.mjs approve <명세> - <<'EOF'/);
  }
  assert.deepEqual(userLineDrift(BASE, { user_lines: {} }).changes.map((c) => c.kind), ['added', 'added', 'added'], '빈 지문은 지금 [사용자] 줄이 모두 더해진 것이다');
  assert.equal(userLineDrift('', { user_lines: {} }), null);
});

test('F3: diffUserLines and describeChange, with the line shown without its list marker and id', () => {
  assert.deepEqual(diffUserLines({ F1: ['- F1 가'], F2: ['- F2 나'] }, { F1: ['- F1 가'], F3: ['- F3 다'] }), [
    { id: 'F2', kind: 'removed', before: ['- F2 나'], after: [] },
    { id: 'F3', kind: 'added', before: [], after: ['- F3 다'] },
  ]);
  assert.equal(plainLines(['- F2 출석은 닫는다 [사용자]', '- 케이스: 지남 → 닫힘']), '출석은 닫는다 [사용자] / 케이스: 지남 → 닫힘');
  assert.equal(describeChange({ id: 'F2', kind: 'changed', before: ['- F2 가 [사용자]'], after: ['- F2 나 [사용자]'] }), 'F2 바뀜("가 [사용자]" → "나 [사용자]")');
  // 케이스만 바뀐 것은 바뀐 케이스 줄을 보인다. 케이스 줄이 더해지거나 빠진 것도 알린다
  assert.equal(describeChange({ id: 'F2', kind: 'changed', before: ['- F2 가 [사용자]', '- 케이스: 가 → 나'], after: ['- F2 가 [사용자]', '- 케이스: 가 → 다'] }), 'F2 바뀜("케이스: 가 → 나" → "케이스: 가 → 다")');
  assert.equal(describeChange({ id: 'F2', kind: 'changed', before: ['- F2 가 [사용자]'], after: ['- F2 가 [사용자]', '- 케이스: 없음 → 빈 화면'] }), 'F2 바뀜(줄이 더해짐 "케이스: 없음 → 빈 화면")');
  assert.equal(describeChange({ id: 'F2', kind: 'changed', before: ['- F2 가 [사용자]', '- 케이스: 없음 → 빈 화면'], after: ['- F2 가 [사용자]'] }), 'F2 바뀜(줄이 빠짐 "케이스: 없음 → 빈 화면")');
  assert.equal(describeChange({ id: 'F2', kind: 'removed', before: ['- F2 가'], after: [] }), 'F2 빠짐');
  assert.equal(describeChange({ id: 'F2', kind: 'added', before: [], after: ['- F2 나 [사용자]', '- 케이스: 없음 → 빈 화면'] }), 'F2 더해짐("나 [사용자] / 케이스: 없음 → 빈 화면")');
  assert.equal(describeChange({ id: 'F2', kind: 'retagged', tag: 'AI 가정', before: [], after: [] }), 'F2 태그가 바뀜([AI 가정])');
  assert.equal(describeChange({ id: 'F2', kind: 'retagged', tag: null, before: [], after: [] }), 'F2 태그가 바뀜(태그 없음)');
});

// ---------- F3: pact:worker 부르기와 snapshot이 쓰는 관문 ----------

test('(d) checkStart for the worker and for snapshot refuses a changed [사용자] line, names it, and says to quote the person and approve again; the other purposes do not look', () => {
  const w = makeWorld({ specBody: USER_SPEC() });
  grantApproval(w);
  for (const purpose of ['worker', 'snapshot']) assert.equal(checkStart({ specFile: w.spec, purpose }).ok, true, `${purpose}: 그대로면 통과`);
  for (const [label, [edit, expected]] of Object.entries(EDITS)) {
    writeFileSync(w.spec, edit(BASE));
    for (const purpose of ['worker', 'snapshot']) {
      const verdict = checkStart({ specFile: w.spec, purpose });
      assert.equal(verdict.ok, false, `${label} / ${purpose}`);
      assert.match(verdict.reason, /^승인 뒤 \[사용자\] 줄이 바뀌었다\(가장 최근 승인 기록 \d{4}-\d\d-\d\dT[\d:.]+Z\): /, label);
      for (const { id } of expected) assert.ok(verdict.reason.includes(`${id} `), `${label}: ${id}를 알린다: ${verdict.reason}`);
      assert.match(verdict.instead, /바꿔 달라고 한 사용자 말을 인용해 spec\.mjs approve <명세> - <<'EOF'로 다시 기록한다/);
      assert.match(verdict.instead, /사용자가 파일을 직접 고쳤으면 한 번 묻고 그 답을 인용한다/);
      assert.doesNotMatch(refusalLine(verdict), /\n|"<사용자 말>"/);
    }
    // 시작이 아닌 목적은 바뀐 줄을 보지 않는다(set-status building, 완료 검사의 시작 확인)
    for (const purpose of ['approved', 'building', 'finish']) assert.equal(checkStart({ specFile: w.spec, purpose }).ok, true, `${label} / ${purpose}`);
  }
  // 줄이 바뀐 말은 글자까지 보인다
  writeFileSync(w.spec, EDITS.글[0](BASE));
  assert.match(checkStart({ specFile: w.spec, purpose: 'worker' }).reason, /F2 바뀜\("출석은 시작 10분 뒤에 닫는다 \[사용자\]" → "출석은 시작 15분 뒤에 닫는다 \[사용자\]"\)/);
  writeFileSync(w.spec, EDITS['[AI 가정]으로 태그 바꾸기'][0](BASE));
  assert.match(checkStart({ specFile: w.spec, purpose: 'worker' }).reason, /R2 태그가 바뀜\(\[AI 가정\]\)/);
  writeFileSync(w.spec, EDITS['둘 이상'][0](BASE));
  assert.match(checkStart({ specFile: w.spec, purpose: 'worker' }).reason, /F2 바뀜\(.*\), R2 빠짐\./);
});

test('(d) many changed lines are named four at a time and counted: the one line stays one line', () => {
  const many = Array.from({ length: 7 }, (_, i) => `- F${i + 2} 기능 ${i} [사용자]\n`).join('');
  const w = makeWorld({ specBody: specText({ status: 'building', features: many }) });
  grantApproval(w);
  writeFileSync(w.spec, specText({ status: 'building', features: many.replaceAll('기능', '바뀐 기능') }));
  const verdict = checkStart({ specFile: w.spec, purpose: 'worker' });
  assert.match(verdict.reason, /F2 바뀜.*F3 바뀜.*F4 바뀜.*F5 바뀜.* 외 3개\./);
  assert.doesNotMatch(refusalLine(verdict), /\n/);
});

test('(d) the project-and-run-id form (the hook) judges the same, and a spec it cannot find is refused rather than passed', () => {
  const w = makeWorld({ specBody: USER_SPEC() });
  grantApproval(w);
  assert.equal(checkStart({ project: w.project, runId: w.id, purpose: 'worker' }).ok, true);
  writeFileSync(w.spec, EDITS.글[0](BASE));
  assert.match(checkStart({ project: w.project, runId: w.id, purpose: 'worker' }).reason, /F2 바뀜/);
  rmSync(w.spec);
  const lost = checkStart({ project: w.project, runId: w.id, purpose: 'worker' });
  assert.equal(lost.ok, false);
  assert.match(lost.reason, /승인 뒤 \[사용자\] 줄이 바뀌었는지 확인하려는데 명세를 찾지 못했다/);
});

test('(e) only [AI 가정] lines changed: the worker and snapshot gates pass, and so does approving once more', () => {
  const w = makeWorld({ specBody: USER_SPEC() });
  grantApproval(w);
  for (const edit of [
    (t) => t.replace('화면 문구는 한국어 — 한국어 사용자라서', '화면 문구는 영어 — 해외 사용자라서'),
    (t) => t.replace('## 공통 규칙\n', '## 공통 규칙\n- R8 AI가 더한 규칙 — 이유 [AI 가정]\n'),
  ]) {
    writeFileSync(w.spec, edit(BASE));
    for (const purpose of ['worker', 'snapshot']) assert.deepEqual(checkStart({ specFile: w.spec, purpose }).ok, true, purpose);
  }
});

test('(f) an old spec (pact: 1, no record) skips the check even though it has [사용자] lines that no record covers', () => {
  const w = makeWorld({ pact: 1, status: 'building' });
  for (const purpose of ['worker', 'snapshot']) assert.deepEqual(checkStart({ specFile: w.spec, purpose }), { ok: true, mode: 'legacy', note: '참고: 옛 판이라 승인 기록 없음' });
  writeFileSync(w.spec, specText({ pact: 1, status: 'building', features: '- F2 새로 더한 줄 [사용자]\n' }));
  assert.equal(checkStart({ project: w.project, runId: w.id, purpose: 'worker' }).mode, 'legacy');
});

// ---------- F3: 다시 승인하기 ----------

test('(d) after a [사용자] line changed, approving with a newer quote passes; the same or an older message is refused', () => {
  const w = makeWorld({ specBody: USER_SPEC() });
  grantApproval(w, { text: '승인', time: T(10) });
  writeFileSync(w.spec, EDITS.글[0](BASE));
  assert.equal(checkStart({ specFile: w.spec, purpose: 'worker' }).ok, false);
  const asked = typed('출석은 15분 뒤에 닫는 걸로 바꿔 줘', T(20));
  const older = typed('아까 한 말이지만 15분 뒤에 닫아 주세요', T(7));
  writeTranscript(w, [typed('승인', T(10)), older, asked]);
  // 같은 말, 옛 말
  assertRefused(runSpec(w, ['approve', w.spec, '승인']), /앞 승인 기록에 쓴 메시지/, '같은 메시지');
  assertRefused(runSpec(w, ['approve', w.spec, '아까 한 말이지만 15분 뒤에 닫아 주세요']), /앞 승인 기록에 쓴 메시지/, '옛 메시지');
  assert.equal(approvalEntries(w).length, 1);
  assert.equal(checkStart({ specFile: w.spec, purpose: 'worker' }).ok, false, '거절한 뒤에도 바뀐 줄은 아직 승인되지 않았다');
  // 바꿔 달라고 한 새 말
  const again = runSpec(w, ['approve', w.spec, '출석은 15분 뒤에 닫는 걸로 바꿔 줘']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /status는 building 그대로/);
  assert.equal(specStatus(w), 'building');
  const entries = approvalEntries(w);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].message_uuid, asked.uuid);
  assert.deepEqual(entries[1].user_lines, lines(EDITS.글[0](BASE)), '새 기록이 새 줄을 덮는다');
  assert.deepEqual(entries[0].user_lines, lines(BASE), '앞 기록은 그대로 남는다');
  for (const purpose of ['worker', 'snapshot']) assert.equal(checkStart({ specFile: w.spec, purpose }).ok, true, `${purpose}: 다시 승인한 뒤에는 통과`);
  // 한 번 더 바뀌면 또 새 말이 있어야 한다
  writeFileSync(w.spec, EDITS.글[0](BASE).replace('15분', '30분'));
  assert.equal(checkStart({ specFile: w.spec, purpose: 'worker' }).ok, false);
  assertRefused(runSpec(w, ['approve', w.spec, '출석은 15분 뒤에 닫는 걸로 바꿔 줘']), /앞 승인 기록에 쓴 메시지/);
});

test('(d) a delegation cannot be written again with the old delegation words after a [사용자] line changed: the message must be newer, for delegate as for approve', () => {
  const w = makeWorld({ specBody: USER_SPEC() });
  grantApproval(w, { kind: 'delegate', text: '끝까지 알아서 해', time: T(1), checker: true }); // approve도 시험하려고 spec-checker 기록을 둔다
  assert.equal(approvalEntries(w)[0].spec_checker_time, null, '위임 기록은 spec-checker 시각을 담지 않는다(spec-checker 기록이 있어도)');
  writeFileSync(w.spec, EDITS.글[0](BASE));
  assert.match(checkStart({ specFile: w.spec, purpose: 'worker' }).reason, /F2 바뀜/);
  // 옛 위임 말로 다시 기록하려 한다
  const stale = assertRefused(runSpec(w, ['delegate', w.spec, '끝까지 알아서 해']), /앞 승인 기록에 쓴 메시지/, '같은 위임 말');
  assert.match(stale, /사용자의 새 말을 인용한다/);
  assert.equal(approvalEntries(w).length, 1);
  assert.equal(checkStart({ specFile: w.spec, purpose: 'worker' }).ok, false, '비켜 가지 못한다');
  // 더 옛 말도 같다
  writeTranscript(w, [typed('옛날에 한 위임 말이에요', T(0)), typed('끝까지 알아서 해', T(1))]);
  assertRefused(runSpec(w, ['delegate', w.spec, '옛날에 한 위임 말이에요']), /앞 승인 기록에 쓴 메시지/, '더 옛 말');
  // 새 말은 위임으로도 승인으로도 기록된다
  writeTranscript(w, [typed('끝까지 알아서 해', T(1)), typed('출석 닫는 시간을 15분으로 바꿔 줘', T(30)), typed('이 말도 새 말이에요 알아서 계속 해', T(31))]);
  assert.equal(runSpec(w, ['delegate', w.spec, '이 말도 새 말이에요 알아서 계속 해']).status, 0);
  assert.equal(checkStart({ specFile: w.spec, purpose: 'worker' }).ok, true);
  assert.deepEqual(approvalEntries(w).map((e) => e.kind), ['delegate', 'delegate']);
  writeFileSync(w.spec, EDITS.글[0](BASE).replace('15분', '30분'));
  const viaApprove = runSpec(w, ['approve', w.spec, '출석 닫는 시간을 15분으로 바꿔 줘']);
  assertRefused(viaApprove, /앞 승인 기록에 쓴 메시지/, '승인으로도 앞 기록보다 옛 말은 안 된다');
});

test('(d) a message whose time cannot be read cannot be shown to be newer than an earlier record, so it is refused', () => {
  const w = makeWorld({ specBody: USER_SPEC() });
  grantApproval(w, { kind: 'delegate', text: '끝까지 알아서 해', time: T(1) });
  writeTranscript(w, [typed('끝까지 알아서 해', T(1)), typed('시각이 없는 새 말이에요 알아서 해', undefined)]);
  assertRefused(runSpec(w, ['delegate', w.spec, '시각이 없는 새 말이에요 알아서 해']), /시각을 대화 기록에서 읽지 못했다/);
  // 앞 기록이 없으면 위임은 시각이 없어도 된다
  const fresh = makeWorld({ specBody: USER_SPEC() });
  writeTranscript(fresh, [typed('시각이 없는 처음 말이에요 알아서 해', undefined)]);
  assert.equal(runSpec(fresh, ['delegate', fresh.spec, '시각이 없는 처음 말이에요 알아서 해']).status, 0);
});

test('(d) F5 is checked when approving again too: a re-approval that drops the pair of a review number is refused', () => {
  const w = makeWorld({ specBody: USER_SPEC({ features: '- F2 닫는 시간 [사용자: 검수 1]\n' }) });
  grantApproval(w, { checkerMessage: checkerReply(['출석을 몇 분 뒤에 닫을까요?']) });
  // 줄을 고치다가 번호 태그를 지웠다
  writeFileSync(w.spec, USER_SPEC({ features: '- F2 닫는 시간을 바꿨다 [사용자]\n' }));
  writeTranscript(w, [typed('승인', T(10)), typed('닫는 시간을 바꿔 주세요 부탁해요', T(20))]);
  assertRefused(runSpec(w, ['approve', w.spec, '닫는 시간을 바꿔 주세요 부탁해요']), /검수 1\("출석을 몇 분 뒤에 닫을까요\?"\)에 명세의 짝이 없다/);
  assert.equal(approvalEntries(w).length, 1);
  writeFileSync(w.spec, USER_SPEC({ features: '- F2 닫는 시간을 바꿨다 [사용자: 검수 1]\n' }));
  assert.equal(runSpec(w, ['approve', w.spec, '닫는 시간을 바꿔 주세요 부탁해요']).status, 0);
  assert.equal(existsSync(path.join(w.run, 'approvals.jsonl')), true);
});

// ---------- 검토 반영 3차: 제목 칸을 못 읽으면 맨 줄의 '없음'으로 넘어가지 않는다, 한 줄에 태그는 하나다 ----------

test('parseReviewReply: when a heading section exists but cannot be read, a bare line "없음" does not turn it into none', () => {
  const message = '## 사용자만 답할 수 있음\n1. 질문 하나 (기본안: a)\n\n사용자만 답할 수 있음: 없음에 가깝지만 위 하나는 확인';
  const reply = parseReviewReply(message);
  assert.deepEqual({ ...reply, items: reply.items.length }, { found: true, none: false, items: 0 });
  const problem = pairingProblem(specText(), { time: T(5), message });
  assert.ok(problem, '읽지 못한 답은 거절한다');
  assert.match(problem.reason, /칸에서 검수 번호\(검수 1, 검수 2 …\)도 '없음'도 읽지 못했다/);
  // 제목이 읽히지 않아도 맨 줄이 "없음"으로 깔끔히 끝나면 여전히 제목 칸이 먼저다
  const strictNone = '## 사용자만 답할 수 있음\n질문이 하나 있습니다.\n\n사용자만 답할 수 있음: 없음';
  assert.equal(parseReviewReply(strictNone).none, false);
  assert.ok(pairingProblem(specText(), { time: T(5), message: strictNone }));
});

test('parseReviewReply: "없음" is read only when it ends the line or is followed by punctuation or a parenthesis', () => {
  for (const tail of ['없음', '없음.', '없음(이번엔)', '없음 (이번엔)', '없음, 이번엔', '없음 — 이번엔', '없음!']) {
    const message = `## 사용자만 답할 수 있음\n${tail}`;
    assert.equal(parseReviewReply(message).none, true, tail);
    assert.equal(pairingProblem(specText(), { message }), null, tail);
  }
  for (const tail of ['없음에 가깝지만 위 하나는 확인', '없음이라고 하기는 어렵다']) {
    const message = `## 사용자만 답할 수 있음\n${tail}`;
    assert.equal(parseReviewReply(message).none, false, tail);
    assert.ok(pairingProblem(specText(), { time: T(5), message }), tail);
  }
  assert.equal(parseReviewReply('사용자만 답할 수 있음: 없음에 가깝지만 위 하나는 확인').none, false);
});

test('two tags on one line: lint says so, and the approve refusal tells why a number has no pair', () => {
  const problems = lintSpec(specText({ features: '- F1 보기 [사용자: 검수 1] [사용자: 검수 3]\n' }));
  assert.ok(problems.some((p) => /^F1: 태그가 둘입니다.*한 태그에 모읍니다/.test(p)), problems.join('\n'));
  assert.ok(lintSpec(specText({ features: '- F1 보기 [AI 가정] [사용자: 검수 1]\n' })).some((p) => /^F1: 태그가 둘/.test(p)));
  assert.equal(lintSpec(specText({ features: '- F1 보기 [위험: 지우기] [사용자: 검수 1, 3]\n' })).some((p) => /태그가 둘/.test(p)), false);
  assert.equal(lintSpec(specText({ features: '- F1 목록 [초안] 보기 [사용자]\n' })).some((p) => /태그가 둘/.test(p)), false);
  const three = checkerReply(['질문 하나', '질문 둘', '질문 셋']);
  const problem = pairingProblem(specText({ features: '- F1 보기 [사용자: 검수 1] [사용자: 검수 3]\n- F2 닫기 [사용자: 검수 2]\n' }), { time: T(5), message: three });
  assert.match(problem.reason, /검수 1\(/);
  assert.doesNotMatch(problem.reason, /검수 3/);
  assert.match(problem.instead, /한 줄에 태그는 하나다\. 번호가 여럿이면 `\[사용자: 검수 n, m\]`처럼 한 태그에 쓴다/);
  assert.equal(pairingProblem(specText({ features: '- F1 보기 [사용자: 검수 1, 3]\n- F2 닫기 [사용자: 검수 2]\n' }), { time: T(5), message: three }), null);
});

test('a period after the tag on a case line is not a tag; the refusal says to leave no text after the tag', () => {
  const features = '- F1 보기 [AI 가정]\n  - 케이스: 빈 목록 → 안내 문구 [사용자: 검수 1].\n';
  const problem = pairingProblem(specText({ features }), { time: T(5), message: TWO });
  assert.match(problem.reason, /검수 1\(/);
  assert.match(problem.instead, /검수 1의 태그 뒤에 글자\(마침표 등\)가 있어 읽히지 않는다\. 태그 뒤에 글자를 두지 않는다/);
  assert.doesNotMatch(pairingProblem(specText({ features: '- F1 보기 [사용자: 검수 1]\n' }), { time: T(5), message: TWO }).instead, /태그 뒤에 글자\(/);
});
