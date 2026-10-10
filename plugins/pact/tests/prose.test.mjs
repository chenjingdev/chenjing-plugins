// 프롬프트 파일(스킬, 에이전트)은 TDD 대신 쓴 뒤에 이 정적 검사로 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : [];
  });
const PROSE = [...walk(path.join(ROOT, 'skills')), ...walk(path.join(ROOT, 'agents'))];
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const rel = (p) => path.relative(ROOT, p);

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const out = {};
  for (const line of (m?.[1] ?? '').split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

const FORBIDDEN = [
  '1%', 'MUST', 'not negotiable', 'Delete it', 'Iron Law', 'No exceptions', 'letter of the rules',
  /\blying\b/, '반드시 스킬', '예외 없이',
];

test('no forbidden phrasing anywhere in skills or agents', () => {
  for (const file of PROSE) {
    const text = readFileSync(file, 'utf8');
    for (const f of FORBIDDEN) {
      const hit = typeof f === 'string' ? text.includes(f) : f.test(text);
      assert.ok(!hit, `${rel(file)} contains ${f}`);
    }
  }
});

test('no calls into other plugins', () => {
  for (const file of PROSE) {
    const text = readFileSync(file, 'utf8');
    for (const ns of ['superpowers:', 'tiers:', 'proto:']) assert.ok(!text.includes(ns), `${rel(file)} contains ${ns}`);
  }
});

const AGENTS = ['spec-checker', 'worker', 'reviewer', 'verifier'];

test('every agent has name, description and model', () => {
  for (const a of AGENTS) {
    const fm = frontmatter(read(`agents/${a}.md`));
    assert.equal(fm.name, a);
    assert.ok(fm.description, `${a} description`);
    assert.ok(fm.model, `${a} model`);
  }
});

test('spec-checker and reviewer are read-only opus agents; worker and verifier run on sonnet', () => {
  for (const a of ['spec-checker', 'reviewer']) {
    const fm = frontmatter(read(`agents/${a}.md`));
    assert.equal(fm.model, 'opus');
    assert.match(fm.disallowedTools ?? '', /\bEdit\b/);
    assert.match(fm.disallowedTools ?? '', /\bWrite\b/);
  }
  for (const a of ['worker', 'verifier']) assert.equal(frontmatter(read(`agents/${a}.md`)).model, 'sonnet');
  assert.equal(frontmatter(read('agents/verifier.md')).disallowedTools, 'Agent');
});

test('spec-checker ends with the one-round line', () => {
  const lines = read('agents/spec-checker.md').trimEnd().split('\n');
  assert.equal(lines.at(-1), '질문 라운드는 이것 한 번뿐입니다.');
});

test('worker reports with DONE_WITH_CONCERNS and Ruling lines', () => {
  const text = read('agents/worker.md');
  assert.ok(text.includes('DONE_WITH_CONCERNS'));
  assert.ok(text.includes('Ruling:'));
  assert.ok(text.includes('Ruling: <무엇을 정했나> — <왜> — <틀리면 무엇을 잃나>'));
});

test('verifier writes results.json with scenario kinds including newcomer', () => {
  const text = read('agents/verifier.md');
  assert.ok(text.includes('"kind"'));
  assert.ok(text.includes('newcomer'));
  assert.ok(text.includes('results.json'));
});
