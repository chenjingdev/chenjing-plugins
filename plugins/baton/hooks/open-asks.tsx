import { atom, read, update } from 'claude-code'
import type {EngineInterface, On, PluginOptions } from 'claude-code'

import { enter, isKnown, isLive, SESSIONS, settle } from './live'
import type { Ask, AsksStats as Stats, Book } from '../types'

// Claude가 사용자에게 넘긴 일(물을 것·볼 것)을 모아 두고, 입력창 아래 줄 끝에 개수를 보인다. 목록은 옆 패널의 내 차례(side-panel).
// 다르게 한 것은 답할 것이 없는 알림이라 모으지 않는다: 본문에 남는다(answer-blocks).
// 턴이 끝날 때마다 작은 모델이 판정한다: 이번 메시지로 답한 질문은 닫고, 이번 답의 새 질문은 더한다.

const BOOK = { plugin: 'baton', key: 'book' } as const
const TURN = { plugin: 'baton', key: 'turn' } as const
const LAST = { plugin: 'baton', key: 'lastRequest' } as const
const HUMAN = { plugin: 'baton', key: 'humanTurn' } as const
const STATS = { plugin: 'baton', key: 'asksStats' } as const
const JUDGED = { plugin: 'baton', key: 'judgedAnswer' } as const
export const EMPTY: Book = { items: [], closed: [], seq: 0 }
// 이 세션에서 지난 세션 항목을 이미 가져왔는지, 세션이 끝날 때 쓸 작업 폴더
let importedFor = ''
let cwdNow = ''
const book = atom(BOOK, EMPTY)
const turn = atom(TURN, 0)
const lastRequest = atom(LAST, '')
const humanTurn = atom(HUMAN, false)
const stats = atom(STATS, { judged: 0, failed: 0 })

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

// "↩ 항목 → 답" 줄로 답한 항목(옆 패널의 [답하기]가 입력창에 붙인 줄): 판정을 기다리지 않고 바로 닫는다
export function answeredIds(items: readonly Ask[], text: string): number[] {
  const ids: number[] = []
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    if (!l.startsWith('↩')) continue
    const rest = l.slice(1).trim()
    const hit = items.find(a => rest.startsWith(`${a.text} → `) && rest.slice(a.text.length + 3).trim() !== '')
    if (hit && !ids.includes(hit.id)) ids.push(hit.id)
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

export function judgePrompt(open: readonly Ask[], request: string | undefined, answer: string, turnNo: number, taken: readonly string[] = []): string {
  const list = open.length
    ? open
        .map((a, i) => `${i + 1}. ${a.text} (${a.skips === 0 ? '직전 답에서 물음' : `${Math.max(1, turnNo - a.turn)}턴 전에 물었고 아직 답 없음`})`)
        .join('\n')
    : '(없음)'
  return [
    '[아직 끝나지 않은 항목]',
    list,
    '',
    '[이번 답에서 이미 잡은 항목: new에 넣지 않는다]',
    taken.length ? taken.map(t => `- ${t}`).join('\n') : '(없음)',
    '',
    '[이번 사용자 메시지]',
    request === undefined ? '(없음: 알림 등으로 시작된 턴)' : request.slice(0, 1500),
    '',
    '[이번 Claude 답]',
    answer.replace(CODE, '[코드 블록]').slice(0, 6000),
    '',
    '두 가지를 판정하라.',
    'closed: 위 목록에서 이번 턴으로 끝난 질문의 번호. 사용자가 답했거나 골랐거나 거절·보류한 것, Claude가 이번 답에서 이미 처리한 것, 상황이 바뀌어 더 물을 필요가 없어진 것. "ㅇㅇ" "ㄱㄱ" "해봐"처럼 짧은 답은 직전 답의 질문에 대한 답으로 본다. 사용자가 다른 얘기를 했거나 그 질문에 대해 되묻기만 했으면 닫지 않는다. "볼 것:"으로 시작하는 항목은 사용자가 이번 메시지를 보냈고 그 항목에 되묻거나 반대하지 않았으면 닫는다.',
    'new: 이번 Claude 답에서 사용자가 답하거나 골라야 다음으로 넘어가는데 "물을 것:" 줄로 쓰지 않은 질문. "할까요?" "어느 쪽으로 할까요?" 같은 것. 수사적 질문, 이번 메시지에서 이미 답한 것, 목록이나 이미 잡은 항목에 있는 것, "다르게 한 것:" 줄(한 일을 알리기만 한다)은 넣지 않는다. 최대 3개. 각각 60자 안에서, 이것만 봐도 무엇에 관한 질문인지 알도록 대상 이름을 넣고, 원문보다 단정하지 않게 쓴다.',
    '출력 형식: {"closed":[번호],"new":["질문"]}',
  ].join('\n')
}

export type Judgment = { closed: number[]; added: string[] }

export function parseJudgment(text: string): Judgment | undefined {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return undefined
  try {
    const j = JSON.parse(m[0]) as { closed?: unknown; new?: unknown }
    const closed = Array.isArray(j.closed) ? j.closed.map(Number).filter(n => Number.isInteger(n) && n > 0) : []
    const added = Array.isArray(j.new)
      ? j.new.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean).slice(0, 3)
      : []
    return { closed, added }
  } catch {
    return undefined
  }
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

// seen: 판정 모델이 본 질문 id. 그중 닫히지 않은 것은 사람 턴이 한 번 지나갈 때마다 skips가 는다
export function apply(
  b: Book,
  seen: readonly number[],
  closedIds: readonly number[],
  added: readonly string[],
  turnNo: number,
  now: number,
  countSkips: boolean,
): Book {
  const items: Ask[] = []
  const closed = [...b.closed]
  for (const a of b.items) {
    if (closedIds.includes(a.id)) closed.push({ text: a.text, at: now })
    else items.push(countSkips && seen.includes(a.id) ? { ...a, skips: a.skips + 1 } : a)
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
  const isNotice = (a: Ask) => /^(볼 것|다르게 한 것):/.test(a.text)
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
  // 끝까지 간 판정만 적는다(판정 모델이 답하지 못한 것도 끝난 것이다). 다시 불러올 때 되짚는 건 불러오기에 끊긴 판정뿐이다
  await $.state.set(JUDGED, answerMark(answer))
}

async function judgeOnce($: EngineInterface, s: Settings, answer: string, request: string | undefined, countSkips: boolean) {
  const { value: turnNo = 0 } = await $.state.get(TURN)
  const taken = labeledAsks(answer)
  await update($, book, (cur: Book): Book => apply(supersede(cur, Date.now()), [], [], taken, turnNo, Date.now(), false))
  // 판정은 이번 답 전부터 열려 있던 항목만 본다: 방금 올린 사용자 차례 줄은 이번 메시지로 닫힐 수 없다
  const takenKeys = new Set(taken.map(t => sameKey(shorten(t))))
  const { value: b = EMPTY } = await $.state.get(BOOK)
  const open = b.items.filter(a => !takenKeys.has(sameKey(a.text)))
  if (!open.length && !mayAsk(answer)) return
  const r = await $.model.complete({
    model: s.model,
    effort: 'low',
    maxTokens: 400,
    timeoutMs: 30000,
    system: JUDGE_SYSTEM,
    prompt: judgePrompt(open, request, answer, turnNo, taken),
  })
  const j = r.isAnswered ? parseJudgment(r.text) : undefined
  await update($, stats, (x: Stats): Stats => (j ? { ...x, judged: x.judged + 1 } : { ...x, failed: x.failed + 1 }))
  // 판정이 없으면 닫지도 세지도 않는다
  const closedIds = j ? j.closed.map(n => open[n - 1]?.id).filter((id): id is number => id !== undefined) : []
  const added = j ? j.added : []
  const seen = open.map(a => a.id)
  await update($, book, (cur: Book): Book => apply(cur, seen, closedIds, added, turnNo, Date.now(), countSkips && request !== undefined && j !== undefined))
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
