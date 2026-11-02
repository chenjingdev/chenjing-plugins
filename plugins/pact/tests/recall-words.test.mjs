import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordPattern, overlapOf } from '../scripts/recall/sources/words.mjs';

test('wordPattern: 영문·숫자로 시작하거나 끝나는 낱말은 이웃에 영숫자가 붙으면 안 맞고, 한글은 부분 일치다', () => {
  assert.ok(wordPattern('pact').test('pact를 쓴다'));
  assert.ok(!wordPattern('pact').test('impact'));
  assert.ok(!wordPattern('pact').test('pact2'));
  assert.ok(wordPattern('선택지').test('선택지를 묻는다'));
  assert.ok(wordPattern('a.b').test('x a.b y'));
  assert.ok(!wordPattern('a.b').test('x axb y'));
});

test('overlapOf: 대소문자 없이 겹친 서로 다른 낱말 수를 세고, 백틱 안 조각은 건너뛴다', () => {
  assert.equal(overlapOf(['Pact', '선택지', 'pact'], 'PACT가 선택지를 묻는다'), 2);
  assert.equal(overlapOf(['pact', '선택지'], '`pact` 코드만 있고 선택지는 글에 있다'), 1);
  assert.equal(overlapOf(['pact'], '여러 줄\n`pact\n안`\n글'), 0);
  assert.equal(overlapOf(['없는낱말'], '아무 글'), 0);
});
