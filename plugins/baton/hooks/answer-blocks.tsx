import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { enter, isKnown, isLive, OFF_TEXT, SESSIONS, settle } from './live'
// 답을 세 덩어리로 쓰게 한다: 물은 것에 대한 답, 접혀 보이는 "설명:", 사용자 차례(물을 것·볼 것·다르게 한 것).
// 길이 제한은 두지 않는다: 설명은 접혀 있고, 물을 것·볼 것은 본문에서 빠져 옆 패널(side-panel)의 내 차례에 뜬다.
// 다르게 한 것은 답할 것이 없는 알림이라 본문 끝에 남긴다. 0.7.2까지는 이것도 내 차례에 올라 [답하기]가 붙고 패널이 열렸다(2026-10-11 사용자 "답이 필요없는 질문인데 사이드로옴").
// 2026-10-06 벤치마크에서 접힌 설명이 다음 판단에 필요한 단서·숫자를 숨겨서, 그것들은 첫 문단에 쓰게 했다.
// 2026-10-08 첫 문단 끝에 설명에 든 것의 이름을 대게 했다: 필요한 것이 접혔을 때 주제를 알린 비율 2/24 → 19/21(A3 벤치).
// 2026-10-23 첫 덩어리(요약)를 줄글 대신 결론 한 줄과 "- **이름:** 내용" 목록으로 쓰게 했다(사용자 "지금 그냥 줄글로 되있어서 복잡함").
// 그 전 엿새 동안 설명이 붙은 답 116개 가운데 요약에 목록을 쓴 답은 6개였고, 요약 길이는 중간값 308자였다. 그래서 굵은 글씨는 목록의 이름에만 쓰게 풀었다.
// 2026-10-25 물을 것은 사용자만 답할 수 있는 것만, 그 줄만 읽고 답할 수 있게(왜 묻는지, 선택지와 추천) 쓰게 했다(사용자 "대충 질문 올리는 일은 없엇으면 좋겠음").
// 지난 16일 패널로 답한 항목 75개 중 20개쯤이 "이건 뭔데?" "뭘 바꿨음?" 같은 되물음이었고, "오토메이션은 안쌓기로 했잖아?"처럼 이미 정한 것을 다시 물은 것도 있었다
// 2026-10-27 ~/AGENTS.md에 있던 문장·형식 규칙(Karpathy 글: 80% ASD-STE100, 다이어그램·HTML·설명 영상)을 옮기고 한국어 문장 규칙을 더했다(사용자 "codex 상관없어 지워도됨").
// STE는 영어 규격이라 주어 생략·긴 관형절·끝말 섞기·번역투 피동처럼 한국어에서 생기는 문제는 따로 적었다
const EXPANDED = { plugin: 'baton', key: 'expanded' } as const
const expanded = atom(EXPANDED, [])

export function ruleText(): string {
  return [
    '# 답 형식 (answer-blocks)',
    '- 사용자가 이 세션에서 켠 baton 플러그인의 규칙이다. 이 대화의 모든 답에 적용한다.',
    '- 답은 세 덩어리로 쓴다. 해당 없는 덩어리는 쓰지 않는다. 길이 제한은 없다.',
    '- 요약(첫 덩어리): 사용자가 물은 것에 답한다. 물은 것과 상관없는 내용은 넣지 않는다.',
    '- 요약은 줄글로 이어 쓰지 않고, 훑어볼 수 있게 마크다운으로 나눈다. 첫 줄은 결론 한 문장이다. 그 밖에 알릴 것이 둘 이상이면 결론 아래에 "- **이름:** 내용" 목록으로 한 항목에 한 가지씩 쓴다. 이름은 사용자가 쓰는 말로 짧게, 내용은 한 문장으로 쓴다. 더 할 말이나 다섯 개를 넘는 항목은 설명으로 보낸다. 차례가 있는 단계는 번호 목록으로 쓰고, 여러 대상을 같은 기준으로 견줄 때만 3열 이하의 표를 쓴다. 사용자가 칠 명령은 `백틱`으로 감싼다. 알릴 것이 결론 하나뿐이면 목록 없이 1~2문장으로 끝낸다.',
    '- 사용자는 접힌 설명을 펼치지 않고 요약과 사용자 차례 줄만 보고 다음 말을 정한다. 그래서 결론에 붙는 단서(확인 못 함·추정·실패·위험)와 사용자가 판단에 쓸 숫자는 요약에 쓴다. 물을 것에 답하는 데 필요한 선택지별 차이는 요약이나 그 물을 것 줄에 쓴다.',
    '- "설명:"으로 시작하는 문단: 그 밖의 것(근거, 과정, 실제로 확인한 것과 결과, 배경). 사용자 화면에서는 접혀 있어 펼쳐야 보인다. 설명은 "- 이름: 내용" 항목으로 쓴다. 화면에서는 접힌 설명 위에 그 이름들이 목차로 뜨니, 요약에 "설명에는 …이 있어요" 같은 목차 문장은 쓰지 않는다.',
    '- 마지막 줄들은 사용자 차례다: "물을 것:"(사용자가 답하거나 고를 것), "볼 것:"(사용자가 직접 보고 판단할 것), "다르게 한 것:"(요청과 다르게 했거나 요청 밖에서 한 일). 해당하는 줄만, 줄마다 한 문장. 요약 목록 안에는 넣지 않는다.',
    '- 사용자가 답하거나 볼 것이 없으면 사용자 차례 줄을 쓰지 않는다. 할 말을 채우려고 질문을 만들지 않는다.',
    '- 물을 것은 사용자만 정하거나 알 수 있는 것만 쓴다. 대화에서 이미 정했거나 답한 것, 파일이나 명령으로 확인할 수 있는 것은 묻지 말고 확인한다. 사용자가 물을 것을 모르겠다고 하면 설명한 뒤 그 질문을 쉬운 말로 고쳐 다시 묻는다.',
    '- 물을 것·볼 것 줄은 본문에는 보이지 않고 옆 패널의 "내 차례"에만 따로 뜨고, 다르게 한 것 줄은 접힌 설명 아래에 보인다. 그래서 사용자 차례 줄은 그 줄만 읽고 답할 수 있게 쓴다: 대상 이름과 왜 묻는지를 넣고, 고르는 것이면 선택지와 추천을 넣는다. "위·아래·이것·1번"처럼 본문을 가리키는 말이나 사용자가 모를 내부 이름만으로 쓰지 않는다.',
    '- 문장은 "80% of the way to ASD-STE100"으로 쓴다: 짧은 문장, 한 문장에 한 뜻, 한 단어에 한 뜻, 능동형.',
    '- 한국어 문장: 누가 하는 동작인지 흐려지면 주어를 쓴다. 수식어를 앞에 길게 쌓지 말고 문장을 나눈다. 끝말은 한 답 안에서 한 가지로 맞추고, "~함·~임" 같은 개조식 끝말은 쓰지 않는다. "~되어지다" 같은 번역투 피동은 쓰지 않는다. 같은 대상은 끝까지 같은 이름으로 부르고, 우리말이 있으면 영어보다 우리말을 쓴다. 코드·명령·고유명사는 원어로 둔다.',
    '- 형식: 기본은 글이다. 구조·흐름·관계를 설명하면 다이어그램을 붙이고, 눌러 보며 이해하는 편이 나으면 인터랙티브 HTML 페이지를 만들고, 내레이션과 움직임이 크게 도움이 될 때만 설명 영상을 만든다. 사용자가 형식을 고르기를 기다리지 않되, 무거운 형식은 들이는 품에 값할 때만 고른다.',
    '- 제목(#)은 쓰지 않는다. 굵은 글씨는 요약 목록의 이름에만 쓴다. 단서와 근거는 지우지 않는다.',
    '- 작업 중간에 쓰는 글은 한 줄로 쓴다.',
  ].join('\n')
}

// 규칙을 받은 대화에서 /baton off를 하면 다음 입력에 한 번 붙인다
export const OFF_RULE = '사용자가 이 세션에서 baton을 껐다. 앞에서 받은 "답 형식 (answer-blocks)" 규칙은 이제 따르지 않는다.'

// 옆 패널로 가는 사용자 차례 줄(물을 것·볼 것)과 본문에 남는 알림 줄(다르게 한 것)
const TURN_LABEL = /^\s*(?:[-*•]\s*)?(?:\*\*)?(?:물을 것|볼 것)(?:\*\*)?\s*[:：]/
const NOTICE_LABEL = /^\s*(?:[-*•]\s*)?(?:\*\*)?다르게 한 것(?:\*\*)?\s*[:：]/
const EXPLAIN_LABEL = /^\s*(?:\*\*)?설명(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*/

export type Blocks = { answer: string; explain: string; turn: string; notice: string }

// 첫 표시 줄 앞은 답. 그 뒤로는 "설명:" 줄부터 설명, 물을 것·볼 것 줄부터 사용자 차례, 다르게 한 것 줄부터 알림. 코드 블록 안은 나누지 않는다
export function splitBlocks(text: string): Blocks {
  const out: Record<keyof Blocks, string[]> = { answer: [], explain: [], turn: [], notice: [] }
  let section: keyof Blocks = 'answer'
  let inCode = false
  for (const line of text.split('\n')) {
    if (!inCode && EXPLAIN_LABEL.test(line)) {
      section = 'explain'
      const rest = line.replace(EXPLAIN_LABEL, '')
      if (rest.trim()) out.explain.push(rest)
      continue
    }
    if (!inCode && TURN_LABEL.test(line)) section = 'turn'
    else if (!inCode && NOTICE_LABEL.test(line)) section = 'notice'
    if (/^\s*```/.test(line)) inCode = !inCode
    out[section].push(line)
  }
  const joined = (k: keyof Blocks) => out[k].join('\n').trim()
  return { answer: joined('answer'), explain: joined('explain'), turn: joined('turn'), notice: joined('notice') }
}

// 본문에서 뺀 사용자 차례 줄을 대신하는 한 줄: 무엇이 몇 개 옆 패널로 갔는지
export function turnNote(turn: string): string {
  const counts: Record<string, number> = {}
  for (const line of turn.split('\n')) {
    const m = line.match(/^\s*(?:[-*•]\s*)?(?:\*\*)?(물을 것|볼 것)(?:\*\*)?\s*[:：]/)
    if (m?.[1]) counts[m[1]] = (counts[m[1]] ?? 0) + 1
  }
  const parts = Object.entries(counts).map(([k, n]) => `${k} ${n}`)
  return `↩ ${parts.length ? parts.join(' · ') : '사용자 차례'} → 옆 패널 내 차례 (/baton-side)`
}

// 접힌 설명의 목차: 설명의 맨 앞 단계 항목 이름("- 확인한 것: …"이나 "1. 확인한 것: …"이면 "확인한 것")을 글에서 그대로 뽑는다.
// 예전에는 모델이 첫 문단 끝에 "설명에는 …이 있어요"를 썼는데 항목을 빠뜨린 적이 있어서(2026-10-09 "확인한 것" 누락), 코드가 뽑는 이 줄로 바꿨다(2026-10-09 그 문장은 규칙에서 뺌)
export function explainIndex(explain: string): string[] {
  const name = (raw: string) => {
    const item = raw.replace(/\*\*/g, '').replace(/`/g, '').trim()
    const head = item.match(/^([^:：.。]{1,24})[:：]/)?.[1]?.trim()
    return head ?? (item.length > 18 ? `${item.slice(0, 18)}…` : item)
  }
  const items: string[] = []
  const paras: string[] = []
  let inCode = false
  let prevBlank = true
  for (const line of explain.split('\n')) {
    if (/^\s*```/.test(line)) inCode = !inCode
    if (inCode || /^\s*```/.test(line)) continue
    const m = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/)
    if (m?.[1]) items.push(name(m[1]))
    else if (prevBlank && line.trim() && !/^\s/.test(line)) paras.push(name(line))
    prevBlank = !line.trim()
  }
  // 목록이 없으면(문단만 쓴 설명) 문단마다 첫머리를 댄다
  return items.length ? items : paras
}

export function countChars(text: string): number {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim().length
}

export function textKey(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  let h = 5381
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0
  return `${t.length}:${(h >>> 0).toString(36)}`
}

// 설명이 있는 최근 답의 key, 새것이 끝: /baton-e가 키보드로 펼치고 접는다. 모듈 변수라 다시 불러오면 비고, 그때는 그려진 순서로 채운다
let recent: string[] = []
const remember = (key: string) => {
  recent = [...recent.filter(k => k !== key), key].slice(-20)
}

// /baton-e N: 끝에서 N번째 답(1이 마지막)의 설명을 펼치거나 접는다
export function pickRecent(list: readonly string[], arg: string): string | undefined {
  const n = arg.trim() ? Number(arg.trim()) : 1
  if (!Number.isInteger(n) || n < 1) return undefined
  return list[list.length - n]
}

const MD_MAX = 9500
const clip = (s: string) => (s.length > MD_MAX ? `${s.slice(0, MD_MAX)}\n…(ctrl+o로 원문)` : s)

export const E_COMMAND = { name: 'baton-e', description: '마지막 답의 설명 펼치기/접기 (/baton-e 2: 그 전 답)' }

// 이 세션에서 켜졌는지(live.ts). $를 쓰는 함수라 hook과 같은 파일에 둔다
async function live($: EngineInterface): Promise<boolean> {
  if (isKnown()) return isLive()
  // 읽다가 실패하면 이번만 꺼진 것으로 보고, 정하지 않은 채 두어 다음에 다시 읽는다
  const id = await $.session.id().catch(() => '')
  const list = id ? await $.store.get(SESSIONS).catch(() => null) : null
  return list === null ? false : settle(list, id)
}

// 규칙을 이미 받은 대화의 세션 id. 압축하면 규칙이 붙은 입력이 요약으로 바뀌어 사라지니 지운다
let ruleIn: string | undefined

export function registerBlocks(on: On): void {
  // 규칙은 시스템 프롬프트가 아니라 입력 옆 맥락으로 넣는다. Team·Enterprise 조직이나 managed settings가 있는 Mac에서는
  // 내장 cc-plugin-sec-default가 사용자 플러그인의 prompt.compose·prompt.section·prompt.context hook을 건너뛰지만 prompt.submit은 두기 때문이다(2.1.296에서 확인).
  // 입력마다 붙이면 약 760자씩 대화에 쌓여서, 대화마다 한 번(첫 입력, /clear 뒤, 압축 뒤) 붙인다
  on('prompt.submit', { text: /[\s\S]/ }, async ($, e, next) => {
    const isOn = await live($)
    if (!isOn && ruleIn === undefined) return next(e)
    const id = await $.session.id().catch(() => '')
    // 켜져 있으면 이 대화가 아직 규칙을 받지 않았을 때, 꺼져 있으면 이 대화가 규칙을 받았을 때만 붙인다
    if (isOn ? ruleIn === id : ruleIn !== id) return next(e)
    const r = await next({ ...e, context: [...(e.context ?? []), isOn ? ruleText() : OFF_RULE] })
    // 곁대화로 보내는 등 들어가지 않은 입력은 규칙을 싣지 못했으니 다음 입력에 다시 붙인다
    if (!r.drop) ruleIn = isOn ? id : undefined
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && e.trigger !== 'precompute' && r.messages) ruleIn = undefined
    return r
  })

  // 설명 덩어리는 접어서 한 줄 버튼으로만 보인다. 설명도 옆 패널로 갈 줄도 없는 답은 엔진이 그대로 그린다(다르게 한 것 줄은 원래 본문에 남는다)
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!(await live($))) return next(e)
    const b = splitBlocks(e.props.text)
    if (!b.explain && !b.turn) return next(e)
    const key = textKey(e.props.text)
    if (b.explain && !recent.includes(key)) remember(key)
    const isOpen = (await read($, expanded)).includes(key)
    const toggle = () =>
      update($, expanded, (l: string[]): string[] => (l.includes(key) ? l.filter(k => k !== key) : [...l, key].slice(-40)))
    const { Box, Text, Markdown, Button } = $.ui.resolve(e)
    const parts = []
    if (b.answer) parts.push(<Markdown key="answer" text={clip(b.answer)} />)
    if (b.explain && isOpen) {
      parts.push(<Markdown key="explain" text={clip(b.explain)} dimColor />)
      parts.push(<Button key={`close-${key}`} label="설명 접기" onPress={toggle} />)
    } else if (b.explain) {
      const index = explainIndex(b.explain)
      if (index.length) parts.push(<Text key="index" dimColor wrap="wrap">{`설명 목차: ${index.join(' · ')}`}</Text>)
      parts.push(<Button key={`open-${key}`} label={`설명 펼치기 (${countChars(b.explain)}자) /baton-e`} variant="primary" onPress={toggle} />)
    }
    // 다르게 한 것 줄은 답한 일의 일부라 본문에 그대로 둔다. 물을 것·볼 것 줄은 옆 패널(side-panel)의 내 차례로 보내고, 본문에는 한 줄만 남긴다
    if (b.notice) parts.push(<Markdown key="notice" text={clip(b.notice)} />)
    if (b.turn) parts.push(<Text key="turn" dimColor>{turnNote(b.turn)}</Text>)
    return <Box flexDirection="column">{parts}</Box>
  })

  on('turn.complete', { reason: 'answer' }, async ($, e, next) => {
    if (!(await live($))) return next(e)
    const done = await next(e)
    if (e.agentId || e.reason !== 'answer' || !e.answer.trim()) return done
    const b = splitBlocks(e.answer)
    if (b.explain) remember(textKey(e.answer))
    return done
  })

  // matcher 없는 session.start는 이것 하나다: -p·SDK에서도 돌아 대화형인지 기록한다(live.ts). 다른 mod의 session.start는 isInteractive: true에만 돈다
  on('session.start', async ($, e, next) => {
    if (!enter(e) || !(await live($))) return next(e)
    const started = await next(e)
    await $.command.register(E_COMMAND)
    return started
  })

  on('command.run', { command: 'baton-e' }, async ($, e) => {
    if (!(await live($))) return { text: OFF_TEXT }
    const key = pickRecent(recent, e.args)
    if (!key) return { text: recent.length ? `설명이 있는 답은 최근 ${recent.length}개예요. /baton-e 1~${recent.length}로 골라요.` : '펼칠 설명이 있는 답이 아직 없어요.' }
    let isOpen = false
    await update($, expanded, (l: string[]): string[] => {
      isOpen = !l.includes(key)
      return isOpen ? [...l, key].slice(-40) : l.filter(k => k !== key)
    })
    return { text: isOpen ? '설명을 펼쳤어요.' : '설명을 접었어요.' }
  })
}
