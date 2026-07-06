export const meta = {
  name: 'vet-verify',
  description: 'vet /vet 답변 게이트 엔진 — C-n 앵커 초안을 렌즈 분산 검증자 3명(opus 고정)이 병렬 검증하고, 순수 코드가 (앵커+카테고리) 2표 합의만 확정 반박으로 집계한다. Args: {question, draft, round}',
  whenToUse: '/vet 스킬이 검증(round 1)·재검증(round 2)에 호출한다. 초안의 각 원자 주장에 C-n 앵커가 있어야 한다.',
  phases: [{ title: 'Verify', detail: '렌즈 3검증자 병렬 (opus/high 고정, 실패분만 재시도 1회)' }],
}

// vet-verify: C-n 초안 → 렌즈 3검증자 병렬(schema 강제) → 순수 코드 2표 집계.
// 계약 (specs/001-vet-v1/spec.md):
//   FR-012 검증자 정확히 3명, 렌즈 A 전제·사실 / B 논리·반례 / C 의도 부합
//   FR-013 세 렌즈 공유 카테고리 enum + C-n 앵커 필수 · 초안 인라인 전달 ·
//          저장소 읽기 전용, 웹 배제 (2026-07-07 사용자 결정 — gate-report 에스컬레이션 기록)
//   FR-014 확정 = 같은 앵커 AND 같은 카테고리에 서로 다른 검증자 2표 이상, LLM 심판 금지
//   FR-017 실패 검증자만 1회 재시도 → 그래도 실패면 부분 집계 없이 unverified 반환
//   D-12/D-13 모든 agent() 호출에 model 명시(opus) — 세션 모델 상속 금지

let A = args || {}
if (typeof A === 'string') {
  const s = A.trim()
  let parsed = null
  if (s.startsWith('{')) { try { parsed = JSON.parse(s) } catch {} }
  A = (parsed && typeof parsed === 'object') ? parsed : {}
}
const QUESTION = (A.question || '').trim()
const DRAFT = (A.draft || '').trim()
const ROUND = A.round === 2 ? 2 : 1

if (!QUESTION || !DRAFT) {
  return { error: 'question과 draft가 모두 필요하다 — /vet 스킬이 {question, draft, round}로 호출한다.' }
}
if (DRAFT.length > 40000) {
  return { error: '초안이 너무 크다(40k자 초과). 질문을 좁혀 초안을 축소한 뒤 다시 호출하라.' }
}
const ANCHORS = [...new Set(DRAFT.match(/\bC-\d+\b/g) || [])]
if (ANCHORS.length === 0) {
  return { error: '초안에 C-n 앵커가 없다. 각 원자 주장에 C-1, C-2… 앵커를 붙여 다시 호출하라.' }
}

const CATEGORIES = ['fact-error', 'premise-error', 'logic-flaw', 'intent-mismatch', 'unsupported']
const VERDICT_SCHEMA = {
  type: 'object', required: ['rebuttals'],
  properties: {
    rebuttals: { type: 'array', maxItems: 10, items: {
      type: 'object', required: ['anchor', 'category', 'evidence'],
      properties: {
        anchor: { type: 'string', pattern: '^C-[0-9]+$' },
        category: { enum: CATEGORIES },
        evidence: { type: 'string' },
      },
    }},
  },
}

const LENSES = [
  { key: 'fact', title: '렌즈 A — 전제·사실', focus: '초안의 사실 주장과 전제가 실측과 일치하는가. 저장소 파일을 Read/Grep/Glob으로 직접 열어 대조하라. 저장소로 확인 불가능한 외부 사실의 무근거 단정은 unsupported로 표시하라.' },
  { key: 'logic', title: '렌즈 B — 논리·반례', focus: '주장 사이의 추론이 타당한가, 반례가 존재하는가. 숨은 전제 오류(premise-error)와 비약·과잉 일반화(logic-flaw)를 찾아라.' },
  { key: 'intent', title: '렌즈 C — 의도 부합', focus: '초안이 질문이 실제로 묻는 것에 답하는가. 질문 재해석 오류·초점 이탈·묻지 않은 것에 대한 답변(intent-mismatch)을 찾아라.' },
]

const PROMPT = (lens) =>
  '## vet 검증자 — ' + lens.title + ' (라운드 ' + ROUND + ')\n\n' +
  '아래는 사용자 질문과, 세션이 작성한 답변 초안이다. 너의 렌즈로 초안을 검증하라.\n' +
  '렌즈: ' + lens.focus + '\n\n' +
  '## 질문\n' + QUESTION + '\n\n' +
  '## 초안 (원자 주장마다 C-n 앵커)\n' + DRAFT + '\n\n' +
  '## 규칙\n' +
  '- 반박 카테고리(세 렌즈 공용): fact-error(실측과 모순) / premise-error(숨은 전제가 틀림) / logic-flaw(추론 결함·반례) / intent-mismatch(질문이 묻는 것과 불일치) / unsupported(근거 없는 단정). 렌즈는 주의 초점일 뿐, 발견한 반박은 어느 카테고리로든 낼 수 있다.\n' +
  '- 모든 반박은 초안에 실재하는 C-n 앵커 하나를 지목해야 한다. 앵커 없는 일반론은 내지 마라.\n' +
  '- 도구는 저장소 읽기(Read/Grep/Glob)만 사용하라. 웹 검색·페이지 가져오기·파일 쓰기·명령 실행은 금지다.\n' +
  '- evidence는 구체적으로: 실측 반박이면 파일:라인, 논리 반박이면 반례를 명시하라.\n' +
  '- 확실한 반박만 내라 — 문체·취향·사소한 표현 차이는 반박이 아니다. 반박이 없으면 빈 배열을 반환하라.\n\n' +
  'Structured output only.'

phase('Verify')
log('vet r' + ROUND + ': 앵커 ' + ANCHORS.length + '개, 검증자 3명(opus) 스폰')

const spawn = (lens) => agent(PROMPT(lens), {
  label: 'verify:' + lens.key + ':r' + ROUND,
  phase: 'Verify',
  schema: VERDICT_SCHEMA,
  model: 'opus',
  effort: 'high',
})

let reports = await parallel(LENSES.map(l => () => spawn(l)))
let validatorCalls = 3

// FR-017: 실패한 검증자만 1회 재시도 (전체 재실행 아님)
const failedIdx = reports.map((r, i) => (r ? -1 : i)).filter(i => i >= 0)
if (failedIdx.length > 0) {
  log('검증자 재시도: ' + failedIdx.map(i => LENSES[i].key).join(', '))
  const retries = await parallel(failedIdx.map(i => () => spawn(LENSES[i])))
  failedIdx.forEach((idx, j) => { reports[idx] = retries[j] })
  validatorCalls += failedIdx.length
}

const failedLenses = LENSES.filter((l, i) => !reports[i]).map(l => l.key)
if (failedLenses.length > 0) {
  // I-7: 부분 집계 금지 — 합의 기준이 라운드마다 변동하지 않도록 전체를 미검증 처리
  log('검증 미완료: ' + failedLenses.join(', ') + ' — 부분 집계 없이 반환')
  return {
    round: ROUND, unverified: true, failedLenses,
    confirmed: [], informational: [],
    stats: { validatorCalls, model: 'opus/high' },
  }
}

// ─── 순수 코드 집계 (FR-014 — LLM 심판 금지) ───
const invalidAnchors = []
const votes = new Map() // 'C-n|category' → {anchor, category, voters: [], evidence: []}
reports.forEach((rep, i) => {
  const lens = LENSES[i].key
  const seenKeys = new Set() // 같은 검증자의 같은 (앵커,카테고리) 중복 제기는 1표
  for (const r of rep.rebuttals) {
    if (!ANCHORS.includes(r.anchor)) { invalidAnchors.push({ lens, ...r }); continue }
    const key = r.anchor + '|' + r.category
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    if (!votes.has(key)) votes.set(key, { anchor: r.anchor, category: r.category, voters: [], evidence: [] })
    const v = votes.get(key)
    v.voters.push(lens)
    v.evidence.push({ lens, evidence: r.evidence })
  }
})

const anchorNum = a => parseInt(a.slice(2), 10)
const all = [...votes.values()]
  .map(v => ({ anchor: v.anchor, category: v.category, votes: v.voters.length, voters: v.voters, evidence: v.evidence }))
  .sort((a, b) => anchorNum(a.anchor) - anchorNum(b.anchor))
const confirmed = all.filter(v => v.votes >= 2)
const informational = all.filter(v => v.votes < 2)

log('집계 r' + ROUND + ': 반박 ' + all.length + '건 → 확정 ' + confirmed.length + ' · 정보성 ' + informational.length +
  (invalidAnchors.length ? ' · 무효 앵커 ' + invalidAnchors.length : ''))

return {
  round: ROUND, unverified: false,
  confirmed, informational, invalidAnchors,
  anchorsInDraft: ANCHORS.length,
  stats: { validatorCalls, model: 'opus/high' },
}
