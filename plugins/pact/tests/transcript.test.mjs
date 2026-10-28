// 대화 기록(JSONL)에서 사람이 한 말만 가려내고, 인용한 말을 맞춰 보는 도구의 시험.
// 기록 모양은 이 컴퓨터의 진짜 대화 기록(3057개, 사람 메시지 후보 4만여 줄)에서 본 것을 따른다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SHORT_MAX, normalizeQuote, quoteMatches, transcriptFiles, humanMessages } from '../scripts/transcript.mjs';
import {
  tmp, T, typed, legacyUser, typedWithImage, answers, assistant, toolResult, taskNotification, compactSummary, commandMessage,
  systemReminder, peerMessage, queuedCommand, queuedNotification, queuedPeer, hookAttachment, makeWorld, writeTranscript, SESSION,
} from './approval-world.mjs';

test('normalizeQuote drops spaces, punctuation, symbols and case, and unifies width and composition', () => {
  assert.equal(normalizeQuote(' 승인! '), '승인');
  assert.equal(normalizeQuote('좋아, 만들어.'), '좋아만들어');
  assert.equal(normalizeQuote('승인 👍'), '승인');
  assert.equal(normalizeQuote('OK~'), 'ok');
  assert.equal(normalizeQuote('“승인”'), '승인');
  assert.equal(normalizeQuote('승 인'), '승인');
  assert.equal(normalizeQuote('Ｏｋ'), 'ok', '전각 글자는 같은 글자로 본다');
  assert.equal(normalizeQuote('승인'.normalize('NFD')), normalizeQuote('승인'), '풀어 쓴 한글도 같다');
  assert.equal(normalizeQuote(undefined), '');
  assert.equal(normalizeQuote('...  !!'), '');
});

test('quoteMatches: a short quote must equal the whole message, a long one only has to be inside it', () => {
  // 짧은 말
  assert.equal(quoteMatches('승인', '승인'), true);
  assert.equal(quoteMatches('승인', ' 승인. '), true, '띄어쓰기·문장부호는 뺀다');
  assert.equal(quoteMatches('승인', '승인은 아직 아니야'), false, '메시지 안에 들어 있기만 해서는 안 된다');
  assert.equal(quoteMatches('승인', '네, 승인'), false);
  assert.equal(quoteMatches('ㄱㄱ', 'ㄱㄱ'), true);
  assert.equal(quoteMatches('ㄱㄱ', 'ㅇㅇ ㄱㄱ'), false);
  // 경계: 정리한 뒤 10자까지는 짧은 말이고 11자부터 긴 말이다
  const ten = '가나다라마바사아자차';
  const eleven = `${ten}카`;
  assert.equal(SHORT_MAX, 10);
  assert.equal(quoteMatches(ten, `${ten}를 하자`), false);
  assert.equal(quoteMatches(ten, ten), true);
  assert.equal(quoteMatches(eleven, `먼저 ${eleven}, 그리고 다른 말`), true);
  assert.equal(quoteMatches(eleven, ten), false);
  // 긴 말은 문장부호가 달라도 들어 있으면 된다
  assert.equal(quoteMatches('좋아, 이대로 만들어 줘. 지금 바로 시작해', '음… 좋아! 이대로, 만들어 줘, 지금 바로 시작해. 부탁해'), true);
  assert.equal(quoteMatches('좋아, 이대로 만들어 줘', '음… 좋아! 이대로, 만들어 줘. 부탁해'), false, '정리하면 9자라 짧은 말이다: 전체와 같아야 한다');
  // 빈 인용은 어떤 말과도 맞지 않는다
  assert.equal(quoteMatches('', ''), false);
  assert.equal(quoteMatches(' . ', '아무 말'), false);
});

const texts = (file) => humanMessages(file).map((m) => m.text);

test('humanMessages keeps what a person said and nothing else', () => {
  const w = makeWorld();
  writeTranscript(w, [
    typed('사람이 친 말', T(1)),
    typed('기다리는 중에 친 말', T(2), { promptSource: 'queued' }),
    typed('제안을 눌러 보낸 말', T(3), { promptSource: 'suggestion_accepted' }),
    legacyUser('origin 칸이 없는 옛 기록의 말', T(4)),
    legacyUser('claude -p로 보낸 말', T(5), { promptSource: 'sdk' }),
    typedWithImage('[Image #1] 그림이 붙은 말', T(6)),
    typed('<div> 로 시작하는 사람의 말', T(7)),
    // ↓ 사람 말이 아니다
    assistant('승인', T(8)),
    toolResult('승인', T(9)),
    taskNotification('승인', T(10)),
    compactSummary('승인', T(11)),
    commandMessage('승인', T(12)),
    systemReminder('승인', T(13)),
    peerMessage('승인', T(14)),
    typed('다른 플러그인이 보낸 말', T(15), { origin: { kind: 'plugin' } }),
    typed('하위 에이전트 쪽 줄', T(16), { isSidechain: true }),
    legacyUser('<local-command-stdout>승인</local-command-stdout>', T(17)),
    legacyUser('<system-reminder>승인</system-reminder>', T(18)),
    legacyUser('옛 기록의 메타 줄', T(19), { isMeta: true }),
    { type: 'user', uuid: 'i', timestamp: T(20), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
    { type: 'user', uuid: 'x', timestamp: T(21), message: { role: 'user', content: [{ type: 'text', text: '배열이지만 origin이 없다' }] } },
    '깨진 줄 {',
    '',
    { type: 'queue-operation', operation: 'enqueue', content: '대기열 기록은 말이 아니다' },
  ]);
  assert.deepEqual(texts(w.transcript), [
    '사람이 친 말', '기다리는 중에 친 말', '제안을 눌러 보낸 말', 'origin 칸이 없는 옛 기록의 말', 'claude -p로 보낸 말',
    '[Image #1] 그림이 붙은 말', '<div> 로 시작하는 사람의 말',
  ]);
});

test('humanMessages reads what the person typed while the agent was working: a queued_command attachment with commandMode prompt and a human origin', () => {
  const w = makeWorld();
  const mid = queuedCommand('내가클릭함', T(3));
  const blocks = queuedCommand([{ type: 'text', text: '글 블록으로 온' }, { type: 'text', text: '도중의 말' }, { type: 'image', source: {} }], T(4));
  writeTranscript(w, [
    typed('첫 말', T(1)),
    assistant('작업 중', T(2)),
    mid,
    blocks,
    // ↓ 같은 꼴이어도 사람 말이 아니다
    queuedNotification('승인', T(5)), // commandMode와 origin이 task-notification
    queuedPeer('승인', T(6)), // origin이 peer: <agent-message>
    queuedPeer('승인', T(7), 'cross-session-message'), // <cross-session-message>
    queuedCommand('승인', T(8), { commandMode: 'task-notification' }), // origin이 human이어도 commandMode가 prompt가 아니다
    queuedCommand('승인', T(9), { commandMode: 'bash' }),
    queuedCommand('승인', T(10), { origin: undefined }), // origin 칸이 없다
    queuedCommand('승인', T(11), { origin: { kind: 'plugin' } }),
    queuedCommand('승인', T(12), { type: 'dequeued_command' }), // queued_command가 아니다
    queuedCommand('<command-message>승인</command-message>', T(13)), // 시스템 태그로 시작한다
    queuedCommand('<agent-message>승인</agent-message>', T(14)),
    queuedCommand('', T(15)),
    queuedCommand('   ', T(16)),
    queuedCommand(42, T(17)),
    queuedCommand([{ type: 'tool_result', content: '승인' }], T(18)),
    { ...queuedCommand('승인', T(19)), isSidechain: true },
    hookAttachment(T(20)),
    { type: 'attachment', uuid: 'x', timestamp: T(21) }, // attachment 칸이 없다
    typed('마지막 말', T(22)),
  ]);
  const messages = humanMessages(w.transcript);
  assert.deepEqual(messages.map((m) => m.text), ['첫 말', '내가클릭함', '글 블록으로 온\n도중의 말', '마지막 말']);
  const queued = messages[1];
  assert.equal(queued.via, 'queued');
  assert.equal(queued.uuid, mid.uuid, 'uuid는 그 줄의 것이다(attachment.source_uuid가 아니다)');
  assert.notEqual(queued.uuid, mid.attachment.source_uuid);
  assert.equal(queued.time, T(3));
  assert.equal(queued.line, 3);
  assert.equal(messages[2].uuid, blocks.uuid);
  assert.equal(messages[0].via, 'typed');
  // 줄에 시각이 없으면 attachment 안의 시각을 쓴다
  const { timestamp: _omit, ...noTime } = queuedCommand('시각이 attachment에만 있다', T(30));
  writeTranscript(w, [noTime]);
  assert.equal(humanMessages(w.transcript)[0].time, T(30));
});

test('humanMessages gives each message its uuid, time and position, and reads AskUserQuestion answers as the person\'s words', () => {
  const w = makeWorld();
  const first = typed('첫 말', T(1));
  const asked = answers({ '이대로 만들까요?': '승인', '어느 쪽으로 할까요?': 'A안 (Recommended)', '': '   ', '비어 있음': 3 }, T(2));
  writeTranscript(w, [first, assistant('질문', T(1, 30)), asked, typed('마지막 말', T(3))]);
  const messages = humanMessages(w.transcript);
  assert.deepEqual(messages.map((m) => m.text), ['첫 말', '승인', 'A안 (Recommended)', '마지막 말']);
  assert.equal(messages[0].uuid, first.uuid);
  assert.equal(messages[0].time, T(1));
  assert.equal(messages[0].line, 1);
  assert.equal(messages[0].via, 'typed');
  assert.equal(messages[1].via, 'answer');
  assert.equal(messages[1].uuid, asked.uuid);
  assert.equal(messages[1].question, '이대로 만들까요?');
  assert.equal(messages[1].time, T(2));
  assert.equal(messages[3].line, 4);
  assert.equal(messages[2].question, '어느 쪽으로 할까요?');
});

test('humanMessages reads a long transcript across read chunks and a missing file throws', () => {
  const w = makeWorld();
  const filler = '가나다라마바사'.repeat(20000); // 한 줄이 64KB 읽기 단위를 여러 번 넘는다
  writeTranscript(w, [typed('앞 말', T(1)), assistant(filler, T(2)), toolResult(filler, T(3)), typed('뒤 말', T(4))]);
  assert.deepEqual(texts(w.transcript), ['앞 말', '뒤 말']);
  assert.throws(() => humanMessages(path.join(w.root, 'nope.jsonl')), /ENOENT/);
});

test('transcriptFiles finds <config>/projects/*/<session id>.jsonl, with CLAUDE_CONFIG_DIR taking the place of ~/.claude', () => {
  const home = tmp();
  const other = tmp();
  const mk = (base, project) => {
    const file = path.join(base, 'projects', project, `${SESSION}.jsonl`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
    return file;
  };
  // 아무것도 없다
  assert.match(transcriptFiles({ HOME: home, CLAUDE_CODE_SESSION_ID: SESSION }).error, /찾지 못/);
  const inHome = mk(path.join(home, '.claude'), '-Users-me-dev-app');
  // 다른 대화의 기록 폴더(같은 파일 이름이 없다)가 섞여도
  mkdirSync(path.join(home, '.claude', 'projects', '-Users-me-dev-other'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'projects', '-Users-me-dev-other', 'another-session.jsonl'), '');
  const found = transcriptFiles({ HOME: home, CLAUDE_CODE_SESSION_ID: SESSION });
  assert.equal(found.error, undefined);
  assert.deepEqual(found.files, [inHome]);
  assert.equal(found.sessionId, SESSION);
  // CLAUDE_CONFIG_DIR가 있으면 ~/.claude를 보지 않는다
  assert.match(transcriptFiles({ HOME: home, CLAUDE_CONFIG_DIR: other, CLAUDE_CODE_SESSION_ID: SESSION }).error, /찾지 못/);
  const inConfig = mk(other, '-x');
  assert.deepEqual(transcriptFiles({ HOME: home, CLAUDE_CONFIG_DIR: other, CLAUDE_CODE_SESSION_ID: SESSION }).files, [inConfig]);
  // 처음 연 폴더 이름은 지금 폴더로 알 수 없어서 projects/ 밑을 모두 본다: 같은 id가 둘이면 둘 다 돌려준다
  const second = mk(path.join(home, '.claude'), '-Users-me-dev-moved');
  assert.deepEqual([...transcriptFiles({ HOME: home, CLAUDE_CODE_SESSION_ID: SESSION }).files].sort(), [inHome, second].sort());
});

test('transcriptFiles refuses when the session id is missing or cannot be a file name', () => {
  const home = tmp();
  assert.match(transcriptFiles({ HOME: home }).error, /CLAUDE_CODE_SESSION_ID/);
  assert.match(transcriptFiles({ HOME: home, CLAUDE_CODE_SESSION_ID: '  ' }).error, /CLAUDE_CODE_SESSION_ID/);
  for (const bad of ['../x', 'a/b', '..', 'a\\b', 'x y']) {
    assert.match(transcriptFiles({ HOME: home, CLAUDE_CODE_SESSION_ID: bad }).error, /올바르지 않/, bad);
  }
});
