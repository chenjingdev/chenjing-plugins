import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSpec, lintSpec, setStatus, slugify, newSpecPath } from '../scripts/spec.mjs';
import { ensureRunDir } from '../scripts/paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'scripts', 'spec.mjs');

const GOOD = `---
pact: 1
topic: 출결
status: draft
created: 2026-10-10
---
# 출결
## 목적
교수자가 출석을 빨리 확인한다.
## 범위
웹 화면 하나.
## 하지 않는 것
출석 처리 자체.
## 기능
- F1 오늘 수업 출석 현황 보기 [사용자]
  - 케이스: 수업 0건 → 빈 상태 문구
## 공통 규칙
- R1 삭제 전 확인 팝업 [AI 가정]
## 구조 판정
## 확인 필요
## 결정 기록
`;

const tmp = () => mkdtempSync(path.join(tmpdir(), 'pact-spec-'));

test('parseSpec reads frontmatter, sections and tagged items', () => {
  const s = parseSpec(GOOD);
  assert.equal(s.frontmatter.status, 'draft');
  assert.equal(s.frontmatter.topic, '출결');
  assert.ok('기능' in s.sections && '공통 규칙' in s.sections);
  assert.deepEqual(
    s.items.map(({ id, tag, section }) => ({ id, tag, section })),
    [
      { id: 'F1', tag: '사용자', section: '기능' },
      { id: 'R1', tag: 'AI 가정', section: '공통 규칙' },
    ],
  );
  assert.match(s.items[0].text, /출석 현황/);
});

test('lintSpec passes a well-formed spec', () => {
  assert.deepEqual(lintSpec(GOOD), []);
});

test('lintSpec reports each hand-edit problem in Korean without throwing', () => {
  const bad = GOOD
    .replace('status: draft\n', '')
    .replace('- R1 삭제 전 확인 팝업 [AI 가정]', '- R1 삭제 전 확인 팝업\n- F3 엑셀 내보내기 [AI가정]');
  const problems = lintSpec(bad);
  assert.ok(problems.includes('status가 없습니다'), problems.join('|'));
  assert.ok(problems.includes('R1: 태그가 없습니다 ([사용자] 또는 [AI 가정])'), problems.join('|'));
  assert.ok(problems.includes('F3: 알 수 없는 태그 [AI가정]'), problems.join('|'));
});

test('lintSpec flags an invalid status and a missing 기능 section', () => {
  const p = lintSpec(GOOD.replace('status: draft', 'status: foo').replace('## 기능\n', '## 기능들\n'));
  assert.ok(p.includes('status 값이 잘못됐습니다: foo'), p.join('|'));
  assert.ok(p.includes('## 기능 섹션이 없습니다'), p.join('|'));
});

test('lintSpec on an empty string returns problems instead of throwing', () => {
  const p = lintSpec('');
  assert.ok(p.length > 0);
  assert.ok(p.includes('status가 없습니다'));
});

test('setStatus changes only the frontmatter status', () => {
  const out = setStatus(GOOD, 'approved');
  assert.equal(parseSpec(out).frontmatter.status, 'approved');
  assert.equal(out.replace('status: approved', 'status: draft'), GOOD);
  assert.throws(() => setStatus(GOOD, 'shipped'));
});

test('slugify keeps Korean, joins words with dashes, lowercases ASCII', () => {
  assert.equal(slugify('출결 대시보드 v2'), '출결-대시보드-v2');
  assert.equal(slugify('  A/B  test '), 'a-b-test');
});

test('newSpecPath does not overwrite an existing spec of the same day and topic', () => {
  const d = tmp();
  const first = newSpecPath(d, '출결', '2026-10-10');
  assert.equal(first, path.join(d, 'docs', 'pact', '2026-10-10-출결.md'));
  mkdirSync(path.dirname(first), { recursive: true });
  writeFileSync(first, 'x');
  assert.equal(newSpecPath(d, '출결', '2026-10-10'), path.join(d, 'docs', 'pact', '2026-10-10-출결-2.md'));
});

test('ensureRunDir creates .pact/<slug>/ with a self-ignoring .pact/.gitignore, idempotently', () => {
  const d = tmp();
  const run = ensureRunDir(d, '출결');
  assert.equal(run, path.join(d, '.pact', '출결'));
  assert.ok(existsSync(run));
  assert.equal(readFileSync(path.join(d, '.pact', '.gitignore'), 'utf8'), '*\n');
  assert.equal(ensureRunDir(d, '출결'), run);
});

test('CLI: new creates a spec from the template, lint and set-status work on it', () => {
  const d = tmp();
  const r = spawnSync('node', [CLI, 'new', d, '출결 대시보드'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const file = r.stdout.trim();
  assert.ok(file.endsWith('-출결-대시보드.md'), file);
  const text = readFileSync(file, 'utf8');
  assert.equal(parseSpec(text).frontmatter.topic, '출결 대시보드');
  assert.equal(parseSpec(text).frontmatter.status, 'draft');
  assert.match(text, /^# 출결 대시보드$/m);
  assert.equal(spawnSync('node', [CLI, 'status', file], { encoding: 'utf8' }).stdout.trim(), 'draft');
  assert.equal(spawnSync('node', [CLI, 'set-status', file, 'approved']).status, 0);
  assert.equal(spawnSync('node', [CLI, 'status', file], { encoding: 'utf8' }).stdout.trim(), 'approved');
  const bad = path.join(d, 'bad.md');
  writeFileSync(bad, GOOD.replace(' [사용자]', ''));
  const lint = spawnSync('node', [CLI, 'lint', bad], { encoding: 'utf8' });
  assert.equal(lint.status, 1);
  assert.match(lint.stdout, /F1: 태그가 없습니다/);
});
