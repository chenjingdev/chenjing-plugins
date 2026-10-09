import type { Register } from 'claude-code'

import { registerBlocks } from './answer-blocks'
import { registerDebate } from './debate'
import { registerMods } from './mods'
import { registerAsks } from './open-asks'
import { registerSide } from './side-panel'

// 네 mod를 한 플러그인으로 묶는다: answer-blocks(답 형식), open-asks(내 차례 모으기), side-panel(옆 패널), debate(토론).
// 엔진은 register.tsx가 바뀌어야 다시 불러온다: 다른 파일만 고쳤으면 이 파일도 건드린다(0.6.0, /debate만 치면 지금 대화에서 주제를 고름·패널 버튼·/mods 안내(on·off 말고는 모두 도움말)·지운 항목은 다시 불러오거나 resume해도 지운 채·토론 기본 10라운드).
// 대화형이고 /mods on으로 고른 세션에서만 켜는 것은 각 hook 첫 줄의 live($)/enter()가 맡는다(live.ts, mods.tsx).
// 한 플러그인은 같은 이벤트를 matcher 없이 두 번 등록할 수 없어서, 여러 mod가 쓰는 이벤트(session.start, turn.complete, prompt.submit)는 matcher를 붙여 등록한다.
export const register: Register = (on, options) => {
  registerBlocks(on)
  registerSide(on, options)
  registerAsks(on, options)
  registerDebate(on, options)
  registerMods(on, options)
}
