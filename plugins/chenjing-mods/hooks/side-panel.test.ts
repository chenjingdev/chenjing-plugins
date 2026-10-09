import { test, expect } from 'claude-code/testing'

import { fakeSession, modsOn, RUN } from './testkit'
import type { Engine, TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

import { answersText, classifyPrompt, draftWith, focusAfter, forkPrompt, isHuman, isSide, recentWork, ringAfterDrop, settingsFrom, worthChecking } from './side-panel'

test('settings default to haiku with automatic routing off', () => {
  expect(settingsFrom({})).toEqual({ model: 'haiku', auto: false })
  expect(settingsFrom({ classify_model: 'sonnet', side_auto: 'on' })).toEqual({ model: 'sonnet', auto: true })
})

test('only question-like messages are checked', () => {
  expect(worthChecking('근데 zsh랑 bash 차이가 뭐야?')).toBe(true)
  expect(worthChecking('점심 뭐 먹지')).toBe(true)
  expect(worthChecking('Jev가 뭐였지')).toBe(true)
  expect(worthChecking('ㅇㅇ')).toBe(false)
  expect(worthChecking('굳')).toBe(false)
  expect(worthChecking('그거 적용해줘?')).toBe(false)
  expect(worthChecking('/short')).toBe(false)
  expect(worthChecking('↩ 세 가지 적용할까요? → ㅇㅇ')).toBe(false)
  expect(worthChecking('길이제한은 따로 필요없을거 같음')).toBe(false)
  expect(worthChecking('첫 줄?\n둘째 줄')).toBe(false)
})

test('the reply counts as side only when it clearly says SIDE', () => {
  expect(isSide('SIDE')).toBe(true)
  expect(isSide(' side\n')).toBe(true)
  expect(isSide('MAIN')).toBe(false)
  expect(isSide('SIDE or MAIN')).toBe(false)
  expect(isSide('')).toBe(false)
})

test('the work context is the last answer and the request before it', () => {
  const msgs = [
    { role: 'user', text: '모드 만들자' },
    { role: 'assistant', text: '' },
    { role: 'user', text: '' },
    { role: 'assistant', text: '만들었어요.' },
  ]
  expect(recentWork(msgs)).toEqual({ request: '모드 만들자', answer: '만들었어요.' })
  expect(recentWork([])).toEqual({ request: '', answer: '' })
})

test('the prompt leans to MAIN when unsure', () => {
  const p = classifyPrompt('요청', '답', '새 질문?')
  expect(p).toContain('애매하면 MAIN')
  expect(p).toContain('새 질문?')
})

test('only the person typing is checked', () => {
  expect(isHuman({ kind: 'composer' })).toBe(true)
  expect(isHuman({ kind: 'plugin' })).toBe(false)
})

test('the panel fork carries the earlier side turns and the new question', () => {
  const p = forkPrompt([{ q: 'zsh랑 bash 차이?', a: '대화형은 zsh.' }, { q: '실패한 질문', err: 'x' }], 'fish는?')
  expect(p).toContain('Q: zsh랑 bash 차이?\nA: 대화형은 zsh.')
  expect(p).not.toContain('실패한 질문')
  expect(p.endsWith('[이번 질문]\nfish는?')).toBe(true)
  expect(forkPrompt([], '첫 질문')).not.toContain('[앞선 곁대화]')
})

test('pressing a to-do puts it in front of the draft, once', () => {
  expect(draftWith('debate를 끌까요?', '')).toBe('↩ debate를 끌까요? → ')
  expect(draftWith('B?', '↩ debate를 끌까요? → ㅇㅇ')).toBe('↩ B? → ㅇㅇ')
})

test('collected answers go to the main conversation one line per item', () => {
  expect(answersText([{ q: 'debate를 옮길까요?', a: ' ㅇㅇ ' }, { q: 'B?', a: '' }, { q: 'C?', a: '나중에' }])).toBe('↩ debate를 옮길까요? → ㅇㅇ\n↩ C? → 나중에')
  expect(answersText([])).toBe('')
})

test('after saving, the keyboard goes to the next unanswered item, then to send', () => {
  expect(focusAfter([1, 2, 3], 1, new Set([1]), true)).toBe('todo-btn-2')
  expect(focusAfter([1, 2, 3], 3, new Set([3]), true)).toBe('todo-btn-1')
  expect(focusAfter([1, 2, 3], 2, new Set([1, 2, 3]), true)).toBe('send-answers')
  expect(focusAfter([1], 1, new Set(), false)).toBe(undefined)
})

const PANE_PROPS = { title: '내 차례 · 곁대화', isFocused: true, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

// 테스트의 $에는 state가 없어서, 답의 "물을 것:" 줄로 내 차례 항목을 만든다(판정 모델은 아무것도 더하지 않게 막는다)
async function seed($: Engine, on: On, texts: string[]) {
  fakeSession(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"closed":[],"new":[]}', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  await modsOn($)
  await $.turn.complete({ answer: `했어요.\n\n${texts.map(t => `물을 것: ${t}`).join('\n')}`, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' })
  return $.ui.mount({ plugin: 'chenjing-mods', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'side-chat' })
}

test('answers written in the panel are sent together as the person\'s words', async ($, on) => {
  const got: { text: string; origin: unknown }[] = []
  on('prompt.submit', (_$, e) => {
    got.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  const ui = await seed($, on, ['debate를 옮길까요?', '자동 분리를 끌까요?'])
  expect(await ui.find({ key: 'send-answers' })).toBe(undefined)
  await ui.press({ key: 'todo-btn-1' })
  await ui.input({ key: 'answer-1', text: 'ㅇㅇ' })
  await ui.press({ key: 'todo-btn-2' })
  await ui.input({ key: 'answer-2', text: ' 아니, 첫 문단 규칙만 ' })
  expect((await ui.find({ key: 'send-answers' }))?.text).toContain('답 2개 본 대화로 보내기')
  expect((await ui.find({ key: 'todo-btn-1' }))?.text).toContain('고치기')
  await ui.press({ key: 'send-answers' })
  expect(got).toEqual([{ text: '↩ debate를 옮길까요? → ㅇㅇ\n↩ 자동 분리를 끌까요? → 아니, 첫 문단 규칙만', origin: { kind: 'plugin', name: 'chenjing-mods', asUser: true } }])
  expect(await ui.find({ key: 'send-answers' })).toBe(undefined)
  expect(await ui.find({ text: '[ 보냄 ]' })).not.toBe(undefined)
})

test('an empty answer removes the draft', async ($, on) => {
  const ui = await seed($, on, ['A?'])
  await ui.press({ key: 'todo-btn-1' })
  await ui.input({ key: 'answer-1', text: 'ㅇㅇ' })
  expect(await ui.find({ key: 'send-answers' })).not.toBe(undefined)
  await ui.press({ key: 'todo-btn-1' })
  await ui.input({ key: 'answer-1', text: '  ' })
  expect(await ui.find({ key: 'send-answers' })).toBe(undefined)
})

test('a side question sent to the main conversation goes as the person\'s words', async ($, on) => {
  fakeSession(on)
  const got: unknown[] = []
  on('prompt.submit', (_$, e) => {
    got.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await modsOn($)
  const r = await $.command.run({ command: 'side', args: 'zsh랑 bash 차이?', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  expect(r.text).toContain('곁대화에서 답해요')
  const ui = await $.ui.mount({ plugin: 'chenjing-mods', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'side-chat' })
  await ui.press({ key: 'main' })
  expect(got).toEqual([{ text: 'zsh랑 bash 차이?', origin: { kind: 'plugin', name: 'chenjing-mods', asUser: true } }])
})

test('keys: digits answer the item, s sends, and the ring starts on the first unanswered item', async ($, on) => {
  const ui = await seed($, on, ['A?', 'B?'])
  expect((await ui.find({ key: 'todo-btn-1' }))?.props).toMatchObject({ hotkey: '1', autoFocus: true })
  expect((await ui.find({ key: 'todo-btn-2' }))?.props.hotkey).toBe('2')
  expect((await ui.find({ key: 'ask' }))?.props.autoFocus).toBe(undefined)
  await ui.press({ key: 'todo-btn-1' })
  await ui.input({ key: 'answer-1', text: 'ㅇㅇ' })
  expect((await ui.find({ key: 'todo-btn-1' }))?.props.autoFocus).toBe(undefined)
  expect((await ui.find({ key: 'todo-btn-2' }))?.props.autoFocus).toBe(true)
  expect((await ui.find({ key: 'send-answers' }))?.props.hotkey).toBe('s')
  expect((await ui.find({ key: 'ask-focus' }))?.props.hotkey).toBe('q')
})

async function askLooksSide($: Engine, on: On) {
  fakeSession(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'SIDE', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: [{ role: 'user', text: '플러그인 고쳐줘', toolUses: [] }, { role: 'assistant', text: '고쳤어요.', toolUses: [] }] }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await modsOn($)
  return $.prompt.submit({ text: '근데 zsh랑 bash 차이가 뭐야?', origin: { kind: 'composer' }, wait: false })
}

test('automatic side routing is off by default', async ($, on) => {
  const r = await askLooksSide($, on)
  expect('drop' in r ? r.drop : undefined).toBe(undefined)
})

test('with the side_auto option on, an unrelated question goes to the side chat', { options: { side_auto: 'on' } }, async ($, on) => {
  const r = await askLooksSide($, on)
  expect('drop' in r ? r.drop : '').toContain('곁대화')
})

import { fromKeep, toKeep } from './side-panel'

test('answers written in the panel and the side chat survive a reload through state', () => {
  const k = toKeep(new Map([[3, 'ㅇㅇ']]), new Map([[5, '보낸 답']]), [{ q: '먼저?', a: '답' }, { q: '기다리는 중' }])
  expect(k).toEqual({ drafts: { '3': 'ㅇㅇ' }, sent: { '5': '보낸 답' }, chat: [{ q: '먼저?', a: '답' }, { q: '기다리는 중' }] })
  const back = fromKeep(k)
  expect(back.drafts.get(3)).toBe('ㅇㅇ')
  expect(back.sent.get(5)).toBe('보낸 답')
  expect(back.chat[0]).toEqual({ q: '먼저?', a: '답' })
  // 답을 기다리던 질문은 다시 불러온 뒤 답이 오지 않으니 그렇다고 보여 준다
  expect(back.chat[1]?.err).toContain('다시 불러와')
  expect(fromKeep(undefined).drafts.size).toBe(0)
})

test('a to-do is dropped with its button and [되돌리기] brings it back until the next message', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const ui = await seed($, on, ['A?', 'B?'])
  await ui.press({ key: 'todo-del-1' })
  expect(await ui.find({ key: 'todo-btn-1' })).toBe(undefined)
  expect((await ui.find({ key: 'undo' }))?.props.hotkey).toBe('u')
  expect(await ui.find({ text: '지운 항목: A?' })).not.toBe(undefined)
  await ui.press({ key: 'undo' })
  expect(await ui.find({ key: 'todo-btn-1' })).not.toBe(undefined)
  expect(await ui.find({ key: 'undo' })).toBe(undefined)
  await ui.press({ key: 'todo-del-2' })
  expect(await ui.find({ key: 'undo' })).not.toBe(undefined)
  await $.prompt.submit({ text: '다음 일 해 줘', origin: { kind: 'composer' }, wait: false })
  await ui.redraw()
  expect(await ui.find({ key: 'undo' })).toBe(undefined)
})

// 링이 있던 [지우기]가 사라져 u가 먹지 않았다(2026-10-09): 지우고 나면 링이 그 자리 항목으로, 다 지우면 [되돌리기]로 간다.
// 테스트 키트는 플러그인의 $.ui.focus를 테스트 훅으로 넘기지 않아("no implementation for ui.focus") 링이 갈 곳만 따로 본다
test('after [지우기] the ring goes to the row in its place, the row above at the end, else [되돌리기]', () => {
  expect(ringAfterDrop([1, 2, 3], 2)).toBe('todo-del-3')
  expect(ringAfterDrop([1, 3], 3)).toBe('todo-del-1')
  expect(ringAfterDrop([1], 1)).toBe('undo')
  expect(ringAfterDrop([4, 5], 9)).toBe('todo-del-4')
})

test('[지우기] several times keeps them all for one [되돌리기], which puts the rows back in order', async ($, on) => {
  const ui = await seed($, on, ['A?', 'B?', 'C?'])
  for (const key of ['todo-del-2', 'todo-del-3', 'todo-del-1']) await ui.press({ key })
  expect(await ui.find({ text: '지운 항목 3개' })).not.toBe(undefined)
  await ui.press({ key: 'undo' })
  expect((await ui.findAll({ type: 'Text', text: /^\d\. / })).map(t => t.text)).toEqual(['1. A?', '2. B?', '3. C?'])
})

test('the side chat has a button for automatic routing, and the panel says where the debate is', async ($, on) => {
  on('ui.toast', () => ({ value: undefined }))
  const ui = await seed($, on, ['A?'])
  expect((await ui.find({ key: 'auto' }))?.text).toContain('자동 분리 켜기')
  expect(await ui.find({ text: '[자동 분리 켜기]를 누르면' })).not.toBe(undefined)
  await ui.press({ key: 'auto' })
  expect((await ui.find({ key: 'auto' }))?.text).toContain('자동 분리 끄기')
  expect((await $.command.run({ command: 'side', args: 'status', ...RUN })).text).toContain('자동 분리 켜짐')
  expect(await ui.find({ type: 'Text', text: '토론: /debate만 치면' })).not.toBe(undefined)
})
