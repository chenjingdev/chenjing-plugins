import { test, expect } from 'claude-code/testing'

import { fakeSession, modsOn } from './testkit'

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
  })
})

test('without markers everything stays in the answer', () => {
  expect(splitBlocks('그냥 답이에요.\n둘째 줄.')).toEqual({ answer: '그냥 답이에요.\n둘째 줄.', explain: '', turn: '' })
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
  expect(turnNote('물을 것: A를 할까요?\n볼 것: B\n물을 것: C?')).toBe('↩ 물을 것 2 · 볼 것 1 → 옆 패널 내 차례 (/side)')
  expect(turnNote('- **다르게 한 것:** D')).toBe('↩ 다르게 한 것 1 → 옆 패널 내 차례 (/side)')
})

test('the rule tells the turn lines to stand alone', () => {
  expect(ruleText()).toContain('본문을 가리키는 말을 쓰지 않는다')
})

test('/e picks the last answer, /e 2 the one before', () => {
  expect(pickRecent(['a', 'b', 'c'], '')).toBe('c')
  expect(pickRecent(['a', 'b', 'c'], '2')).toBe('b')
  expect(pickRecent(['a', 'b', 'c'], '4')).toBe(undefined)
  expect(pickRecent(['a'], 'x')).toBe(undefined)
})

test('/e says so when no answer has an explanation yet', async ($, on) => {
  fakeSession(on)
  await modsOn($)
  const r = await $.command.run({ command: 'e', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
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
