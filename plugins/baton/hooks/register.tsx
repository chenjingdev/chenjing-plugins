import type { Register } from 'claude-code'

import { registerBlocks } from './answer-blocks'
import { registerDebate } from './debate'
import { registerEntry } from './entry'
import { registerAsks } from './open-asks'
import { registerSide } from './side-panel'

// 네 mod를 한 플러그인으로 묶는다: answer-blocks(답 형식), open-asks(내 차례 모으기), side-panel(옆 패널), debate(토론).
// 엔진은 register.tsx가 바뀌어야 다시 불러온다: 다른 파일만 고쳤으면 이 파일도 건드린다(0.7.8, 요약을 줄글 대신 결론 한 줄과 굵은 이름 목록으로 쓰게 함. 2026-10-23 사용자 "지금 그냥 줄글로 되있어서 복잡함").
// 대화형이고 /baton on으로 고른 세션에서만 켜는 것은 각 hook 첫 줄의 live($)/enter()가 맡는다(live.ts, entry.tsx).
// 한 플러그인은 같은 이벤트를 matcher 없이 두 번 등록할 수 없어서, 여러 mod가 쓰는 이벤트(session.start, turn.complete, prompt.submit)는 matcher를 붙여 등록한다.
export const register: Register = (on, options) => {
  registerBlocks(on)
  registerSide(on, options)
  registerAsks(on, options)
  registerDebate(on, options)
  registerEntry(on, options)
}
