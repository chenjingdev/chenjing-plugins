import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { enter, isKnown, isLive, OFF_TEXT, SESSIONS, settle } from './live'
// 답을 세 덩어리로 쓰게 한다: 물은 것에 대한 답, 접혀 보이는 "설명:", 사용자 차례(물을 것·볼 것·다르게 한 것).
// 길이 제한은 두지 않는다: 설명은 접혀 있고, 사용자 차례는 본문에서 빠져 옆 패널(side-panel)의 내 차례에 뜬다.
// 2026-10-06 벤치마크에서 접힌 설명이 다음 판단에 필요한 단서·숫자를 숨겨서, 그것들은 첫 문단에 쓰게 했다.
// 2026-10-08 첫 문단 끝에 설명에 든 것의 이름을 대게 했다: 필요한 것이 접혔을 때 주제를 알린 비율 2/24 → 19/21(A3 벤치).
const EXPANDED = { plugin: 'chenjing-mods', key: 'expanded' } as const
const expanded = atom(EXPANDED, [])

export function ruleText(): string {
  return [
    '# 답 형식 (answer-blocks)',
    '- 답은 세 덩어리로 쓴다. 해당 없는 덩어리는 쓰지 않는다. 길이 제한은 없다.',
    '- 첫 문단: 사용자가 물은 것에 답한다. 결론부터, 보통 1~3문장. 물은 것과 상관없는 내용은 넣지 않는다.',
    '- 사용자는 접힌 설명을 펼치지 않고 첫 문단과 사용자 차례 줄만 보고 다음 말을 정한다. 그래서 결론에 붙는 단서(확인 못 함·추정·실패·위험)와 사용자가 판단에 쓸 숫자는 첫 문단에 쓴다. 물을 것에 답하는 데 필요한 선택지별 차이는 첫 문단이나 그 물을 것 줄에 쓴다.',
    '- "설명:"으로 시작하는 문단: 그 밖의 것(근거, 과정, 실제로 확인한 것과 결과, 배경). 사용자 화면에서는 접혀 있어 펼쳐야 보인다. 설명은 "- 이름: 내용" 항목으로 쓴다. 화면에서는 접힌 설명 위에 그 이름들이 목차로 뜨니, 첫 문단에 "설명에는 …이 있어요" 같은 목차 문장은 쓰지 않는다.',
    '- 마지막 줄들은 사용자 차례다: "물을 것:"(사용자가 답하거나 고를 것), "볼 것:"(사용자가 직접 보고 판단할 것), "다르게 한 것:"(요청과 다르게 했거나 요청 밖에서 한 일). 해당하는 줄만, 줄마다 한 문장.',
    '- 사용자 차례 줄은 본문에는 보이지 않고 옆 패널의 "내 차례"에만 따로 뜬다. 그래서 그 줄만 읽어도 무엇에 관한 것인지 알도록 대상 이름을 넣고, "위·아래·이것"처럼 본문을 가리키는 말을 쓰지 않는다.',
    '- 굵은 글씨와 제목은 쓰지 않는다. 단서와 근거는 지우지 않는다.',
    '- 작업 중간에 쓰는 글은 한 줄로 쓴다.',
  ].join('\n')
}

const TURN_LABEL = /^\s*(?:[-*•]\s*)?(?:\*\*)?(?:물을 것|볼 것|다르게 한 것)(?:\*\*)?\s*[:：]/
const EXPLAIN_LABEL = /^\s*(?:\*\*)?설명(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*/

export type Blocks = { answer: string; explain: string; turn: string }

// 첫 표시 줄 앞은 답. 그 뒤로는 "설명:" 줄부터 설명, 사용자 차례 이름이 붙은 줄부터 사용자 차례. 코드 블록 안은 나누지 않는다
export function splitBlocks(text: string): Blocks {
  const out: Record<keyof Blocks, string[]> = { answer: [], explain: [], turn: [] }
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
    if (/^\s*```/.test(line)) inCode = !inCode
    out[section].push(line)
  }
  return { answer: out.answer.join('\n').trim(), explain: out.explain.join('\n').trim(), turn: out.turn.join('\n').trim() }
}

// 본문에서 뺀 사용자 차례 줄을 대신하는 한 줄: 무엇이 몇 개 옆 패널로 갔는지
export function turnNote(turn: string): string {
  const counts: Record<string, number> = {}
  for (const line of turn.split('\n')) {
    const m = line.match(/^\s*(?:[-*•]\s*)?(?:\*\*)?(물을 것|볼 것|다르게 한 것)(?:\*\*)?\s*[:：]/)
    if (m?.[1]) counts[m[1]] = (counts[m[1]] ?? 0) + 1
  }
  const parts = Object.entries(counts).map(([k, n]) => `${k} ${n}`)
  return `↩ ${parts.length ? parts.join(' · ') : '사용자 차례'} → 옆 패널 내 차례 (/side)`
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

// 설명이 있는 최근 답의 key, 새것이 끝: /e가 키보드로 펼치고 접는다. 모듈 변수라 다시 불러오면 비고, 그때는 그려진 순서로 채운다
let recent: string[] = []
const remember = (key: string) => {
  recent = [...recent.filter(k => k !== key), key].slice(-20)
}

// /e N: 끝에서 N번째 답(1이 마지막)의 설명을 펼치거나 접는다
export function pickRecent(list: readonly string[], arg: string): string | undefined {
  const n = arg.trim() ? Number(arg.trim()) : 1
  if (!Number.isInteger(n) || n < 1) return undefined
  return list[list.length - n]
}

const MD_MAX = 9500
const clip = (s: string) => (s.length > MD_MAX ? `${s.slice(0, MD_MAX)}\n…(ctrl+o로 원문)` : s)

export const E_COMMAND = { name: 'e', description: '마지막 답의 설명 펼치기/접기 (/e 2: 그 전 답)' }

// 이 세션에서 켜졌는지(live.ts). $를 쓰는 함수라 hook과 같은 파일에 둔다
async function live($: EngineInterface): Promise<boolean> {
  if (isKnown()) return isLive()
  // 읽다가 실패하면 이번만 꺼진 것으로 보고, 정하지 않은 채 두어 다음에 다시 읽는다
  const id = await $.session.id().catch(() => '')
  const list = id ? await $.store.get(SESSIONS).catch(() => null) : null
  return list === null ? false : settle(list, id)
}

export function registerBlocks(on: On): void {
  on('prompt.compose', async ($, e, next) => {
    if (!(await live($))) return next(e)
    const r = await next(e)
    return { sections: [...r.sections, { id: 'answer-blocks:rule', text: ruleText(), scope: 'session' as const }] }
  })

  // 설명 덩어리는 접어서 한 줄 버튼으로만 보인다. 설명이 없는 답은 엔진이 그대로 그린다
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
      parts.push(<Button key={`open-${key}`} label={`설명 펼치기 (${countChars(b.explain)}자) /e`} variant="primary" onPress={toggle} />)
    }
    // 사용자 차례 줄은 옆 패널(side-panel)의 내 차례로 보내고, 본문에는 한 줄만 남긴다
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

  on('command.run', { command: 'e' }, async ($, e) => {
    if (!(await live($))) return { text: OFF_TEXT }
    const key = pickRecent(recent, e.args)
    if (!key) return { text: recent.length ? `설명이 있는 답은 최근 ${recent.length}개예요. /e 1~${recent.length}로 골라요.` : '펼칠 설명이 있는 답이 아직 없어요.' }
    let isOpen = false
    await update($, expanded, (l: string[]): string[] => {
      isOpen = !l.includes(key)
      return isOpen ? [...l, key].slice(-40) : l.filter(k => k !== key)
    })
    return { text: isOpen ? '설명을 펼쳤어요.' : '설명을 접었어요.' }
  })
}
