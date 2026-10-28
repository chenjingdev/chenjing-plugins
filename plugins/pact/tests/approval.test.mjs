// 승인·위임 기록 시험. 가짜 HOME에 손으로 만든 대화 기록(JSONL)을 두고, 실행 폴더 log/에 spec-checker 기록을 두고,
// spec.mjs를 자식 프로세스로 돌린다(HOME과 CLAUDE_CODE_SESSION_ID만 가짜). 스크립트에는 대화 기록 위치를 덮어쓰는 옵션이 없다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  tmp, T, typed, legacyUser, typedWithImage, answers, assistant, toolResult, taskNotification, compactSummary, commandMessage,
  systemReminder, peerMessage, makeWorld, writeTranscript, addCheckerRecord, runSpec, specStatus, approvalEntries, assertRefused,
  grantApproval, specText, SESSION, SPEC_CLI,
} from './approval-world.mjs';
import { checkStart, readApprovals, runDirOfSpec, findSpecForRun, LEGACY_NOTE } from '../scripts/approval.mjs';

const LONG = '이대로 만들어 주세요 지금 바로 시작합니다';

// ---------- (a) approve ----------

test('(a) approve: a person\'s "승인" after the spec-checker finished is recorded in the run folder and the status becomes approved', () => {
  const w = makeWorld();
  addCheckerRecord(w, T(5));
  const said = typed('승인', T(10));
  writeTranscript(w, [typed('출결 관리 만들어 줘', T(0)), assistant('명세를 검수했어요. 승인할까요?', T(8)), said]);
  const r = runSpec(w, ['approve', w.spec, '승인']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /승인을 기록했다: "승인"/);
  assert.match(r.stdout, /status approved/);
  assert.equal(specStatus(w), 'approved');

  const entries = approvalEntries(w);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.version, 1);
  assert.equal(entry.kind, 'approve');
  assert.equal(entry.quote, '승인');
  assert.equal(entry.message, '승인');
  assert.equal(entry.message_uuid, said.uuid);
  assert.equal(entry.message_time, T(10));
  assert.equal(entry.answer_question, null);
  assert.equal(entry.transcript, w.transcript);
  assert.equal(entry.session_id, SESSION);
  assert.equal(entry.spec, w.spec);
  assert.equal(entry.spec_checker_time, T(5));
  assert.match(entry.recorded_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Math.abs(Date.now() - Date.parse(entry.recorded_at)) < 60_000);
  assert.equal(readFileSync(path.join(w.project, '.pact', '.gitignore'), 'utf8'), '*\n', '실행 폴더를 만들 때 .pact/.gitignore도 만든다');
  // 명세는 status 한 줄만 바뀐다
  assert.equal(readFileSync(w.spec, 'utf8'), specText({ status: 'approved' }));
});

test('(a) a quote may be part of a long message, may come as several arguments, and ㄱㄱ-like short answers work when they are the whole message', () => {
  const w = makeWorld();
  addCheckerRecord(w, T(5));
  writeTranscript(w, [typed(`네, ${LONG}. 그리고 하나 더 부탁해요`, T(10)), typed('ㄱㄱ', T(11))]);
  let r = runSpec(w, ['approve', w.spec, LONG]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(approvalEntries(w)[0].message, `네, ${LONG}. 그리고 하나 더 부탁해요`);
  assert.equal(approvalEntries(w)[0].quote, LONG);

  const w2 = makeWorld();
  addCheckerRecord(w2, T(5));
  writeTranscript(w2, [typed('좋아, 만들어', T(10))]);
  r = runSpec(w2, ['approve', w2.spec, '좋아,', '만들어']); // 따옴표 없이 넘겨도 한 줄로 이어 받는다
  assert.equal(r.status, 0, r.stderr);
  assert.equal(approvalEntries(w2)[0].quote, '좋아, 만들어');

  const w3 = makeWorld();
  addCheckerRecord(w3, T(5));
  writeTranscript(w3, [typed('ㄱㄱ', T(10))]);
  assert.equal(runSpec(w3, ['approve', w3.spec, 'ㄱㄱ']).status, 0);
  // 문장부호·띄어쓰기는 맞춰 볼 때 뺀다
  const w4 = makeWorld();
  addCheckerRecord(w4, T(5));
  writeTranscript(w4, [typed('좋아 , 만들어 !', T(10))]);
  assert.equal(runSpec(w4, ['approve', w4.spec, '좋아, 만들어']).status, 0);
});

test('(a) a person\'s words with an image attached, and older records with no origin or from claude -p, are a person\'s words', () => {
  for (const make of [
    (text) => typedWithImage(`[Image #1] ${text}`, T(10)),
    (text) => legacyUser(text, T(10)),
    (text) => legacyUser(text, T(10), { promptSource: 'sdk' }),
    (text) => typed(text, T(10), { promptSource: 'queued' }),
  ]) {
    const w = makeWorld();
    addCheckerRecord(w, T(5));
    writeTranscript(w, [make(LONG)]);
    const r = runSpec(w, ['approve', w.spec, LONG]);
    assert.equal(r.status, 0, r.stderr);
  }
});

// ---------- (b) 사람 말이 아닌 것은 승인 근거가 아니다 ----------

test('(b) a quote that is not in a person\'s message is refused: never said, or found only in a notification, summary, reminder, command, tool result, assistant message or other session', () => {
  const sources = {
    '기록에 없는 말': () => [typed('다른 말이에요', T(10))],
    '작업 알림': (text) => [taskNotification(text, T(10))],
    '대화 요약': (text) => [compactSummary(text, T(10))],
    '명령 메시지': (text) => [commandMessage(text, T(10))],
    'system-reminder': (text) => [systemReminder(text, T(10)), legacyUser(`<system-reminder>${text}</system-reminder>`, T(11))],
    '도구 결과': (text) => [toolResult(text, T(10))],
    '어시스턴트 말': (text) => [assistant(text, T(10))],
    '다른 세션': (text) => [peerMessage(text, T(10))],
    '하위 에이전트 쪽 줄': (text) => [typed(text, T(10), { isSidechain: true })],
    '플러그인이 보낸 말': (text) => [typed(text, T(10), { origin: { kind: 'plugin' } })],
  };
  for (const quote of ['승인', LONG]) {
    for (const [label, make] of Object.entries(sources)) {
      const w = makeWorld();
      addCheckerRecord(w, T(5));
      writeTranscript(w, make(quote));
      const before = readFileSync(w.spec, 'utf8');
      const line = assertRefused(runSpec(w, ['approve', w.spec, quote]), /사용자 메시지에 없/, `${label}(${quote})`);
      assert.match(line, /사용자가 실제로 한 말을 그대로/, '대신 할 일이 같은 줄에 있다');
      assert.equal(specStatus(w), 'draft', label);
      assert.equal(readFileSync(w.spec, 'utf8'), before, `${label}: 명세는 그대로다`);
      assert.deepEqual(approvalEntries(w), [], `${label}: 기록이 생기지 않는다`);
    }
  }
});

test('(b) a person\'s message that mixes in another kind of record is still found: a human line wins over noise around it', () => {
  const w = makeWorld();
  addCheckerRecord(w, T(5));
  writeTranscript(w, [taskNotification('승인', T(6)), compactSummary('승인', T(7)), typed('승인', T(10)), toolResult('승인', T(11))]);
  assert.equal(runSpec(w, ['approve', w.spec, '승인']).status, 0);
  assert.equal(approvalEntries(w)[0].message_time, T(10));
});

// ---------- (c) 짧은 말은 메시지 전체와 같아야 한다 ----------

test('(c) a short quote found only inside a longer message is refused, with a reason that says how to quote it', () => {
  const w = makeWorld();
  addCheckerRecord(w, T(5));
  writeTranscript(w, [typed('승인은 아직 아니야', T(10)), typed('네, 승인', T(11))]);
  const line = assertRefused(runSpec(w, ['approve', w.spec, '승인']), /짧은 말이라 사용자 메시지 전체와 같아야/, '승인');
  assert.match(line, /메시지 전체를 그대로 인용한다/);
  assert.equal(specStatus(w), 'draft');
  assert.deepEqual(approvalEntries(w), []);
  // 메시지 전체를 인용하면 길이에 상관없이 맞는다
  assert.equal(runSpec(w, ['approve', w.spec, '네, 승인']).status, 0);
  assert.equal(approvalEntries(w)[0].message, '네, 승인');
});

test('(c) the short-quote limit is 10 characters once spaces and punctuation are dropped', () => {
  const ten = '가나다라마바사아자차';
  const w = makeWorld();
  addCheckerRecord(w, T(5));
  writeTranscript(w, [typed(`${ten}를 하자`, T(10))]);
  assertRefused(runSpec(w, ['approve', w.spec, ten]), /짧은 말/);
  assertRefused(runSpec(w, ['approve', w.spec, ' 가나다 라마바 사아자 차! ']), /짧은 말/, '띄어쓰기를 넣어도 같다');
  assert.equal(runSpec(w, ['approve', w.spec, `${ten}카`]).status, 1, '11자지만 메시지에 없다');
  writeTranscript(w, [typed(`${ten}카를 하자`, T(10))]);
  assert.equal(runSpec(w, ['approve', w.spec, `${ten}카`]).status, 0, '11자부터는 메시지 안에 들어 있으면 된다');
});

// ---------- (d) AskUserQuestion의 답 ----------

test('(d) the answer a person picked in an AskUserQuestion is a person\'s word, and the record says which question it answered', () => {
  const w = makeWorld();
  addCheckerRecord(w, T(5));
  const asked = answers({ '이 명세대로 만들까요?': '승인', '어느 화면부터 볼까요?': '목록 (Recommended)' }, T(10));
  writeTranscript(w, [assistant('질문', T(9)), asked]);
  const r = runSpec(w, ['approve', w.spec, '승인']);
  assert.equal(r.status, 0, r.stderr);
  const [entry] = approvalEntries(w);
  assert.equal(entry.message, '승인');
  assert.equal(entry.message_uuid, asked.uuid);
  assert.equal(entry.answer_question, '이 명세대로 만들까요?');
  assert.equal(specStatus(w), 'approved');
  // 고르지 않은 선택지는 답이 아니다
  const w2 = makeWorld();
  addCheckerRecord(w2, T(5));
  writeTranscript(w2, [answers({ '이 명세대로 만들까요?': '조금 고칠게요' }, T(10))]);
  assertRefused(runSpec(w2, ['approve', w2.spec, '승인']), /사용자 메시지에 없/);
  // 질문 글 자체는 사람의 말이 아니다
  assertRefused(runSpec(w2, ['approve', w2.spec, '이 명세대로 만들까요?']), /사용자 메시지에 없/);
});

// ---------- (e) 시각 순서 ----------

test('(e) a quote said before the spec-checker finished is refused, and so is one said at the same moment', () => {
  const w = makeWorld();
  addCheckerRecord(w, T(5));
  writeTranscript(w, [typed('승인', T(3)), typed(LONG, T(5))]);
  const line = assertRefused(runSpec(w, ['approve', w.spec, '승인']), /spec-checker가 끝난 뒤/, '검수 전');
  assert.ok(line.includes(T(5)), '검수가 끝난 시각을 알린다');
  assert.match(line, /승인을 다시 묻고, 그 답을 인용한다/);
  assertRefused(runSpec(w, ['approve', w.spec, LONG]), /spec-checker가 끝난 뒤/, '같은 시각');
  assert.equal(specStatus(w), 'draft');
  assert.deepEqual(approvalEntries(w), []);
  // 같은 말이 검수 전과 후에 둘 다 있으면 뒤의 것을 쓴다
  writeTranscript(w, [typed('승인', T(3)), typed('승인', T(9))]);
  assert.equal(runSpec(w, ['approve', w.spec, '승인']).status, 0);
  assert.equal(approvalEntries(w)[0].message_time, T(9));
});

test('(e) with no spec-checker record approve is refused, and an unreadable record refuses too', () => {
  const w = makeWorld();
  writeTranscript(w, [typed('승인', T(10))]);
  const line = assertRefused(runSpec(w, ['approve', w.spec, '승인']), /spec-checker 기록이 없다/);
  assert.match(line, /pact:spec-checker로 명세를 검수한 뒤/);
  assert.equal(specStatus(w), 'draft');
  assert.equal(existsSync(path.join(w.project, '.pact')), false, '거절하면 실행 폴더도 만들지 않는다');
  // 다른 에이전트의 기록만 있어도 spec-checker 기록이 아니다
  mkdirSync(path.join(w.run, 'log'), { recursive: true });
  writeFileSync(path.join(w.run, 'log', 'subagents.jsonl'), `${JSON.stringify({ time: T(1), agent_type: 'pact:worker', message: '끝' })}\n`);
  assertRefused(runSpec(w, ['approve', w.spec, '승인']), /spec-checker 기록이 없다/);
  // 시각을 못 읽는 spec-checker 기록은 확인하지 못한 것이다
  writeFileSync(path.join(w.run, 'log', 'subagents.jsonl'), `${JSON.stringify({ time: '어제', agent_type: 'pact:spec-checker', message: '검수' })}\n`);
  assertRefused(runSpec(w, ['approve', w.spec, '승인']), /시각을 읽지 못/);
  // 기록 자리가 파일이 아닌 폴더이면 읽지 못한다: 거절한다
  rmSync(path.join(w.run, 'log'), { recursive: true, force: true });
  writeFileSync(path.join(w.run, 'log'), '폴더 자리에 파일');
  const r = runSpec(w, ['approve', w.spec, '승인']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.trim(), '까닭이 나온다');
  assert.equal(specStatus(w), 'draft');
  assert.deepEqual(approvalEntries(w), []);
});

test('(e) approving again needs a message newer than every message already recorded; the same message is refused', () => {
  const w = makeWorld();
  addCheckerRecord(w, T(5));
  writeTranscript(w, [typed('승인', T(10))]);
  assert.equal(runSpec(w, ['approve', w.spec, '승인']).status, 0);

  // 같은 메시지
  const same = assertRefused(runSpec(w, ['approve', w.spec, '승인']), /앞 승인 기록에 쓴 메시지/, '같은 메시지');
  assert.match(same, /사용자의 새 말을 인용한다/);
  assert.equal(approvalEntries(w).length, 1);

  // 앞 기록보다 오래된 말(검수 뒤이긴 하다)
  writeTranscript(w, [typed('다시 승인해요 이대로 가요', T(7)), typed('승인', T(10))]);
  assertRefused(runSpec(w, ['approve', w.spec, '다시 승인해요 이대로 가요']), /앞 승인 기록에 쓴 메시지/, '더 오래된 말');

  // 새 메시지는 된다: 명세를 고치자고 한 말을 인용해 다시 승인한다(F3)
  writeTranscript(w, [typed('승인', T(10)), assistant('F3을 바꿨어요', T(12)), typed('승인', T(20))]);
  writeFileSync(w.spec, specText({ status: 'building' })); // 만드는 중에 다시 승인한다
  const again = runSpec(w, ['approve', w.spec, '승인']);
  assert.equal(again.status, 0, again.stderr);
  const entries = approvalEntries(w);
  assert.equal(entries.length, 2, '이력이 쌓인다');
  assert.equal(entries[0].message_time, T(10));
  assert.equal(entries[1].message_time, T(20), '맞는 말이 둘이면 가장 최근 것을 쓴다');
  assert.notEqual(entries[1].message_uuid, entries[0].message_uuid);
  assert.equal(specStatus(w), 'approved');
  // 방금 쓴 메시지를 또 쓰면 거절
  assertRefused(runSpec(w, ['approve', w.spec, '승인']), /앞 승인 기록에 쓴 메시지/);
  assert.equal(approvalEntries(w).length, 2);
});

test('(e) a spec-checker run after the last approval means the next approval must come after that run too', () => {
  const w = makeWorld();
  addCheckerRecord(w, T(5));
  writeTranscript(w, [typed('승인', T(10)), typed('다시 해 주세요 이대로 승인합니다', T(20))]);
  assert.equal(runSpec(w, ['approve', w.spec, '승인']).status, 0);
  addCheckerRecord(w, T(30)); // 고친 명세를 다시 검수했다
  assertRefused(runSpec(w, ['approve', w.spec, '다시 해 주세요 이대로 승인합니다']), /spec-checker가 끝난 뒤/);
  writeTranscript(w, [typed('승인', T(10)), typed('다시 해 주세요 이대로 승인합니다', T(20)), typed('이제 승인', T(40))]);
  assert.equal(runSpec(w, ['approve', w.spec, '이제 승인']).status, 0);
  assert.equal(approvalEntries(w).length, 2);
});

// ---------- (f) 위임 ----------

test('(f) delegate: words that hand over the approval too are recorded, at any time, without a spec-checker record', () => {
  const w = makeWorld();
  writeTranscript(w, [typed('끝까지 알아서 해', T(0)), assistant('네', T(1))]); // 처음 부탁에 있는 말
  const r = runSpec(w, ['delegate', w.spec, '끝까지 알아서 해']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /위임을 기록했다/);
  assert.equal(specStatus(w), 'approved');
  const [entry] = approvalEntries(w);
  assert.equal(entry.kind, 'delegate');
  assert.equal(entry.quote, '끝까지 알아서 해');
  assert.equal(entry.message_time, T(0));
  assert.equal(entry.spec_checker_time, null);
  // 검수가 끝난 뒤의 말이어도 된다. 같은 말로 다시 위임을 적는 것도 막지 않는다(이력이 쌓인다)
  addCheckerRecord(w, T(5));
  writeTranscript(w, [typed('끝까지 알아서 해', T(0)), typed('승인 없이 만들어', T(9))]);
  assert.equal(runSpec(w, ['delegate', w.spec, '승인 없이 만들어']).status, 0);
  assert.equal(runSpec(w, ['delegate', w.spec, '끝까지 알아서 해']).status, 0);
  assert.deepEqual(approvalEntries(w).map((e) => e.kind), ['delegate', 'delegate', 'delegate']);
});

test('(f) delegate quotes are matched like approve quotes: a short quote must be the whole message, and only a person\'s words count', () => {
  const w = makeWorld();
  writeTranscript(w, [typed('끝까지 알아서 해줘 근데 승인은 내가 할게', T(0)), taskNotification('끝까지 알아서 해', T(1)), compactSummary('끝까지 알아서 해', T(2))]);
  assertRefused(runSpec(w, ['delegate', w.spec, '끝까지 알아서 해']), /짧은 말이라 사용자 메시지 전체와 같아야/);
  assert.equal(specStatus(w), 'draft');
  writeTranscript(w, [taskNotification('끝까지 알아서 해', T(1)), compactSummary('끝까지 알아서 해', T(2))]);
  assertRefused(runSpec(w, ['delegate', w.spec, '끝까지 알아서 해']), /사용자 메시지에 없/);
  assert.deepEqual(approvalEntries(w), []);
});

test('(f) delegate with a [위험: …] mark, or with a risk word and no mark, is refused and says to get an approval instead', () => {
  const variants = {
    '지우기 표시': { features: '- F2 지난 학기 자료 비우기 [위험: 지우기] [사용자]\n', pattern: /F2\(위험 표시\)/ },
    '공개 표시(규칙)': { rules: '- R2 결과 페이지를 외부에 올린다 [위험: 공개] [AI 가정]\n', pattern: /R2\(위험 표시\)/ },
    '표시 없는 낱말': { rules: '- R2 기록을 삭제한다 [AI 가정]\n', pattern: /R2\(낱말 삭제\)/ },
    '케이스의 낱말': { features: '- F2 자료 정리 [사용자]\n  - 케이스: 오래된 자료 → 덮어쓰기 전에 묻는다\n', pattern: /F2\(낱말 덮어쓰\)/ },
    '케이스의 표시': { features: '- F2 자료 정리 [사용자]\n  - 케이스: 오래된 자료 → 비운다 [위험: 지우기]\n', pattern: /F2\(위험 표시\)/ },
    '접힌 칸': { rules: '\n<details><summary>그 밖의 AI 가정 1개</summary>\n\n- R2 결제 내역 보기 [AI 가정]\n\n</details>\n\n', pattern: /R2\(낱말 결제\)/ },
  };
  for (const [label, parts] of Object.entries(variants)) {
    const w = makeWorld({ features: parts.features, rules: parts.rules });
    writeTranscript(w, [typed('끝까지 알아서 해', T(0))]);
    const before = readFileSync(w.spec, 'utf8');
    const line = assertRefused(runSpec(w, ['delegate', w.spec, '끝까지 알아서 해']), /위험 항목이 있어 위임으로 기록하지 않는다/, label);
    assert.match(line, parts.pattern, label);
    assert.match(line, /사용자의 승인을 받아 spec\.mjs approve/, `${label}: 승인을 받으라고 알린다`);
    assert.equal(specStatus(w), 'draft', label);
    assert.equal(readFileSync(w.spec, 'utf8'), before, label);
    assert.deepEqual(approvalEntries(w), [], label);
    assert.equal(existsSync(path.join(w.project, '.pact')), false, `${label}: 거절하면 실행 폴더도 만들지 않는다`);
  }
  // 목적·범위·하지 않는 것의 낱말은 보지 않는다
  const calm = makeWorld({ specBody: specText().replace('교수자가 출석을 빨리 확인한다.', '기록을 삭제하거나 공개하지 않는다.').replace('웹 화면 하나.', '배포 push 결제는 범위 밖.').replace('출석 처리 자체.', '- 유료 기능은 없다') });
  writeTranscript(calm, [typed('끝까지 알아서 해', T(0))]);
  assert.equal(runSpec(calm, ['delegate', calm.spec, '끝까지 알아서 해']).status, 0);
});

test('(f) a risk item does not stop an approve: the person said it after seeing the spec', () => {
  const w = makeWorld({ features: '- F2 지난 학기 자료 비우기 [위험: 지우기] [사용자]\n' });
  addCheckerRecord(w, T(5));
  writeTranscript(w, [typed('끝까지 알아서 해', T(0)), typed('승인', T(10))]);
  assert.equal(runSpec(w, ['delegate', w.spec, '끝까지 알아서 해']).status, 1);
  assert.equal(runSpec(w, ['approve', w.spec, '승인']).status, 0);
  assert.equal(approvalEntries(w)[0].kind, 'approve');
});

// ---------- 명령 쓰임새와 대화 기록 찾기 ----------

test('approve and delegate refuse with one line when the quote is empty, the spec is missing, or the session cannot be found', () => {
  const w = makeWorld();
  addCheckerRecord(w, T(5));
  writeTranscript(w, [typed('승인', T(10))]);
  assertRefused(runSpec(w, ['approve', w.spec, '   ']), /인용한 사용자 말이 비어 있다/);
  assertRefused(runSpec(w, ['approve', w.spec]), /인용한 사용자 말이 비어 있다/);
  assertRefused(runSpec(w, ['delegate', w.spec, '!!!']), /인용한 사용자 말이 비어 있다/);
  const missing = runSpec(w, ['approve', path.join(w.project, 'docs', 'pact', 'nope.md'), '승인']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ENOENT/);
  // 세션 id가 없거나 대화 기록이 없다: 확인하지 못하면 기록하지 않는다
  assertRefused(runSpec(w, ['approve', w.spec, '승인'], { env: { CLAUDE_CODE_SESSION_ID: '' } }), /CLAUDE_CODE_SESSION_ID가 없어/);
  assertRefused(runSpec(w, ['approve', w.spec, '승인'], { env: { CLAUDE_CODE_SESSION_ID: 'another-session-id' } }), /기록 파일을 찾지 못/);
  assertRefused(runSpec(w, ['approve', w.spec, '승인'], { env: { HOME: path.join(w.root, 'no-home') } }), /기록 파일을 찾지 못/);
  assert.equal(specStatus(w), 'draft');
  assert.deepEqual(approvalEntries(w), []);
  // 인자가 모자라면 사용법
  const usage = spawnSync(process.execPath, [SPEC_CLI, 'approve'], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /spec\.mjs approve <명세>/);
});

test('a spec whose status cannot be changed (no frontmatter) gets no record either', () => {
  const w = makeWorld({ specBody: '# 머리말이 없는 명세\n## 기능\n- F1 보기 [사용자]\n## 공통 규칙\n' });
  addCheckerRecord(w, T(5));
  writeTranscript(w, [typed('승인', T(10))]);
  const r = runSpec(w, ['approve', w.spec, '승인']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /frontmatter/);
  assert.deepEqual(approvalEntries(w), [], '명세가 안 바뀌었는데 기록만 남지 않는다');
});

test('the transcript is looked up under CLAUDE_CONFIG_DIR when it is set, and in any project folder under projects/', () => {
  const w = makeWorld();
  addCheckerRecord(w, T(5));
  const config = tmp();
  const file = path.join(config, 'projects', '-somewhere-else-entirely', `${SESSION}.jsonl`);
  writeTranscript(w, [typed('승인', T(10))], file);
  // ~/.claude에는 없고 CLAUDE_CONFIG_DIR에만 있다
  assertRefused(runSpec(w, ['approve', w.spec, '승인']), /기록 파일을 찾지 못/);
  const r = runSpec(w, ['approve', w.spec, '승인'], { env: { CLAUDE_CONFIG_DIR: config } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(approvalEntries(w)[0].transcript, file);
});

test('a session whose transcript is in two project folders is read from both, and the same line is counted once', () => {
  const w = makeWorld();
  addCheckerRecord(w, T(5));
  const said = typed('승인', T(10));
  writeTranscript(w, [typed('앞 말', T(0))]);
  writeTranscript(w, [typed('앞 말', T(0)), said], path.join(w.home, '.claude', 'projects', '-moved-here', `${SESSION}.jsonl`));
  const r = runSpec(w, ['approve', w.spec, '승인']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(approvalEntries(w)[0].message_uuid, said.uuid);
});

// ---------- (g) 기록 없이는 시작하지 못한다 ----------

test('(g) set-status approved and building are refused without a record, on a new spec', () => {
  for (const status of ['draft', 'approved', 'building']) {
    for (const target of ['approved', 'building']) {
      const w = makeWorld({ status });
      const before = readFileSync(w.spec, 'utf8');
      const line = assertRefused(runSpec(w, ['set-status', w.spec, target]), /승인 기록이 없다/, `${status} → ${target}`);
      assert.match(line, /spec\.mjs approve <명세> "<사용자 말>"/);
      assert.match(line, /delegate/);
      assert.equal(readFileSync(w.spec, 'utf8'), before, `${status} → ${target}: status가 바뀌지 않는다`);
    }
  }
  // 승인 기록과 상관없는 status는 그대로 바뀐다
  const w = makeWorld({ status: 'building' });
  assert.equal(runSpec(w, ['set-status', w.spec, 'verifying']).status, 0);
  assert.equal(specStatus(w), 'verifying');
  assert.equal(runSpec(w, ['set-status', w.spec, 'draft']).status, 0);
  assert.equal(runSpec(w, ['set-status', w.spec, 'done']).status, 1, 'done은 여전히 finish만 바꾼다');
  assert.equal(runSpec(w, ['set-status', w.spec, 'nonsense']).status, 1);
});

test('(g) with a record, set-status approved and building go through', () => {
  const w = makeWorld();
  grantApproval(w);
  assert.equal(specStatus(w), 'approved');
  let r = runSpec(w, ['set-status', w.spec, 'building']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', '기록이 있으면 참고도 없다');
  assert.equal(specStatus(w), 'building');
  assert.equal(runSpec(w, ['set-status', w.spec, 'verifying']).status, 0);
  r = runSpec(w, ['set-status', w.spec, 'building']); // verify에서 build로 되돌아간다
  assert.equal(r.status, 0, r.stderr);
  assert.equal(runSpec(w, ['set-status', w.spec, 'approved']).status, 0);
});

test('(g) an old spec (pact: 1, status approved/building/verifying/done) goes on without a record and says so; an old draft does not', () => {
  for (const status of ['approved', 'building', 'verifying', 'done']) {
    for (const target of ['approved', 'building']) {
      const w = makeWorld({ pact: 1, status });
      const r = runSpec(w, ['set-status', w.spec, target]);
      assert.equal(r.status, 0, `${status} → ${target}: ${r.stderr}`);
      assert.equal(r.stdout.trim(), '참고: 옛 판이라 승인 기록 없음', `${status} → ${target}`);
      assert.equal(specStatus(w), target);
    }
  }
  for (const target of ['approved', 'building']) {
    const w = makeWorld({ pact: 1, status: 'draft' });
    assertRefused(runSpec(w, ['set-status', w.spec, target]), /승인 기록이 없다/, `pact 1 draft → ${target}`);
    assert.equal(specStatus(w), 'draft');
  }
  // pact: 1이 아닌 것은 옛 명세가 아니다: 손으로 status를 고친 새 명세가 옛 판처럼 보이지 않게
  for (const pact of [2, 3, 'x']) {
    const w = makeWorld({ pact, status: 'building' });
    assertRefused(runSpec(w, ['set-status', w.spec, 'building']), /승인 기록이 없다/, `pact ${pact}`);
  }
  const noPact = makeWorld({ specBody: specText({ status: 'building' }).replace('pact: 2\n', '') });
  assertRefused(runSpec(noPact, ['set-status', noPact.spec, 'building']), /승인 기록이 없다/, 'pact 줄 없음');
  // 옛 명세라도 기록이 생기면 그 기록을 따른다(참고도 없다)
  const w = makeWorld({ pact: 1, status: 'draft' });
  grantApproval(w);
  const r = runSpec(w, ['set-status', w.spec, 'building']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('(g) checkStart answers for a spec file or for a project and run-id, and a judge by run-id finds the dated spec of an undated old run folder', () => {
  const w = makeWorld({ pact: 1, status: 'building' });
  assert.deepEqual(checkStart({ specFile: w.spec, purpose: 'building' }), { ok: true, mode: 'legacy', note: LEGACY_NOTE });
  assert.deepEqual(checkStart({ project: w.project, runId: w.id, purpose: 'worker' }), { ok: true, mode: 'legacy', note: LEGACY_NOTE });
  // 날짜 없는 옛 실행 폴더 이름으로 불러도 날짜 붙은 명세를 찾는다
  assert.equal(findSpecForRun(w.project, w.id), w.spec);
  assert.equal(findSpecForRun(w.project, '출결-관리'), w.spec);
  assert.equal(checkStart({ project: w.project, runId: '출결-관리', purpose: 'worker' }).mode, 'legacy');
  assert.equal(findSpecForRun(w.project, '없는-판'), null);
  assert.equal(findSpecForRun(path.join(w.root, 'nowhere'), w.id), null);
  const lost = checkStart({ project: w.project, runId: '없는-판', purpose: 'worker' });
  assert.equal(lost.ok, false);
  assert.match(lost.reason, /명세를 찾지 못하고 승인 기록도 없다/);
  assert.deepEqual(runDirOfSpec(w.spec), { spec: w.spec, project: w.project, runId: w.id, runDir: w.run });
  assert.deepEqual(readApprovals(w.run), []);
});

// ---------- 위임이면 만들기를 시작할 때 다시 본다 ----------

test('(f) a delegate record is looked at again when building starts: a risk item that appeared since stops it, and approving settles it', () => {
  const w = makeWorld();
  writeTranscript(w, [typed('끝까지 알아서 해', T(0))]);
  assert.equal(runSpec(w, ['delegate', w.spec, '끝까지 알아서 해']).status, 0);
  assert.equal(runSpec(w, ['set-status', w.spec, 'building']).status, 0, '위험이 없으면 시작한다');
  runSpec(w, ['set-status', w.spec, 'approved']);

  // 만드는 중에 명세에 위험 항목이 생겼다
  writeFileSync(w.spec, specText({ status: 'approved', rules: '- R2 오래된 기록을 삭제한다 [AI 가정]\n' }));
  const line = assertRefused(runSpec(w, ['set-status', w.spec, 'building']), /위임으로 시작하려는데 지금 명세에 위험 항목이 있다: R2\(낱말 삭제\)/);
  assert.match(line, /사용자의 승인을 받아 spec\.mjs approve/);
  assert.equal(specStatus(w), 'approved');
  // 승인 기록이 없는 것과 달리 approved로는 바뀐다(만들기를 시작하는 것이 아니다)
  assert.equal(runSpec(w, ['set-status', w.spec, 'approved']).status, 0);

  // 사용자가 보고 승인하면 이어 간다: 마지막 기록이 승인이면 위험 항목이 있어도 시작한다
  addCheckerRecord(w, T(5));
  writeTranscript(w, [typed('끝까지 알아서 해', T(0)), typed('승인', T(10))]);
  assert.equal(runSpec(w, ['approve', w.spec, '승인']).status, 0);
  assert.equal(runSpec(w, ['set-status', w.spec, 'building']).status, 0);
  assert.deepEqual(approvalEntries(w).map((e) => e.kind), ['delegate', 'approve']);
});

test('(f) a delegate record is matched against the recorded transcript again when building starts; if it cannot be, building does not start', () => {
  const w = makeWorld();
  const said = typed('끝까지 알아서 해', T(0));
  writeTranscript(w, [said]);
  assert.equal(runSpec(w, ['delegate', w.spec, '끝까지 알아서 해']).status, 0);
  // 대화 기록이 사라졌다
  rmSync(w.transcript);
  const line = assertRefused(runSpec(w, ['set-status', w.spec, 'building']), /위임 기록의 인용을 다시 맞춰 보지 못했다: 기록한 대화 기록을 읽지 못했다/);
  assert.match(line, /사용자에게 승인을 다시 받아 spec\.mjs approve/);
  // 기록에서 그 메시지가 사라졌다
  writeTranscript(w, [typed('다른 말', T(0))]);
  assertRefused(runSpec(w, ['set-status', w.spec, 'building']), /다시 찾지 못했다/);
  // 같은 uuid의 메시지 글이 달라졌다
  writeTranscript(w, [{ ...said, message: { role: 'user', content: '끝까지 알아서 하지 마' } }]);
  assertRefused(runSpec(w, ['set-status', w.spec, 'building']), /메시지 글이 기록한 글과 다르다/);
  // 사람 말이 아닌 것으로 바뀌었다(같은 uuid가 작업 알림이 됨)
  writeTranscript(w, [taskNotification('끝까지 알아서 해', T(0))].map((r) => ({ ...r, uuid: said.uuid })));
  assertRefused(runSpec(w, ['set-status', w.spec, 'building']), /다시 찾지 못했다/);
  // 원래대로 돌아오면 시작한다
  writeTranscript(w, [said]);
  assert.equal(runSpec(w, ['set-status', w.spec, 'building']).status, 0);
  // 다시 맞춰 볼 때는 지금 환경이 아니라 기록한 경로를 본다
  runSpec(w, ['set-status', w.spec, 'approved']);
  assert.equal(runSpec(w, ['set-status', w.spec, 'building'], { env: { HOME: path.join(w.root, 'elsewhere'), CLAUDE_CODE_SESSION_ID: 'other' } }).status, 0);
});

test('(f) an AskUserQuestion-based record is matched again by its uuid and question', () => {
  const w = makeWorld();
  const asked = answers({ '승인까지 맡기시겠어요?': '끝까지 알아서 해' }, T(2));
  writeTranscript(w, [asked]);
  assert.equal(runSpec(w, ['delegate', w.spec, '끝까지 알아서 해']).status, 0);
  assert.equal(approvalEntries(w)[0].answer_question, '승인까지 맡기시겠어요?');
  assert.equal(runSpec(w, ['set-status', w.spec, 'building']).status, 0);
  runSpec(w, ['set-status', w.spec, 'approved']);
  // 같은 줄이어도 그 답이 다른 질문에 대한 것이면 기록한 말이 아니다
  writeTranscript(w, [{ ...asked, toolUseResult: { questions: [], answers: { '다른 질문': '끝까지 알아서 해' }, annotations: {} } }]);
  assertRefused(runSpec(w, ['set-status', w.spec, 'building']), /다시 찾지 못했다/);
});

// ---------- 기록 파일 ----------

test('readApprovals skips broken lines and lines that are not records, and returns [] when there is no file', () => {
  const w = makeWorld();
  assert.deepEqual(readApprovals(w.run), []);
  mkdirSync(w.run, { recursive: true });
  const good = { version: 1, kind: 'approve', quote: '승인', message_time: T(1) };
  writeFileSync(path.join(w.run, 'approvals.jsonl'), `${JSON.stringify(good)}\n{"kind":"approve","quote\n\n[1]\n"문자열"\n${JSON.stringify({ kind: 'other' })}\n${JSON.stringify({ ...good, kind: 'delegate' })}\n`);
  assert.deepEqual(readApprovals(w.run).map((e) => e.kind), ['approve', 'delegate']);
  // 읽을 수 없으면 던진다: 확인 못 하면 거절하는 쪽이 받는다
  const bad = makeWorld();
  mkdirSync(path.join(bad.run, 'approvals.jsonl'), { recursive: true });
  assert.throws(() => readApprovals(bad.run), /EISDIR/);
  const r = runSpec(bad, ['set-status', bad.spec, 'building']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /EISDIR/);
});

test('a file with only broken lines is no record: the gate refuses (new spec) or passes as an old spec', () => {
  const w = makeWorld();
  mkdirSync(w.run, { recursive: true });
  writeFileSync(path.join(w.run, 'approvals.jsonl'), '이건 기록이 아니다\n{"kind":\n');
  assertRefused(runSpec(w, ['set-status', w.spec, 'building']), /승인 기록이 없다/);
  assert.ok(existsSync(path.join(w.run, 'approvals.jsonl')));
});
