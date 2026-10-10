import { test, expect, mock } from 'claude-code/testing'

import { fakeSession, turnOn } from './testkit'

import type { Ask, Book } from '../types'
import { answeredIds, answerMark, apply, carryKey, endMarkOf, END_MARKS, withEndMark, contextText, judgePrompt, labeledAsks, lastExchange, mayAsk, mergeCarried, parseJudgment, readCarried, restore, isHuman, settingsFrom, supersede, tailText, toCarry, waiting } from './open-asks'

const ask = (id: number, text: string, skips = 0, turn = 1): Ask => ({ id, text, turn, at: 0, skips })
const empty: Book = { items: [], closed: [], seq: 0 }

test('settings fall back to sonnet', () => {
  expect(settingsFrom({})).toEqual({ model: 'sonnet' })
  expect(settingsFrom({ judge_model: 'haiku' })).toEqual({ model: 'haiku' })
})

test('answers without a question skip the model when nothing is open', () => {
  expect(mayAsk('적용했어요.')).toBe(false)
  expect(mayAsk('세 가지를 같이 적용할까요?')).toBe(true)
  expect(mayAsk('물을 것: 720자 기준')).toBe(true)
  expect(mayAsk('끝났어요.\n```\nif (a?.b) x()\n```')).toBe(false)
})

test('judgment parsing tolerates fences and drops junk', () => {
  expect(parseJudgment('```json\n{"closed":[1,"2",0,-1],"new":["A할까요?"," ",3]}\n```')).toEqual({ closed: [1, 2], added: ['A할까요?'] })
  expect(parseJudgment('모르겠어요')).toBe(undefined)
  expect(parseJudgment('{"closed": [1,}')).toBe(undefined)
  expect(parseJudgment('{"new":["a","b","c","d"]}')?.added.length).toBe(3)
})

test('the user-turn lines go up as they are, outside code blocks', () => {
  const answer = '결론이에요.\n\n설명: 길게.\n\n**물을 것:** 세 가지를 같이 적용할까요?\n- 볼 것: /short 출력\n다르게 한 것: 접기도 바꿨어요.\n```\n물을 것: 코드 안\n```'
  expect(labeledAsks(answer)).toEqual(['세 가지를 같이 적용할까요?', '볼 것: /short 출력', '다르게 한 것: 접기도 바꿨어요.'])
  expect(labeledAsks('물을 것 없음')).toEqual([])
  expect(labeledAsks('물을 것:   ')).toEqual([])
})

test('the judge is told which items were already taken from this answer', () => {
  const p = judgePrompt([], 'q', 'a', 1, ['볼 것: X'])
  expect(p).toContain('- 볼 것: X')
  expect(p).toContain('"볼 것:"이나 "다르게 한 것:"으로 시작하는 항목은')
})

test('an unanswered question counts a skip; an answered one closes', () => {
  const b: Book = { items: [ask(1, 'A를 적용할까요?'), ask(2, 'B로 갈까요?')], closed: [], seq: 2 }
  const next = apply(b, [1, 2], [2], ['C를 켤까요?'], 3, 100, true)
  expect(next.items.map(a => [a.id, a.skips])).toEqual([[1, 1], [3, 0]])
  expect(next.closed).toEqual([{ text: 'B로 갈까요?', at: 100 }])
  expect(next.seq).toBe(3)
})

test('no skips without a human turn or for questions the judge did not see', () => {
  const b: Book = { items: [ask(1, 'A?'), ask(2, 'B?')], closed: [], seq: 2 }
  expect(apply(b, [1, 2], [], [], 3, 0, false).items.map(a => a.skips)).toEqual([0, 0])
  expect(apply(b, [1], [], [], 3, 0, true).items.map(a => a.skips)).toEqual([1, 0])
})

test('a question already open is not added twice', () => {
  const b: Book = { items: [ask(1, '세 가지를 같이 적용할까요?')], closed: [], seq: 1 }
  expect(apply(b, [1], [], ['세 가지를  같이 적용할까요'], 2, 0, true).items.length).toBe(1)
  expect(apply(empty, [], [], ['A?', 'A?'], 1, 0, true).items.length).toBe(1)
})

test('the model context carries only questions that went past a reply', () => {
  const b: Book = { items: [ask(1, '오래된 질문?', 2), ask(2, '방금 질문?', 0)], closed: [], seq: 2 }
  expect(waiting(b).map(a => a.id)).toEqual([1])
})

test('the hint line always says how many questions are open', () => {
  expect(tailText(empty)).toBe('↩ 내 차례 없음')
  expect(tailText({ items: [ask(1, 'A?'), ask(2, 'B?', 1)], closed: [], seq: 2 })).toBe('↩ 내 차례 2')
})

test('the judge sees which questions are fresh and which were skipped', () => {
  const p = judgePrompt([ask(1, 'A?', 1, 2), ask(2, 'B?', 0, 5)], 'ㅇㅇ', '했어요', 5)
  expect(p).toContain('1. A? (3턴 전에 물었고 아직 답 없음)')
  expect(p).toContain('2. B? (직전 답에서 물음)')
  expect(judgePrompt([], undefined, '알림 처리', 1)).toContain('(없음: 알림 등으로 시작된 턴)')
})

test('the model context numbers the band rows the same way', () => {
  const t = contextText([ask(4, 'A를 적용할까요?', 1), ask(9, 'B로 갈까요?', 2)])
  expect(t).toContain('1. A를 적용할까요?')
  expect(t).toContain('2. B로 갈까요?')
})

test('after a reload the last answer and the message before it are found', () => {
  const msgs = [
    { role: 'user', text: '다시 띄워봐' },
    { role: 'assistant', text: '' },
    { role: 'user', text: '' },
    { role: 'assistant', text: '고쳤어요. 보이나요?' },
  ]
  expect(lastExchange(msgs)).toEqual({ request: '다시 띄워봐', answer: '고쳤어요. 보이나요?' })
  expect(lastExchange([{ role: 'assistant', text: '안녕하세요?' }])).toEqual({ request: '', answer: '안녕하세요?' })
  expect(lastExchange([{ role: 'user', text: 'hi' }])).toBe(undefined)
  expect(lastExchange([])).toBe(undefined)
})

test('notices from an earlier answer close when the next answer lands; questions stay', () => {
  const b: Book = { items: [ask(1, '세 가지를 적용할까요?'), ask(2, '볼 것: /baton-side 출력'), ask(3, '다르게 한 것: 띠를 뺐어요.')], closed: [], seq: 3 }
  const next = supersede(b, 9)
  expect(next.items.map(a => a.id)).toEqual([1])
  expect(next.closed.map(c => c.text)).toEqual(['볼 것: /baton-side 출력', '다르게 한 것: 띠를 뺐어요.'])
  expect(supersede(next, 10)).toBe(next)
})

test('undo puts removed items back in their places without duplicates', () => {
  const removed = [ask(1, 'debate를 끌까요?'), ask(2, '볼 것: 패널')]
  const now: Book = { items: [ask(3, '볼 것: 패널'), ask(4, '새 질문?')], closed: [], seq: 4 }
  expect(restore(now, removed).items.map(a => a.id)).toEqual([1, 3, 4])
  expect(restore(empty, removed).items.map(a => a.id)).toEqual([1, 2])
  // 3번을 지우고 1번을 지웠어도 되돌리면 원래 순서다
  const kept: Book = { items: [ask(2, 'B?'), ask(4, 'D?')], closed: [], seq: 4 }
  expect(restore(kept, [ask(3, 'C?'), ask(1, 'A?')]).items.map(a => a.id)).toEqual([1, 2, 3, 4])
})

test('only questions carry to the next session, marked once', () => {
  const b: Book = { items: [ask(1, 'debate를 옮길까요?'), ask(2, '볼 것: 패널'), ask(3, '지난 세션: 예전 질문?')], closed: [], seq: 3 }
  expect(toCarry(b).map(c => c.text)).toEqual(['지난 세션: debate를 옮길까요?', '지난 세션: 예전 질문?'])
  expect(carryKey('/Users/me/dev')).toBe('carry:/Users/me/dev')
})

test('carried items merge without duplicates and ignore junk', () => {
  const old = [{ text: '지난 세션: A?', at: 1 }, { nope: true }, 'x']
  expect(readCarried(old)).toEqual([{ text: '지난 세션: A?', at: 1 }])
  expect(mergeCarried(old, [{ text: '지난 세션: A?', at: 2 }, { text: '지난 세션: B?', at: 3 }]).map(c => c.text)).toEqual(['지난 세션: A?', '지난 세션: B?'])
  expect(readCarried(undefined)).toEqual([])
})

test('answers a mod sent as the person count as a human turn', () => {
  expect(isHuman({ kind: 'composer' })).toBe(true)
  expect(isHuman({ kind: 'plugin', asUser: true })).toBe(true)
  expect(isHuman({ kind: 'plugin' })).toBe(false)
  expect(isHuman({ kind: 'notification' })).toBe(false)
})

test('"↩ item → answer" lines name the items they answer', () => {
  const items = [ask(1, 'debate를 옮길까요?'), ask(2, 'A → B로 바꿀까요?'), ask(3, '볼 것: 패널')]
  expect(answeredIds(items, '↩ debate를 옮길까요? → ㅇㅇ\n  ↩ A → B로 바꿀까요? → 아니\n그리고 이것도')).toEqual([1, 2])
  expect(answeredIds(items, '↩ debate를 옮길까요? → ')).toEqual([])
  expect(answeredIds(items, 'debate를 옮길까요? → ㅇㅇ')).toEqual([])
  expect(answeredIds(items, '↩ 없는 질문? → ㅇㅇ')).toEqual([])
})

test('answers another mod sends as the person close their items before the turn starts', async ($, on) => {
  fakeSession(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => ({ text: e.text, ...(e.context ? { context: e.context } : {}) }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"closed":[],"new":[]}', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  const asks = async () => (await $.command.run({ command: 'baton-side', args: 'list', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).text
  await turnOn($)
  await $.turn.complete({ answer: '했어요.\n\n물을 것: debate를 옮길까요?\n물을 것: 자동 분리를 끌까요?', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' })
  expect(await asks()).toContain('내 차례 2개')
  await $.prompt.submit({ text: '↩ debate를 옮길까요? → ㅇㅇ', origin: { kind: 'plugin', name: 'side-panel', asUser: true }, wait: false })
  const after = await asks()
  expect(after).toContain('내 차례 1개\n1. 자동 분리를 끌까요?')
  expect(after).toContain('- debate를 옮길까요?')
})

test('items keep their whole text up to 300 characters', () => {
  const long = `볼 것: 옆 패널 내 차례에서 [답하기]로 답 하나를 쓰고 보내기를 눌렀을 때 ${'가'.repeat(120)}`
  expect(apply(empty, [], [], [long], 1, 0, false).items[0]?.text).toBe(long)
  expect(apply(empty, [], [], ['나'.repeat(400)], 1, 0, false).items[0]?.text.length).toBe(300)
})

test('a -p or SDK session (not interactive) collects nothing; an interactive one does', async ($, on) => {
  fakeSession(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"closed":[],"new":[]}', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  const list = async () => (await $.command.run({ command: 'baton-side', args: 'list', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).text
  const answer = { answer: '했어요.\n\n물을 것: A?', reason: 'answer' as const, durationMs: 1, isAborted: false, turnId: 't1' }
  await turnOn($)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await $.turn.complete(answer)
  // /baton on으로 고른 세션이라도 -p·SDK에서는 꺼져 있다
  expect(await list()).toContain('꺼져 있어요')
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ ...answer, turnId: 't2' })
  expect(await list()).toContain('내 차례 1개')
})

test('the mark of a judged answer ignores spacing and tells answers apart', () => {
  expect(answerMark('했어요.\n\n물을 것: A?')).toBe(answerMark('했어요.\n물을 것:  A? '))
  expect(answerMark('했어요.\n\n물을 것: A?')).not.toBe(answerMark('했어요.\n\n물을 것: B?'))
})

// 2026-10-09 /reload-plugins 뒤 [지우기]로 지운 질문이 되살아났다: 다시 불러올 때(session.start) 이미 판정한 마지막 답은 다시 판정하지 않는다
test('a reload does not judge the last answer again, so a dropped item stays dropped; an unjudged one is caught up', async ($, on) => {
  fakeSession(on)
  // session.start는 catchUp을 기다리지 않고 띄운다: 끝난 뒤에 보려고 settle한다
  const clock = mock.clock(on)
  let msgs = [
    { role: 'user' as const, text: '메모 앱 만들어 줘', toolUses: [] },
    { role: 'assistant' as const, text: '했어요.\n\n물을 것: A?', toolUses: [] },
  ]
  on('session.messages', () => ({ value: msgs }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"closed":[],"new":[]}', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  const side = async (args: string) => (await $.command.run({ command: 'baton-side', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })).text
  const start = async () => {
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.settle()
  }
  await turnOn($)
  await start()
  await $.turn.complete({ answer: '했어요.\n\n물을 것: A?', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' })
  await clock.settle()
  expect(await side('list')).toContain('내 차례 1개')
  await side('drop 1')
  await start()
  expect(await side('list')).toContain('내 차례 없음')
  // 판정이 끊겨 적히지 않은 답(여기서는 대화에만 있는 새 답)은 다시 불러올 때 판정한다
  msgs = [...msgs, { role: 'assistant' as const, text: '고쳤어요.\n\n물을 것: B?', toolUses: [] }]
  await start()
  expect(await side('list')).toContain('B?')
})

test('the end marks keep one per session, newest last, at most 50, and ignore junk', () => {
  let m: Record<string, string> = withEndMark(undefined, 'a', '1:x')
  m = withEndMark(m, 'b', '2:y')
  m = withEndMark(m, 'a', '3:z')
  expect(Object.keys(m)).toEqual(['b', 'a'])
  expect(endMarkOf(m, 'a')).toBe('3:z')
  expect(endMarkOf(m, 'c')).toBe('')
  expect(endMarkOf(['a'], 'a')).toBe('')
  expect(endMarkOf({ a: 3 }, 'a')).toBe('')
  for (let i = 0; i < 60; i++) m = withEndMark(m, `s${i}`, 'm')
  expect(Object.keys(m).length).toBe(50)
})

// --resume하면 $.state가 비어 지문도 사라진다(2026-10-09 --continue 뒤 지운 질문이 되살아났다): 세션이 끝날 때 store에 세션 id별로 남긴다
test('a session that ends leaves the mark of its last judged answer in the store under its id', async ($, on) => {
  const s = fakeSession(on)
  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"closed":[],"new":[]}', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  await turnOn($)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const answer = '했어요.\n\n물을 것: A?'
  await $.turn.complete({ answer, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' })
  await clock.settle()
  await $.session.end({ reason: 'other', sessionId: 'test-session', resume: { id: 'test-session' } })
  expect(endMarkOf(s.store.get(END_MARKS), 'test-session')).toBe(answerMark(answer))
})
