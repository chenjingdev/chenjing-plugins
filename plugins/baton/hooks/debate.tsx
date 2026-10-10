import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, ToolSpec } from 'claude-code'

import { enter, isKnown, isLive, OFF_TEXT, SESSIONS, settle } from './live'
import { closeAnswered } from './open-asks'
import type { Book, Debate, DebateQA, Side, Turn } from '../types'

const PANE = 'debate'
export const DEBATE_PANE = PANE
const CURRENT = { plugin: 'baton', key: 'debate' } as const
const current = atom(CURRENT, null)
// 사람 턴 세기(open-asks와 같은 키): [본 대화로 보내기]가 쓴다
const askBook = atom({ plugin: 'baton', key: 'book' } as const, { items: [], closed: [], seq: 0 })
const turnNo = atom({ plugin: 'baton', key: 'turn' } as const, 0)
const lastRequest = atom({ plugin: 'baton', key: 'lastRequest' } as const, '')
const humanTurn = atom({ plugin: 'baton', key: 'humanTurn' } as const, false)
const DEFAULT_REPORT_DIR = '~/.claude/baton/debates'
const DEBATER_TOOLS = 'SendMessage,WebSearch,WebFetch,Read,Grep,Glob'
const DEBATER_MODEL = 'sonnet'
const TOOL = 'start_debate'
const DEFAULT_LABELS: Record<Side, string> = { pro: '찬성', con: '반대' }
// 라운드는 기본도 최대도 10이다(2026-10-09 사용자 "기본 라운드 10라운드로". 그 전에는 기본 3, 최대 5)
const DEFAULT_ROUNDS = 10
const MAX_ROUNDS = 10

// "/baton-debate [라운드] [주제]": 주제가 비면(topic '') 지금 대화에서 고른다
export function parseArgs(args: string): { maxRounds: number; topic: string } {
  const [first = '', ...rest] = args.trim().split(/\s+/)
  const n = Number(first)
  const isRounds = first !== '' && Number.isInteger(n) && n > 0 && n <= MAX_ROUNDS
  const topic = (isRounds ? rest : [first, ...rest]).join(' ').trim()
  return { maxRounds: isRounds ? n : DEFAULT_ROUNDS, topic }
}

// /baton-debate만 쳤을 때 주제를 고르는 포크에 붙이는 말. 포크는 이 대화 전부(도구 결과 포함)를 보고 도구 없이 답한다(2026-10-09 사용자 "/baton-debate 만 치면 자동으로 실행되게")
export function topicPrompt(previous: string): string {
  return [
    '[토론 주제 고르기] 사용자가 /baton-debate만 쳤다. 지금까지 이 대화를 보고, 두 Claude가 두 편으로 나눠 토론할 주제를 하나 골라라. 이 답은 사용자에게 보이지 않고 토론 준비에만 쓰인다. 도구는 쓰지 않는다.',
    '- 따져 볼 값어치가 가장 큰 쟁점을 고른다. 사용자가 아직 정하지 않은 선택, Claude가 최근 답에서 권하거나 단정한 주장, 방금 한 작업이 제대로 됐는지 순으로 보고, 최근 대화를 먼저 본다.',
    ...(previous ? [`- 직전 토론 주제는 "${previous}"였다. 그 뒤로 다시 따질 일이 생긴 게 아니면 다른 쟁점을 고른다.`] : []),
    '- topic: 두 편이 갈리는 한 문장 명제, 60자 안.',
    '- pro, con: 두 편의 이름, 각 8자 안(예: "A안"과 "B안", "현행 유지"와 "바꾸기", "옹호"와 "반박"). pro가 topic을 지지한다.',
    '- brief: 토론자는 이 대화를 볼 수 없다. 쟁점이 생긴 배경, 양쪽이 기댈 근거, 확인된 사실과 숫자, 아직 모르는 것을 1500자 안에서 적는다. 대화에 없는 것은 지어내지 않는다.',
    'JSON 한 줄만 출력한다: {"topic":"…","pro":"…","con":"…","brief":"…"}',
  ].join('\n')
}

export type PickedTopic = { topic: string; labels: Record<Side, string>; brief: string }

// 포크의 답에서 주제를 읽는다: 앞뒤 글이나 코드 울타리가 붙어도 JSON 부분만 본다
export function parseTopic(text: string): PickedTopic | undefined {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return undefined
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>
    const line = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
    const topic = line(j.topic, 120)
    if (!topic) return undefined
    return {
      topic,
      labels: { pro: line(j.pro, 12) || DEFAULT_LABELS.pro, con: line(j.con, 12) || DEFAULT_LABELS.con },
      brief: typeof j.brief === 'string' ? j.brief.trim().slice(0, 4000) : '',
    }
  } catch {
    return undefined
  }
}

// /baton이 보여 주는 토론 상태 한 단어
export function debateWord(d: Debate | null | undefined): string {
  if (!isCurrent(d)) return '없음'
  if (isStalePick(d)) return '끊김'
  return { picking: '주제 고르는 중', starting: '시작하는 중', running: '진행 중', judging: '판정 중', done: '끝남', failed: '실패' }[d.status]
}

// 패널 제목: 주제를 고르는 동안은 주제가 비어 있다
export function paneTitle(d: Pick<Debate, 'topic'>): string {
  return `토론: ${d.topic || '주제 고르는 중'}`.slice(0, 40)
}

// 토론 기록 폴더(userConfig debate_dir)와 토론자 세션이 도는 폴더(debate_work_dir). ~는 홈 폴더다.
// 토론자는 도는 폴더의 CLAUDE.md를 읽으므로 기록 폴더와 따로 둘 수 있게 했다(2026-10-09).
// 토론자 폴더는 신뢰된 폴더여야 해서(아니면 claude --bg가 "Workspace not trusted."로 끝난다), 비워 두면 토론을 연 세션의 작업 폴더에서 돈다.
export type DebateDirs = { reportDir: string; workDir: string }

export function debateDirs(o: PluginOptions, home: string, cwd: string): DebateDirs {
  const dir = (v: unknown, fallback: string) => {
    const s = typeof v === 'string' && v.trim() ? v.trim() : fallback
    if (s !== '~' && !s.startsWith('~/')) return s.replace(/(.)\/+$/, '$1')
    if (!home) throw new Error(`홈 폴더를 몰라 ${s}를 풀지 못했어요`)
    return (home + s.slice(1)).replace(/(.)\/+$/, '$1')
  }
  return { reportDir: dir(o.debate_dir, DEFAULT_REPORT_DIR), workDir: dir(o.debate_work_dir, cwd) }
}

// "backgrounded · 9446dcda · debate-pro-x (idle …)" → 9446dcda
export function parseBgId(stdout: string): string | null {
  return stdout.match(/backgrounded\s*·\s*([0-9a-f]{6,})/)?.[1] ?? null
}

// <cross-session-message from="…" from-name="debate-pro-x" …>본문</cross-session-message>
export function parsePeer(text: string): { fromName: string | null; body: string } {
  const fromName = text.match(/from-name="([^"]+)"/)?.[1] ?? null
  const body = text
    .replace(/<\/?cross-session-message[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { fromName, body }
}

export function rules(d: Pick<Debate, 'topic' | 'brief' | 'labels' | 'maxRounds'>, side: Side): string {
  const other: Side = side === 'pro' ? 'con' : 'pro'
  return [
    `토론 참가 안내: 주제는 "${d.topic}". 너는 ${d.labels[side]} 측, 상대는 ${d.labels[other]} 측이다.`,
    d.brief ? `\n배경 자료(사용자와 다른 Claude가 나눈 대화 요약):\n${d.brief}\n` : '',
    `상대 주장이 이 세션을 통해 전달되면, 그것을 짚어 반박하고 새 근거를 하나 더해라. 총 ${d.maxRounds}번 발언한다.`,
    '4문장 이내, 한국어, 인사나 메타 설명 없이 주장만. 사실 주장은 가능하면 WebSearch로 확인하고, 확인 못 한 건 추정이라고 밝혀라.',
    '발언은 반드시 이 메시지의 from 주소로 SendMessage를 보내는 것으로 한다. 일반 텍스트 출력은 상대에게 안 보인다.',
  ].join('\n')
}

export function toMarkdown(d: Debate): string {
  const turns = d.log.map((t, i) => `### ${i + 1}. ${d.labels[t.side]}\n\n${t.text}\n`).join('\n')
  return [
    `# 토론: ${d.topic}`,
    '',
    `${d.labels.pro}: ${d.pro.name} · ${d.labels.con}: ${d.con.name} · ${d.maxRounds}라운드`,
    d.brief ? `\n## 배경 자료\n\n${d.brief}\n` : '',
    '## 발언',
    '',
    turns,
    '## 판정',
    '',
    d.verdict || '(없음)',
    '',
  ].join('\n')
}

// 이전 버전이 남긴 상태(모양이 다름)는 없는 것으로 본다; labels 등 새 필드만 빠진 건 upgrade로 채움
function isCurrent(d: Debate | null | undefined): d is Debate {
  return !!d && typeof d.pro?.name === 'string' && typeof d.con?.name === 'string' && !!d.labels
}

export function upgrade(d: Partial<Debate> | null | undefined): Debate | null {
  if (!d || typeof d.pro?.name !== 'string' || typeof d.con?.name !== 'string') return null
  return {
    topic: d.topic ?? '',
    brief: d.brief ?? '',
    labels: d.labels ?? DEFAULT_LABELS,
    maxRounds: d.maxRounds ?? 3,
    status: d.status ?? 'done',
    pro: d.pro,
    con: d.con,
    log: d.log ?? [],
    verdict: d.verdict ?? '',
    error: d.error ?? '',
    reportPath: d.reportPath ?? '',
    qa: d.qa ?? [],
    sent: d.sent ?? false,
  }
}

// 이 모듈이 주제를 고르고 있는 토론의 토론자 이름. 다시 불러오면 비므로, 그때 state에 남은 'picking'은 끊긴 것이다
let pickingFor = ''

function isStalePick(d: Debate): boolean {
  return d.status === 'picking' && pickingFor !== d.pro.name
}

function isActive(d: Debate | null | undefined): boolean {
  if (!isCurrent(d)) return false
  if (d.status === 'picking') return !isStalePick(d)
  return d.status === 'starting' || d.status === 'running' || d.status === 'judging'
}

function nextSide(log: readonly Turn[]): Side {
  return log.at(-1)?.side === 'pro' ? 'con' : 'pro'
}

async function patch($: EngineInterface, fn: (d: Debate) => Debate) {
  await update($, current, (d: Debate | null): Debate | null => (d ? fn(d) : d))
}

async function spawnDebater($: EngineInterface, name: string, workDir: string): Promise<string> {
  const { exitCode, stdout, stderr } = await $.process.run(
    ['claude', '--bg', '-n', name, '--permission-mode', 'bypassPermissions', '--model', DEBATER_MODEL, '--tools', DEBATER_TOOLS],
    { cwd: workDir, timeoutMs: 60_000 },
  )
  const id = parseBgId(stdout)
  if (exitCode === 0 && id) return id
  const out = (stderr || stdout).trim()
  const hint = /not trusted/i.test(out) ? ` 토론자 폴더(${workDir})를 신뢰하지 않았어요. 그 폴더에서 claude를 한 번 열어 신뢰하거나, /config에서 debate_work_dir를 비워 이 세션 폴더에서 돌게 해요.` : ''
  throw new Error(`${name} 시작 실패: ${out.slice(0, 200)}${hint}`)
}

// 홈 폴더와 이 세션의 작업 폴더를 읽어 토론 폴더를 정한다. $를 쓰는 함수라 hook과 같은 파일에 둔다
async function dirsFor($: EngineInterface, o: PluginOptions): Promise<DebateDirs> {
  const home = await $.process.run(['printenv', 'HOME'], { timeoutMs: 5_000 }).then(r => r.stdout.trim(), () => '')
  return debateDirs(o, home, await $.session.cwd())
}

// --bg는 세션이 피어로 등록되기 전에 돌아오므로, 이름이 보일 때까지 기다림
async function waitForPeers($: EngineInterface, names: readonly string[]) {
  for (let i = 0; i < 30; i++) {
    const { stdout } = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: 15_000 })
    const seen = new Set<string>()
    try {
      for (const a of JSON.parse(stdout) as { name?: string }[]) if (a.name) seen.add(a.name)
    } catch {}
    if (names.every(n => seen.has(n))) return
    await $.clock.sleep(1000)
  }
  throw new Error(`토론자 세션이 30초 안에 등록되지 않음: ${names.join(', ')}`)
}

async function sendOrThrow($: EngineInterface, to: string, text: string) {
  for (let i = 0; i < 3; i++) {
    const sent = await $.session.send({ to, text })
    if (sent.isDelivered) return
    if (i === 2) throw new Error(`${to}에게 전송 실패: ${sent.reason}`)
    await $.clock.sleep(2000)
  }
}

async function stopDebaters($: EngineInterface, d: Debate) {
  for (const id of [d.pro.id, d.con.id]) {
    if (id) await $.process.run(['claude', 'stop', id], { timeoutMs: 20_000 }).catch(() => undefined)
  }
}

async function start($: EngineInterface, o: PluginOptions) {
  const { value: d } = await $.state.get(CURRENT)
  if (!isCurrent(d)) return
  try {
    const { workDir } = await dirsFor($, o)
    // 없는 폴더만 만든다: 기본값(이 세션 폴더)에 파일을 남기지 않는다
    if (!(await $.fs.exists(workDir))) await $.fs.write(`${workDir}/.keep`, '')
    const [proId, conId] = await Promise.all([spawnDebater($, d.pro.name, workDir), spawnDebater($, d.con.name, workDir)])
    await patch($, cur => ({ ...cur, pro: { ...cur.pro, id: proId }, con: { ...cur.con, id: conId } }))
    await waitForPeers($, [d.pro.name, d.con.name])
    await patch($, cur => ({ ...cur, status: 'running' }))
    await sendOrThrow($, d.pro.name, `${rules(d, 'pro')}\n\n첫 발언을 지금 해라.`)
  } catch (err) {
    await patch($, cur => ({ ...cur, status: 'failed', error: String(err) }))
    await stopDebaters($, (await $.state.get(CURRENT)).value ?? d)
  }
}

// 토론 패널 아래 입력칸의 질문과 답(곁대화처럼)과 보냄 표시는 토론 state(qa, sent)에 둔다: 다시 불러와도 남고, 새 토론을 열면 비워진다

// 본 대화로 보낼 글: 판정(양측 핵심·승부처·판정)과 패널에서 물은 것, 전문은 경로만. 사용자가 누른 버튼이라 사용자의 말로 보낸다
export function reportText(d: Pick<Debate, 'topic' | 'verdict' | 'reportPath'>, asked: readonly DebateQA[]): string {
  const qs = asked.filter(x => x.a).slice(-4).map(x => `Q. ${x.q}\nA. ${(x.a ?? '').slice(0, 1500)}`)
  return [
    `↩ 토론 결과: "${d.topic}"`,
    d.verdict,
    ...(qs.length ? ['', '토론 패널에서 물은 것:', ...qs] : []),
    ...(d.reportPath ? ['', `전문: ${d.reportPath}`] : []),
    '',
    '이 토론 결과로 원래 대화의 주장 중 무엇이 버티고 무엇이 흔들렸는지 짧게 정리해 줘. 토론자 주장도 그대로 사실로 받아들이지 말고.',
  ].join('\n')
}

// open-asks의 countHumanTurn과 같다: baton이 보낸 글은 baton의 prompt.submit 훅을 모두 건너뛰고, $는 다른 파일의 함수로 넘길 수 없다
async function countHumanTurn($: EngineInterface, text: string) {
  const n = await update($, turnNo, (x: number) => x + 1)
  await update($, lastRequest, () => text)
  await update($, humanTurn, () => true)
  await update($, askBook, (cur: Book): Book => closeAnswered(cur, text, n, Date.now()))
}

async function sendReport($: EngineInterface) {
  const { value: d } = await $.state.get(CURRENT)
  if (!isCurrent(d) || d.status !== 'done' || !d.verdict || d.sent) return
  await patch($, cur => ({ ...cur, sent: true }))
  const text = reportText(d, d.qa ?? [])
  await countHumanTurn($, text)
  const r = await $.prompt.submit({ text, asUser: true }).catch((err: unknown) => ({ drop: String(err) }))
  if (r.drop === undefined) return
  await patch($, cur => ({ ...cur, sent: false }))
  $.ui.toast(`본 대화로 못 보냈어요: ${r.drop}`, { timeoutMs: 8000 })
}

export function askPrompt(d: Pick<Debate, 'topic' | 'brief' | 'labels' | 'log' | 'verdict'>, history: readonly DebateQA[], question: string): string {
  const transcript = d.log.map(t => `[${d.labels[t.side]}] ${t.text}`).join('\n\n')
  const past = history.filter(x => x.a).slice(-4).map(x => `Q: ${x.q}\nA: ${(x.a ?? '').slice(0, 1500)}`)
  return [
    `[토론 주제] ${d.topic}`,
    ...(d.brief ? ['', '[토론자에게 준 배경]', d.brief] : []),
    '',
    '[토론 기록]',
    transcript || '(아직 발언 없음)',
    ...(d.verdict ? ['', '[심판 판정]', d.verdict] : []),
    ...(past.length ? ['', '[앞선 질문]', ...past] : []),
    '',
    '[사용자 질문]',
    question.trim(),
  ].join('\n')
}

async function askDebate($: EngineInterface, question: string) {
  const q = question.trim()
  if (!q) return
  const { value: d } = await $.state.get(CURRENT)
  if (!isCurrent(d)) return
  const item: DebateQA = { id: Math.random().toString(36).slice(2, 10), q }
  const history = d.qa ?? []
  await patch($, cur => ({ ...cur, qa: [...(cur.qa ?? []), item].slice(-12) }))
  const r = await $.model.complete({
    model: 'sonnet',
    maxTokens: 1500,
    system: '너는 이 토론을 지켜본 해설자다. 토론 기록과 판정만 근거로 한국어로 짧게 답한다. 토론자 주장도 검증 대상이라 그대로 사실로 말하지 않고, 기록에 없는 것은 모른다고 말한다.',
    prompt: askPrompt(d, history, q),
  })
  const done: DebateQA = r.isAnswered ? { ...item, a: r.text.trim() } : { ...item, err: `답을 받지 못했어요: ${r.reason}` }
  // 답을 기다리는 사이 새 토론이 열렸으면 그 토론에는 넣지 않는다
  await patch($, cur => (cur.qa?.some(x => x.id === item.id) ? { ...cur, qa: cur.qa.map(x => (x.id === item.id ? done : x)) } : cur))
}

// launch의 글은 모델에게 하는 말이라, 사용자가 /baton-debate로 시작했을 때는 사용자에게 할 말로 바꾼다(2026-10-09 "사용자에게 시작했다고만 짧게 알려라"가 사용자 화면에 떴다)
export function commandText(said: string, topic: string, rounds: number): string {
  if (said.startsWith('이미 토론이')) return BUSY_TEXT
  if (!said.startsWith('토론을 시작')) return said
  const n = Math.min(MAX_ROUNDS, Math.max(1, rounds))
  return `토론을 시작했어요: "${topic.trim()}" (${n}라운드${rounds > n ? `, ${rounds}라운드는 ${n}라운드로 줄였어요` : ''}). 토론 탭에서 진행을 보고, 끝나면 [본 대화로 보내기](m)로 결과를 이 대화에 넣을 수 있어요.`
}

// /baton-debate로 시작하면 토론자는 이 대화를 못 보므로 최근 요청과 답을 배경으로 넘긴다(2026-10-09 토론자가 "지금 작업"을 몰라 엉뚱한 파일을 두고 다퉜다)
export function recentBrief(msgs: readonly { role: string; text: string }[]): string {
  const out: string[] = []
  for (let i = msgs.length - 1; i >= 0 && out.length < 4; i--) {
    const m = msgs[i]
    if (!m?.text.trim() || (m.role !== 'user' && m.role !== 'assistant')) continue
    out.unshift(`${m.role === 'user' ? '사용자' : 'Claude'}: ${m.text.trim().slice(0, 1500)}`)
  }
  return out.length ? `토론을 연 대화의 최근 내용(사용자 요청과 Claude 답):\n${out.join('\n\n')}` : ''
}

// 판정 → 파일 저장 → 메인 대화로 결과 전달
async function finish($: EngineInterface, d: Debate, o: PluginOptions) {
  await stopDebaters($, d)
  const transcript = d.log.map(t => `[${d.labels[t.side]}] ${t.text}`).join('\n\n')
  const r = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    // 500이면 판정 문장이 중간에 잘린 적이 있다(2026-10-02 earlier-m5ys.md "…우월한")
    maxTokens: 1500,
    system: '너는 공정한 토론 심판이다. 한국어로 답한다.',
    prompt: `주제: ${d.topic}\n\n${transcript}\n\n양측 핵심 주장을 한 줄씩, 승부처를 한 줄, 판정(어느 쪽 우세/무승부와 이유)을 한 줄로. 총 4줄.`,
  })
  const verdict = r.isAnswered ? r.text.trim() : `판정 실패 (${r.reason})`
  const stamp = new Date(await $.clock.now()).toISOString().slice(0, 16).replace(/[-:T]/g, '')
  const { reportDir } = await dirsFor($, o)
  const reportPath = `${reportDir}/${stamp}-${d.pro.name.split('-').pop()}.md`
  const done: Debate = { ...d, status: 'done', verdict, reportPath }
  await $.fs.write(reportPath, toMarkdown(done))
  await patch($, cur => ({ ...cur, status: 'done', verdict, reportPath }))
  // 본 대화에는 자동으로 넣지 않는다: 토론 패널의 [본 대화로 보내기]를 눌렀을 때만 보낸다(2026-10-09 사용자 "버튼으로 넣어줘. 자동으로 들어가게 하지말고")
  $.ui.toast('토론이 끝났어요. 토론 탭의 [본 대화로 보내기]로 결과를 본 대화에 넣을 수 있어요.', { timeoutMs: 8000 })
}

type LaunchInput = { topic: string; brief?: string; rounds?: number; proLabel?: string; conLabel?: string }

function newDebate(input: LaunchInput, status: Debate['status']): Debate {
  const tag = Math.random().toString(36).slice(2, 6)
  return {
    topic: input.topic.trim(),
    brief: (input.brief ?? '').trim(),
    labels: { pro: input.proLabel?.trim() || DEFAULT_LABELS.pro, con: input.conLabel?.trim() || DEFAULT_LABELS.con },
    maxRounds: Math.min(MAX_ROUNDS, Math.max(1, Math.round(input.rounds ?? DEFAULT_ROUNDS))),
    status,
    pro: { name: `debate-pro-${tag}`, id: null },
    con: { name: `debate-con-${tag}`, id: null },
    log: [],
    verdict: '',
    error: '',
    reportPath: '',
    qa: [],
    sent: false,
  }
}

async function launch($: EngineInterface, input: LaunchInput, o: PluginOptions): Promise<string> {
  const { value: prev } = await $.state.get(CURRENT)
  if (isActive(prev)) return '이미 토론이 진행 중이다. 끝나거나 /baton-debate stop 후 다시 시작해야 한다.'
  const debate = newDebate(input, 'starting')
  await update($, current, (): Debate | null => debate)
  await $.ui.open({ id: PANE, title: paneTitle(debate) })
  void start($, o)
  return `토론을 시작했다: "${debate.topic}" (${debate.maxRounds}라운드, ${debate.labels.pro} vs ${debate.labels.con}). 패널에서 진행이 보이고, 끝나면 사용자가 토론 패널의 [본 대화로 보내기]를 눌렀을 때만 결과가 이 대화에 들어온다. 사용자에게 시작했다고만 짧게 알려라.`
}

const BUSY_TEXT = '이미 토론이 진행 중이에요. 끝나거나 /baton-debate stop 뒤에 다시 시작하세요.'
export const NOTHING_YET = '토론할 대화가 아직 없어요. 대화를 조금 한 뒤 /baton-debate를 치거나, /baton-debate 주제로 직접 주세요.'

// 주제를 고르다 실패하면 그 토론이 아직 고르는 중일 때만 실패로 적는다
async function failPick($: EngineInterface, name: string, why: string) {
  await update($, current, (cur: Debate | null): Debate | null =>
    cur && cur.pro.name === name && cur.status === 'picking' ? { ...cur, status: 'failed', error: `주제를 고르지 못했어요(${why}). /baton-debate 주제로 직접 주세요.` } : cur,
  )
}

async function pick($: EngineInterface, name: string, previous: string, o: PluginOptions) {
  const r = await $.model.fork({ prompt: topicPrompt(previous) })
  const picked = r.isAnswered ? parseTopic(r.text) : undefined
  if (!picked) {
    const why = r.isAnswered ? '답 형식이 달랐어요' : r.reason === 'nothing-to-fork' ? '아직 고를 대화가 없어요' : `모델 답 없음: ${r.reason}`
    return failPick($, name, why)
  }
  // 고르는 사이 중지했거나 새 토론을 열었으면 시작하지 않는다
  let isMine = false
  await update($, current, (cur: Debate | null): Debate | null => {
    isMine = !!cur && cur.pro.name === name && cur.status === 'picking'
    return cur && isMine ? { ...cur, topic: picked.topic, brief: picked.brief, labels: picked.labels, status: 'starting' } : cur
  })
  if (!isMine) return
  await $.ui.open({ id: PANE, title: paneTitle(picked) }).catch(() => undefined)
  $.ui.toast(`토론 주제: ${picked.topic}`, { timeoutMs: 8000 })
  await start($, o)
}

// /baton-debate만 쳤을 때: 패널을 먼저 열어 "주제 고르는 중"을 보이고, 지금 대화를 이어받은 포크($.model.fork)가 고른 주제로 시작한다.
// /baton-debate 주제처럼 최근 메시지 몇 개만 넘기는 대신 포크가 brief를 쓰므로, 토론자가 받는 배경도 대화 전체에서 나온다
async function launchPicked($: EngineInterface, rounds: number, o: PluginOptions): Promise<string> {
  const { value: prev } = await $.state.get(CURRENT)
  if (isActive(prev)) return BUSY_TEXT
  const msgs = await $.session.messages().catch(() => [])
  if (!msgs.some(m => m.role === 'assistant' && m.text.trim())) return NOTHING_YET
  const debate = newDebate({ topic: '', rounds }, 'picking')
  const name = debate.pro.name
  pickingFor = name
  await update($, current, (): Debate | null => debate)
  // 패널을 못 열어도 고르기는 한다: 여기서 멈추면 'picking'이 남아 다음 /baton-debate를 막는다
  await $.ui.open({ id: PANE, title: paneTitle(debate) }).catch(() => undefined)
  void pick($, name, isCurrent(prev) ? prev.topic : '', o)
    .catch((err: unknown) => failPick($, name, String(err)))
    .finally(() => {
      if (pickingFor === name) pickingFor = ''
    })
  const cut = rounds > debate.maxRounds ? `, ${rounds}라운드는 ${debate.maxRounds}라운드로 줄였어요` : ''
  return `지금 대화에서 토론 주제를 고르고 있어요(${debate.maxRounds}라운드${cut}). 고르면 바로 시작하고, 주제와 진행은 토론 탭에서 봐요.`
}

async function stopCurrent($: EngineInterface): Promise<{ text: string }> {
  const { value: d } = await $.state.get(CURRENT)
  if (!isCurrent(d)) return { text: '진행 중인 토론이 없어요.' }
  await patch($, cur => ({ ...cur, status: 'done' }))
  await stopDebaters($, d)
  return { text: d.status === 'picking' ? '주제 고르기를 멈췄어요.' : '토론을 멈추고 두 세션을 종료했어요.' }
}

export const DEBATE_COMMAND = {
  name: 'baton-debate',
  description: '두 Claude가 토론해요. /baton-debate만 치면 지금 대화에서 주제를 골라 시작하고, /baton-debate [라운드] 주제로 직접 줄 수도 있어요. /baton-debate stop: 중지',
  argumentHint: '[라운드] [주제 (비우면 지금 대화에서 골라요)]',
}

export const DEBATE_TOOL: ToolSpec = {
  name: TOOL,
  description: [
    '별도의 Claude 세션 두 개를 띄워 주제를 놓고 라운드제 토론을 시키고, 사용자에게 패널로 중계한다.',
    '사용자가 "토론시켜 봐", "토론으로 검증해 보자", "반론 세워서 따져 봐"처럼 요청할 때 쓴다.',
    '토론자는 이 대화를 못 보므로, 검증할 주장과 필요한 사실·맥락을 brief에 충분히 적어 넘겨라.',
    '바로 돌아온다. 토론이 끝나도 결과는 자동으로 오지 않고, 사용자가 토론 패널의 [본 대화로 보내기]를 누르면 판정이 사용자 메시지로 들어온다.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '토론 주제 또는 검증할 명제 (한 문장)' },
      brief: { type: 'string', description: '토론자에게 줄 배경: 지금까지 대화의 핵심 주장, 근거, 결정 사항 요약' },
      rounds: { type: 'integer', minimum: 1, maximum: MAX_ROUNDS, description: `각 측 발언 횟수 (기본 ${DEFAULT_ROUNDS})` },
      pro_label: { type: 'string', description: '찬성 측 이름 (예: 옹호, 현행 유지). 기본 찬성' },
      con_label: { type: 'string', description: '반대 측 이름 (예: 반박, 비판). 기본 반대' },
    },
    required: ['topic'],
  },
}

// 이 세션에서 켜졌는지(live.ts). $를 쓰는 함수라 hook과 같은 파일에 둔다
async function live($: EngineInterface): Promise<boolean> {
  if (isKnown()) return isLive()
  // 읽다가 실패하면 이번만 꺼진 것으로 보고, 정하지 않은 채 두어 다음에 다시 읽는다
  const id = await $.session.id().catch(() => '')
  const list = id ? await $.store.get(SESSIONS).catch(() => null) : null
  return list === null ? false : settle(list, id)
}

export function registerDebate(on: On, options: PluginOptions): void {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    if (!enter(e) || !(await live($))) return next(e)
    const started = await next(e)
    // 이전 버전 상태를 새 모양으로 옮기고, 끝난 토론인데 파일이 없으면 저장
    const { value: old } = await $.state.get(CURRENT)
    const up = upgrade(old as Partial<Debate> | null)
    if (up && !isCurrent(old)) await update($, current, (): Debate | null => up)
    if (up && up.status === 'done' && !up.reportPath && up.log.length > 0) {
      const dirs = await dirsFor($, options).catch(() => null)
      if (dirs) {
        const reportPath = `${dirs.reportDir}/earlier-${up.pro.name.split('-').pop()}.md`
        await $.fs.write(reportPath, toMarkdown({ ...up, reportPath }))
        await patch($, cur => ({ ...cur, reportPath }))
      }
    }
    await $.command.register(DEBATE_COMMAND)
    await $.tool.register(DEBATE_TOOL)
    return started
  })

  // 등록한 도구는 내장 도구 표에 없어 matcher 타입이 안 맞으므로 이름으로 비교
  on('tool.call', async ($, e, next) => {
    if (!String(e.tool).endsWith(`__${TOOL}`)) return next(e)
    if (!(await live($))) return { result: { started: false }, text: `${OFF_TEXT} 그래서 토론을 시작하지 않았다.` }
    const input = e as unknown as { topic?: unknown; brief?: unknown; rounds?: unknown; pro_label?: unknown; con_label?: unknown }
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
    const topic = str(input.topic)
    if (!topic?.trim()) return { result: { started: false }, text: 'topic이 필요하다.' }
    const text = await launch($, {
      topic,
      brief: str(input.brief),
      rounds: typeof input.rounds === 'number' ? input.rounds : undefined,
      proLabel: str(input.pro_label),
      conLabel: str(input.con_label),
    }, options)
    return { result: { started: text.startsWith('토론을 시작') }, text }
  })

  on('command.run', { command: 'baton-debate' }, async ($, e) => {
    if (!(await live($))) return { text: OFF_TEXT }
    if (e.args.trim() === 'stop') return stopCurrent($)
    const { maxRounds, topic } = parseArgs(e.args)
    if (!topic) return { text: await launchPicked($, maxRounds, options) }
    const brief = recentBrief(await $.session.messages().catch(() => []))
    const said = await launch($, { topic, rounds: maxRounds, brief }, options)
    return { text: commandText(said, topic, maxRounds) }
  })

  // 토론자 발언은 메인 모델에게 보내지 않고(consumed) 패널에 기록 후 상대에게 중계
  on('session.receive', async ($, e, next) => {
    if (!(await live($))) return next(e)
    const { value: d } = await $.state.get(CURRENT)
    if (!isCurrent(d) || d.status !== 'running' || e.agentId) return next(e)
    const { fromName, body } = parsePeer(e.text)
    const side: Side | null = fromName === d.pro.name ? 'pro' : fromName === d.con.name ? 'con' : null
    if (!side) return next(e)

    const log = [...d.log, { side, text: body }]
    const isOver = log.length >= d.maxRounds * 2
    await patch($, cur => ({ ...cur, log, status: isOver ? 'judging' : cur.status }))

    if (isOver) {
      void finish($, { ...d, log }, options).catch(err => patch($, cur => ({ ...cur, status: 'failed', error: String(err) })))
    } else {
      const other: Side = side === 'pro' ? 'con' : 'pro'
      const isFirstForOther = !d.log.some(t => t.side === other)
      const intro = isFirstForOther ? `${rules(d, other)}\n\n` : ''
      void sendOrThrow(
        $,
        d[other].name,
        `${intro}${d.labels[side]} 측 발언:\n${body}\n\n이제 너(${d.labels[other]})의 차례다.`,
      ).catch(err => patch($, cur => ({ ...cur, status: 'failed', error: String(err) })))
    }
    return { consumed: `debate: ${d.labels[side]} 발언 중계` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = els
    if (!(await live($))) return <Text dimColor>{OFF_TEXT}</Text>
    const Input = 'Input' in els ? els.Input : undefined
    const d = await read($, current)
    if (!isCurrent(d)) return <Text dimColor>진행 중인 토론이 없어요. /baton-debate [라운드] &lt;주제&gt;</Text>

    const status = {
      picking: isStalePick(d) ? '주제를 고르다 플러그인을 다시 불러와 멈췄어요. /baton-debate를 다시 쳐요.' : '지금 대화에서 토론 주제를 고르는 중…',
      starting: '토론자 세션 띄우는 중…',
      running: `${d.labels[nextSide(d.log)]} 측 생각 중…`,
      judging: '심판이 판정 중…',
      done: d.reportPath ? `종료 · 전문: ${d.reportPath}` : '종료',
      failed: `실패: ${d.error}`,
    }[d.status]
    const isPicking = d.status === 'picking' && !isStalePick(d)

    return (
      <Box flexDirection="column">
        <Text bold>{d.topic || (isPicking ? '(주제 고르는 중)' : '(주제 없음)')}</Text>
        {d.topic && (
          <Text dimColor>
            {d.labels.pro} vs {d.labels.con} · 발언 {d.log.length}/{d.maxRounds * 2}
          </Text>
        )}
        {d.log.slice(-8).map((turn, i) => (
          <Box key={`t-${i}`} flexDirection="column" marginTop={1}>
            <Text bold color={turn.side === 'pro' ? 'cyan' : 'magenta'}>
              {turn.side === 'pro' ? '▶' : '◀'} {d.labels[turn.side]}
            </Text>
            <Text>{turn.text}</Text>
          </Box>
        ))}
        {d.verdict && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="yellow">⚖ 판정</Text>
            <Text>{d.verdict}</Text>
          </Box>
        )}
        <Text color={d.status === 'failed' ? 'red' : undefined} dimColor={d.status !== 'failed'}>
          {status}
        </Text>
        {(d.qa ?? []).slice(-6).map(x => (
          <Box key={`qa-${x.id}`} flexDirection="column" marginTop={1}>
            <Text bold>{`Q. ${x.q}`}</Text>
            {x.a ? <Markdown text={x.a.slice(0, 9500)} /> : <Text dimColor>{x.err ?? '답 쓰는 중…'}</Text>}
          </Box>
        ))}
        {d.status === 'done' && d.verdict && (
          d.sent ? (
            <Text key="sent" dimColor>[ 본 대화로 보냄 ]</Text>
          ) : (
            // 패널에 들어오면 링이 이 버튼에서 시작한다: 입력칸이 먼저 받으면 m이 글자로 들어갔다(2026-10-09 tmux로 확인)
            <Button key="send-report" label="본 대화로 보내기 (m)" hotkey="m" variant="primary" autoFocus onPress={() => void sendReport($).catch(() => undefined)} />
          )
        )}
        {Input && (
          <Input
            key="debate-ask"
            placeholder="토론에 질문 (기록과 판정을 보고 답해요)"
            submitLabel="묻기"
            {...(d.status === 'done' && d.verdict && !d.sent ? {} : { autoFocus: true as const })}
            onSubmit={v => void askDebate($, v).catch(() => undefined)}
          />
        )}
        {(isPicking || d.status === 'starting' || d.status === 'running') && (
          <Button
            key="stop"
            label="토론 중지"
            onPress={async () => {
              await patch($, cur => ({ ...cur, status: 'done' }))
              await stopDebaters($, d)
            }}
          />
        )}
      </Box>
    )
  })
}
