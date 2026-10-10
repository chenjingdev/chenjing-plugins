export type Ask = { id: number; text: string; turn: number; at: number; skips: number }
export type Closed = { text: string; at: number }
export type Book = { items: Ask[]; closed: Closed[]; seq: number }
export type AsksStats = { judged: number; failed: number }
export type SideStats = { checked: number; side: number; failed: number; totalMs: number }

// 곁대화 한 번과, 다시 불러와도 남기는 곁대화
export type SideTurn = { q: string; a?: string; err?: string }
export type SideKeep = { chat: SideTurn[] }

export type Side = 'pro' | 'con'
export type Turn = { side: Side; text: string }
export type Debater = { name: string; id: string | null }
// 토론 패널 아래 입력칸에서 물은 것
export type DebateQA = { id: string; q: string; a?: string; err?: string }
export type Debate = {
  topic: string
  brief: string
  labels: Record<Side, string>
  maxRounds: number
  // picking: /baton-debate만 쳐서 지금 대화에서 주제를 고르는 중(topic은 아직 비어 있음)
  status: 'picking' | 'starting' | 'running' | 'judging' | 'done' | 'failed'
  pro: Debater
  con: Debater
  log: Turn[]
  verdict: string
  error: string
  reportPath: string
  // 토론 패널에서 물은 질문과 답, 결과를 본 대화로 보냈는지(다시 불러와도 남게 state에 둔다)
  qa?: DebateQA[]
  sent?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'baton': {
      expanded: string[]
      book: Book
      turn: number
      lastRequest: string
      humanTurn: boolean
      // 판정을 마친 마지막 답의 지문(open-asks answerMark): 다시 불러온 뒤 같은 답을 또 판정하지 않는다
      judgedAnswer: string
      asksStats: AsksStats
      sideEnabled: boolean
      lastSide: string
      sideStats: SideStats
      debate: Debate | null
      sideKeep: SideKeep
    }
  }
}
