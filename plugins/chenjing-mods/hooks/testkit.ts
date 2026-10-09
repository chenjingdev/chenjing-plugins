import type { Engine, TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

export const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }

// 테스트 키트에는 세션 id와 store의 바닥이 없어서 테스트가 대신 답한다. id는 바꿔 가며 쓸 수 있다
export function fakeSession(on: On, first = 'test-session') {
  const store = new Map<string, unknown>()
  const s = { id: first, store, registered: [] as string[] }
  on('session.id', () => ({ value: s.id }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', (_$, e) => {
    s.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', (_$, e) => {
    s.registered.push(e.name)
    return { value: { tool: e.name } }
  })
  return s
}

// 테스트 세션을 /mods on으로 고른다. 키트는 on()을 모두 첫 $ 호출 전에 받으므로, fakeSession(on)을 먼저 부르고 다른 on()들 뒤에 이것을 부른다
export async function modsOn($: Engine) {
  const r = await $.command.run({ command: 'mods', args: 'on', ...RUN })
  if (!r.text?.includes('켰어요')) throw new Error(r.text ?? '/mods on: 답 없음')
}
