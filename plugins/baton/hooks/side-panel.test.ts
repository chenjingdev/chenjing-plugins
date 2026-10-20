import { test, expect, mock } from 'claude-code/testing'

import { fakeSession, turnOn, RUN } from './testkit'
import type { Engine, TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

import { answersText, classifyPrompt, focusAfter, forkPrompt, isHuman, isSide, recentWork, ringAfterDrop, settingsFrom, withAnswerLine, withSideCommand, worthChecking } from './side-panel'

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

test('collected answers go to the main conversation one line per item', () => {
  expect(answersText([{ q: 'debate를 옮길까요?', a: ' ㅇㅇ ' }, { q: 'B?', a: '' }, { q: 'C?', a: '나중에' }])).toBe('↩ debate를 옮길까요? → ㅇㅇ\n↩ C? → 나중에')
  expect(answersText([])).toBe('')
})

test('after saving, the ring goes to the next unanswered item, then to send', () => {
  expect(focusAfter([1, 2, 3], 1, new Set([1]), true)).toBe('todo-btn-2')
  expect(focusAfter([1, 2, 3], 3, new Set([3]), true)).toBe('todo-btn-1')
  expect(focusAfter([1, 2, 3], 2, new Set([1, 2, 3]), true)).toBe('send-answers')
  expect(focusAfter([1], 1, new Set(), false)).toBe(undefined)
})

// 입력칸을 그리지 못하는 화면에서만 쓴다
test('without an input field, [답하기] puts the item in the prompt box: alone, in front of what was typed, or on a new line after other answers', () => {
  expect(withAnswerLine('debate를 끌까요?', '')).toBe('↩ debate를 끌까요? → ')
  expect(withAnswerLine('debate를 끌까요?', '  \n')).toBe('↩ debate를 끌까요? → ')
  expect(withAnswerLine('B?', 'ㅇㅇ 그렇게 해')).toBe('↩ B? → ㅇㅇ 그렇게 해')
  expect(withAnswerLine('B?', '↩ A? → ㅇㅇ\n')).toBe('↩ A? → ㅇㅇ\n↩ B? → ')
  // 같은 항목을 또 누르면 그대로 둔다
  expect(withAnswerLine('A?', '↩ A? → ㅇㅇ')).toBe('↩ A? → ㅇㅇ')
})

test('q puts /baton-side in front of the prompt box, but leaves answers being written alone', () => {
  expect(withSideCommand('')).toBe('/baton-side ')
  expect(withSideCommand('zsh랑 bash 차이?')).toBe('/baton-side zsh랑 bash 차이?')
  expect(withSideCommand('/baton-side 이미')).toBe('/baton-side 이미')
  expect(withSideCommand('↩ A? → ㅇㅇ')).toBe(undefined)
})

const PANE_PROPS = { title: '내 차례 · 곁대화', isFocused: true, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

// 테스트의 $에는 state가 없어서, 답의 "물을 것:" 줄로 내 차례 항목을 만든다(판정 모델은 아무것도 더하지 않게 막는다)
async function seed($: Engine, on: On, texts: string[]) {
  fakeSession(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"closed":[],"new":[]}', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  await turnOn($)
  await $.turn.complete({ answer: `했어요.\n\n${texts.map(t => `물을 것: ${t}`).join('\n')}`, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' })
  return $.ui.mount({ plugin: 'baton', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'side-chat' })
}

// 테스트의 입력창: q가 읽고 쓰는 곳
function fakeBox(on: On) {
  const box = { text: '' }
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', (_$, e) => {
    box.text = e.mode === 'replace' ? e.text : box.text + e.text
    return { isFilled: true }
  })
  on('ui.toast', () => ({ value: undefined }))
  return box
}

// 2026-10-11 사용자 "그전에 클릭해서 input채우는 경험이 좋앗던거 같음": 답은 다시 패널 입력칸에서 쓴다(0.7.1처럼).
// 보내는 쪽이 사람 턴을 직접 세서 보낸 항목은 바로 닫힌다(0.7.2): 엔진은 baton이 보낸 글에 baton의 prompt.submit 훅을 돌리지 않는다
test('answers written in the panel are sent together as the person\'s words, and their items close at once', async ($, on) => {
  const got: { text: string; origin: unknown }[] = []
  on('prompt.submit', (_$, e) => {
    got.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  const ui = await seed($, on, ['debate를 옮길까요?', '자동 분리를 끌까요?'])
  expect(await ui.find({ key: 'send-answers' })).toBe(undefined)
  await ui.press({ key: 'todo-btn-1' })
  // 입력칸이 열린 항목은 버튼 줄 대신 입력칸을 둔다
  expect(await ui.find({ key: 'todo-btn-1' })).toBe(undefined)
  await ui.input({ key: 'answer-1', text: 'ㅇㅇ' })
  await ui.press({ key: 'todo-btn-2' })
  await ui.input({ key: 'answer-2', text: ' 아니, 첫 문단 규칙만 ' })
  expect((await ui.find({ key: 'send-answers' }))?.text).toContain('답 2개 본 대화로 보내기')
  expect((await ui.find({ key: 'todo-btn-1' }))?.text).toContain('고치기')
  expect(await ui.find({ text: '답: ㅇㅇ' })).not.toBe(undefined)
  await ui.press({ key: 'send-answers' })
  expect(got).toEqual([{ text: '↩ debate를 옮길까요? → ㅇㅇ\n↩ 자동 분리를 끌까요? → 아니, 첫 문단 규칙만', origin: { kind: 'plugin', name: 'baton', asUser: true } }])
  await ui.redraw()
  expect(await ui.find({ key: 'send-answers' })).toBe(undefined)
  expect(await ui.find({ key: 'todo-btn-1' })).toBe(undefined)
  expect(await ui.find({ text: '내 차례 0' })).not.toBe(undefined)
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

// 쓰는 동안 value가 바뀌어 다시 그려지면 엔진이 친 글을 그 값으로 되돌린다: 새 답에는 value를 주지 않고, 고칠 때만 써 둔 답을 준다
test('the answer field gets no value for a new answer, the saved one when fixing it, and no change handler', async ($, on) => {
  const ui = await seed($, on, ['A?'])
  await ui.press({ key: 'todo-btn-1' })
  const fresh = await ui.find({ key: 'answer-1' })
  expect(fresh?.props.value).toBe(undefined)
  expect(fresh?.props.autoFocus).toBe(true)
  expect('onInput' in (fresh?.props ?? {})).toBe(false)
  await ui.input({ key: 'answer-1', text: '여름' })
  await ui.press({ key: 'todo-btn-1' })
  expect((await ui.find({ key: 'answer-1' }))?.props.value).toBe('여름')
})

test('answers that could not be sent come back with their items', async ($, on) => {
  on('prompt.submit', () => ({ drop: '지금은 보낼 수 없어요' }))
  on('ui.toast', () => ({ value: undefined }))
  const ui = await seed($, on, ['A?'])
  await ui.press({ key: 'todo-btn-1' })
  await ui.input({ key: 'answer-1', text: 'ㅇㅇ' })
  await ui.press({ key: 'send-answers' })
  await ui.redraw()
  expect(await ui.find({ text: '내 차례 1' })).not.toBe(undefined)
  expect(await ui.find({ text: '답: ㅇㅇ' })).not.toBe(undefined)
  expect(await ui.find({ key: 'send-answers' })).not.toBe(undefined)
})

// 2026-10-11 사용자 "답이 필요없는 질문인데 사이드로옴": 다르게 한 것 줄 하나만 남긴 답이 내 차례에 [답하기] 항목을 올리고 패널을 열었다
test('an answer that only says what was done differently leaves nothing to answer and opens no panel; a question does', async ($, on) => {
  fakeSession(on)
  const clock = mock.clock(on)
  const opened: string[] = []
  let modelCalls = 0
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.complete', () => {
    modelCalls += 1
    return { value: { isAnswered: true, text: '{"closed":[],"new":[]}', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  const list = async () => (await $.command.run({ command: 'baton-side', args: 'list', ...RUN })).text
  await turnOn($)
  await $.turn.complete({ answer: '고쳤어요.\n\n다르게 한 것: 요청 밖의 일로, 비어 있던 `data/claude-bridge` 폴더를 지웠어요.', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' })
  // 패널은 판정이 끝날 때까지 1.5초마다 보고 연다(최대 20번)
  await clock.advance(30000)
  expect(await list()).toContain('내 차례 없음')
  expect(modelCalls).toBe(0)
  expect(opened).toEqual([])
  await $.turn.complete({ answer: '고쳤어요.\n\n물을 것: 커밋할까요?\n다르게 한 것: 빈 폴더를 지웠어요.', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't2' })
  await clock.advance(30000)
  expect(await list()).toContain('내 차례 1개\n1. 커밋할까요?')
  expect(opened).toEqual(['side-chat'])
})

test('q starts a side question in the prompt box', async ($, on) => {
  const box = fakeBox(on)
  const ui = await seed($, on, ['A?'])
  await ui.press({ key: 'ask-focus' })
  expect(box.text).toBe('/baton-side ')
})

// 엔진은 baton이 보낸 글에 baton의 prompt.submit 훅을 돌리지 않는다(re-entry). 그래서 보내는 쪽이 사람 턴을 직접 센다:
// 안 세면 내 차례 판정이 지난 메시지를 이번 메시지로 읽었다(2026-10-10)
test('a side question sent to the main conversation goes as the person\'s words, and the judge reads it as this turn\'s message', async ($, on) => {
  fakeSession(on)
  const got: unknown[] = []
  const judged: string[] = []
  on('prompt.submit', (_$, e) => {
    got.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.complete', (_$, e) => {
    judged.push(e.prompt)
    return { value: { isAnswered: true, text: '{"closed":[],"new":[]}', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  await turnOn($)
  await $.prompt.submit({ text: '플러그인 고쳐줘', origin: { kind: 'composer' }, wait: false })
  got.length = 0
  const r = await $.command.run({ command: 'baton-side', args: 'zsh랑 bash 차이?', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  expect(r.text).toContain('곁대화에서 답해요')
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'side-chat' })
  await ui.press({ key: 'main' })
  expect(got).toEqual([{ text: 'zsh랑 bash 차이?', origin: { kind: 'plugin', name: 'baton', asUser: true } }])
  await $.turn.complete({ answer: '대화형이면 zsh예요. 더 볼까요?', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't2' })
  // 판정은 턴이 끝난 뒤 따로 돈다: 목록을 한 번 읽어 그 사이를 둔다
  await $.command.run({ command: 'baton-side', args: 'list', ...RUN })
  expect(judged.at(-1)).toContain('[이번 사용자 메시지]\nzsh랑 bash 차이?')
})

test('keys: digits answer the item, s sends, q asks on the side, and the ring starts on the first unanswered item', async ($, on) => {
  const ui = await seed($, on, ['A?', 'B?'])
  expect((await ui.find({ key: 'todo-btn-1' }))?.props).toMatchObject({ hotkey: '1', autoFocus: true })
  expect((await ui.find({ key: 'todo-btn-2' }))?.props.hotkey).toBe('2')
  expect((await ui.find({ key: 'todo-btn-2' }))?.props.autoFocus).toBe(undefined)
  await ui.press({ key: 'todo-btn-1' })
  await ui.input({ key: 'answer-1', text: 'ㅇㅇ' })
  expect((await ui.find({ key: 'todo-btn-1' }))?.props.autoFocus).toBe(undefined)
  expect((await ui.find({ key: 'todo-btn-2' }))?.props.autoFocus).toBe(true)
  expect((await ui.find({ key: 'send-answers' }))?.props.hotkey).toBe('s')
  expect((await ui.find({ key: 'ask-focus' }))?.props.hotkey).toBe('q')
})

// 패널에 입력칸이 없어서, 키보드는 패널만 열 때 가져온다. 곁질문 뒤에 가져가면 이어 친 글자가 단축키를 눌렀다
test('/baton-side takes the keyboard to the panel, /baton-side 질문 leaves it in the prompt box', async ($, on) => {
  fakeSession(on)
  const opened: unknown[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.focus)
    return { value: { isPlaced: true } }
  })
  await turnOn($)
  await $.command.run({ command: 'baton-side', args: '', ...RUN })
  await $.command.run({ command: 'baton-side', args: 'zsh랑 bash 차이?', ...RUN })
  expect(opened).toEqual([true, undefined])
})

async function askLooksSide($: Engine, on: On) {
  fakeSession(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'SIDE', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.messages', () => ({ value: [{ role: 'user', text: '플러그인 고쳐줘', toolUses: [] }, { role: 'assistant', text: '고쳤어요.', toolUses: [] }] }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await turnOn($)
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

test('the side chat and the answers written in the panel survive a reload through state', () => {
  const k = toKeep([{ q: '먼저?', a: '답' }, { q: '기다리는 중' }], new Map([[3, 'ㅇㅇ']]))
  expect(k).toEqual({ chat: [{ q: '먼저?', a: '답' }, { q: '기다리는 중' }], drafts: { 3: 'ㅇㅇ' } })
  const back = fromKeep(k)
  expect(back.drafts.get(3)).toBe('ㅇㅇ')
  // 0.7.2~0.7.3이 남긴 값에는 drafts가 없다
  expect(fromKeep({ chat: [] }).drafts.size).toBe(0)
  expect(back.chat[0]).toEqual({ q: '먼저?', a: '답' })
  // 답을 기다리던 질문은 다시 불러온 뒤 답이 오지 않으니 그렇다고 보여 준다
  expect(back.chat[1]?.err).toContain('다시 불러와')
  expect(fromKeep(undefined).chat).toEqual([])
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
  expect((await ui.findAll({ type: 'Text', text: /^[ABC]\?$/ })).map(t => t.text)).toEqual(['A?', 'B?', 'C?'])
})

test('the side chat has a button for automatic routing, and the panel says where the debate is', async ($, on) => {
  on('ui.toast', () => ({ value: undefined }))
  const ui = await seed($, on, ['A?'])
  expect((await ui.find({ key: 'auto' }))?.text).toContain('자동 분리 켜기')
  expect(await ui.find({ text: 'q로 여기에 물어요' })).not.toBe(undefined)
  await ui.press({ key: 'auto' })
  expect((await ui.find({ key: 'auto' }))?.text).toContain('자동 분리 끄기')
  expect((await $.command.run({ command: 'baton-side', args: 'status', ...RUN })).text).toContain('자동 분리 켜짐')
  expect(await ui.find({ type: 'Text', text: '토론: /baton-debate' })).not.toBe(undefined)
})
