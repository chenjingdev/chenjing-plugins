'use strict';
/*
 * salvo — composition validator (計-class, LLM=0)
 *
 * 융합/격리 법칙을 순수 코드로 강제한다. 이 파일은 forge의 안전 울타리 씨앗이며,
 * forge가 존재하기 전에 미리 만들어 둘 수 있다 — 규칙이 전부 기계적이기 때문.
 *
 * 한 줄 법칙: 측정에는 독립이 필요하고, 구성에는 연속이 허용된다.
 *   - 심사 원소(判/名/critique-索)가 같은 맥락에서 만든 자기 산출물을 심사 → 고착(거절)
 *   - 합의(quorum) 집계가 독립 사수 2명 미만에서 나옴 → 측정 아닌 짐작(거절)
 *
 * 워크플로우 표현 (분자):
 *   stages: [{
 *     id, element,            // 원소 기호 (아래 ELEMENTS)
 *     context,               // 맥락 그룹 — 같은 값 = 융합(한 세션/에이전트), 다른 값 = 격리
 *     produces?: artifactId, // 이 스테이지가 낳는 산출물
 *     input?: { artifact, mode: 'builds_on' | 'examines' },
 *                            //   builds_on = 앞 산출물 위에 쌓음(연속, 융합 안전)
 *                            //   examines  = 앞 산출물을 비판적으로 심사(측정, 독립 필요)
 *     fanout?: n,            // 독립 사수 수 (일제사격의 발수)
 *     aggregation?: { kind: 'union'|'quorum'|'argmax'|'identity', k? }
 *   }]
 */

const ELEMENTS = {
  '生': { key: 'generate',  fixationImmune: false }, // 낳기
  '索': { key: 'seek',      fixationImmune: false }, // 색출
  '判': { key: 'judge',     fixationImmune: false }, // 판정
  '名': { key: 'classify',  fixationImmune: false }, // 판별(라우팅)
  '換': { key: 'transform', fixationImmune: false }, // 변환
  '分': { key: 'split',     fixationImmune: false }, // 분할
  '計': { key: 'reckon',    fixationImmune: true  }, // 추적/장부 — LLM=0, 고착 면역
};

function validateWorkflow(wf) {
  const violations = [];
  const stages = wf.stages || [];

  // 산출물별 생산자 색인
  const producerOf = {};
  for (const s of stages) if (s.produces) producerOf[s.produces] = s;

  for (const s of stages) {
    // R1 — 표에 없는 원소는 거절 (forge가 여섯 번째 원소를 지어내는 것 차단)
    if (!ELEMENTS[s.element]) {
      violations.push({ code: 'unknown-element', stage: s.id,
        message: `원소 '${s.element}'는 표에 없음 (허용: ${Object.keys(ELEMENTS).join(' ')})` });
      continue;
    }

    // R2 — 자기참조 고착: 심사 원소가 같은 맥락에서 만든 자기 산출물을 examines
    if (s.input && s.input.mode === 'examines') {
      const P = producerOf[s.input.artifact];
      if (P && !ELEMENTS[P.element].fixationImmune && P.context === s.context) {
        violations.push({ code: 'fixation', stage: s.id,
          message: `자기참조 검증 — '${s.id}'(${s.element})가 같은 맥락 '${s.context}'에서 ` +
                   `'${P.id}'(${P.element})가 만든 '${s.input.artifact}'를 심사. 격리 필요` });
      }
      // 산출물이 워크플로우 밖(외부 문서)이면 P=undefined → 남의 것 심사라 안전
    }

    // R3 — 합의는 독립을 요구: quorum 집계는 독립 사수 ≥2, 그리고 ≥k
    const agg = s.aggregation;
    if (agg && (agg.kind === 'quorum' || agg.kind === 'consensus')) {
      const k = agg.k || 2;
      const n = s.fanout || 1;
      if (n < 2) {
        violations.push({ code: 'fake-independence', stage: s.id,
          message: `합의(k=${k})인데 독립 사수 ${n}명 — 한 발 쏜 걸 합의로 포장. 측정이 아니라 짐작` });
      } else if (n < k) {
        violations.push({ code: 'quorum-unreachable', stage: s.id,
          message: `정족수 k=${k}인데 사수 ${n}명 — 정족수 도달 불가` });
      }
    }

    // R4 — 바닥 원소 순수성: 計(장부)는 LLM=0이라 사수를 배정할 수 없다
    if (s.element === '計' && (s.fanout || 0) > 1) {
      violations.push({ code: 'substrate-fanout', stage: s.id,
        message: `計(장부)는 LLM=0 순수 코드인데 fanout ${s.fanout} 선언 — 사고 안 하는 원소에 사수 배정 불가` });
    }
  }

  return { ok: violations.length === 0, violations };
}

/* ------------------------------------------------------------------ *
 * 실측: 실존 무기 3종은 통과, 위반 2종은 거절해야 법칙이 현실에서 성립.
 * ------------------------------------------------------------------ */

const FIXTURES = [
  {
    expect: 'pass',
    note: 'spec-gate — 콜드 리더 3명이 외부 SPEC을 索+判(융합)으로 심사, 리더끼리 격리, 2표 합의',
    wf: { name: 'spec-gate', stages: [
      { id: 'read', element: '索', context: 'reader', fanout: 3,
        input: { artifact: 'SPEC', mode: 'examines' },      // SPEC은 외부 → 생산자 없음
        aggregation: { kind: 'quorum', k: 2 } },
    ]},
  },
  {
    expect: 'pass',
    note: 'sweep — 독립 파인더 2명이 외부 대상을 색출, 합집합',
    wf: { name: 'sweep', stages: [
      { id: 'find', element: '索', context: 'finder', fanout: 2,
        input: { artifact: 'TARGET', mode: 'examines' },
        aggregation: { kind: 'union' } },
    ]},
  },
  {
    expect: 'pass',
    note: 'vet — 저자(author)가 초안 생성, 검증자(validator) 3명이 격리된 맥락에서 초안을 심사, 2표 합의',
    wf: { name: 'vet', stages: [
      { id: 'draft',    element: '生', context: 'author',    produces: 'DRAFT' },
      { id: 'validate', element: '判', context: 'validator', fanout: 3,
        input: { artifact: 'DRAFT', mode: 'examines' },      // author ≠ validator → 독립
        aggregation: { kind: 'quorum', k: 2 } },
    ]},
  },
  {
    expect: 'reject',
    note: '자기-vet (나쁜 예) — 한 세션이 초안을 만들고 그 자리에서 자기가 검증',
    wf: { name: 'self-vet(BAD)', stages: [
      { id: 'draft', element: '生', context: 'solo', produces: 'DRAFT' },
      { id: 'check', element: '判', context: 'solo',           // 같은 맥락!
        input: { artifact: 'DRAFT', mode: 'examines' },
        aggregation: { kind: 'identity' } },
    ]},
  },
  {
    expect: 'reject',
    note: '가짜 합의 (나쁜 예) — 사수 1명인데 2표 합의라 우김',
    wf: { name: 'fake-consensus(BAD)', stages: [
      { id: 'judge', element: '判', context: 'one', fanout: 1,
        input: { artifact: 'X', mode: 'examines' },
        aggregation: { kind: 'quorum', k: 2 } },
    ]},
  },
];

function main() {
  let allGood = true;
  console.log('\nsalvo 합성 검증 — 융합/격리 법칙 실측\n' + '='.repeat(58));
  for (const f of FIXTURES) {
    const r = validateWorkflow(f.wf);
    const got = r.ok ? 'pass' : 'reject';
    const pass = got === f.expect;
    allGood = allGood && pass;
    console.log(`\n${pass ? '✓' : '✗ 법칙 불일치!'}  [${got.toUpperCase()}] ${f.wf.name}  (기대: ${f.expect})`);
    console.log(`   ${f.note}`);
    for (const v of r.violations) console.log(`   └─ ⛔ ${v.code}: ${v.message}`);
  }
  console.log('\n' + '='.repeat(58));
  console.log(allGood
    ? '결론: 법칙이 현실과 일치 — 실존 무기 3종 통과, 위반 2종 거절.\n'
    : '결론: 법칙과 현실 불일치 — 규칙 재검토 필요.\n');
  process.exit(allGood ? 0 : 1);
}

if (require.main === module) main();
module.exports = { validateWorkflow, ELEMENTS };
