import { atom, read, update } from 'claude-code'
import type {EngineInterface, On, PluginOptions } from 'claude-code'

import { splitBlocks } from './answer-blocks'
import { enter, isKnown, isLive, SESSIONS, settle } from './live'
import type { Ask, AsksStats as Stats, Book, Exchange } from '../types'

// Claude가 사용자에게 넘긴 일(물을 것·볼 것)을 모아 두고, 입력창 아래 줄 끝에 개수를 보인다. 목록은 옆 패널의 내 차례(side-panel).
// 다르게 한 것은 답할 것이 없는 알림이라 모으지 않는다: 본문에 남는다(answer-blocks).
// 턴이 끝날 때마다 작은 모델이 판정한다: 이번 메시지로 답한 질문은 닫고, 같은 것을 묻는 질문은 하나로 합치고, 상황이 바뀌었거나 글만으로 알 수 없는 질문은 고쳐 쓰고, 이번 답의 새 질문은 더한다.
// 합치기와 고쳐 쓰기는 0.7.10에서 더했다(2026-10-25 사용자 "중복질문은 합치는 기능도 있었으면 좋겠다. 그리고 모르는건 다시 맥락파악해서 적고, 대충 질문 올리는 일은 없엇으면 좋겠음").
// 지난 16일 baton 세션 12개에서 같은 질문이 말만 바뀌어 다시 올라온 일이 열 번 넘게 있었다: 대개 사용자가 "뭔소리지"라고 되물어 Claude가 쉬운 말로 다시 물었는데, 옛 질문이 닫히지 않고 남았다.
// 패널로 답한 항목 75개 중 20개쯤은 "이건 뭔데?" "뭘 바꿨음?" 같은 되물음이었다. 판정이 쓴 질문은 60자 제한 때문에 무엇을·왜가 빠진 것이 많았다
// 0.7.12에서 둘을 더했다(2026-10-27 사용자 "side패널에 필요없는 결정내역들은 갱신해주기로 했던거 같았는데"). 답 없이 세 턴을 지나친 항목은 대화가 다른 일로 넘어갔으면 닫는다(stale).
// 사용자가 메시지를 보내면 Claude 답을 기다리지 않고 그 메시지로 끝난 항목을 닫는다(judgeMessage). 0.7.11까지는 "다른 얘기를 하면 닫지 않는다"는 규칙 때문에 넘어간 질문이 끝까지 남았고,
// 판정이 턴 끝에만 돌아서 입력창에 "ㄱㄱ"로 답한 질문도 긴 턴 내내 남았다(2026-10-27 agent-bar에서 8분 넘게)

const BOOK = { plugin: 'baton', key: 'book' } as const
const TURN = { plugin: 'baton', key: 'turn' } as const
const LAST = { plugin: 'baton', key: 'lastRequest' } as const
const HUMAN = { plugin: 'baton', key: 'humanTurn' } as const
const STATS = { plugin: 'baton', key: 'asksStats' } as const
const JUDGED = { plugin: 'baton', key: 'judgedAnswer' } as const
const RECENT = { plugin: 'baton', key: 'recentTurns' } as const
// 옆 패널이 항목 id별로 쥔 써 둔 답(side-panel): 합칠 때 답을 써 둔 항목을 남긴다
const KEEP = { plugin: 'baton', key: 'sideKeep' } as const
export const EMPTY: Book = { items: [], closed: [], seq: 0 }
// 이 세션에서 지난 세션 항목을 이미 가져왔는지, 세션이 끝날 때 쓸 작업 폴더
let importedFor = ''
let cwdNow = ''
const book = atom(BOOK, EMPTY)
const turn = atom(TURN, 0)
const lastRequest = atom(LAST, '')
const humanTurn = atom(HUMAN, false)
const stats = atom(STATS, { judged: 0, failed: 0 })
const recent = atom(RECENT, [])

export type Settings = { model: 'sonnet' | 'haiku' }

export function settingsFrom(o: PluginOptions): Settings {
  return { model: o['judge_model'] === 'haiku' ? 'haiku' : 'sonnet' }
}

const CODE = /```[\s\S]*?```/g

// 다른 mod가 사용자의 말로 보낸 글(asUser)도 사람 턴으로 센다. baton 자신이 보낸 글은 이 훅에 오지 않는다(countHumanTurn)
export function isHuman(origin: { kind?: string; asUser?: boolean } | undefined): boolean {
  if (!origin || origin.kind === undefined || origin.kind === 'composer' || origin.kind === 'bridge') return true
  return origin.kind === 'plugin' && origin.asUser === true
}

// 패널로 보낸 답이 되물음인지: 모르겠다는 말이 있거나, 무엇·왜를 묻고 물음표로 끝난다.
// 물음표만 보지 않는 것은 "~하는게 나을듯?" "1회성 아님?"처럼 물음표로 끝나는 답·반대가 많아서다(2026-10-25 패널로 답한 항목 75개)
const CONFUSED = /뭔\s?(?:소리|말|뜻|데|쇠)|뭐(?:야|임)|머야|무슨\s?(?:소리|말|뜻|질문|얘기|상관)|모르겠|이해\s?(?:가\s?)?(?:안|못)|헷갈|eli5/i
const WHAT = /뭐|뭘|뭔|왜|어떻게|어디|언제|누가|무슨|어느|몇/

export function asksBack(answer: string): boolean {
  const t = answer.trim()
  return CONFUSED.test(t) || (/[?？]$/.test(t) && WHAT.test(t))
}

// "↩ 항목 → 답" 줄로 답한 항목(옆 패널의 [답하기]가 입력창에 붙인 줄): 판정을 기다리지 않고 바로 닫는다.
// 답이 되물음("이건 뭔데?" "아직 뭔소리인지 모르겠다")이면 닫지 않는다: Claude가 설명한 뒤 판정이 그 설명을 넣어 고쳐 쓴다.
// 0.7.9까지는 되물어도 닫혀서, Claude가 다시 묻지 않으면 그 질문이 사라졌다
export function answeredIds(items: readonly Ask[], text: string): number[] {
  const ids: number[] = []
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    if (!l.startsWith('↩')) continue
    const rest = l.slice(1).trim()
    const said = (a: Ask) => rest.slice(a.text.length + 3).trim()
    const hit = items.find(a => rest.startsWith(`${a.text} → `) && said(a) !== '')
    if (hit && !asksBack(said(hit)) && !ids.includes(hit.id)) ids.push(hit.id)
  }
  return ids
}

// 열린 항목이 없을 때는 물음표나 "물을 것"이 있는 답만 판정에 보낸다
export function mayAsk(answer: string): boolean {
  return /[?？]|물을 것/.test(answer.replace(CODE, ' '))
}

// 항목 글은 300자까지 그대로 둔다: 옆 패널이 줄을 바꿔 다 보여 준다. 띠에 한 줄로 보이던 때의 80자 제한은 2026-10-06 긴 줄을 잘라서 뺐다
export function shorten(s: string, n = 300): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const sameKey = (s: string) => s.replace(/[\s?？.!,·…"'“”]/g, '')

export const JUDGE_SYSTEM =
  '너는 대화에서 Claude가 사용자에게 넘긴 일(질문, 볼 것) 가운데 아직 끝나지 않은 것을 관리한다. 대화에 없는 내용을 만들지 않는다. JSON 한 줄만 출력한다.'

// 판정에 맥락으로 붙이는 앞선 턴: 사용자 메시지와 답의 요약(설명·사용자 차례 줄을 뺀 첫 덩어리)
export function exchangeOf(request: string | undefined, answer: string): Exchange {
  return { request: shorten(request ?? '(알림 등으로 시작된 턴)', 300), answer: shorten(splitBlocks(answer).answer || answer, 700) }
}

// 다시 불러온 뒤 같은 턴을 다시 판정해도 겹치지 않게 같은 것은 빼고 붙인다. 앞선 두 턴만 둔다
export function withExchange(list: readonly Exchange[], x: Exchange): Exchange[] {
  return [...list.filter(y => y.request !== x.request || y.answer !== x.answer), x].slice(-2)
}

// 판정 전에 답 없이 두 번 지나친 항목(이번 턴이 세 번째)은 "오래됨"으로 보인다: 대화가 다른 일로 넘어갔으면 판정이 닫는다(stale)
export const STALE_SKIPS = 2

function whenAsked(a: Ask, turnNo: number, fresh: ReadonlySet<number>): string {
  if (fresh.has(a.id)) return '이번 답에서 물음'
  if (a.skips === 0) return '직전 답에서 물음'
  return `${Math.max(1, turnNo - a.turn)}턴 전에 물었고 아직 답 없음${a.skips >= STALE_SKIPS ? ' · 오래됨' : ''}`
}

function listText(items: readonly Ask[], turnNo: number, fresh: ReadonlySet<number> = new Set()): string {
  return items.length ? items.map((a, i) => `${i + 1}. ${a.text} (${whenAsked(a, turnNo, fresh)})`).join('\n') : '(없음)'
}

function beforeText(before: readonly Exchange[]): string[] {
  return before.length ? ['', '[앞선 대화: 맥락을 알기 위한 것이다. 여기서 질문을 뽑지 않는다]', ...before.map(x => `사용자: ${x.request}\nClaude: ${x.answer}`)] : []
}

// 판정에 보이는 목록에는 이번 답에서 물은 항목도 넣는다: 앞의 질문을 다시 물었으면 합치고, 글만으로 알 수 없으면 고쳐 쓰게 한다.
// fresh: 그 항목들의 id. 이번 메시지로 닫힐 수 없어서 판정에 그렇게 알린다
export function judgePrompt(
  items: readonly Ask[],
  request: string | undefined,
  answer: string,
  turnNo: number,
  fresh: ReadonlySet<number> = new Set(),
  before: readonly Exchange[] = [],
): string {
  return [
    '[내 차례: 사용자가 옆 패널에서 보는 항목]',
    listText(items, turnNo, fresh),
    ...beforeText(before),
    '',
    '[이번 사용자 메시지]',
    request === undefined ? '(없음: 알림 등으로 시작된 턴)' : request.slice(0, 1500),
    '',
    '[이번 Claude 답]',
    answer.replace(CODE, '[코드 블록]').slice(0, 6000),
    '',
    '옆 패널은 대화와 떨어져 있어서, 사용자는 항목 글만 보고 답한다. 여섯 가지를 판정하라.',
    'closed: 이번 턴으로 끝난 항목의 번호("이번 답에서 물음"은 넣지 않는다). 사용자가 답했거나 골랐거나 거절·보류한 것, Claude가 이번 답에서 이미 처리한 것, Claude가 그 안을 거두었거나 상황이 바뀌어 더 물을 필요가 없어진 것. "ㅇㅇ" "ㄱㄱ" "해봐"처럼 짧은 답은 직전 답의 질문에 대한 답으로 본다. 사용자가 다른 얘기를 했거나, 그 항목을 모르겠다고 하거나 되묻기만 했으면 닫지 않는다.',
    'stale: "오래됨" 표시가 붙은 항목(사용자가 답하지 않고 여러 턴을 지나친 것) 가운데, 대화가 다른 일로 넘어가 이제 답이 필요 없어진 것의 번호. 지금 하는 일이 아직 그 답을 기다리거나, 답이 없어서 다음 단계가 멈춰 있으면 넣지 않는다.',
    'merged: 같은 결정을 묻는 항목의 묶음. 하나에 답하면 다른 것도 답이 되는 것만 합친다: 같은 질문을 말만 바꿔 다시 물은 것, 한 항목이 다른 항목에 들어 있는 것. 대상이 같아도 정할 것이 다르면 합치지 않는다. 이번 답에서 물은 항목끼리는 합치지 않는다(Claude가 일부러 나눠 물었다). "볼 것:" 항목과 질문은 합치지 않는다. 합친 글은 가장 나중에 물은 글을 바탕으로, 앞 항목에만 있던 그 결정의 선택지·이유를 더해 쓴다. 다른 결정의 내용은 넣지 않는다.',
    'clear: "이번 답에서 물음" 항목을 하나씩 대화를 못 본 사람 눈으로 읽는다. 대화를 가리키는 말("이 주소" "이 토큰" "1번" "B안" "① 줄" "위 방법")이 있거나 대상이 빠져서 그 글만으로는 무엇을 정하거나 보라는지 알 수 없으면, 이번 답에서 찾아 채운 글을 넣는다. 그 글만으로 알 수 있으면 넣지 않는다.',
    'changed: 앞서 물은 항목이 둘 중 하나일 때만 번호와 고친 글을 넣는다. ① 상황이 바뀌었다(선택지가 줄었거나, 전제가 바뀌었거나, 이미 정해진 부분이 생겼다). ② 사용자가 그 항목을 모르겠다고 하거나 되물었고, Claude가 이번 답에서 설명했다: 그 설명을 넣어 쉬운 말로 다시 쓴다. 사용자가 그 항목에 답하거나 지시했으면 고치지 말고 closed에 넣는다. 말투를 다듬거나 진행 상황을 덧붙이려고 고치지 않는다.',
    'new: 이번 Claude 답에서 사용자가 답하거나 골라야 다음으로 넘어가는데 "물을 것:" 줄로 쓰지 않은 질문("할까요?" "어느 쪽으로 할까요?" 같은 것). 수사적 질문, 이번 메시지에서 이미 답한 것, 목록에 있는 것과 같은 것을 묻는 것, "다르게 한 것:" 줄(한 일을 알리기만 한다)은 넣지 않는다. 최대 3개.',
    'merged·clear·changed·new의 글: 그 글만 보고 답할 수 있게 쓴다. 무엇을 정하는지와 왜 묻는지를 대상 이름과 함께 넣고, 고르는 질문이면 선택지를, 추천이 있으면 추천도 넣는다. 사용자가 모를 내부 이름(함수, 파일, 단계 번호)만으로 쓰지 말고 쉬운 말로 쓴다. 글은 사용자에게 묻는 질문(볼 것은 볼 것)이다: 사용자가 한 말, 판정한 까닭, 다른 항목의 번호를 적지 않는다. 대화에 없는 내용을 만들지 않고 원문보다 단정하지 않게, 한두 문장 150자 안으로 쓴다.',
    '한 번호는 closed·stale·merged·clear·changed 가운데 한 곳에만 넣는다.',
    '출력 형식: {"closed":[번호],"stale":[번호],"merged":[{"n":[번호,번호],"text":"합친 글"}],"clear":[{"n":번호,"text":"채운 글"}],"changed":[{"n":번호,"text":"고친 글"}],"new":["질문"]}',
  ].join('\n')
}

// clear: 이번 답에서 물은 항목 가운데 글만으로 알 수 없어 채운 것, changed: 앞서 물은 항목 가운데 상황이 바뀌었거나 되물어서 고친 것
export type Judgment = {
  closed: number[]
  stale: number[]
  merged: { n: number[]; text: string }[]
  clear: { n: number; text: string }[]
  changed: { n: number; text: string }[]
  added: string[]
}

// 글 속의 JSON 객체 가운데 마지막으로 온전한 것. 판정 모델이 JSON을 쓴 뒤 "Wait — 고친 출력:"과 함께 하나를 더 쓸 때가 있다(2026-10-25 시험에서 115번 중 4번)
function lastObject(text: string): unknown {
  const found: string[] = []
  let depth = 0
  let start = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
    } else if (c === '"' && depth > 0) inString = true
    else if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}' && depth > 0 && --depth === 0) found.push(text.slice(start, i + 1))
  }
  for (const s of found.reverse()) {
    try {
      return JSON.parse(s)
    } catch {
      // 앞의 것을 본다
    }
  }
  return undefined
}

// 한 번호는 한 곳에만 쓴다: 닫는 번호는 합치지 않고, 앞 묶음에 든 번호는 다음 묶음과 고쳐 쓰기에서 뺀다
export function parseJudgment(text: string): Judgment | undefined {
  const j = lastObject(text) as { closed?: unknown; stale?: unknown; merged?: unknown; clear?: unknown; changed?: unknown; new?: unknown } | undefined
  if (!j || typeof j !== 'object') return undefined
  const closed = Array.isArray(j.closed) ? j.closed.map(Number).filter(n => Number.isInteger(n) && n > 0) : []
  const used = new Set(closed)
  const stale = Array.isArray(j.stale) ? [...new Set(j.stale.map(Number))].filter(n => Number.isInteger(n) && n > 0 && !used.has(n)) : []
  for (const n of stale) used.add(n)
  const merged: Judgment['merged'] = []
  for (const x of Array.isArray(j.merged) ? j.merged : []) {
    const raw = (x as { n?: unknown })?.n
    const n = [...new Set((Array.isArray(raw) ? raw : []).map(Number))].filter(k => Number.isInteger(k) && k > 0 && !used.has(k))
    if (n.length < 2) continue
    for (const k of n) used.add(k)
    merged.push({ n, text: String((x as { text?: unknown })?.text ?? '').trim() })
  }
  const rewrites = (raw: unknown) => {
    const out: { n: number; text: string }[] = []
    for (const x of Array.isArray(raw) ? raw : []) {
      const n = Number((x as { n?: unknown })?.n)
      const t = String((x as { text?: unknown })?.text ?? '').trim()
      if (!Number.isInteger(n) || n <= 0 || !t || used.has(n)) continue
      used.add(n)
      out.push({ n, text: t })
    }
    return out
  }
  const clear = rewrites(j.clear)
  const changed = rewrites(j.changed)
  const added = Array.isArray(j.new)
    ? j.new.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean).slice(0, 3)
    : []
  return { closed, stale, merged, clear, changed, added }
}

// 사용자가 메시지를 보낸 순간의 판정은 닫기만 한다. 새 질문·합치기·고쳐 쓰기·오래된 항목은 Claude 답이 끝날 때 판정한다
export function messagePrompt(items: readonly Ask[], request: string, turnNo: number, before: readonly Exchange[] = []): string {
  return [
    '[내 차례: 사용자가 옆 패널에서 보는 항목]',
    listText(items, turnNo),
    ...beforeText(before),
    '',
    '[방금 보낸 사용자 메시지: Claude는 아직 답하지 않았다]',
    request.slice(0, 1500),
    '',
    'closed: 이 메시지로 끝난 항목의 번호. 사용자가 답했거나 골랐거나 거절·보류한 것, 이 메시지로 정해져서 더 묻거나 볼 필요가 없어진 것. "ㅇㅇ" "ㄱㄱ" "해봐"처럼 짧은 답은 직전 답에서 물은 질문에 대한 답으로 본다. 사용자가 다른 얘기를 했거나, 그 항목을 모르겠다고 하거나 되묻기만 했으면 넣지 않는다. 애매하면 넣지 않는다: Claude가 답한 뒤에 한 번 더 판정한다.',
    '출력 형식: {"closed":[번호]}',
  ].join('\n')
}

// 메시지 판정이 닫은 번호를 지금 내 차례에 옮긴다. 판정하는 사이에 합쳐지거나 고쳐 써져 글이 바뀐 항목은 판정이 본 것과 달라서 닫지 않는다
export function closeSeen(cur: Book, list: readonly Ask[], nums: readonly number[], turnNo: number, now: number): Book {
  const ids = nums
    .map(n => list[n - 1])
    .filter((a): a is Ask => !!a && cur.items.some(c => c.id === a.id && c.text === a.text))
    .map(a => a.id)
  return ids.length ? apply(cur, [], ids, [], turnNo, now, false) : cur
}

// 사용자 차례 줄(물을 것·볼 것)은 모델 판정을 기다리지 않고 바로 띠에 올린다. 다르게 한 것 줄은 올리지 않는다
const TURN_LINE = /^(물을 것|볼 것)\s*[:：]\s*/

export function labeledAsks(answer: string): string[] {
  const out: string[] = []
  for (const raw of answer.replace(CODE, ' ').split('\n')) {
    const l = raw.replace(/^[\s>*\-•]+/, '').replace(/\*\*/g, '').trim()
    const m = l.match(TURN_LINE)
    const rest = m ? l.slice(m[0].length).trim() : ''
    if (m && rest) out.push(m[1] === '물을 것' ? rest : `${m[1]}: ${rest}`)
  }
  return out.slice(0, 5)
}

// 고쳐 쓴 글에 원래 글의 머리말("볼 것:", "지난 세션:")이 빠졌으면 붙인다: 볼 것은 다음 답에서 닫히고, 지난 세션 표시는 어디서 온 질문인지 알린다
const HEAD = /^(?:볼 것\s*[:：]|지난 세션\s*[:：])\s*/

export function keepHead(was: string, text: string): string {
  const head = was.match(HEAD)?.[0] ?? ''
  const t = text.trim()
  return !t || !head || HEAD.test(t) ? t : `${head}${t}`
}

const pairsOf = (s: string) => {
  const t = s.replace(/[\s?？.!,·…"'“”()]/g, '')
  const out = new Set<string>()
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
  return out
}

// 두 글이 말투만 다른지: 붙은 두 글자 묶음이 85% 넘게 겹친다.
// 판정 모델은 같은 질문을 턴마다 조금씩 다시 써서 글이 자꾸 바뀌었다(2026-10-25 시험에서 고쳐 쓰기 47번 중 13번이 이만큼 겹쳤고, 그중 11번은 말투나 진행 상황만 바꿨다)
export function nearlySame(a: string, b: string): boolean {
  const x = pairsOf(a)
  const y = pairsOf(b)
  if (!x.size || !y.size) return false
  let both = 0
  for (const p of x) if (y.has(p)) both++
  return (2 * both) / (x.size + y.size) >= 0.85
}

// 판정이 고쳐 쓰거나 합친 글로 받을 것: 300자(항목 글 상한)를 넘으면 자르지 않고 받지 않는다. 자르면 끝에 오는 묻는 말이 잘린다
function judgeText(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= 300 ? t : ''
}

// seen: 판정 모델이 본 질문 id. 그중 닫히지 않은 것은 사람 턴이 한 번 지나갈 때마다 skips가 는다.
// changed: 상황이 바뀌었거나 글만으로 알 수 없어 고쳐 쓴 글(id별). id를 그대로 두어 옆 패널에 써 둔 답이 남는다. 다른 항목과 같아지거나 너무 길면 고치지 않는다
export function apply(
  b: Book,
  seen: readonly number[],
  closedIds: readonly number[],
  added: readonly string[],
  turnNo: number,
  now: number,
  countSkips: boolean,
  changed: ReadonlyMap<number, string> = new Map(),
): Book {
  const items: Ask[] = []
  const closed = [...b.closed]
  const others = (id: number) => new Set(b.items.filter(a => a.id !== id).map(a => sameKey(a.text)))
  for (const a of b.items) {
    if (closedIds.includes(a.id)) {
      closed.push({ text: a.text, at: now })
      continue
    }
    const t = changed.has(a.id) ? judgeText(keepHead(a.text, changed.get(a.id) ?? '')) : ''
    const next = t && !others(a.id).has(sameKey(t)) ? { ...a, text: t } : a
    items.push(countSkips && seen.includes(a.id) ? { ...next, skips: next.skips + 1 } : next)
  }
  let seq = b.seq
  const have = new Set(items.map(a => sameKey(a.text)))
  for (const t of added) {
    const text = shorten(t)
    if (!text || have.has(sameKey(text))) continue
    have.add(sameKey(text))
    items.push({ id: ++seq, text, turn: turnNo, at: now, skips: 0 })
  }
  return { items: items.slice(-12), closed: closed.slice(-10), seq }
}

const isNotice = (a: Ask) => /^(볼 것|다르게 한 것):/.test(a.text)

// 같은 것을 묻는 항목 묶음(ids)을 하나로 합친다. 남는 것은 가장 먼저 들어온 항목이라 패널에서 자리가 그대로다.
// 옆 패널은 써 둔 답을 항목 id별로 쥐어서(hasDraft), 답을 써 둔 항목이 있으면 그 항목을 남기고 둘 이상이면 합치지 않는다.
// 글은 판정이 합친 글(비었거나 너무 길면 가장 나중에 물은 글)이고, 모두 같은 머리말(볼 것·지난 세션)이면 그 머리말을 둔다.
// 물은 턴은 가장 나중 것이다: 방금 다시 물은 질문은 답 없이 지나간 질문이 아니다.
// 볼 것과 질문이 섞인 묶음, 이번 답에서 물은 항목(fresh)이 둘 이상인 묶음은 합치지 않는다: 볼 것은 다음 답에서 닫히는 알림이고,
// 한 답에서 따로 물은 질문은 Claude가 일부러 나눈 것이다(2026-10-25 시험에서 "시험용 컨테이너를 지울까요?"와 "CLI 문제를 고칠까요?"가 합쳐졌다)
export function merge(
  b: Book,
  groups: readonly { ids: readonly number[]; text: string }[],
  hasDraft: (id: number) => boolean = () => false,
  fresh: ReadonlySet<number> = new Set(),
): Book {
  let items = b.items
  for (const g of groups) {
    const members = items.filter(a => g.ids.includes(a.id))
    const drafted = members.filter(a => hasDraft(a.id))
    if (members.length < 2 || drafted.length > 1) continue
    if (new Set(members.map(isNotice)).size > 1 || members.filter(a => fresh.has(a.id)).length > 1) continue
    const keep = drafted[0] ?? members.reduce((x, y) => (y.id < x.id ? y : x))
    const last = members.reduce((x, y) => (y.turn > x.turn || (y.turn === x.turn && y.id > x.id) ? y : x))
    const said = judgeText(members.every(a => HEAD.test(a.text)) ? keepHead(keep.text, g.text) : g.text)
    const others = new Set(items.filter(a => !g.ids.includes(a.id)).map(a => sameKey(a.text)))
    const text = said && !others.has(sameKey(said)) ? said : last.text
    const one: Ask = { ...keep, text, turn: last.turn, skips: Math.min(...members.map(a => a.skips)) }
    items = items.filter(a => a.id === keep.id || !g.ids.includes(a.id)).map(a => (a.id === keep.id ? one : a))
  }
  return items === b.items ? b : { ...b, items }
}

// 이번 답의 사용자 차례 줄로 올라간 항목의 id
export function freshIds(items: readonly Ask[], taken: readonly string[]): Set<number> {
  const keys = new Set(taken.map(t => sameKey(shorten(t))))
  return new Set(items.filter(a => keys.has(sameKey(a.text))).map(a => a.id))
}

// 판정을 내 차례에 옮긴다. list: 판정에 보인 항목(번호 순), fresh: 그중 이번 답에서 물은 항목.
// 이번 답에서 물은 항목은 이번 메시지로 닫지 않고, 답 없이 지나간 횟수(skips)도 세지 않는다. 그사이 패널에서 지운 항목은 건드리지 않는다.
// 오래된 항목 닫기(stale)는 "오래됨"으로 보인 항목만 받고, 옆 패널에 답을 써 둔 항목은 받지 않는다: 답하려던 질문이다
export function applyJudgment(
  b: Book,
  list: readonly Ask[],
  fresh: ReadonlySet<number>,
  j: Judgment,
  turnNo: number,
  now: number,
  countSkips: boolean,
  hasDraft?: (id: number) => boolean,
): Book {
  const idOf = (n: number) => list[n - 1]?.id
  const staleIds = j.stale
    .map(n => list[n - 1])
    .filter((a): a is Ask => !!a && !fresh.has(a.id) && a.skips >= STALE_SKIPS && !hasDraft?.(a.id))
    .map(a => a.id)
  const closedIds = [...j.closed.map(idOf).filter((id): id is number => id !== undefined && !fresh.has(id)), ...staleIds]
  // 앞서 물은 항목의 고쳐 쓰기는 말투만 달라졌으면 받지 않는다(nearlySame). 글만으로 알 수 없어 채운 것(clear)은 몇 글자만 바뀌어도 받는다: "이 주소"를 주소로 바꾸는 것도 그렇다
  const changed = new Map<number, string>()
  for (const c of j.changed) {
    const a = list[c.n - 1]
    if (a && !nearlySame(a.text, c.text)) changed.set(a.id, c.text)
  }
  for (const c of j.clear) {
    const a = list[c.n - 1]
    if (a) changed.set(a.id, c.text)
  }
  const groups = j.merged.map(m => ({ ids: m.n.map(idOf).filter((id): id is number => id !== undefined), text: m.text }))
  const seen = list.filter(a => !fresh.has(a.id)).map(a => a.id)
  return merge(apply(b, seen, closedIds, j.added, turnNo, now, countSkips, changed), groups, hasDraft, fresh)
}

// 답을 못 한 질문은 세션이 끝날 때 $.store에 작업 폴더별로 남기고, 그 폴더의 다음 세션이 가져간다
export type Carried = { text: string; at: number }
export const CARRY_PREFIX = '지난 세션: '

export function carryKey(cwd: string): string {
  return `carry:${cwd}`
}

// 넘길 것은 답을 기다리는 질문뿐이다. 볼 것은 알림이라 넘기지 않는다(0.7.2까지 모은 다르게 한 것도)
export function toCarry(b: Book): Carried[] {
  return b.items
    .filter(a => !/^(볼 것|다르게 한 것):/.test(a.text))
    .map(a => ({ text: a.text.startsWith(CARRY_PREFIX) ? a.text : `${CARRY_PREFIX}${a.text}`, at: a.at }))
}

export function readCarried(raw: unknown): Carried[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((c): c is Carried => !!c && typeof c === 'object' && typeof (c as Carried).text === 'string' && typeof (c as Carried).at === 'number')
}

export function mergeCarried(old: unknown, add: readonly Carried[]): Carried[] {
  const prev = readCarried(old)
  const seen = new Set(prev.map(c => sameKey(c.text)))
  return [...prev, ...add.filter(c => !seen.has(sameKey(c.text)))].slice(-12)
}

// 세션이 끝날 때 판정을 마친 마지막 답의 지문(answerMark)을 세션 id별로 store에 남긴다. --resume하면 $.state가 비어서다. 최근 50개 세션만 둔다
export const END_MARKS = 'judgedAtEnd'

function marksOf(raw: unknown): [string, string][] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.entries(raw as Record<string, unknown>).filter((x): x is [string, string] => typeof x[1] === 'string')
}

export function withEndMark(raw: unknown, id: string, mark: string): Record<string, string> {
  return Object.fromEntries([...marksOf(raw).filter(([k]) => k !== id), [id, mark] as [string, string]].slice(-50))
}

export function endMarkOf(raw: unknown, id: string): string {
  return marksOf(raw).find(([k]) => k === id)?.[1] ?? ''
}

async function importCarried($: EngineInterface) {
  const id = await $.session.id()
  if (importedFor === id) return
  importedFor = id
  cwdNow = cwdNow || (await $.session.cwd())
  const key = carryKey(cwdNow)
  const list = readCarried(await $.store.get(key))
  if (!list.length) return
  await $.store.delete(key)
  const { value: turnNo = 0 } = await $.state.get(TURN)
  await update($, book, (cur: Book): Book => apply(cur, [], [], list.map(c => c.text), turnNo, Date.now(), false))
}

// 지운 항목을 제자리(들어온 순서인 id 순)에 되살린다: 그사이 같은 항목이 다시 들어왔으면 겹치지 않게 한다
export function restore(b: Book, back: readonly Ask[]): Book {
  const have = new Set(b.items.map(a => sameKey(a.text)))
  return { ...b, items: [...back.filter(a => !have.has(sameKey(a.text))), ...b.items].sort((x, y) => x.id - y.id) }
}

// "볼 것"은 알림이라 다음 답이 나오면 닫는다(0.7.2까지 모은 "다르게 한 것"도 이때 닫힌다). 답을 기다리는 건 "물을 것"뿐이다
export function supersede(b: Book, now: number): Book {
  const gone = b.items.filter(isNotice)
  if (!gone.length) return b
  return { ...b, items: b.items.filter(a => !isNotice(a)), closed: [...b.closed, ...gone.map(a => ({ text: a.text, at: now }))].slice(-10) }
}

// 모델에게 붙이는 목록은 답 없이 한 번 이상 지나간 질문만: 방금 물은 질문은 바로 위 답에 있다
export function waiting(b: Book): Ask[] {
  return b.items.filter(a => a.skips >= 1)
}

// 입력창 아래 줄 끝에 늘 붙는 표시: 켜져 있는지, 방금 넘긴 일이 잡혔는지 바로 보인다
export function tailText(b: Book): string {
  return b.items.length ? `↩ 내 차례 ${b.items.length}` : '↩ 내 차례 없음'
}

export function contextText(list: readonly Ask[]): string {
  return [
    '[open-asks] 사용자가 아직 답하지 않은 이전 질문이다. 사용자는 옆 패널의 내 차례에서 이 번호를 본다.',
    ...list.map((a, i) => `${i + 1}. ${a.text}`),
    '사용자의 메시지가 이 중 하나에 대한 답이면(번호나 "아까 그거"로 가리켜도) 그 질문에 대한 답으로 처리한다. 관계없는 메시지면 이 목록을 언급하지 않는다.',
  ].join('\n')
}

// 대화의 마지막 답과 그 앞 사용자 메시지: 다시 불러온 직후, 불러오기 전에 끝난 턴을 판정할 때 쓴다
export function lastExchange(msgs: readonly { role: string; text: string }[]): { request: string; answer: string } | undefined {
  let i = msgs.length - 1
  while (i >= 0 && !(msgs[i]?.role === 'assistant' && msgs[i]?.text.trim())) i--
  const answer = msgs[i]?.text
  if (i < 0 || !answer) return undefined
  let j = i - 1
  while (j >= 0 && !(msgs[j]?.role === 'user' && msgs[j]?.text.trim())) j--
  return { request: msgs[j]?.text ?? '', answer }
}

// 판정을 마친 답의 지문: 공백을 뺀 글의 길이와 해시. turn.complete의 답과 다시 읽은 대화의 답은 공백·줄바꿈이 다를 수 있다
export function answerMark(answer: string): string {
  const t = answer.replace(/\s+/g, '')
  let h = 5381
  for (let i = 0; i < t.length; i++) h = (Math.imul(h, 33) ^ t.charCodeAt(i)) >>> 0
  return `${t.length}:${h.toString(36)}`
}

// request가 undefined면 사람이 쓴 메시지가 없는 턴이다. countSkips가 false면 닫고 더하기만 한다(같은 턴을 다시 판정할 때)
async function judge($: EngineInterface, s: Settings, answer: string, request: string | undefined, countSkips: boolean) {
  await judgeOnce($, s, answer, request, countSkips)
  await update($, recent, (l: Exchange[]) => withExchange(l, exchangeOf(request, answer)))
  // 끝까지 간 판정만 적는다(판정 모델이 답하지 못한 것도 끝난 것이다). 다시 불러올 때 되짚는 건 불러오기에 끊긴 판정뿐이다
  await $.state.set(JUDGED, answerMark(answer))
}

async function judgeOnce($: EngineInterface, s: Settings, answer: string, request: string | undefined, countSkips: boolean) {
  const { value: turnNo = 0 } = await $.state.get(TURN)
  const taken = labeledAsks(answer)
  await update($, book, (cur: Book): Book => apply(supersede(cur, Date.now()), [], [], taken, turnNo, Date.now(), false))
  const { value: b = EMPTY } = await $.state.get(BOOK)
  if (!b.items.length && !mayAsk(answer)) return
  const fresh = freshIds(b.items, taken)
  const { value: before = [] } = await $.state.get(RECENT)
  // 합치거나 고쳐 쓴 글이 길어서(한두 문장) 400이던 상한을 늘렸다
  const r = await $.model.complete({
    model: s.model,
    effort: 'low',
    maxTokens: 1500,
    timeoutMs: 45000,
    system: JUDGE_SYSTEM,
    prompt: judgePrompt(b.items, request, answer, turnNo, fresh, before),
  })
  const j = r.isAnswered ? parseJudgment(r.text) : undefined
  await update($, stats, (x: Stats): Stats => (j ? { ...x, judged: x.judged + 1 } : { ...x, failed: x.failed + 1 }))
  // 판정이 없으면 닫지도 세지도 않는다
  if (!j) return
  const { value: keep } = await $.state.get(KEEP)
  const drafted = new Set(Object.keys(keep?.drafts ?? {}).map(Number))
  await update($, book, (cur: Book): Book => applyJudgment(cur, b.items, fresh, j, turnNo, Date.now(), countSkips && request !== undefined, id => drafted.has(id)))
}

// 사람이 보낸 메시지로 끝난 항목을 Claude 답을 기다리지 않고 닫는다. "↩ 항목 → 답" 줄만 있는 메시지는 closeAnswered가 이미 닫았다
async function judgeMessage($: EngineInterface, s: Settings, text: string) {
  if (!text.split('\n').some(l => l.trim() && !l.trim().startsWith('↩'))) return
  const { value: b = EMPTY } = await $.state.get(BOOK)
  if (!b.items.length) return
  const { value: turnNo = 0 } = await $.state.get(TURN)
  const { value: before = [] } = await $.state.get(RECENT)
  const r = await $.model.complete({
    model: s.model,
    effort: 'low',
    maxTokens: 400,
    timeoutMs: 45000,
    system: JUDGE_SYSTEM,
    prompt: messagePrompt(b.items, text, turnNo, before),
  })
  const j = r.isAnswered ? parseJudgment(r.text) : undefined
  await update($, stats, (x: Stats): Stats => (j ? { ...x, judged: x.judged + 1 } : { ...x, failed: x.failed + 1 }))
  if (j?.closed.length) await update($, book, (cur: Book): Book => closeSeen(cur, b.items, j.closed, turnNo, Date.now()))
}

// 모듈을 다시 불러오면 그 전에 시작된 판정이 사라질 수 있다. 불러올 때 마지막 턴을 한 번 더 판정한다(같은 질문은 다시 더하지 않는다)
async function catchUp($: EngineInterface, s: Settings) {
  const ex = lastExchange(await $.session.messages())
  if (!ex) return
  // 판정을 마친 답은 다시 보지 않는다: 다시 판정하면 그사이 [지우기]로 지운 질문이 되살아났다(2026-10-09 /reload-plugins와 --continue로 확인).
  // /reload-plugins는 $.state가 남고, --resume은 비어서 세션이 끝날 때 store에 남긴 지문을 본다. 끝나지 못하고 죽은 세션은 지문이 없어 다시 판정한다
  const mark = answerMark(ex.answer)
  const { value: done = '' } = await $.state.get(JUDGED)
  const id = await $.session.id().catch(() => '')
  const ended = id ? endMarkOf(await $.store.get(END_MARKS).catch(() => undefined), id) : ''
  if (mark === done || mark === ended) return
  await judge($, s, ex.answer, ex.request || undefined, false)
}

// 이 세션에서 켜졌는지(live.ts). $를 쓰는 함수라 hook과 같은 파일에 둔다
async function live($: EngineInterface): Promise<boolean> {
  if (isKnown()) return isLive()
  // 읽다가 실패하면 이번만 꺼진 것으로 보고, 정하지 않은 채 두어 다음에 다시 읽는다
  const id = await $.session.id().catch(() => '')
  const list = id ? await $.store.get(SESSIONS).catch(() => null) : null
  return list === null ? false : settle(list, id)
}

// 사람 턴의 메시지로 내 차례를 고친다: "↩ 항목 → 답" 줄로 답한 항목을 닫는다
export function closeAnswered(cur: Book, text: string, turnNo: number, now: number): Book {
  const answered = answeredIds(cur.items, text)
  return answered.length ? apply(cur, [], answered, [], turnNo, now, false) : cur
}

// 사람 턴 하나를 센다: 턴 번호, 판정이 볼 사용자 메시지, 답한 항목 닫기.
// baton이 $.prompt.submit으로 보낸 글(곁대화·토론의 [본 대화로 보내기])에는 엔진이 baton의 prompt.submit 훅을 모두 건너뛴다
// (debug 로그 "prompt.submit skipped: re-entry"). 그래서 보내는 파일(side-panel, debate)에도 같은 함수를 두고 보내기 전에 부른다:
// 안 세면 판정이 지난 메시지를 이번 메시지로 읽어 내 차례를 잘못 닫거나 남겼다(2026-10-10). $는 다른 파일의 함수로 넘길 수 없다
async function countHumanTurn($: EngineInterface, text: string): Promise<void> {
  const turnNo = await update($, turn, (n: number) => n + 1)
  await update($, lastRequest, () => text)
  await update($, humanTurn, () => true)
  await update($, book, (cur: Book): Book => closeAnswered(cur, text, turnNo, Date.now()))
}

export function registerAsks(on: On, options: PluginOptions): void {
  const s = settingsFrom(options)

  on('prompt.submit', { text: /[\s\S]/ }, async ($, e, next) => {
    if (!(await live($))) return next(e)
    // /clear 뒤처럼 session.start 없이 새 세션이 된 경우에도 지난 세션 항목을 가져온다
    await importCarried($).catch(() => undefined)
    if (!isHuman(e.origin as { kind?: string; asUser?: boolean } | undefined)) {
      await update($, humanTurn, () => false)
      return next(e)
    }
    await countHumanTurn($, e.text)
    // 판정 모델을 기다리면 보내기가 늦어지므로 띄워 두기만 한다
    void judgeMessage($, s, e.text).catch(() => undefined)
    const { value: b = EMPTY } = await $.state.get(BOOK)
    const list = waiting(b)
    if (!list.length) return next(e)
    return next({ ...e, context: [...(e.context ?? []), contextText(list)] })
  })

  on('turn.complete', { reason: 'answer' }, async ($, e, next) => {
    if (!(await live($))) return next(e)
    const done = await next(e)
    if (e.agentId || e.reason !== 'answer' || !e.answer.trim()) return done
    const { value: request = '' } = await $.state.get(LAST)
    const { value: human = false } = await $.state.get(HUMAN)
    void judge($, s, e.answer, human ? request : undefined, true).catch(() => undefined)
    return done
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!(await live($))) return next(e)
    const mine = tailText(await read($, book))
    return next({ ...e, props: { ...e.props, tail: e.props.tail ? `${e.props.tail} · ${mine}` : mine } })
  })

  on('session.start', { isInteractive: true }, async ($, e, next) => {
    if (!enter(e) || !(await live($))) return next(e)
    const started = await next(e)
    cwdNow = e.cwd
    await importCarried($).catch(() => undefined)
    void catchUp($, s).catch(() => undefined)
    return started
  })

  // 세션이 끝나면 답을 못 한 질문을 이 작업 폴더의 다음 세션으로 넘긴다
  on('session.end', async ($, e, next) => {
    if (!(await live($))) return next(e)
    const ended = await next(e)
    try {
      const { value: b = EMPTY } = await $.state.get(BOOK)
      const carry = toCarry(b)
      if (carry.length && cwdNow) {
        const key = carryKey(cwdNow)
        await $.store.set(key, mergeCarried(await $.store.get(key), carry))
      }
      const { value: mark = '' } = await $.state.get(JUDGED)
      if (mark && e.sessionId) await $.store.set(END_MARKS, withEndMark(await $.store.get(END_MARKS), e.sessionId, mark))
    } catch {
      // 끝나는 중이라 실패해도 할 수 있는 일이 없다
    }
    return ended
  })
}
