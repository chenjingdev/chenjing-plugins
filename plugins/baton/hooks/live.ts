// 사람이 앉아 있고(대화형) 사용자가 /baton on으로 고른 세션에서만 켠다(2026-10-09, 다른 세션에도 퍼져서 바꿈).
// - interactive: session.start가 알린 값. -p, SDK, 데스크톱 앱은 false다. session.start 전에는 true로 본다(테스트는 session.start 없이 돈다).
// - chosen: 이 세션을 /baton on으로 골랐는지. 처음 물을 때 store의 목록(SESSIONS)에서 이 세션 id를 찾고, 그 뒤로는 기억한다.
//   /clear는 session.start 없이 새 id로 이어지므로 그대로 둔다(새 id는 entry.tsx가 목록에 더한다). /resume으로 다른 세션이 오면 다시 찾는다.
// $를 쓰는 함수는 hook과 같은 파일에 두어야 해서, store를 읽는 부분은 각 파일의 live()가 맡고 여기는 값만 쥔다.
export const SESSIONS = 'sessions'
const MAX_SESSIONS = 200
export const OFF_TEXT = '이 세션에서는 baton이 꺼져 있어요. /baton on으로 켜요.'

let interactive = true
let chosen: boolean | undefined

export function isLive(): boolean {
  return interactive && chosen === true
}

export function isKnown(): boolean {
  return chosen !== undefined
}

// store에서 읽은 목록에 이 세션 id가 있는지로 정하고, 켜졌는지를 돌려준다
export function settle(list: unknown, id: string): boolean {
  chosen = idsFrom(list).includes(id)
  return isLive()
}

export function choose(isOn: boolean): void {
  chosen = isOn
}

export function forget(): void {
  chosen = undefined
}

// session.start hook의 첫 줄: 이 세션이 대화형인지 기록하고 그 값을 돌려준다
export function enter(e: { isInteractive: boolean }): boolean {
  interactive = e.isInteractive
  return interactive
}

export function idsFrom(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export function withId(list: string[], id: string, isOn: boolean): string[] {
  const rest = list.filter(x => x !== id)
  return isOn ? [...rest, id].slice(-MAX_SESSIONS) : rest
}
