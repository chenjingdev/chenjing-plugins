import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { idsFrom, withId } from './live'
import { modsReply } from './mods'
import { fakeSession, modsOn, RUN } from './testkit'

const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const ANSWER = { answer: '했어요.\n\n설명:\n- 확인한 것: 테스트\n\n물을 것: A를 할까요?', reason: 'answer' as const, durationMs: 1, isAborted: false, turnId: 't1' }
const MESSAGE = { text: '했어요.\n\n설명:\n- 확인한 것: 테스트', isFirstOfReply: true }

// 판정은 turn.complete가 기다리지 않고 돈다: $ 호출을 몇 번 거치며 판정이 모델에 닿을 틈을 준다
async function letWorkRun($: Engine, until: () => boolean) {
  for (let i = 0; i < 40 && !until(); i++) await $.command.run({ command: 'mods', args: 'status', ...RUN })
}

test('the /mods argument reads on, off and status', () => {
  expect(modsReply(' ON ')).toBe('on')
  expect(modsReply('off')).toBe('off')
  expect(modsReply('')).toBe('status')
  expect(modsReply('status')).toBe('status')
  expect(modsReply('도움말')).toBe('status')
  expect(modsReply('help')).toBe('status')
})

test('the list of chosen sessions keeps each id once, newest last, and drops junk', () => {
  expect(withId(['a', 'b'], 'a', true)).toEqual(['b', 'a'])
  expect(withId(['a', 'b'], 'a', false)).toEqual(['b'])
  expect(withId([], 'a', true)).toEqual(['a'])
  expect(idsFrom(['a', 3, null, 'b'])).toEqual(['a', 'b'])
  expect(idsFrom(undefined)).toEqual([])
})

test('a session not chosen with /mods gets only /mods: no folding, no judge call, other commands answer that it is off', async ($, on) => {
  const s = fakeSession(on)
  let modelCalls = 0
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.complete', () => {
    modelCalls += 1
    return { value: { isAnswered: true, text: '{"closed":[],"new":[]}', usage: NO_USAGE } }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(s.registered).toEqual(['mods'])
  await $.turn.complete(ANSWER)
  await letWorkRun($, () => modelCalls > 0)
  expect(modelCalls).toBe(0)
  // 플러그인이 그리지 않고 엔진에 넘긴다: 테스트에는 엔진의 그림이 없어서 그 사실이 오류로 보인다
  await expect($.ui.mount({ plugin: 'chenjing-mods', surface: 'terminal', component: 'AssistantMessage', props: MESSAGE })).rejects.toThrow('no implementation for ui.render')
  expect((await $.command.run({ command: 'e', args: '', ...RUN })).text).toContain('/mods on')
  expect((await $.command.run({ command: 'side', args: 'list', ...RUN })).text).toContain('/mods on')
  expect((await $.command.run({ command: 'mods', args: '', ...RUN })).text).toContain('꺼짐')
})

test('/mods on registers the other commands and the debate tool, folds answers and runs the judge', async ($, on) => {
  const s = fakeSession(on)
  let modelCalls = 0
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('model.complete', () => {
    modelCalls += 1
    return { value: { isAnswered: true, text: '{"closed":[],"new":["A를 할까요?"]}', usage: NO_USAGE } }
  })
  await modsOn($)
  expect(s.registered).toEqual(expect.arrayContaining(['e', 'side', 'debate', 'start_debate']))
  expect(s.store.get('sessions')).toEqual(['test-session'])
  await $.turn.complete(ANSWER)
  await letWorkRun($, () => modelCalls > 0)
  expect(modelCalls).toBe(1)
  const ui = await $.ui.mount({ plugin: 'chenjing-mods', surface: 'terminal', component: 'AssistantMessage', props: MESSAGE })
  expect((await ui.find({ type: 'Text', text: '설명 목차' }))?.text).toBe('설명 목차: 확인한 것')
  expect((await ui.find({ type: 'Button', text: '설명 펼치기' }))?.text).toContain('/e')
  expect((await $.command.run({ command: 'mods', args: 'status', ...RUN })).text).toContain('켜짐')
})

test('the choice follows the session id: /resume to another session finds it off, coming back finds it on', async ($, on) => {
  const s = fakeSession(on, 'A')
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  const status = async () => (await $.command.run({ command: 'mods', args: '', ...RUN })).text
  await modsOn($)
  await $.session.end({ reason: 'resume', sessionId: 'A', resume: { id: 'A' } })
  s.id = 'B'
  expect(await status()).toContain('꺼짐')
  await $.session.end({ reason: 'resume', sessionId: 'B', resume: { id: 'B' } })
  s.id = 'A'
  expect(await status()).toContain('켜짐')
})

test('after /clear (a new id, no session.start) the tab stays on and the new id joins the list', async ($, on) => {
  const s = fakeSession(on, 'A')
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await modsOn($)
  s.id = 'C'
  await $.prompt.submit({ text: '다음 일', origin: { kind: 'composer' }, wait: false })
  expect(s.store.get('sessions')).toEqual(['A', 'C'])
})

test('/mods off turns it off, takes the id off the list and closes both panes', async ($, on) => {
  const s = fakeSession(on)
  const closed: string[] = []
  on('ui.close', (_$, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  await modsOn($)
  expect((await $.command.run({ command: 'mods', args: 'off', ...RUN })).text).toContain('껐어요')
  expect(s.store.get('sessions')).toEqual([])
  expect(closed).toEqual(['side-chat', 'debate'])
  expect((await $.command.run({ command: 'debate', args: '3 주제', ...RUN })).text).toContain('/mods on')
})

test('/mods lists everything by screen and what is there now; off, it says what turning it on brings', async ($, on) => {
  fakeSession(on)
  const off = (await $.command.run({ command: 'mods', args: '', ...RUN })).text ?? ''
  expect(off).toContain('/mods on으로 켜면')
  expect(off).toContain('/debate만 치면')
  await modsOn($)
  const t = (await $.command.run({ command: 'mods', args: '', ...RUN })).text ?? ''
  for (const s of ['켜짐', '/e', '옆 패널(/side)', '되돌리기', '자동 분리', '토론(/debate)', '내 차례 0개', '토론 없음']) expect(t).toContain(s)
})

test('/mods on says in a few lines where things are', async ($, on) => {
  fakeSession(on)
  const t = (await $.command.run({ command: 'mods', args: 'on', ...RUN })).text ?? ''
  for (const s of ['켰어요', '/e', '/side', '/debate만 치면', '모르면 /mods']) expect(t).toContain(s)
})
