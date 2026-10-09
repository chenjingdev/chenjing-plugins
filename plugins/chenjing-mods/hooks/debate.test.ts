import { test, expect } from 'claude-code/testing'

import { debateDirs, parseArgs, parseBgId, parsePeer } from './debate'

test('debate folders: ~ is the home folder, an empty work folder is the session folder', () => {
  expect(debateDirs({}, '/home/u', '/work/proj')).toEqual({ reportDir: '/home/u/.claude/chenjing-mods/debates', workDir: '/work/proj' })
  expect(debateDirs({ debate_dir: '~/notes/debates/', debate_work_dir: ' /tmp/d ' }, '/home/u', '/w')).toEqual({ reportDir: '/home/u/notes/debates', workDir: '/tmp/d' })
  expect(debateDirs({ debate_dir: '/r', debate_work_dir: '~' }, '/home/u', '/w')).toEqual({ reportDir: '/r', workDir: '/home/u' })
  expect(() => debateDirs({}, '', '/w')).toThrow('홈 폴더')
  expect(debateDirs({ debate_dir: '/r' }, '', '/w')).toEqual({ reportDir: '/r', workDir: '/w' })
})

test('parses debate args; no topic means picking one from the conversation', () => {
  expect(parseArgs('4 탭이 스페이스보다 낫다')).toEqual({ maxRounds: 4, topic: '탭이 스페이스보다 낫다' })
  expect(parseArgs('원격근무가 낫다')).toEqual({ maxRounds: 10, topic: '원격근무가 낫다' })
  expect(parseArgs('  ')).toEqual({ maxRounds: 10, topic: '' })
  expect(parseArgs('2')).toEqual({ maxRounds: 2, topic: '' })
})

test('parses background session id', () => {
  expect(parseBgId('backgrounded · 9446dcda · debate-probe (idle — send a prompt to start)')).toBe('9446dcda')
  expect(parseBgId('Workspace not trusted.')).toBe(null)
})

test('parses cross-session envelope', () => {
  const msg = '<cross-session-message from="uds:/tmp/x.sock" from-name="debate-pro-ab12" from-mode="bypass">\n주장입니다.\n</cross-session-message>'
  expect(parsePeer(msg)).toEqual({ fromName: 'debate-pro-ab12', body: '주장입니다.' })
})

import { rules, toMarkdown } from './debate'

test('rules carry brief and labels', () => {
  const r = rules({ topic: 'X', brief: '요약', labels: { pro: '옹호', con: '반박' }, maxRounds: 2 }, 'con')
  expect(r).toContain('너는 반박 측, 상대는 옹호 측')
  expect(r).toContain('배경 자료')
})

test('report markdown', () => {
  const md = toMarkdown({
    topic: 'X', brief: '', labels: { pro: '찬성', con: '반대' }, maxRounds: 1, status: 'done',
    pro: { name: 'debate-pro-ab', id: null }, con: { name: 'debate-con-ab', id: null },
    log: [{ side: 'pro', text: 'a' }, { side: 'con', text: 'b' }], verdict: 'v', error: '', reportPath: '',
  })
  expect(md).toContain('### 2. 반대\n\nb')
  expect(md).toContain('## 판정\n\nv')
})

import { askPrompt, recentBrief, reportText } from './debate'

const D = { topic: 'T', brief: '', labels: { pro: '찬성', con: '반대' }, log: [{ side: 'pro' as const, text: '가' }, { side: 'con' as const, text: '나' }], verdict: '[판정: 무승부]', reportPath: '/tmp/r.md' }

test('a question to the debate carries the record, the verdict and earlier answers', () => {
  const p = askPrompt(D, [{ id: 'a', q: '먼저?', a: '먼저 답' }, { id: 'b', q: '실패', err: 'x' }], '왜 무승부?')
  expect(p).toContain('[찬성] 가\n\n[반대] 나')
  expect(p).toContain('[심판 판정]\n[판정: 무승부]')
  expect(p).toContain('Q: 먼저?\nA: 먼저 답')
  expect(p).not.toContain('실패')
  expect(p.endsWith('[사용자 질문]\n왜 무승부?')).toBe(true)
})

test('/debate hands the debaters the latest request and answer as background', () => {
  const b = recentBrief([{ role: 'user', text: '플러그인 합쳐줘' }, { role: 'assistant', text: '합쳤어요.' }, { role: 'system', text: 'x' }])
  expect(b).toContain('사용자: 플러그인 합쳐줘\n\nClaude: 합쳤어요.')
  expect(recentBrief([])).toBe('')
})

test('the result goes to the main conversation only as the verdict, asked questions and the file path', () => {
  const t = reportText(D, [{ id: 'a', q: '왜?', a: '그래서' }])
  expect(t.startsWith('↩ 토론 결과: "T"\n[판정: 무승부]')).toBe(true)
  expect(t).toContain('Q. 왜?\nA. 그래서')
  expect(t).toContain('전문: /tmp/r.md')
  expect(t).not.toContain('[찬성] 가')
})

import { upgrade } from './debate'

test('an older debate state gets empty questions and is not marked sent', () => {
  const d = upgrade({ topic: 'T', pro: { name: 'debate-pro-a', id: null }, con: { name: 'debate-con-a', id: null } })
  expect(d?.qa).toEqual([])
  expect(d?.sent).toBe(false)
  const kept = upgrade({ topic: 'T', pro: { name: 'debate-pro-a', id: null }, con: { name: 'debate-con-a', id: null }, qa: [{ id: 'x', q: '왜?', a: '그래서' }], sent: true })
  expect(kept?.qa?.[0]?.a).toBe('그래서')
  expect(kept?.sent).toBe(true)
})

import { commandText } from './debate'

test('/debate tells the person, not the model, that the debate started', () => {
  const t = commandText('토론을 시작했다: "T" (10라운드). 사용자에게 시작했다고만 짧게 알려라.', 'T', 12)
  expect(t).toContain('토론을 시작했어요: "T" (10라운드, 12라운드는 10라운드로 줄였어요)')
  expect(t).not.toContain('알려라')
  expect(commandText('이미 토론이 진행 중이다.', 'T', 3)).toContain('/debate stop')
})

import { mock } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

import { NOTHING_YET, parseTopic, topicPrompt } from './debate'
import { fakeSession, modsOn, RUN } from './testkit'

type On = Parameters<TestBody>[1]

test('the topic picker asks for one JSON line and steers away from the last topic', () => {
  const p = topicPrompt('탭이 낫다')
  expect(p).toContain('JSON 한 줄')
  expect(p).toContain('토론자는 이 대화를 볼 수 없다')
  expect(p).toContain('직전 토론 주제는 "탭이 낫다"')
  expect(topicPrompt('')).not.toContain('직전 토론 주제')
})

test('the picked topic is read from the fork reply, fences and all', () => {
  expect(parseTopic('```json\n{"topic":"A안이 낫다","pro":"A안","con":"B안","brief":"배경"}\n```')).toEqual({ topic: 'A안이 낫다', labels: { pro: 'A안', con: 'B안' }, brief: '배경' })
  expect(parseTopic('{"topic":"X"}')).toEqual({ topic: 'X', labels: { pro: '찬성', con: '반대' }, brief: '' })
  expect(parseTopic('{"topic":"  "}')).toBe(undefined)
  expect(parseTopic('모르겠어요')).toBe(undefined)
})

const NO_USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const CONVO = [
  { role: 'user' as const, text: '곁질문 자동 분리를 뺄까?', toolUses: [] },
  { role: 'assistant' as const, text: '벤치에서 6개 모두 손실이라 빼는 걸 권해요.', toolUses: [] },
]
const PICKED = '{"topic":"곁질문 자동 분리는 빼는 게 낫다","pro":"빼기","con":"두기","brief":"벤치에서 옆으로 보낸 6개가 모두 본 대화에 필요했다."}'
const DEBATE_PANE = { title: '토론', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

// 토론자 세션은 띄우지 않는다: claude --bg가 "신뢰하지 않은 폴더"로 실패하게 두어, 주제를 고른 뒤 시작하려는 데까지만 본다.
// fork가 undefined를 주면 고를 대화가 없다는 답(nothing-to-fork)이다
function debateWorld(on: On, fork: () => Promise<string | undefined> | string | undefined, msgs: typeof CONVO = CONVO) {
  fakeSession(on)
  const clock = mock.clock(on)
  const spawned: string[] = []
  const forks: string[] = []
  on('session.messages', () => ({ value: msgs }))
  on('session.cwd', () => ({ value: '/work' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_$, e) => {
    const out = { isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv[0] === 'printenv') return { value: { ...out, exitCode: 0, stdout: '/home/u\n', stderr: '' } }
    spawned.push(e.argv.join(' '))
    return { value: { ...out, exitCode: 1, stdout: '', stderr: 'Workspace not trusted.' } }
  })
  on('model.fork', async (_$, e) => {
    forks.push(e.prompt)
    const text = await fork()
    return { value: text === undefined ? { isAnswered: false as const, reason: 'nothing-to-fork' as const } : { isAnswered: true as const, text, usage: NO_USAGE } }
  })
  return { clock, spawned, forks }
}

const paneOf = ($: Engine) => $.ui.mount({ plugin: 'chenjing-mods', surface: 'terminal', component: 'Pane', props: DEBATE_PANE, requestId: 'debate' })

test('/debate alone picks the topic from the conversation and starts on it', async ($, on) => {
  const w = debateWorld(on, () => PICKED)
  await modsOn($)
  expect((await $.command.run({ command: 'debate', args: '', ...RUN })).text).toContain('주제를 고르고 있어요(10라운드)')
  await w.clock.settle()
  expect(w.forks[0]).toContain('[토론 주제 고르기]')
  const pane = await paneOf($)
  expect(await pane.find({ text: '곁질문 자동 분리는 빼는 게 낫다' })).not.toBe(undefined)
  expect(await pane.find({ text: '빼기 vs 두기' })).not.toBe(undefined)
  expect(w.spawned.filter(c => c.startsWith('claude --bg'))).toHaveLength(2)
  // 토론자를 못 띄우면 패널이 이유와 고치는 법을 보인다
  expect((await pane.find({ text: '실패:' }))?.text).toContain('debate_work_dir')
})

test('/debate alone before any answer asks for a topic and forks nothing', async ($, on) => {
  const w = debateWorld(on, () => PICKED, [])
  await modsOn($)
  expect((await $.command.run({ command: 'debate', args: '', ...RUN })).text).toBe(NOTHING_YET)
  await w.clock.settle()
  expect(w.forks).toEqual([])
})

test('a fork reply with no readable topic, or nothing to fork, fails with a way out and starts nothing', async ($, on) => {
  const replies: (string | undefined)[] = ['잘 모르겠어요', undefined]
  const w = debateWorld(on, () => replies.shift())
  await modsOn($)
  const pane = await paneOf($)
  await $.command.run({ command: 'debate', args: '2', ...RUN })
  await w.clock.settle()
  await pane.redraw()
  expect((await pane.find({ text: '실패:' }))?.text).toContain('답 형식이 달랐어요). /debate 주제로 직접')
  await $.command.run({ command: 'debate', args: '', ...RUN })
  await w.clock.settle()
  await pane.redraw()
  expect((await pane.find({ text: '실패:' }))?.text).toContain('아직 고를 대화가 없어요')
  expect(w.spawned).toEqual([])
})

test('stopping while the topic is being picked starts nothing; a second /debate meanwhile is told to wait', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(r => {
    release = () => r()
  })
  const w = debateWorld(on, async () => {
    await gate
    return PICKED
  })
  await modsOn($)
  await $.command.run({ command: 'debate', args: '', ...RUN })
  await w.clock.settle()
  expect((await $.command.run({ command: 'debate', args: '', ...RUN })).text).toContain('이미 토론이 진행 중')
  expect((await $.command.run({ command: 'debate', args: 'stop', ...RUN })).text).toBe('주제 고르기를 멈췄어요.')
  release()
  await w.clock.settle()
  expect(w.spawned).toEqual([])
  expect(await (await paneOf($)).find({ text: '곁질문 자동 분리는 빼는 게 낫다' })).toBe(undefined)
})
