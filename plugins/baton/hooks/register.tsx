import type { Register } from 'claude-code'

import { registerBlocks } from './answer-blocks'
import { registerDebate } from './debate'
import { registerEntry } from './entry'
import { registerAsks } from './open-asks'
import { registerSide } from './side-panel'

// 네 mod를 한 플러그인으로 묶는다: answer-blocks(답 형식), open-asks(내 차례 모으기), side-panel(옆 패널), debate(토론).
// 엔진은 register.tsx가 바뀌어야 다시 불러온다: 다른 파일만 고쳤으면 이 파일도 건드린다(0.7.4, 내 차례 답을 다시 패널 입력칸에서 씀. 2026-10-11 사용자 "그전에 클릭해서 input채우는 경험이 좋앗던거 같음").
// 대화형이고 /baton on으로 고른 세션에서만 켜는 것은 각 hook 첫 줄의 live($)/enter()가 맡는다(live.ts, entry.tsx).
// 한 플러그인은 같은 이벤트를 matcher 없이 두 번 등록할 수 없어서, 여러 mod가 쓰는 이벤트(session.start, turn.complete, prompt.submit)는 matcher를 붙여 등록한다.
export const register: Register = (on, options) => {
  registerBlocks(on)
  registerSide(on, options)
  registerAsks(on, options)
  registerDebate(on, options)
  registerEntry(on, options)
}
