import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, renderBlocks, inline } from '../plugin/web/markdown.js';
import { planAnswer, renderPlan } from '../plugin/web/structure.js';
import { LONG_ANSWER } from './fixtures/transcript.mjs';

const html = (md) => renderBlocks(parseBlocks(md));
const text = (h) => h.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

test('모든 글자를 이스케이프한다', () => {
  const out = html('<script>alert(1)</script> & "따옴표"\n\n`<b>코드</b>`');
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(out.includes('<code>&lt;b&gt;코드&lt;/b&gt;</code>'));
});

test('링크는 http·mailto만 걸고, 파일 경로 링크는 이름만 보인다', () => {
  assert.match(inline('[문서](https://example.com/a?b=1&c=2)'), /<a href="https:\/\/example.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">문서<\/a>/);
  assert.ok(!inline('[x](javascript:alert(1))').includes('<a '));
  assert.match(inline('[reader.mjs](plugin/lib/reader.mjs:42)'), /<span class="file" title="plugin\/lib\/reader.mjs:42">reader.mjs<\/span>/);
  assert.match(inline('자세한 건 https://example.com/x 참고'), /<a href="https:\/\/example.com\/x"/);
});

test('강조는 코드 안에서 바뀌지 않는다', () => {
  assert.equal(inline('**굵게** 와 `**그대로**` 와 *기울임*'), '<strong>굵게</strong> 와 <code>**그대로**</code> 와 <em>기울임</em>');
  assert.equal(inline('5 * 3 = 15, __init__'), '5 * 3 = 15, __init__');
  assert.equal(inline('첫 줄\n둘째 줄'), '첫 줄<br>둘째 줄');
});

test('중첩 목록, 번호 시작값, 체크 목록, 빈 줄로 떨어진 항목', () => {
  const out = html('3. 셋째\n4. 넷째\n   - 하위 가\n   - 하위 나\n\n5. 다섯째\n\n- [x] 끝남\n- [ ] 남음');
  assert.match(out, /^<ol start="3"><li>셋째<\/li><li><p>넷째<\/p><ul><li>하위 가<\/li><li>하위 나<\/li><\/ul><\/li><li>다섯째<\/li><\/ol>/);
  assert.match(out, /<li class="task done"><span class="box" aria-label="완료"><\/span>끝남<\/li>/);
});

test('문단 안의 "2026. 9. 30" 같은 줄은 목록으로 끊지 않고, "- " 목록은 끊는다', () => {
  const blocks = parseBlocks('예약 날짜는\n2026. 1. 15 오후입니다.\n정리:\n- 첫째\n- 둘째');
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'list']);
  assert.equal(blocks[0].text, '예약 날짜는\n2026. 1. 15 오후입니다.\n정리:');
});

test('표(정렬·셀 안 파이프), 코드(언어), 인용, 가로줄', () => {
  const out = html('| 이름 | 값 |\n| :--- | ---: |\n| `a\\|b` | 3 |\n\n```js\nconst x = 1;\n```\n\n> 인용\n\n---');
  assert.match(out, /<th>이름<\/th><th class="right">값<\/th>/);
  assert.match(out, /<td><code>a\|b<\/code><\/td><td class="right">3<\/td>/);
  assert.match(out, /<pre class="code" data-lang="js"><code>const x = 1;<\/code><\/pre>/);
  assert.match(out, /<blockquote><p>인용<\/p><\/blockquote><hr>/);
});

test('짧은 답은 접지 않는다', () => {
  const plan = planAnswer('고쳤습니다.\n\n## 바꾼 것\n- 한 줄');
  assert.equal(plan.folded, false);
  assert.match(renderPlan(plan), /<section class="sec plain"><h3 class="sec-title">바꾼 것<\/h3>/);
});

test('긴 답: 결론은 펼치고 섹션은 접고, 끝의 질문과 선택지는 강조한다', () => {
  const plan = planAnswer(LONG_ANSWER);
  assert.equal(plan.folded, true);
  assert.deepEqual(plan.sections.map((s) => [s.title, s.open, s.hint]), [['바꾼 것', false, '2항목'], ['확인한 것', false, '표 2행 · 코드 1줄'], ['남은 일', false, '1문단']]);
  assert.deepEqual(plan.ask.map((b) => b.type), ['list', 'paragraph']);
  const out = renderPlan(plan);
  assert.match(out, /^<div class="lead"><p>설정 이전을 마쳤습니다\./);
  assert.match(out, /<details class="sec" data-sec="0"><summary><span class="sec-title">바꾼 것<\/span><span class="hint">2항목<\/span><\/summary>/);
  assert.match(out, /<div class="ask" role="note">.*<ol><li>문서 예시만 고치기<\/li>.*어느 쪽으로 할까요\?<\/p><\/div>$/s);
  // 사용자가 펼친 섹션은 그대로 둔다
  assert.match(renderPlan(plan, new Map([[1, true]])), /<details class="sec" data-sec="1" open>/);
});

test('제목으로 시작하는 긴 답은 첫 섹션을 펼친다', () => {
  const plan = planAnswer(`## 결론\n${'결론 문장입니다. '.repeat(80)}\n\n## 근거\n${'근거 문장입니다. '.repeat(90)}`);
  assert.deepEqual(plan.sections.map((s) => s.open), [true, false]);
});

test('문장 보존: 보이는 글에 원문의 모든 글자가 순서대로 남는다', () => {
  for (const md of [LONG_ANSWER, '네, 됩니다.\n\n진행할까요?', '**요약**\n두 가지를 바꿨습니다.\n\n- 가\n- 나']) {
    const shown = text(renderPlan(planAnswer(md))).replace(/답이 필요해요 · 터미널에서 답하세요/g, '').replace(/\d+항목|표 \d+행|코드 \d+줄|\d+문단/g, '');
    const strip = (s) => s.replace(/```\w*|\*\*|`|^#+\s|^\s*[-*]\s|^\s*\d+\.\s|^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$|\|/gm, '').replace(/\s+/g, '');
    let at = 0;
    const flat = shown.replace(/\s+/g, '');
    for (const ch of strip(md)) {
      const next = flat.indexOf(ch, at);
      assert.ok(next >= 0, `빠진 글자: ${ch} (원문: ${md.slice(0, 30)}…)`);
      at = next + 1;
    }
  }
});
