// vet-verify 엔진 스모크 테스트 — 하네스 밖에서 전역(agent/parallel/…)을 스텁해 실행한다.
// 실행: node plugins/vet/tests/engine.test.mjs
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = await readFile(join(here, '..', 'skills', 'vet', 'engine.js'), 'utf8')
const body = src.replace(/^export const meta =/m, 'const meta =')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

async function run(argsValue, agentImpl) {
  const calls = []
  const agent = async (prompt, opts) => { calls.push({ prompt, opts }); return agentImpl(prompt, opts, calls.length) }
  const parallel = (thunks) => Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null)))
  const noop = () => {}
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'log', 'phase', 'budget', 'workflow', body)
  const result = await fn(argsValue, agent, parallel, noop, noop, { total: null, spent: () => 0, remaining: () => Infinity }, noop)
  return { result, calls }
}

const DRAFT = '- C-1 주장 하나\n- C-2 주장 둘\n- C-3 주장 셋'
const rb = (anchor, category, evidence = '근거') => ({ anchor, category, evidence })

// 1) FR-014: 같은 앵커+카테고리 2표 = 확정, 나머지는 정보성. 같은 앵커·다른 카테고리는 별개.
{
  const perLens = [
    { rebuttals: [rb('C-1', 'fact-error'), rb('C-2', 'logic-flaw')] },
    { rebuttals: [rb('C-1', 'fact-error')] },
    { rebuttals: [rb('C-1', 'logic-flaw')] },
  ]
  let i = 0
  const { result, calls } = await run({ question: 'q', draft: DRAFT }, () => perLens[i++])
  assert.equal(result.unverified, false)
  assert.equal(calls.length, 3)
  assert.equal(result.confirmed.length, 1)
  assert.equal(result.confirmed[0].anchor, 'C-1')
  assert.equal(result.confirmed[0].category, 'fact-error')
  assert.equal(result.confirmed[0].votes, 2)
  assert.equal(result.informational.length, 2)
  // D-12/D-13: 모든 호출이 opus 고정
  for (const c of calls) assert.equal(c.opts.model, 'opus')
  // FR-013: 초안 인라인 전달
  for (const c of calls) assert.ok(c.prompt.includes('C-2 주장 둘'))
}

// 2) FR-017 전반: 검증자 1명 첫 시도 실패 → 그 검증자만 1회 재시도 → 성공
{
  let failedOnce = false
  const { result, calls } = await run({ question: 'q', draft: DRAFT }, (p, opts) => {
    if (opts.label.startsWith('verify:logic') && !failedOnce) { failedOnce = true; return null }
    return { rebuttals: [] }
  })
  assert.equal(result.unverified, false)
  assert.equal(calls.length, 4) // 3 + 실패분 재시도 1 (전체 재실행 아님)
  assert.equal(result.stats.validatorCalls, 4)
}

// 3) FR-017 후반 / I-7: 재시도 후에도 실패 → unverified, 부분 집계 금지
{
  const { result } = await run({ question: 'q', draft: DRAFT }, (p, opts) =>
    opts.label.startsWith('verify:intent') ? null : { rebuttals: [rb('C-1', 'fact-error')] })
  assert.equal(result.unverified, true)
  assert.deepEqual(result.failedLenses, ['intent'])
  assert.equal(result.confirmed.length, 0)
  assert.equal(result.informational.length, 0)
}

// 4) 방어: 초안에 없는 앵커는 격리, 같은 검증자의 같은 (앵커,카테고리) 중복 제기는 1표
{
  const perLens = [
    { rebuttals: [rb('C-9', 'fact-error')] },
    { rebuttals: [rb('C-1', 'fact-error'), rb('C-1', 'fact-error')] },
    { rebuttals: [rb('C-1', 'fact-error')] },
  ]
  let i = 0
  const { result } = await run({ question: 'q', draft: DRAFT }, () => perLens[i++])
  assert.equal(result.confirmed.length, 1)
  assert.equal(result.confirmed[0].votes, 2)
  assert.equal(result.invalidAnchors.length, 1)
}

// 5) 입력 계약: 앵커 없는 초안·빈 입력은 error 반환
{
  const { result: r1 } = await run({ question: 'q', draft: '앵커가 하나도 없는 초안' }, () => ({ rebuttals: [] }))
  assert.ok(r1.error)
  const { result: r2 } = await run({ question: '', draft: DRAFT }, () => ({ rebuttals: [] }))
  assert.ok(r2.error)
}

// 6) I-7 방어: 형식 깨진 보고({} — rebuttals 배열 부재)는 실패로 정규화 → 재시도→unverified 경로.
{
  // 6a) intent가 최초+재시도 모두 형식 깨진 보고 → unverified, 부분 집계 없음
  const { result } = await run({ question: 'q', draft: DRAFT }, (p, opts) =>
    opts.label.startsWith('verify:intent') ? {} : { rebuttals: [rb('C-1', 'fact-error')] })
  assert.equal(result.unverified, true)
  assert.deepEqual(result.failedLenses, ['intent'])
  assert.equal(result.confirmed.length, 0)
  assert.equal(result.informational.length, 0)

  // 6b) logic이 최초만 형식 깨진 보고, 재시도는 정상 → unverified 아님, 총 4회 호출
  let malformedOnce = false
  const { result: r2, calls } = await run({ question: 'q', draft: DRAFT }, (p, opts) => {
    if (opts.label.startsWith('verify:logic') && !malformedOnce) { malformedOnce = true; return {} }
    return { rebuttals: [] }
  })
  assert.equal(r2.unverified, false)
  assert.equal(calls.length, 4)
  assert.equal(r2.stats.validatorCalls, 4)
}

console.log('engine.test.mjs: 6/6 통과')
