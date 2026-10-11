import { test, expect } from 'claude-code/testing'

import { fakeSession, turnOn } from './testkit'

import { countChars, pickRecent, ruleText, splitBlocks, textKey, turnNote } from './answer-blocks'

test('the rule names the three blocks and drops the length cap', () => {
  const r = ruleText()
  expect(r).toContain('첫 문단: 사용자가 물은 것에 답한다')
  expect(r).toContain('단서(확인 못 함·추정·실패·위험)와 사용자가 판단에 쓸 숫자는 첫 문단에 쓴다')
  expect(r).toContain('"설명:"으로 시작하는 문단')
  expect(r).toContain('"물을 것:"')
  expect(r).toContain('길이 제한은 없다')
})

test('an answer splits into answer, explanation and user turn', () => {
  const text = '네, 둘 다 켜져요.\n\n설명: 새 프로세스에서 확인했어요.\n두 번째 줄.\n\n물을 것: 데스크톱에도 켤까요?\n볼 것: /blocks 출력'
  expect(splitBlocks(text)).toEqual({
    answer: '네, 둘 다 켜져요.',
    explain: '새 프로세스에서 확인했어요.\n두 번째 줄.',
    turn: '물을 것: 데스크톱에도 켤까요?\n볼 것: /blocks 출력',
    notice: '',
  })
})

test('without markers everything stays in the answer', () => {
  expect(splitBlocks('그냥 답이에요.\n둘째 줄.')).toEqual({ answer: '그냥 답이에요.\n둘째 줄.', explain: '', turn: '', notice: '' })
})

// 2026-10-11 사용자 "답이 필요없는 질문인데 사이드로옴": 다르게 한 것은 답할 것이 없어 내 차례로 보내지 않고 본문에 남긴다
test('what was done differently is a notice kept apart from the user turn, wherever it sits', () => {
  const text = '고쳤어요.\n\n설명: 길게.\n\n물을 것: 커밋할까요?\n다르게 한 것: 요청 밖의 일로 빈 폴더를 지웠어요.\n- **다르게 한 것:** 사용률을 더했어요.\n볼 것: /api/gateway 출력'
  expect(splitBlocks(text)).toEqual({
    answer: '고쳤어요.',
    explain: '길게.',
    turn: '물을 것: 커밋할까요?\n볼 것: /api/gateway 출력',
    notice: '다르게 한 것: 요청 밖의 일로 빈 폴더를 지웠어요.\n- **다르게 한 것:** 사용률을 더했어요.',
  })
  expect(splitBlocks('했어요.\n```\n다르게 한 것: 코드 안\n```').notice).toBe('')
})

test('labels inside code blocks do not split; bold labels do', () => {
  const text = '답.\n```\n설명: 코드 안\n물을 것: 코드 안\n```\n**설명:** 진짜 설명\n- **물을 것:** 진짜 질문?'
  const b = splitBlocks(text)
  expect(b.answer).toBe('답.\n```\n설명: 코드 안\n물을 것: 코드 안\n```')
  expect(b.explain).toBe('진짜 설명')
  expect(b.turn).toBe('- **물을 것:** 진짜 질문?')
})

test('a label on its own line starts the explanation without an empty first line', () => {
  expect(splitBlocks('답.\n설명:\n내용').explain).toBe('내용')
})

test('counting and keys ignore whitespace and code', () => {
  expect(countChars('가  나\n```\nxxxx\n```')).toBe(countChars('가 나'))
  expect(textKey('가  나')).toBe(textKey('가 나'))
})

test('user-turn lines leave one note in the body', () => {
  expect(turnNote('물을 것: A를 할까요?\n볼 것: B\n물을 것: C?')).toBe('↩ 물을 것 2 · 볼 것 1 → 옆 패널 내 차례 (/baton-side)')
  expect(turnNote('- **볼 것:** D')).toBe('↩ 볼 것 1 → 옆 패널 내 차례 (/baton-side)')
})

test('the rule tells the turn lines to stand alone', () => {
  expect(ruleText()).toContain('본문을 가리키는 말을 쓰지 않는다')
})

test('/baton-e picks the last answer, /baton-e 2 the one before', () => {
  expect(pickRecent(['a', 'b', 'c'], '')).toBe('c')
  expect(pickRecent(['a', 'b', 'c'], '2')).toBe('b')
  expect(pickRecent(['a', 'b', 'c'], '4')).toBe(undefined)
  expect(pickRecent(['a'], 'x')).toBe(undefined)
})

test('the body keeps what was done differently under the folded explanation; the panel note counts only questions and things to look at', async ($, on) => {
  fakeSession(on)
  await turnOn($)
  const mount = (text: string) => $.ui.mount({ plugin: 'baton', surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true } })
  const both = await mount('고쳤어요.\n\n설명:\n- 확인한 것: 테스트\n\n물을 것: 커밋할까요?\n다르게 한 것: 요청 밖의 일로 빈 폴더를 지웠어요.')
  expect((await both.find({ key: 'notice' }))?.text).toBe('다르게 한 것: 요청 밖의 일로 빈 폴더를 지웠어요.')
  expect((await both.find({ type: 'Text', text: '↩' }))?.text).toBe('↩ 물을 것 1 → 옆 패널 내 차례 (/baton-side)')
  const noticeOnly = await mount('고쳤어요.\n\n설명:\n- 확인한 것: 테스트\n\n다르게 한 것: 요청 밖의 일로 빈 폴더를 지웠어요.')
  expect(await noticeOnly.find({ key: 'notice' })).not.toBe(undefined)
  expect(await noticeOnly.find({ type: 'Text', text: '↩' })).toBe(undefined)
})

test('/baton-e says so when no answer has an explanation yet', async ($, on) => {
  fakeSession(on)
  await turnOn($)
  const r = await $.command.run({ command: 'baton-e', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  expect(r.text).toContain('아직 없어요')
})

import { explainIndex } from './answer-blocks'

test('the folded explanation shows its top-level item names, not the sub-items', () => {
  const ex = [
    '- tmux로 확인하다가 찾은 문제',
    '  - 토론 탭에서 m을 누르면: 글자로 들어갔어요.',
    '- 바꾼 저장 방식',
    '  - 토론: qa, sent',
    '- 확인한 것: tsc와 validate가 통과했어요.',
    '- **하지 않은 것**: /blocks',
    '```',
    '- 코드 안 줄',
    '```',
  ].join('\n')
  expect(explainIndex(ex)).toEqual(['tmux로 확인하다가 찾은 문제', '바꾼 저장 방식', '확인한 것', '하지 않은 것'])
  expect(explainIndex('목록 없는 설명 문단이에요.')).toEqual(['목록 없는 설명 문단이에요.'])
  expect(explainIndex('1. **정의에서 나옴 (페아노 공리):** 1 = S(0)\n2. **세기의 직관과 일치:** 합친다')).toEqual(['정의에서 나옴 (페아노 공리)', '세기의 직관과 일치'])
  expect(explainIndex('먼저 tsc를 돌렸고 통과했어요.\n둘째 줄\n\n그다음 tmux로 화면을 봤어요.')).toEqual(['먼저 tsc를 돌렸고 통과했어요.', '그다음 tmux로 화면을 봤어요.'])
})

import type { TestBody } from 'claude-code/testing'

import { OFF_RULE } from './answer-blocks'
import { RUN } from './testkit'

const ASK = { origin: { kind: 'composer' as const }, wait: false }
// 압축은 메시지를 적어도 하나 남긴다
const SUMMARY = [{ role: 'user' as const, text: '지금까지의 요약', toolUses: [] }]

// 엔진 바닥: 들어간 프롬프트마다 받은 맥락을 적는다. dropAt번째(0부터) 프롬프트는 들어가지 않는다(곁대화로 보낸 경우처럼)
function core(on: Parameters<TestBody>[1], dropAt = -1) {
  const got: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_$, e) => {
    got.push(e.context)
    return got.length - 1 === dropAt ? { drop: '곁대화에서 답해요' } : { text: e.text }
  })
  return got
}

test('the rule rides beside the first prompt of a conversation, once', async ($, on) => {
  fakeSession(on)
  const got = core(on)
  await turnOn($)
  await $.prompt.submit({ text: '첫 질문', ...ASK })
  await $.prompt.submit({ text: '둘째 질문', ...ASK })
  expect(got).toEqual([[ruleText()], undefined])
})

test('the rule is not put in the system prompt, where cc-plugin-sec-default skips user plugins', async ($, on) => {
  fakeSession(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: '시스템', scope: 'shared' as const }] }))
  await turnOn($)
  const r = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(r.sections.map(s => s.id)).toEqual(['intro'])
})

test('a session not chosen with /baton gets no rule', async ($, on) => {
  fakeSession(on)
  const got = core(on)
  await $.prompt.submit({ text: '질문', ...ASK })
  expect(got).toEqual([undefined])
})

test('after a compaction of the main conversation the next prompt carries the rule again', async ($, on) => {
  fakeSession(on)
  const got = core(on)
  on('session.compact', (_$, e) => (e.instructions === 'skip' ? { skip: '막음' } : { messages: e.messages }))
  await turnOn($)
  await $.prompt.submit({ text: 'a', ...ASK })
  await $.session.compact({ trigger: 'precompute', messages: SUMMARY })
  await $.session.compact({ trigger: 'auto', agentId: 'sub-1', messages: SUMMARY })
  await $.session.compact({ trigger: 'manual', instructions: 'skip', messages: SUMMARY })
  await $.prompt.submit({ text: 'b', ...ASK })
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  await $.prompt.submit({ text: 'c', ...ASK })
  await $.prompt.submit({ text: 'd', ...ASK })
  expect(got).toEqual([[ruleText()], undefined, [ruleText()], undefined])
})

test('/clear goes on under a new session id, and that conversation gets the rule again', async ($, on) => {
  const s = fakeSession(on, 'A')
  const got = core(on)
  await turnOn($)
  await $.prompt.submit({ text: 'a', ...ASK })
  s.id = 'B'
  await $.prompt.submit({ text: 'b', ...ASK })
  await $.prompt.submit({ text: 'c', ...ASK })
  expect(got).toEqual([[ruleText()], [ruleText()], undefined])
})

test('a prompt that did not enter (sent to the side chat) does not count as carrying the rule', async ($, on) => {
  fakeSession(on)
  const got = core(on, 0)
  await turnOn($)
  await $.prompt.submit({ text: '곁질문', ...ASK })
  await $.prompt.submit({ text: '본 질문', ...ASK })
  expect(got).toEqual([[ruleText()], [ruleText()]])
})

test('/baton off after the rule went in tells the model once that the rule no longer applies; on again brings it back', async ($, on) => {
  fakeSession(on)
  const got = core(on)
  await turnOn($)
  await $.prompt.submit({ text: 'a', ...ASK })
  await $.command.run({ command: 'baton', args: 'off', ...RUN })
  await $.prompt.submit({ text: 'b', ...ASK })
  await $.prompt.submit({ text: 'c', ...ASK })
  await turnOn($)
  await $.prompt.submit({ text: 'd', ...ASK })
  expect(got).toEqual([[ruleText()], [OFF_RULE], undefined, [ruleText()]])
})

test('the rule says it holds for the whole conversation', () => {
  expect(ruleText()).toContain('이 대화의 모든 답에 적용한다')
})
