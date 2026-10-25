import type { EngineInterface, On, PluginOptions } from 'claude-code'

import { E_COMMAND } from './answer-blocks'
import { DEBATE_COMMAND, DEBATE_PANE, DEBATE_TOOL, debateWord } from './debate'
import { choose, forget, idsFrom, isKnown, isLive, SESSIONS, settle, withId } from './live'
import { SIDE_COMMAND, SIDE_PANE, settingsFrom as sideSettingsFrom } from './side-panel'

// baton을 켤 세션을 고른다(/baton on|off). 고른 세션 id는 store(SESSIONS)에 남아 --resume으로 돌아와도 켜져 있다.
// 고르지 않은 세션에는 /baton 하나만 보이고, 답 접기·내 차례·옆 패널·토론과 그에 딸린 모델 호출은 모두 쉰다.
export const ENTRY_COMMAND = {
  name: 'baton',
  description: 'baton(답 접기·내 차례·옆 패널·토론): /baton on, /baton off, /baton(상태와 쓸 수 있는 것 전부)',
  argumentHint: '[on | off]',
}

// /baton이 보여 주는 지금 상태
export type Now = { todo: number; chat: number; auto: boolean; judged: number; failed: number; debate: string }

// 모르는 기능은 쓰지 못하니(2026-10-09 사용자 "안쓴거는 몰라서 안쓴건데"), /baton 하나만 알면 나머지를 찾게 화면별로 적는다. 꺼진 세션(now 없음)에는 켜면 무엇이 생기는지 적는다
export function helpText(sessions: number, now: Now | undefined): string {
  if (!now)
    return [
      `이 세션에서 꺼짐 · 켜 둔 세션 ${sessions}개`,
      '/baton on으로 켜면 이렇게 돼요.',
      '- 답의 설명이 접혀요. 펼치기는 버튼이나 /baton-e',
      '- 옆 패널에 내 차례(답이 남긴 물을 것·볼 것)와 곁대화가 생겨요. 열기는 /baton-side',
      '- /baton-debate만 치면 지금 대화에서 주제를 골라 두 Claude가 토론해요',
    ].join('\n')
  return [
    `이 세션에서 켜짐 · 켜 둔 세션 ${sessions}개 · 끄기는 /baton off`,
    '- 답: 설명은 접혀 있어요. 버튼이나 /baton-e로 펼쳐요(/baton-e 2는 그 전 답).',
    '- 옆 패널(/baton-side): 위는 내 차례(답이 남긴 물을 것·볼 것, 입력창 아래 "↩ 내 차례 N"이 그 개수), 아래는 곁대화예요. [답하기]를 누르면 그 질문 아래에 답 칸이 열려요: 쓰고 Enter로 저장해요. 예/아니요로 답할 질문은 [예]·[아니요]를 눌러도 돼요. [답 N개 본 대화로 보내기]로 한 번에 보내면 패널에서 빠져요. 지우기·되돌리기와 자동 분리(작업과 관계없는 질문을 곁대화로 보내기)도 패널 버튼이에요. 곁질문은 q를 누르면 곁대화 아래 칸에서 쓰고, /baton-side 질문으로도 바로 물어요.',
    '- 패널 키: ctrl+x tab 들어가기 · 숫자 답하기 · s 답 보내기 · q 곁질문 · m 본 대화로 · u 되돌리기 · Esc 입력창으로',
    '- 토론(/baton-debate): 그냥 치면 지금 대화에서 주제를 골라 시작해요. /baton-debate 주제로 직접 줄 수도 있어요. 중지는 토론 탭의 버튼이에요.',
    `- 지금: 내 차례 ${now.todo}개 · 곁대화 ${now.chat}개 · 자동 분리 ${now.auto ? '켜짐' : '꺼짐'} · 판정 ${now.judged}번(실패 ${now.failed}) · 토론 ${now.debate}`,
  ].join('\n')
}

// /baton on의 답: 어디에 무엇이 있는지 세 줄로
export function onText(saved: boolean): string {
  return [
    `이 세션에서 baton을 켰어요. ${saved ? '--resume으로 돌아와도 켜져 있어요.' : '다만 목록 저장에 실패해서 이 창에서만 켜져 있어요.'}`,
    '- 답의 설명은 접혀요. 펼치기는 버튼이나 /baton-e',
    '- 할 일과 곁질문은 옆 패널에 모여요. 열기는 /baton-side',
    '- /baton-debate만 치면 지금 대화로 두 Claude가 토론해요',
    // 빈 줄이 없으면 화면이 이 줄을 위 목록 항목에 이어 붙여 들여 쓴다(2026-10-09 tmux로 확인)
    '',
    '모르면 /baton',
  ].join('\n')
}

// 마지막으로 목록에 있는 것을 확인한 세션 id: /clear 뒤 새 id만 store에 더한다
let listedId = ''

// 이 세션에서 켜졌는지(live.ts). $를 쓰는 함수라 hook과 같은 파일에 둔다
async function live($: EngineInterface): Promise<boolean> {
  if (isKnown()) return isLive()
  // 읽다가 실패하면 이번만 꺼진 것으로 보고, 정하지 않은 채 두어 다음에 다시 읽는다
  const id = await $.session.id().catch(() => '')
  const list = id ? await $.store.get(SESSIONS).catch(() => null) : null
  return list === null ? false : settle(list, id)
}

// on·off 말고는(도움말, help 등) 모두 도움말과 상태를 보인다: 2026-10-09 사용자가 /baton 도움말을 쳤다가 사용법 한 줄만 받았다
export function entryReply(arg: string): 'on' | 'off' | 'status' {
  const a = arg.trim().toLowerCase()
  return a === 'on' || a === 'off' ? a : 'status'
}

// 다른 mod가 state에 둔 값을 읽어 /baton에 보일 지금 상태를 만든다. $를 쓰는 함수라 hook과 같은 파일에 둔다
async function nowOf($: EngineInterface, autoDefault: boolean): Promise<Now> {
  const { value: book } = await $.state.get({ plugin: 'baton', key: 'book' })
  const { value: stats } = await $.state.get({ plugin: 'baton', key: 'asksStats' })
  const { value: keep } = await $.state.get({ plugin: 'baton', key: 'sideKeep' })
  const { value: auto = autoDefault } = await $.state.get({ plugin: 'baton', key: 'sideEnabled' })
  const { value: debate } = await $.state.get({ plugin: 'baton', key: 'debate' })
  return { todo: book?.items.length ?? 0, chat: keep?.chat.length ?? 0, auto, judged: stats?.judged ?? 0, failed: stats?.failed ?? 0, debate: debateWord(debate) }
}

export function registerEntry(on: On, options: PluginOptions): void {
  const autoDefault = sideSettingsFrom(options).auto
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    await $.command.register(ENTRY_COMMAND)
    return started
  })

  on('command.run', { command: 'baton' }, async ($, e) => {
    const want = entryReply(e.args)
    const id = await $.session.id().catch(() => '')
    if (!id) return { text: '이 세션의 id를 읽지 못했어요. 잠시 뒤 다시 해 주세요.' }
    const list = idsFrom(await $.store.get(SESSIONS).catch(() => []))
    if (want === 'status') {
      const isOn = await live($)
      // 엔진이 출력 앞에 'baton: '를 붙인다
      return { text: helpText(list.length, isOn ? await nowOf($, autoDefault) : undefined) }
    }
    const isOn = want === 'on'
    const saved = await $.store.set(SESSIONS, withId(list, id, isOn)).then(() => true, () => false)
    choose(isOn)
    listedId = isOn ? id : ''
    if (isOn) {
      // 이미 시작한 세션이라 각 mod의 session.start가 하던 등록을 여기서 한다
      for (const c of [E_COMMAND, SIDE_COMMAND, DEBATE_COMMAND]) await $.command.register(c).catch(() => undefined)
      await $.tool.register(DEBATE_TOOL).catch(() => undefined)
      return { text: onText(saved) }
    }
    await $.ui.close({ id: SIDE_PANE }).catch(() => undefined)
    await $.ui.close({ id: DEBATE_PANE }).catch(() => undefined)
    return { text: `이 세션에서 baton을 껐어요. /baton-side·/baton-e·/baton-debate는 목록에 남지만 꺼져 있다고만 답해요.${saved ? '' : ' 다만 목록 저장에 실패해서 --resume하면 다시 켜질 수 있어요.'}` }
  })

  // /clear는 session.start 없이 새 id로 이어진다: 켜 둔 탭이면 새 id도 목록에 더해 --resume으로 돌아와도 켜지게 한다
  on('prompt.submit', { text: /[\s\S]/ }, async ($, e, next) => {
    if (!(await live($))) return next(e)
    const id = await $.session.id().catch(() => listedId)
    if (id !== listedId) {
      const list = idsFrom(await $.store.get(SESSIONS).catch(() => [id]))
      const isListed = list.includes(id) || (await $.store.set(SESSIONS, withId(list, id, true)).then(() => true, () => false))
      if (isListed) listedId = id
    }
    return next(e)
  })

  // /resume으로 다른 세션이 이 프로세스에 오면 그 세션을 골랐는지 다시 찾는다
  on('session.end', { reason: 'resume' }, async ($, e, next) => {
    const ended = await next(e)
    forget()
    listedId = ''
    return ended
  })
}
