import { atom, read, update } from 'claude-code'
import type {EngineInterface, On, PluginOptions } from 'claude-code'

import { enter, isKnown, isLive, OFF_TEXT, SESSIONS, settle } from './live'
import type { SideStats as Stats } from '../types'
import type { Ask, Book, SideKeep, SideTurn } from '../types'
import { paneTitle } from './debate'
import { answerMark, closeAnswered, EMPTY, restore, settingsFrom as asksSettingsFrom } from './open-asks'

// 전체 화면 모드의 옆 패널 하나에 위는 "내 차례"(open-asks가 모은 할 일), 아래는 "곁대화"를 보여 준다.
// 내 차례는 [답하기]를 누르면 그 질문 아래 입력칸에 답을 써 두었다가(Enter 저장), 모은 답을 한 번에 본 대화로 보낸다(s).
// 0.7.2~0.7.3은 패널 입력칸에서 한글 조합이 깨져서(2026-10-10 "ㅌ튀어나와서", "기억ㅇ ㅣ섞인단") 답을 입력창에서 쓰게 했다.
// 2026-10-11 사용자 "그전에 클릭해서 input채우는 경험이 좋앗던거 같음": 깨질 수 있다는 것을 알고 패널 입력칸을 골랐다.
// 같은 날 tmux에서 패널 입력칸의 커서는 제자리에 놓였다. 쓰는 도중에 패널을 다시 그리는 것이 남은 의심이라, 쓰는 동안은 입력칸 값을 다시 넣지 않고 곁대화 답이 와도 다시 그리지 않는다.
// 곁질문도 같은 식으로 패널에서 쓴다: q를 누르면 곁대화 아래 입력칸이 열리고 Enter로 묻는다(0.7.7. 2026-10-23 사용자 "곁대화 왜 메인에서만 되냐? 사이드바에서도 되야하는데").
// 입력칸을 그리지 못하는 화면에서만 입력창에 /baton-side를 붙인다
// 작업과 관계없는 곁질문은 본 대화에 넣지 않고 곁대화로 보낸다: 질문처럼 보이는 메시지만 작은 모델로 가르고,
// 애매하거나 판정이 늦거나 패널을 둘 자리가 없으면 본 대화로 보낸다. 곁대화의 답은 지금 대화를 이어받은 모델($.model.fork)이 쓴다.
const ENABLED = { plugin: 'baton', key: 'sideEnabled' } as const
const LASTSIDE = { plugin: 'baton', key: 'lastSide' } as const
const STATS = { plugin: 'baton', key: 'sideStats' } as const
const ASKS = { plugin: 'baton', key: 'book' } as const
const DEBATE = { plugin: 'baton', key: 'debate' } as const
const enabled = atom(ENABLED, false)
const lastSide = atom(LASTSIDE, '')
const stats = atom(STATS, { checked: 0, side: 0, failed: 0, totalMs: 0 })
const asks = atom(ASKS, { items: [], closed: [], seq: 0 })
const ASKS_STATS = { plugin: 'baton', key: 'asksStats' } as const
const JUDGED = { plugin: 'baton', key: 'judgedAnswer' } as const
// 사람 턴 세기(open-asks와 같은 키)
const turn = atom({ plugin: 'baton', key: 'turn' } as const, 0)
const lastRequest = atom({ plugin: 'baton', key: 'lastRequest' } as const, '')
const humanTurn = atom({ plugin: 'baton', key: 'humanTurn' } as const, false)
// 패널의 [지우기](또는 /baton-side clear·drop)로 지운 항목: [되돌리기]나 /baton-side undo가 되살린다.
// 사용자가 다음 메시지를 보내면 비운다: 되돌리기는 지운 직후에만 띄운다(모듈 변수라 다시 불러와도 사라진다)
let lastRemoved: Ask[] = []

export type Settings = { model: 'haiku' | 'sonnet'; auto: boolean }

export function settingsFrom(o: PluginOptions): Settings {
  // 곁질문 자동 분리는 옵션이고 기본은 꺼짐이다(2026-10-09 사용자 "자동으로 넘어가는건 옵션 기본은 off"). /baton-side auto on|off는 그 세션만 바꾼다
  return { model: o['classify_model'] === 'sonnet' ? 'sonnet' : 'haiku', auto: o['side_auto'] === 'on' }
}

// 곁대화는 모듈 변수로 그리고, 바뀔 때마다 state(sideKeep)에도 적는다: 다시 불러오면 처음 그릴 때 되살린다
export type { SideTurn }
let chat: SideTurn[] = []
const KEEP = { plugin: 'baton', key: 'sideKeep' } as const
const PANE = 'side-chat'
export const SIDE_PANE = PANE
const SEND_KEY = 'send-answers'
// 내 차례 항목 id별로 써 두고 아직 보내지 않은 답, 지금 입력칸이 열린 항목
const drafts = new Map<number, string>()
let editing: number | undefined
// 곁질문 입력칸이 열려 있는지
let asking = false
const ASK_KEY = 'ask'

// 곁대화와 써 둔 답을 함께 둔다. 0.7.1의 sent(보냈지만 아직 닫히지 않은 답)는 이제 없다: 보내는 쪽이 항목을 바로 닫는다(0.7.2)
export function toKeep(c: readonly SideTurn[], d: ReadonlyMap<number, string>): SideKeep {
  return { chat: [...c], drafts: Object.fromEntries(d) }
}

export function fromKeep(k: SideKeep | undefined): { chat: SideTurn[]; drafts: Map<number, string> } {
  // 답을 기다리던 중에 다시 불러왔으면 그 답은 오지 않는다
  const chat = (k?.chat ?? []).map(t => (t.a || t.err ? t : { ...t, err: '답을 기다리는 중에 플러그인을 다시 불러와 답을 받지 못했어요.' }))
  const drafts = new Map(Object.entries(k?.drafts ?? {}).map(([id, v]) => [Number(id), v] as const))
  return { chat, drafts }
}

async function persist($: EngineInterface) {
  await $.state.set(KEEP, toKeep(chat, drafts))
}

// 처음 그리거나 처음 쓸 때 한 번 state에서 되살린다: /reload-plugins로 다시 불러왔을 때는 session.start가 오지 않아 거기서만 되살리면 비어 보였다(2026-10-09 tmux로 확인)
let loaded = false
async function ensureLoaded($: EngineInterface) {
  if (loaded) return
  loaded = true
  await hydrate($).catch(() => undefined)
}

async function hydrate($: EngineInterface) {
  const { value } = await $.state.get(KEEP)
  const k = fromKeep(value)
  chat = k.chat
  drafts.clear()
  for (const [id, v] of k.drafts) drafts.set(id, v)
}

export function isHuman(origin: { kind?: string } | undefined): boolean {
  return !origin || origin.kind === undefined || origin.kind === 'composer' || origin.kind === 'bridge'
}

const INSTRUCTION = /해\s?줘|해\s?봐|하자|ㄱㄱ|ㅇㅇ|고쳐|만들어|적용|돌려|켜\s?줘|꺼\s?줘|지워|추가해|바꿔|진행|계속|부탁/
const QUESTION_WORD = /뭐|왜|어떻게|어케|언제|어디|누가|누구|얼마|몇|어느|무슨/
const QUESTION_END = /(인가|일까|나요|까요|냐|니|까)$/

// 판정에 보낼 만한 메시지: 질문처럼 보이고, 짧은 대답·지시·명령이 아닌 것
export function worthChecking(text: string): boolean {
  const t = text.trim()
  if (t.length < 6 || t.startsWith('/') || t.startsWith('↩') || t.includes('\n')) return false
  if (INSTRUCTION.test(t)) return false
  return /[?？]/.test(t) || QUESTION_WORD.test(t) || QUESTION_END.test(t.replace(/[\s.!~ㅋㅎ]+$/, ''))
}

export const CLASSIFY_SYSTEM = '너는 사용자의 새 메시지가 지금 하던 작업에 속하는지, 작업과 관계없는 곁질문인지 가른다. 한 단어만 출력한다.'

export function classifyPrompt(request: string, answer: string, message: string): string {
  return [
    '[지금 하던 작업]',
    `사용자 최근 요청: ${request.slice(0, 600)}`,
    `Claude 최근 답(앞부분): ${answer.slice(0, 600)}`,
    '',
    '[새 메시지]',
    message.slice(0, 800),
    '',
    '새 메시지가 지금 작업과 관계없는 곁질문이면 SIDE, 아니면 MAIN.',
    '- SIDE: 작업과 무관한 일반 지식, 잡담, 다른 주제에 대한 궁금증. 답을 들어도 지금 작업의 다음 행동이 바뀌지 않는다.',
    '- MAIN: 지금 작업이나 방금 답에 대한 질문·지시·결정·확인, 새 작업 요청, 이전 질문에 대한 답.',
    '애매하면 MAIN. SIDE 또는 MAIN 한 단어만 출력.',
  ].join('\n')
}

export function isSide(reply: string): boolean {
  const t = reply.trim().toUpperCase()
  return t.startsWith('SIDE') && !t.includes('MAIN')
}

// 최근 사용자 요청과 Claude 답: 판정의 "지금 작업"
export function recentWork(msgs: readonly { role: string; text: string }[]): { request: string; answer: string } {
  let request = ''
  let answer = ''
  for (let i = msgs.length - 1; i >= 0 && !(request && answer); i--) {
    const m = msgs[i]
    if (!m?.text.trim()) continue
    if (m.role === 'assistant' && !answer) answer = m.text
    if (m.role === 'user' && !request && answer) request = m.text
  }
  return { request, answer }
}

async function classify($: EngineInterface, s: Settings, message: string): Promise<boolean> {
  const started = Date.now()
  const work = recentWork(await $.session.messages())
  if (!work.answer) return false
  const r = await $.model.complete({
    model: s.model,
    effort: 'low',
    maxTokens: 10,
    timeoutMs: 4000,
    system: CLASSIFY_SYSTEM,
    prompt: classifyPrompt(work.request, work.answer, message),
  })
  const side = r.isAnswered && isSide(r.text)
  await update($, stats, (x: Stats): Stats => ({
    checked: x.checked + 1,
    side: x.side + (side ? 1 : 0),
    failed: x.failed + (r.isAnswered ? 0 : 1),
    totalMs: x.totalMs + (Date.now() - started),
  }))
  return side
}

// 곁대화의 한 질문: 지금 대화를 이어받은 포크에 앞선 곁대화와 이번 질문을 붙인다
export function forkPrompt(history: readonly SideTurn[], question: string): string {
  const past = history
    .filter(t => t.a)
    .slice(-4)
    .map(t => `Q: ${t.q}\nA: ${(t.a ?? '').slice(0, 1500)}`)
  return [
    '[곁질문 패널] 사용자가 본 작업과 별개로 묻는 곁질문이다. 이 답은 본 대화에 남지 않는다.',
    '본 작업을 진행하거나 도구를 쓰려 하지 말고, 지금까지 대화와 아는 범위에서 바로 답하라. 파일이나 명령 확인이 필요하면 여기서는 확인할 수 없다고 말하라.',
    '답 형식 규칙(세 덩어리)은 따르지 않아도 된다. 짧은 문단으로 답하라.',
    ...(past.length ? ['', '[앞선 곁대화]', ...past] : []),
    '',
    '[이번 질문]',
    question.trim(),
  ].join('\n')
}

// 입력칸을 그리지 못하는 화면에서 [답하기]가 입력창에 붙이는 글. 빈 입력창이면 "↩ 항목 → "만 붙이고, 먼저 써 둔 글이 있으면 그 글을 답으로 보고 앞에 항목을 붙인다.
// 이미 "↩" 줄이 있으면 다음 줄에 하나 더 붙여 여러 답을 한 번에 보낸다. 같은 항목은 두 번 붙이지 않는다.
// 입력창에서 Enter를 치면 open-asks가 "↩ 항목 → 답" 줄을 보고 그 항목을 바로 닫는다
export function withAnswerLine(q: string, draft: string): string {
  const head = `↩ ${q} → `
  const d = draft.trimEnd()
  const lines = d.split('\n').map(l => l.trim())
  if (!d.trim()) return head
  if (lines.some(l => l.startsWith(head.trim()))) return draft
  if (!lines.some(l => l.startsWith('↩'))) return `${head}${d.trim()}`
  return `${d}\n${head}`
}

// 곁질문(q)이 입력창에 붙이는 글: 써 둔 글이 있으면 그 글을 곁질문으로 본다. 입력창에 답("↩" 줄)을 쓰던 중이면 건드리지 않는다(undefined)
export function withSideCommand(draft: string): string | undefined {
  const d = draft.trim()
  if (d.startsWith('/baton-side')) return draft
  if (d.split('\n').some(l => l.trim().startsWith('↩'))) return undefined
  return d ? `/baton-side ${d}` : '/baton-side '
}

// 입력창에 붙인 뒤에는 Esc 없이 바로 이어 쓸 수 있다: 패널에서 클릭하든 숫자·q를 누르든 이어 친 글자는 입력창에 들어갔다(2026-10-11 tmux로 확인)
async function answerTodo($: EngineInterface, q: string) {
  const { text: draft } = await $.prompt.read()
  const text = withAnswerLine(q, draft)
  const r = text === draft ? { isFilled: true } : await $.prompt.fill({ text, mode: 'replace' })
  $.ui.toast(r.isFilled ? '입력창에 붙였어요. 이어서 답을 쓰고 Enter.' : '입력창에 붙이지 못했어요.', { timeoutMs: 6000 })
}

async function askInBox($: EngineInterface) {
  const { text: draft } = await $.prompt.read()
  const text = withSideCommand(draft)
  if (text === undefined) {
    $.ui.toast('입력창에 쓰던 답이 있어요. 먼저 보내고 q를 눌러 주세요.', { timeoutMs: 6000 })
    return
  }
  const r = text === draft ? { isFilled: true } : await $.prompt.fill({ text, mode: 'replace' })
  $.ui.toast(r.isFilled ? '입력창에 붙였어요. 곁질문을 쓰고 Enter. 답은 이 패널에 와요.' : '입력창에 붙이지 못했어요.', { timeoutMs: 6000 })
}

// 모은 답을 본 대화로 보낼 글: 한 줄에 한 항목. "↩ 항목 → 답" 줄을 보고 보내는 쪽(countHumanTurn)이 그 항목을 닫는다
export function answersText(list: readonly { q: string; a: string }[]): string {
  return list
    .filter(x => x.a.trim())
    .map(x => `↩ ${x.q} → ${x.a.trim()}`)
    .join('\n')
}

// 답을 저장한 뒤 링이 갈 곳: 아직 답이 없는 다음 항목의 [답하기], 다 썼으면 보내기 버튼
export function focusAfter(order: readonly number[], from: number, done: ReadonlySet<number>, canSend: boolean): string | undefined {
  const i = order.indexOf(from)
  const next = [...order.slice(i + 1), ...order.slice(0, Math.max(0, i))].find(id => !done.has(id))
  if (next !== undefined) return `todo-btn-${next}`
  return canSend ? SEND_KEY : undefined
}

// 닫힌 항목의 답은 버린다
function prune(open: readonly number[]) {
  for (const id of [...drafts.keys()]) if (!open.includes(id)) drafts.delete(id)
  if (editing !== undefined && !open.includes(editing)) editing = undefined
}

// 숫자나 Enter로 눌렀으면 패널이 키보드를 쥐고 있어서 바로 새 입력칸으로 옮긴다.
// 마우스로 눌렀으면 키보드는 아직 입력창에 있어 옮기기가 거절된다(2026-10-11 tmux로 확인). 그때는 패널을 focus로 다시 열어 키보드를 가져온 뒤 옮긴다:
// 엔진은 입력창이 비어 있을 때만 내주므로, 쓰던 글이 있으면 입력칸을 눌러 쓰라고 알린다
async function startAnswer($: EngineInterface, id: number) {
  editing = id
  asking = false
  $.ui.invalidate('ui.render')
  await focusField($, `answer-${id}`, '답 칸')
}

async function focusField($: EngineInterface, key: string, name: string) {
  const to = { requestId: PANE, key }
  if (!(await $.ui.focus(to)).deny) return
  await openPane($, true)
  if (!(await $.ui.focus(to)).deny) return
  $.ui.toast(`입력창에 쓰던 글이 있어서 키보드가 아직 입력창에 있어요. ${name}을 눌러서 쓰세요.`, { timeoutMs: 6000 })
}

// 곁질문(q): 곁대화 아래 입력칸을 열고 키보드를 그리로 옮긴다
async function startAsk($: EngineInterface) {
  asking = true
  editing = undefined
  $.ui.invalidate('ui.render')
  await focusField($, ASK_KEY, '곁질문 칸')
}

function submitAsk($: EngineInterface, value: string) {
  asking = false
  $.ui.invalidate('ui.render')
  if (value.trim()) void askSide($, value).catch(() => undefined)
}

function saveAnswer($: EngineInterface, id: number, value: string, order: readonly number[]) {
  const v = value.trim()
  if (v) drafts.set(id, v)
  else drafts.delete(id)
  editing = undefined
  $.ui.invalidate('ui.render')
  void persist($).catch(() => undefined)
  const key = focusAfter(order, id, new Set(drafts.keys()), drafts.size > 0)
  // 입력칸이 사라진 뒤 다시 그려지고 나서 옮긴다
  if (key) moveRing($, key)
}

// 써 둔 답을 한 번에 보낸다. 보내는 쪽이 사람 턴을 세며 그 항목들을 바로 닫고(sendAsUser), 못 보냈으면 항목과 답을 되살린다
async function sendAnswers($: EngineInterface) {
  await ensureLoaded($)
  const { value: b } = await $.state.get(ASKS)
  const list = (b?.items ?? []).filter(a => drafts.has(a.id))
  const said = new Map(list.map(a => [a.id, drafts.get(a.id) ?? ''] as const))
  const text = answersText(list.map(a => ({ q: a.text, a: said.get(a.id) ?? '' })))
  if (!text) return
  for (const a of list) drafts.delete(a.id)
  editing = undefined
  $.ui.invalidate('ui.render')
  await persist($).catch(() => undefined)
  if (await sendAsUser($, text)) return
  await update($, asks, (cur: Book): Book => restore(cur, list))
  for (const [id, v] of said) drafts.set(id, v)
  $.ui.invalidate('ui.render')
  await persist($).catch(() => undefined)
}

// open-asks의 countHumanTurn과 같다: baton이 보낸 글은 baton의 prompt.submit 훅을 모두 건너뛰고, $는 다른 파일의 함수로 넘길 수 없다
async function countHumanTurn($: EngineInterface, text: string) {
  const turnNo = await update($, turn, (n: number) => n + 1)
  await update($, lastRequest, () => text)
  await update($, humanTurn, () => true)
  await update($, asks, (cur: Book): Book => closeAnswered(cur, text, turnNo, Date.now()))
}

// 사용자가 쓴 글을 본 대화로 보낸다(asUser: 본 대화의 모델은 사용자의 말로 읽는다). 보냈으면 true.
// baton이 보낸 글은 baton의 prompt.submit 훅을 모두 건너뛰므로, 사람 턴 세기와 [되돌리기] 내리기를 여기서 한다
async function sendAsUser($: EngineInterface, text: string): Promise<boolean> {
  if (lastRemoved.length) {
    lastRemoved = []
    $.ui.invalidate('ui.render')
  }
  await countHumanTurn($, text)
  const r = await $.prompt.submit({ text, asUser: true }).catch((err: unknown) => ({ drop: String(err) }))
  if (r.drop === undefined) return true
  $.ui.toast(`본 대화로 못 보냈어요: ${r.drop}`, { timeoutMs: 8000 })
  return false
}

const FOCUS_DELAY_MS = 150

async function askSide($: EngineInterface, question: string) {
  const q = question.trim()
  if (!q) return
  await ensureLoaded($)
  const turn: SideTurn = { q }
  const history = chat
  chat = [...chat, turn].slice(-12)
  $.ui.invalidate('ui.render')
  await persist($).catch(() => undefined)
  const r = await $.model.fork({ prompt: forkPrompt(history, q) })
  if (r.isAnswered) turn.a = r.text
  else turn.err = `답을 받지 못했어요: ${r.reason}`
  // 패널 입력칸에 답을 쓰는 중이면 지금 다시 그리지 않는다: 저장하면 그때 함께 그려진다(머리 주석)
  if (editing === undefined && !asking) $.ui.invalidate('ui.render')
  await persist($).catch(() => undefined)
}

// Esc는 입력창으로 돌아갈 뿐 패널을 닫지 않는다: 내 차례를 옆에 늘 두기 위해서.
// 키보드는 패널만 열 때(/baton-side)만 가져온다. 곁질문을 보낸 뒤에 가져오면 이어 치는 글자가 패널 단축키(숫자·q·m)를 눌렀다(2026-10-10 tmux로 확인)
async function openPane($: EngineInterface, focus: boolean): Promise<boolean> {
  const r = await $.ui.open({ id: PANE, title: '내 차례 · 곁대화', ...(focus ? { focus: true as const } : {}) })
  return r.isPlaced
}

// 토론(debate.tsx의 패널 'debate')이 있으면 그 패널도 열어 둔다: 패널이 둘이면 엔진이 탭으로 보여 준다(2026-10-09 사용자 "토론을 넣어야 하는거 아님?")
// 토론을 먼저 열고 이 패널을 나중에 열어, 보이는 탭은 내 차례 · 곁대화가 된다
async function openDebateTab($: EngineInterface) {
  const { value: d } = await $.state.get(DEBATE)
  if (!d) return
  if ((await $.ui.panes()).some(p => p.id === 'debate')) return
  await $.ui.open({ id: 'debate', title: paneTitle(d) })
}

// 패널의 [지우기]: 그 항목만 내 차례에서 뺀다. 2026-10-09 하위 명령(/baton-side drop·undo)을 몰라서 못 쓴다고 해서 버튼으로 옮겼다.
// 다음 메시지 전까지 지운 것은 쌓아 두어 [되돌리기] 한 번에 모두 살린다
async function dropTodo($: EngineInterface, a: Ask) {
  lastRemoved = [...lastRemoved, a]
  let order: number[] = []
  await update($, asks, (cur: Book): Book => {
    order = cur.items.map(x => x.id)
    return { ...cur, items: cur.items.filter(x => x.id !== a.id) }
  })
  $.ui.invalidate('ui.render')
  // 링이 있던 [지우기]가 버튼과 함께 사라지면 패널은 키를 쥔 채 링이 없어 u·숫자 단축키가 먹지 않았다(2026-10-09 tmux로 확인)
  moveRing($, ringAfterDrop(order, a.id))
}

// [지우기] 뒤 링이 갈 곳: 그 자리에 올라온 항목의 [지우기](마지막이었으면 바로 위 항목)라 이어 지울 수 있다. 남은 게 없으면 [되돌리기]
export function ringAfterDrop(order: readonly number[], dropped: number): string {
  const at = Math.max(0, order.indexOf(dropped))
  const rest = order.filter(id => id !== dropped)
  const next = rest[Math.min(at, rest.length - 1)]
  return next === undefined ? 'undo' : `todo-del-${next}`
}

// 지운 항목을 되살린다: 몇 개를 되살렸는지 돌려준다
async function undoDrop($: EngineInterface): Promise<number> {
  const back = lastRemoved
  if (!back.length) return 0
  lastRemoved = []
  const ids = new Set(back.map(x => x.id))
  let first: number | undefined
  await update($, asks, (cur: Book): Book => {
    const b = restore(cur, back)
    first = b.items.find(x => ids.has(x.id))?.id
    return b
  })
  $.ui.invalidate('ui.render')
  // [되돌리기]에 링이 있었으면 링도 버튼과 함께 사라지니, 되살린 첫 항목의 [지우기]로 옮긴다
  if (first !== undefined) moveRing($, `todo-del-${first}`)
  return back.length
}

// 다시 그려진 뒤에 링을 옮긴다: 바로 옮기면 Enter 처리와 줄 빠짐 뒤에 링이 한 칸 더 밀려 다음 항목을 건너뛰었다(2026-10-08).
// 패널이 키를 쥐고 있지 않으면(/baton-side 명령으로 불렀을 때 등) 엔진이 거절하고, 그러면 그대로 둔다
function moveRing($: EngineInterface, key: string) {
  $.clock.after(FOCUS_DELAY_MS, () => void $.ui.focus({ requestId: PANE, key }).catch(() => undefined))
}

// 곁대화의 [자동 분리 켜기/끄기]: 이 세션만 바꾼다(/baton-side auto on|off와 같다)
async function toggleAuto($: EngineInterface, s: Settings) {
  const { value: isOn = s.auto } = await $.state.get(ENABLED)
  await update($, enabled, () => !isOn)
  $.ui.invalidate('ui.render')
  $.ui.toast(isOn ? '곁질문 자동 분리를 껐어요.' : '작업과 관계없어 보이는 질문을 곁대화로 보내요.', { timeoutMs: 5000 })
}

// 단축키: 입력창에서 ctrl+x tab(엔진 기본)으로 패널에 들어오고, 패널 안에서는 숫자·글자가 버튼을 누른다.
// 패널 폭(40칸 남짓)에 한 줄로 들어가게 줄였다: 예전 안내는 세 줄로 접혔다(2026-10-10)
const KEYS_HINT = '숫자 답하기 · Esc 입력창 · ctrl+x tab 패널'

const NO_ROOM = '옆 패널을 둘 자리가 없어요. 전체 화면 모드에서 터미널이 넓어야 옆에 붙어요.'

// 턴이 끝나 내 차례가 생겼는데 패널이 닫혀 있으면 연다. 입력창의 키보드는 뺏지 않는다
async function openIfTodo($: EngineInterface) {
  const { value: b } = await $.state.get(ASKS)
  if (!b?.items.length) return
  if ((await $.ui.panes()).some(p => p.id === PANE)) return
  await $.ui.open({ id: PANE, title: '내 차례 · 곁대화' })
}

// 답이 끝나면 내 차례가 생기는 대로 연다. 판정(open-asks)은 모델을 불러 몇 초 걸려서 1.5초 뒤 한 번만 보면 놓쳤다(2026-10-09 tmux로 확인):
// 이 답의 판정이 끝났다고 적힐 때까지(judgedAnswer) 1.5초마다 다시 본다(최대 tries번)
function openWhenJudged($: EngineInterface, mark: string, tries: number) {
  $.clock.after(1500, () => void (async () => {
    const { value: b } = await $.state.get(ASKS)
    if (b?.items.length) return openIfTodo($)
    const { value: done = '' } = await $.state.get(JUDGED)
    if (done !== mark && tries > 1) openWhenJudged($, mark, tries - 1)
  })().catch(() => undefined))
}

// /baton-side의 목록·지우기·되돌리기: clear, undo, drop N, 그 밖(list)은 목록
async function asksCommand($: EngineInterface, arg: string, model: string): Promise<{ text: string }> {
  const { value: b = EMPTY } = await $.state.get(ASKS)
  if (arg === 'clear') {
    lastRemoved = [...lastRemoved, ...b.items]
    await update($, asks, (cur: Book): Book => ({ ...cur, items: [] }))
    return { text: `내 차례 ${b.items.length}개를 지웠어요. 되돌리려면 패널의 [되돌리기]나 /baton-side undo` }
  }
  if (arg === 'undo') {
    const n = await undoDrop($)
    return { text: n ? `${n}개를 되돌렸어요.` : '되돌릴 항목이 없어요.' }
  }
  const drop = arg.match(/^drop\s+(\d+)$/)
  if (drop) {
    const target = b.items[Number(drop[1]) - 1]
    if (!target) return { text: `${drop[1]}번 항목이 없어요.` }
    lastRemoved = [...lastRemoved, target]
    await update($, asks, (cur: Book): Book => ({ ...cur, items: cur.items.filter(a => a.id !== target.id) }))
    return { text: `지웠어요: ${target.text} · 되돌리려면 패널의 [되돌리기]나 /baton-side undo` }
  }
  const { value: n = { judged: 0, failed: 0 } } = await $.state.get(ASKS_STATS)
  const open = b.items.map((a, i) => `${i + 1}. ${a.text}${a.skips >= 1 ? ` (답 없이 ${a.skips}번 지나감)` : ' (방금 물음)'}`)
  const closed = b.closed.slice(-5).map(c => `- ${c.text}`)
  return {
    text: [
      open.length ? `내 차례 ${open.length}개\n${open.join('\n')}` : '내 차례 없음',
      closed.length ? `최근 닫힌 질문\n${closed.join('\n')}` : '',
      `판정 ${n.judged}번 · 실패 ${n.failed}번 · 모델 ${model}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  }
}

// 하위 명령(main, list, drop N, clear, undo, auto on|off, status)은 그대로 받지만 안내에는 넣지 않는다: 같은 일을 패널 버튼과 /baton이 한다(2026-10-09 사용자 "기능이 너무 많아서 외우기도 벅찬데")
export const SIDE_COMMAND = {
  name: 'baton-side',
  description: '옆 패널 열기(위는 내 차례, 아래는 곁대화). /baton-side 질문: 곁대화에 바로 묻기. 지우기·되돌리기·자동 분리는 패널 버튼으로',
  argumentHint: '[질문]',
}

// 이 세션에서 켜졌는지(live.ts). $를 쓰는 함수라 hook과 같은 파일에 둔다
async function live($: EngineInterface): Promise<boolean> {
  if (isKnown()) return isLive()
  // 읽다가 실패하면 이번만 꺼진 것으로 보고, 정하지 않은 채 두어 다음에 다시 읽는다
  const id = await $.session.id().catch(() => '')
  const list = id ? await $.store.get(SESSIONS).catch(() => null) : null
  return list === null ? false : settle(list, id)
}

export function registerSide(on: On, options: PluginOptions): void {
  const s = settingsFrom(options)
  const judgeModel = asksSettingsFrom(options).model

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Markdown, Button } = els
    if (!(await live($))) return <Text dimColor>{OFF_TEXT}</Text>
    // 입력칸을 그리지 못하는 화면이면 [답하기]가 입력창에 붙인다(answerTodo)
    const Input = 'Input' in els ? els.Input : undefined
    const width = Math.max(20, e.props.bodyColumns - 2)
    await ensureLoaded($)
    const todo = (await read($, asks)).items
    prune(todo.map(a => a.id))
    const shown = todo.slice(0, 8)
    const order = shown.map(a => a.id)
    // 패널이 키보드를 받으면 링은 아직 답 안 한 첫 [답하기]에서 시작한다: 숫자·글자 단축키는 버튼에 링이 있을 때만 먹고, 입력칸에 있으면 글자로 들어가기 때문
    const firstOpen = editing === undefined && !asking ? shown.findIndex(a => !drafts.has(a.id)) : -1
    // 항목 글은 패널 폭을 다 쓰고(줄이 바뀌면 번호 뒤에 맞춰 들여 쓴다), 써 둔 답과 입력칸과 버튼은 그 아래 줄에 둔다.
    // 버튼을 글 양옆에 두던 때는 글이 패널의 반쯤으로 좁아져 한 항목이 예닐곱 줄이 됐다(2026-10-10)
    const rows = shown.map((a, i) => {
      const draft = drafts.get(a.id)
      const isEditing = Input !== undefined && editing === a.id
      const question = (
        <Box key={`todo-q-${a.id}`} flexDirection="row">
          <Text key={`todo-n-${a.id}`}>{`${i + 1}. `}</Text>
          <Box key={`todo-tb-${a.id}`} flexShrink={1}>
            <Text key={`todo-t-${a.id}`} wrap="wrap">{a.text}</Text>
          </Box>
        </Box>
      )
      // 입력칸의 value는 여는 순간의 답으로 두고 쓰는 동안 바꾸지 않는다: 값이 바뀌어 다시 그려지면 엔진이 친 글을 그 값으로 되돌린다
      const field =
        Input && isEditing
          ? [
              <Box key={`answer-box-${a.id}`} marginLeft={3}>
                <Input
                  key={`answer-${a.id}`}
                  label="답"
                  placeholder="짧게 답하고 Enter (비우면 지움)"
                  submitLabel="저장"
                  {...(draft !== undefined ? { value: draft } : {})}
                  autoFocus
                  onSubmit={v => saveAnswer($, a.id, v, order)}
                />
              </Box>,
            ]
          : draft !== undefined
            ? [
                <Box key={`todo-said-${a.id}`} marginLeft={3} flexShrink={1}>
                  <Text key={`todo-a-${a.id}`} wrap="wrap">{`답: ${draft}`}</Text>
                </Box>,
              ]
            : []
      const actions = isEditing
        ? []
        : [
            <Box key={`todo-acts-${a.id}`} flexDirection="row" gap={1} marginLeft={3}>
              <Button
                key={`todo-btn-${a.id}`}
                label={draft === undefined ? '답하기' : '고치기'}
                hotkey={String(i + 1)}
                dimColor
                {...(i === firstOpen ? { autoFocus: true as const } : {})}
                onPress={() => void (Input ? startAnswer($, a.id) : answerTodo($, a.text)).catch(() => undefined)}
              />
              <Button key={`todo-del-${a.id}`} label="지우기" dimColor onPress={() => void dropTodo($, a).catch(() => undefined)} />
            </Box>,
          ]
      return (
        <Box key={`todo-${a.id}`} flexDirection="column">
          {[question, ...field, ...actions]}
        </Box>
      )
    })
    // 방금 지운 항목은 다음 메시지를 보내기 전까지 [되돌리기]로 살린다
    const removed = lastRemoved
    const undoRow = removed.length
      ? [
          <Box key="undo-row" flexDirection="row" gap={1}>
            <Button key="undo" label="되돌리기 (u)" hotkey="u" onPress={() => void undoDrop($).catch(() => undefined)} />
            <Box flexShrink={1}>
              <Text dimColor wrap="wrap">{removed.length === 1 ? `지운 항목: ${removed[0]?.text ?? ''}` : `지운 항목 ${removed.length}개`}</Text>
            </Box>
          </Box>,
        ]
      : []
    const top = [
      <Text key="todo-h" bold>{`내 차례 ${todo.length}`}</Text>,
      ...(todo.length ? rows : [<Text key="todo-none" dimColor>지금 답하거나 볼 것이 없어요.</Text>]),
      ...undoRow,
      // 보내기는 이 패널의 주된 버튼이라 하나만 진하게 둔다
      ...(drafts.size
        ? [<Button key={SEND_KEY} label={`답 ${drafts.size}개 본 대화로 보내기 (s)`} hotkey="s" variant="primary" onPress={() => void sendAnswers($).catch(() => undefined)} />]
        : []),
      // 모두 지우기 버튼은 두지 않는다: 2026-10-06 잘못 눌려 다 지워졌다. 항목마다 [지우기]를 두고, 지운 직후에는 [되돌리기]를 띄운다
      ...(todo.length ? [<Text key="todo-hint" dimColor wrap="wrap">{KEYS_HINT}</Text>] : []),
    ]
    const last = chat[chat.length - 1]
    const { value: isAuto = s.auto } = await $.state.get(ENABLED)
    // 강조(굵은 글씨, 사용자 터미널에서는 주황)는 제목과 곁질문에만 쓰고 버튼은 흐리게 둔다: 링이 오면 진해진다.
    // 버튼까지 강조색이면 어디를 읽을지 보이지 않았다(2026-10-10 사용자 "가독성이 안좋은거 같은데"). [되돌리기]만 지운 직후라 진하게 둔다
    const bottom = [
      <Text key="side-h" bold>곁대화</Text>,
      ...(chat.length
        ? chat.slice(-4).map((t, i) => (
            <Box key={`turn-${i}`} flexDirection="column" marginBottom={1}>
              <Text key={`q-${i}`} bold wrap="wrap">{`Q. ${t.q}`}</Text>
              {t.a ? <Markdown key={`a-${i}`} text={t.a.slice(0, 9500)} /> : <Text key={`a-${i}`} dimColor>{t.err ?? '답 쓰는 중…'}</Text>}
            </Box>
          ))
        : [<Text key="side-none" dimColor wrap="wrap">작업과 관계없는 질문은 q로 여기에 물어요. 본 대화에 남지 않아요.</Text>]),
      // 쓰는 동안 값을 넣지 않는다(내 차례 입력칸과 같은 까닭). 비우고 Enter면 그냥 닫힌다
      ...(Input && asking
        ? [<Input key={ASK_KEY} label="곁질문" placeholder="묻고 Enter (비우면 닫기)" submitLabel="묻기" autoFocus onSubmit={v => submitAsk($, v)} />]
        : []),
      <Box key="side-actions" flexDirection="row" flexWrap="wrap" columnGap={1}>
        {[
          ...(Input && asking
            ? []
            : [<Button key="ask-focus" label="곁질문 (q)" hotkey="q" dimColor onPress={() => void (Input ? startAsk($) : askInBox($)).catch(() => undefined)} />]),
          ...(last ? [<Button key="main" label="본 대화로 보내기 (m)" hotkey="m" dimColor onPress={() => void sendAsUser($, last.q).catch(() => undefined)} />] : []),
          ...(chat.length
            ? [<Button key="clear" label="비우기" dimColor onPress={() => { chat = []; $.ui.invalidate('ui.render'); void persist($).catch(() => undefined) }} />]
            : []),
          <Button key="auto" label={isAuto ? '자동 분리 끄기' : '자동 분리 켜기'} dimColor onPress={() => void toggleAuto($, s).catch(() => undefined)} />,
        ]}
      </Box>,
      // 토론은 이 패널 밖(옆 탭)에 있어서, 있는 줄 모르고 지나치지 않게 한 줄로 알린다
      <Text key="debate-hint" dimColor wrap="wrap">토론: /baton-debate (두 Claude가 따져요)</Text>,
    ]
    return (
      <Box flexDirection="column">
        {top}
        <Text key="rule" dimColor>{'─'.repeat(Math.min(width, 40))}</Text>
        {bottom}
      </Box>
    )
  })

  // 물을 것·볼 것 줄은 본문에서 빠지고 이 패널에만 뜬다(answer-blocks). open-asks가 항목을 올릴 틈을 두고 연다
  on('turn.complete', { reason: 'answer' }, async ($, e, next) => {
    if (!(await live($))) return next(e)
    const done = await next(e)
    if (e.agentId || e.reason !== 'answer') return done
    openWhenJudged($, answerMark(e.answer), 20)
    return done
  })

  on('prompt.submit', { text: /[\s\S]/ }, async ($, e, next) => {
    if (!(await live($))) return next(e)
    const isPerson = isHuman(e.origin as { kind?: string } | undefined)
    // 사용자가 다음 메시지를 보내면 방금 지운 항목의 [되돌리기]를 내린다
    if (isPerson && lastRemoved.length) {
      lastRemoved = []
      $.ui.invalidate('ui.render')
    }
    if (!isPerson || e.attachments?.length || !worthChecking(e.text)) return next(e)
    const { value: isOn = s.auto } = await $.state.get(ENABLED)
    if (!isOn) return next(e)
    const side = await classify($, s, e.text).catch(() => false)
    if (!side) return next(e)
    if (!(await openPane($, false).catch(() => false))) {
      $.ui.toast(`${NO_ROOM} 본 대화로 보냈어요.`, { timeoutMs: 8000 })
      return next(e)
    }
    await update($, lastSide, () => e.text)
    void askSide($, e.text).catch(() => undefined)
    return { drop: '작업과 관계없는 질문이라 옆 패널의 곁대화에서 답해요. 본 대화로 보내려면 패널에서 m(또는 /baton-side main)' }
  })

  on('session.start', { isInteractive: true }, async ($, e, next) => {
    if (!enter(e) || !(await live($))) return next(e)
    const started = await next(e)
    await ensureLoaded($)
    await $.command.register(SIDE_COMMAND)
    return started
  })

  on('command.run', { command: 'baton-side' }, async ($, e) => {
    if (!(await live($))) return { text: OFF_TEXT }
    const arg = e.args.trim()
    const auto = arg.match(/^(?:auto\s+)?(on|off)$/)
    if (auto) {
      await update($, enabled, () => auto[1] === 'on')
      return { text: auto[1] === 'on' ? '작업과 관계없는 질문을 곁대화로 보내요.' : '곁질문 자동 분리를 껐어요. /baton-side 질문으로는 계속 물을 수 있어요.' }
    }
    // 내 차례 정리(예전 /asks)
    if (arg === 'list' || arg === 'clear' || arg === 'undo' || /^drop\s+\d+$/.test(arg)) return asksCommand($, arg, judgeModel)
    // 방금 곁대화로 보낸 질문을 본 대화로(예전 /main). 사용자가 쓴 질문이라 asUser로 보낸다
    if (arg === 'main') {
      const { value: text = '' } = await $.state.get(LASTSIDE)
      if (!text) return { text: '본 대화로 보낼 곁질문이 없어요.' }
      await update($, lastSide, () => '')
      void sendAsUser($, text).catch(() => undefined)
      return { text: `본 대화로 보냈어요: ${text}` }
    }
    if (arg === 'status') {
      const { value: n = { checked: 0, side: 0, failed: 0, totalMs: 0 } } = await $.state.get(STATS)
      const { value: isOn = s.auto } = await $.state.get(ENABLED)
      const avg = n.checked ? Math.round(n.totalMs / n.checked) : 0
      return {
        text:
          `곁질문 자동 분리 ${isOn ? '켜짐' : '꺼짐'} · 판정 ${n.checked}번 중 곁질문 ${n.side}번 · 실패 ${n.failed}번 · 평균 ${avg}ms · 모델 ${s.model}` +
          `\n곁대화 ${chat.length}개`,
      }
    }
    // 인자가 없으면 패널만 열고, 그 밖의 글은 질문으로 보고 곁대화에서 답한다. 패널 둘 자리가 없으면 내 차례를 글로 보여 준다
    const question = arg === 'open' ? '' : arg
    await openDebateTab($).catch(() => undefined)
    if (!(await openPane($, !question).catch(() => false))) {
      if (question) return { text: NO_ROOM }
      return { text: `${NO_ROOM}\n\n${(await asksCommand($, 'list', judgeModel)).text}` }
    }
    if (question) {
      await update($, lastSide, () => question)
      void askSide($, question).catch(() => undefined)
    }
    return {
      text: question
        ? '옆 패널의 곁대화에서 답해요.'
        : '옆 패널을 열었어요. 위는 내 차례, 아래는 곁대화예요. 숫자를 누르면 그 질문 아래에 답 칸이 열려요: 쓰고 Enter로 저장, s로 모아 보내요. q는 곁질문, Esc는 입력창으로, ctrl+x tab은 다시 패널로.',
    }
  })
}
