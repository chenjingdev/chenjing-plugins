// 승인 뒤 바뀐 [사용자] 줄(F3, R4, R12)의 시험.
// 명세 글에서 [사용자] 줄을 읽는 함수(spec.mjs), 바뀐 줄을 가려내는 함수와 approve·delegate와 시작 관문(checkStart)을 본다(approval.mjs).
// 훅·snapshot·완료 검사·보고서에서 같은 규칙이 도는지는 hooks·verification·report 시험이 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import {
  T, typed, makeWorld, writeTranscript, runSpec, specStatus, approvalEntries, assertRefused, grantApproval, specText,
} from './approval-world.mjs';
import { lintSpec, parseSpec, userLinesOf } from '../scripts/spec.mjs';
import {
  diffUserLines, userLineDrift, driftProblem, describeChange, plainLines, checkStart, refusalLine,
} from '../scripts/approval.mjs';

// ---------- 명세에서 [사용자] 줄 읽기 ----------

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
- F2 출석은 시작 10분 뒤에 닫는다 [사용자: 10/18]
- F3 화면 문구는 한국어 — 쓰는 사람이 한국어 사용자라서 [AI 가정]
  - 케이스: 글자가 넘침 → 말줄임
- F4 지난 학기 기록은 비운다 [위험: 지우기] [사용자]
## 공통 규칙
- R1 출석 기록은 학기 동안 보관한다 [AI 가정: 기록 10/11]

<details><summary>그 밖의 AI 가정 1개</summary>

- R2 결과는 표로 보인다 [사용자]
  - 케이스: 결과가 없음 → 빈 표

</details>

## 확인 필요
## 결정 기록
`;

test('userLinesOf: the F and R lines tagged [사용자] or [사용자: …] with their cases, folded ones too, and nothing else', () => {
  assert.deepEqual(userLinesOf(SAMPLE), {
    F1: ['- F1 오늘 수업 출석 현황 보기 [사용자]', '- 케이스: 수업 0건 → 빈 상태 문구'],
    F2: ['- F2 출석은 시작 10분 뒤에 닫는다 [사용자: 10/18]'],
    F4: ['- F4 지난 학기 기록은 비운다 [위험: 지우기] [사용자]'],
    R2: ['- R2 결과는 표로 보인다 [사용자]', '- 케이스: 결과가 없음 → 빈 표'],
  }, 'F3(AI 가정)과 그 케이스, R1(AI 가정: 기록 10/11), 목적 칸의 줄은 들어가지 않는다');
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

test('the tags with a source are tags the lint reads, in files and through the CLI: nothing is printed', () => {
  const w = makeWorld({ features: '- F2 출석은 10분 뒤에 닫는다 [사용자: 10/18]\n', rules: '- R2 결석 사유는 선생님만 본다 — 맡겼다 [AI 가정: 기록 10/11]\n- R3 다른 날짜도 된다 [위험: 공개] [사용자: 10/19 회의]\n' });
  assert.deepEqual(lintSpec(readFileSync(w.spec, 'utf8')), []);
  const lint = runSpec(w, ['lint', w.spec]);
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  assert.equal(lint.stdout, '');
  assert.equal(parseSpec(readFileSync(w.spec, 'utf8')).items.find((i) => i.id === 'F2').tag, '사용자');
  assert.equal(parseSpec(readFileSync(w.spec, 'utf8')).items.find((i) => i.id === 'R2').tag, 'AI 가정');
});

// ---------- 출처가 달린 [사용자] 줄도 F3가 지킨다 ----------

// [AI 가정] 기능의 케이스 줄에 사용자의 답이 달렸다
const AI_CASE = '- F3 결석 사유 보기 — 기본은 선생님만 [AI 가정]\n  - 케이스: 학생이 봄 → 안 보임 [사용자: 10/18]\n';

test('a [사용자: 출처] answer on the case line of an [AI 가정] item is kept by F3 as that one line: the [AI 가정] head line is not kept', () => {
  const spec = specText({ status: 'building', features: AI_CASE });
  const kept = userLinesOf(spec);
  assert.deepEqual(kept, {
    F1: ['- F1 오늘 수업 출석 현황 보기 [사용자]', '- 케이스: 수업 0건 → 빈 상태 문구'],
    'F3/1': ['- 케이스: 학생이 봄 → 안 보임 [사용자: 10/18]'],
  }, '머리 줄은 담지 않고, [사용자] 태그가 붙은 케이스 줄만 그 줄 하나로 담는다');
  // 케이스 줄을 바꾸면 바뀐 것이다(전에는 userLineDrift가 null이었다)
  const recorded = { user_lines: kept };
  const drift = userLineDrift(spec.replace('→ 안 보임', '→ 이름만 보임'), recorded);
  assert.deepEqual(drift?.changes.map(({ id, kind }) => ({ id, kind })), [{ id: 'F3/1', kind: 'changed' }]);
  assert.deepEqual(drift.changes[0].before, ['- 케이스: 학생이 봄 → 안 보임 [사용자: 10/18]']);
  assert.deepEqual(drift.changes[0].after, ['- 케이스: 학생이 봄 → 이름만 보임 [사용자: 10/18]']);
  // 머리 줄만 바꾸면 통과한다: [AI 가정] 항목은 AI가 알아서 고친다
  assert.equal(userLineDrift(spec.replace('기본은 선생님만', '기본은 담임만'), recorded), null);
  assert.equal(userLineDrift(spec.replace('— 기본은 선생님만 [AI 가정]', '— 기본은 담임만 — 이유가 바뀜 [AI 가정: 기록 10/11]'), recorded), null);
});

test('the user line kept under an [AI 가정] item is told apart by its order among the [사용자] lines of that item, so adding or changing the AI lines around it is not a change', () => {
  const spec = specText({ status: 'building', features: '- F3 결석 사유 보기 [AI 가정]\n  - 케이스: 교사가 봄 → 보임\n  - 케이스: 학생이 봄 → 안 보임 [사용자: 10/18]\n  - 케이스: 학부모가 봄 → 안 보임 [사용자]\n' });
  const kept = userLinesOf(spec);
  assert.deepEqual(Object.keys(kept).filter((key) => key.includes('/')), ['F3/1', 'F3/2']);
  assert.deepEqual(kept['F3/1'], ['- 케이스: 학생이 봄 → 안 보임 [사용자: 10/18]']);
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
    ['출처 태그를 지움', (t) => t.replace('안 보임 [사용자: 10/18]', '안 보임 [사용자]'), [{ id: 'F3/1', kind: 'changed' }]],
    ['[AI 가정]으로 바꿈', (t) => t.replace('학부모가 봄 → 안 보임 [사용자]', '학부모가 봄 → 안 보임 [AI 가정]'), [{ id: 'F3/2', kind: 'removed' }]],
    ['줄을 뺌', (t) => t.replace('  - 케이스: 학생이 봄 → 안 보임 [사용자: 10/18]\n', ''), [{ id: 'F3/1', kind: 'changed' }, { id: 'F3/2', kind: 'removed' }]],
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

test('F3 keeps a [사용자: 출처] line wherever the tag is: changing the line that carries it is a change (head line, case line, under an [AI 가정] item, with a risk mark)', () => {
  const answers = [
    ['머리 줄', '- F1 보기 [사용자: 10/18]\n', (t) => t.replace('F1 보기', 'F1 화면 보기')],
    ['[사용자] 항목의 케이스 줄', '- F1 보기 [사용자]\n  - 케이스: 가 → 나 [사용자: 10/18]\n', (t) => t.replace('가 → 나', '가 → 다')],
    ['[AI 가정] 항목의 케이스 줄', '- F1 보기 [AI 가정]\n  - 케이스: 가 → 나 [사용자: 10/18]\n', (t) => t.replace('가 → 나', '가 → 다')],
    ['위험 표시가 앞', '- F1 보기 [위험: 공개] [사용자: 10/18]\n', (t) => t.replace('F1 보기', 'F1 화면 보기')],
    ['위험 표시가 뒤', '- F1 보기 [사용자: 10/18] [위험: 공개]\n', (t) => t.replace('F1 보기', 'F1 화면 보기')],
    ['[AI 가정] 항목의 케이스 줄과 위험 표시', '- F1 보기 [AI 가정]\n  - 케이스: 가 → 나 [위험: 지우기] [사용자: 10/18]\n', (t) => t.replace('가 → 나', '가 → 다')],
  ];
  for (const [label, features, edit] of answers) {
    const spec = specText({ status: 'building', features });
    const recorded = { user_lines: userLinesOf(spec) };
    assert.ok(Object.values(recorded.user_lines).flat().some((line) => line.includes('[사용자: 10/18]')), `${label}: 그 줄을 F3가 담는다`);
    const now = edit(spec);
    assert.notEqual(now, spec, label);
    assert.ok(userLineDrift(now, recorded)?.changes?.length, `${label}: 그 줄을 바꾸면 바뀐 것이다`);
  }
});

test('(a) describeChange names a changed, removed or added line under an [AI 가정] item as that item\'s [사용자] line, and shows it without the list marker', () => {
  const line = '- 케이스: 학생이 봄 → 안 보임 [사용자: 10/18]';
  const next = '- 케이스: 학생이 봄 → 보임 [사용자: 10/18]';
  assert.equal(describeChange({ id: 'F3/1', kind: 'changed', before: [line], after: [next] }), 'F3의 [사용자] 줄 바뀜("케이스: 학생이 봄 → 안 보임 [사용자: 10/18]" → "케이스: 학생이 봄 → 보임 [사용자: 10/18]")');
  assert.equal(describeChange({ id: 'F3/1', kind: 'removed', before: [line], after: [] }), 'F3의 [사용자] 줄 빠짐("케이스: 학생이 봄 → 안 보임 [사용자: 10/18]")');
  assert.equal(describeChange({ id: 'F3#2/1', kind: 'added', before: [], after: [line] }), 'F3의 [사용자] 줄 더해짐("케이스: 학생이 봄 → 안 보임 [사용자: 10/18]")');
  assert.equal(plainLines([line], { head: false }), '케이스: 학생이 봄 → 안 보임 [사용자: 10/18]');
});

test('the full-width colon is the same problem for F3 and the lint: no [사용자] line, an unknown tag', () => {
  const spec = specText({ status: 'building', features: '- F3 결석 사유 보기 [사용자： 10/18]\n' });
  assert.ok(!Object.keys(userLinesOf(spec)).some((key) => key.startsWith('F3')), 'F3 줄이 아니다');
  assert.ok(lintSpec(spec).includes('F3: 알 수 없는 태그 [사용자： 10/18]'));
  const w = makeWorld({ specBody: spec });
  const lint = runSpec(w, ['lint', w.spec]);
  assert.equal(lint.status, 1);
  assert.match(lint.stdout, /F3: 알 수 없는 태그 \[사용자： 10\/18\]/);
});

test('(a) the record keeps the [사용자] case line of an [AI 가정] item, so a change to it after the approval stops the worker and snapshot', () => {
  const w = makeWorld({ features: AI_CASE });
  grantApproval(w);
  const [entry] = approvalEntries(w);
  assert.deepEqual(entry.user_lines['F3/1'], ['- 케이스: 학생이 봄 → 안 보임 [사용자: 10/18]']);
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
    assert.match(verdict.reason, /F3의 \[사용자\] 줄 바뀜\("케이스: 학생이 봄 → 안 보임 \[사용자: 10\/18\]" → "케이스: 학생이 봄 → 이름만 보임 \[사용자: 10\/18\]"\)/, purpose);
    assert.match(verdict.instead, /바꿔 달라고 한 사용자 말을 인용해 spec\.mjs approve/);
  }
  // 새 인용으로 다시 승인하면 이어 간다
  writeTranscript(w, [typed('승인', T(10)), typed('학생에게는 이름만 보이게 바꿔 주세요', T(20))]);
  assert.equal(runSpec(w, ['approve', w.spec, '학생에게는 이름만 보이게 바꿔 주세요']).status, 0);
  assert.deepEqual(approvalEntries(w)[1].user_lines['F3/1'], ['- 케이스: 학생이 봄 → 이름만 보임 [사용자: 10/18]']);
  assert.equal(checkStart({ specFile: w.spec, purpose: 'worker' }).ok, true);
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
  '태그에 출처를 붙임': [(t) => t.replace('시작 10분 뒤에 닫는다 [사용자]', '시작 10분 뒤에 닫는다 [사용자: 10/18]'), [{ id: 'F2', kind: 'changed' }]],
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
    '확인 필요': (t) => t.replace('## 확인 필요\n', '## 확인 필요\n- 오늘 날짜로 정했다\n'),
    '[AI 가정] 줄의 글': (t) => t.replace('화면 문구는 한국어 — 한국어 사용자라서', '화면 문구는 영어 — 해외 사용자라서'),
    '[AI 가정] 줄 더하기': (t) => t.replace('## 공통 규칙\n', '## 공통 규칙\n- R8 AI가 더한 규칙 — 이유 [AI 가정]\n'),
    '[AI 가정] 줄 빼기': (t) => t.replace('- F3 화면 문구는 한국어 — 한국어 사용자라서 [AI 가정]\n', ''),
    '[AI 가정] 줄의 출처 태그': (t) => t.replace('한국어 사용자라서 [AI 가정]', '한국어 사용자라서 [AI 가정: 기록 10/11]'),
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
  grantApproval(w, { kind: 'delegate', text: '끝까지 알아서 해', time: T(1) });
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

test('two tags on one line: lint says so', () => {
  const problems = lintSpec(specText({ features: '- F1 보기 [사용자: 10/18] [사용자: 10/19]\n' }));
  assert.ok(problems.some((p) => /^F1: 태그가 둘입니다/.test(p)), problems.join('\n'));
  assert.ok(lintSpec(specText({ features: '- F1 보기 [AI 가정] [사용자: 10/18]\n' })).some((p) => /^F1: 태그가 둘/.test(p)));
  assert.equal(lintSpec(specText({ features: '- F1 보기 [위험: 지우기] [사용자: 10/18]\n' })).some((p) => /태그가 둘/.test(p)), false);
  assert.equal(lintSpec(specText({ features: '- F1 목록 [초안] 보기 [사용자]\n' })).some((p) => /태그가 둘/.test(p)), false);
});
