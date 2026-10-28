import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSpec, lintSpec, riskUnits, explainError, setStatus, slugify, newSpecPath, specRunDir } from '../scripts/spec.mjs';
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
  assert.equal(parseSpec(text).frontmatter.pact, '2', '0.6.0이 만드는 명세는 pact: 2로 시작한다');
  assert.match(text, /^# 출결 대시보드$/m);
  assert.equal(spawnSync('node', [CLI, 'status', file], { encoding: 'utf8' }).stdout.trim(), 'draft');
  // approved·building은 승인 기록이 있어야 바뀐다(test/approval.test.mjs). 그 밖의 status는 그대로 바꾼다
  assert.equal(spawnSync('node', [CLI, 'set-status', file, 'approved']).status, 1);
  assert.equal(spawnSync('node', [CLI, 'status', file], { encoding: 'utf8' }).stdout.trim(), 'draft');
  assert.equal(spawnSync('node', [CLI, 'set-status', file, 'verifying']).status, 0);
  assert.equal(spawnSync('node', [CLI, 'status', file], { encoding: 'utf8' }).stdout.trim(), 'verifying');
  const bad = path.join(d, 'bad.md');
  writeFileSync(bad, GOOD.replace(' [사용자]', ''));
  const lint = spawnSync('node', [CLI, 'lint', bad], { encoding: 'utf8' });
  assert.equal(lint.status, 1);
  assert.match(lint.stdout, /F1: 태그가 없습니다/);
});

test('CLI: run-dir preserves the complete spec basename and creates it', () => {
  const d = tmp();
  const file = spawnSync('node', [CLI, 'new', d, '출결 대시보드'], { encoding: 'utf8' }).stdout.trim();
  const r = spawnSync('node', [CLI, 'run-dir', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), path.join(d, '.pact', path.basename(file, '.md')));
  assert.ok(existsSync(path.join(d, '.pact', '.gitignore')));
});

test('lintSpec catches unnumbered items, duplicate ids and a missing 공통 규칙 section', () => {
  const p = lintSpec(GOOD.replace('- F1 오늘', '- F1 오늘').replace('## 공통 규칙\n- R1 삭제 전 확인 팝업 [AI 가정]\n', '- 로그인 화면 [사용자]\n- F1 중복 [사용자]\n'));
  assert.ok(p.includes('번호가 없는 항목: 로그인 화면 [사용자] (F<n> 또는 R<n>을 붙이세요)'), p.join('|'));
  assert.ok(p.includes('F1: 번호가 겹칩니다'), p.join('|'));
  assert.ok(p.includes('## 공통 규칙 섹션이 없습니다'), p.join('|'));
});

test('a tag may carry its source after a colon', () => {
  const s = GOOD.replace('[사용자]', '[사용자: 10/8 회의]');
  assert.deepEqual(lintSpec(s), []);
  assert.equal(parseSpec(s).items[0].tag, '사용자');
  assert.ok(lintSpec(GOOD.replace('[사용자]', '[사용자 10/8]')).some((x) => x.startsWith('F1: 알 수 없는 태그')));
});

test('lintSpec flags an untouched template and isTemplate tells an abandoned draft', async () => {
  const { isTemplate } = await import('../scripts/spec.mjs');
  const d = tmp();
  const file = spawnSync('node', [CLI, 'new', d, '회의'], { encoding: 'utf8' }).stdout.trim();
  const text = readFileSync(file, 'utf8');
  assert.ok(lintSpec(text).includes('아직 틀 그대로입니다: F1'), lintSpec(text).join('|'));
  assert.equal(isTemplate(text), true);
  assert.equal(isTemplate(GOOD), false);
});

test('CLI: run-dir of a same-day duplicate spec gets its own -2 folder', () => {
  const d = tmp();
  spawnSync('node', [CLI, 'new', d, '출결']);
  const second = spawnSync('node', [CLI, 'new', d, '출결'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(second.endsWith('-출결-2.md'), second);
  assert.equal(spawnSync('node', [CLI, 'run-dir', second], { encoding: 'utf8' }).stdout.trim(), path.join(d, '.pact', path.basename(second, '.md')));
});

test('different dates for the same topic have independent run directories', () => {
  const d = tmp();
  const first = path.join(d, 'docs', 'pact', '2026-10-10-출결.md');
  const second = path.join(d, 'docs', 'pact', '2026-10-11-출결.md');
  const firstRun = specRunDir(first);
  writeFileSync(path.join(firstRun, 'results.json'), 'first run');
  const secondRun = specRunDir(second);
  assert.notEqual(firstRun, secondRun);
  assert.equal(firstRun, path.join(d, '.pact', '2026-10-10-출결'));
  assert.equal(secondRun, path.join(d, '.pact', '2026-10-11-출결'));
  assert.equal(readFileSync(path.join(firstRun, 'results.json'), 'utf8'), 'first run');
  assert.equal(existsSync(path.join(secondRun, 'results.json')), false);
});

test('completed legacy artifacts stay untouched while a dated run is created', () => {
  const d = tmp();
  const legacy = ensureRunDir(d, '출결');
  writeFileSync(path.join(legacy, 'report.html'), 'old report');
  const run = specRunDir(path.join(d, 'docs', 'pact', '2026-10-11-출결.md'));
  assert.equal(run, path.join(d, '.pact', '2026-10-11-출결'));
  assert.equal(readFileSync(path.join(legacy, 'report.html'), 'utf8'), 'old report');
});

test('CLI refuses an unverified legacy worktree without reusing or moving it', () => {
  const d = tmp();
  const legacy = ensureRunDir(d, '출결');
  mkdirSync(path.join(legacy, 'wt'));
  writeFileSync(path.join(legacy, 'wt', 'keep.txt'), 'legacy source');
  const spec = path.join(d, 'docs', 'pact', '2026-10-11-출결.md');
  const r = spawnSync('node', [CLI, 'run-dir', spec], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /기존.*작업 공간/);
  assert.ok(r.stderr.includes(path.join(legacy, 'wt')));
  assert.match(r.stderr, /원래 명세/);
  assert.equal(readFileSync(path.join(legacy, 'wt', 'keep.txt'), 'utf8'), 'legacy source');
  assert.equal(existsSync(path.join(d, '.pact', '2026-10-11-출결')), false);
});

// ---------- 위험 표시 [위험: …]와 태그 읽기 ----------

const withF1 = (line) => GOOD.replace('- F1 오늘 수업 출석 현황 보기 [사용자]', line);

test('a risk mark before the tag is not read as the tag: [위험: 지우기] [사용자]', () => {
  const spec = withF1('- F1 지난 수업 기록 비우기 [위험: 지우기] [사용자]');
  assert.deepEqual(lintSpec(spec), []);
  const [f1] = parseSpec(spec).items;
  assert.equal(f1.tag, '사용자');
  assert.equal(f1.rawTag, '사용자');
  assert.equal(f1.risk, '지우기');
  assert.equal(f1.text, '지난 수업 기록 비우기');
  // 태그 뒤에 와도 읽고, 값이 없는 표시와 여러 표시도 읽는다
  for (const [line, risk] of [
    ['- F1 지난 수업 기록 비우기 [사용자] [위험: 지우기]', '지우기'],
    ['- F1 지난 수업 기록 비우기 [위험] [사용자]', ''],
    ['- F1 지난 수업 기록 비우기 [위험: 지우기] [위험: 공개] [사용자]', '지우기, 공개'],
    ['- F1 지난 수업 기록 비우기 [위험：지우기] [사용자]', '지우기'],
  ]) {
    const item = parseSpec(withF1(line)).items[0];
    assert.equal(item.tag, '사용자', line);
    assert.equal(item.risk, risk, line);
    assert.equal(item.text, '지난 수업 기록 비우기', line);
    assert.deepEqual(lintSpec(withF1(line)), [], line);
  }
  // 표시가 없는 줄의 risk는 null이다
  assert.equal(parseSpec(GOOD).items[0].risk, null);
});

test('tags that carry a source or a review number are accepted, with or without a risk mark', () => {
  for (const line of [
    '- F1 오늘 수업 출석 현황 보기 [사용자: 검수 1]',
    '- F1 오늘 수업 출석 현황 보기 [AI 가정: 검수 2 맡김]',
    '- F1 오늘 수업 출석 현황 보기 [위험: 공개] [사용자: 검수 1]',
    '- F1 오늘 수업 출석 현황 보기 — 이유 [위험: 비용] [AI 가정: 검수 2 맡김]',
  ]) {
    assert.deepEqual(lintSpec(withF1(line)), [], line);
  }
  assert.equal(parseSpec(withF1('- F1 보기 [사용자: 검수 1]')).items[0].tag, '사용자');
  assert.equal(parseSpec(withF1('- F1 보기 [위험: 공개] [AI 가정: 검수 2 맡김]')).items[0].tag, 'AI 가정');
});

test('a risk mark alone is not a tag, a word that only starts like the mark is an unknown tag, and other brackets stay in the text', () => {
  assert.ok(lintSpec(withF1('- F1 기록 비우기 [위험: 지우기]')).includes('F1: 태그가 없습니다 ([사용자] 또는 [AI 가정])'));
  assert.ok(lintSpec(withF1('- F1 기록 비우기 [위험 지우기]')).includes('F1: 태그가 없습니다 ([사용자] 또는 [AI 가정])'), '콜론이 빠진 표시도 표시다: 태그가 아니다');
  // 한글이 이어지면 표시가 아니라 다른 말이다: 맨 뒤에 오면 알 수 없는 태그
  for (const word of ['위험성 높음', '위험한 작업', '위험요소']) {
    assert.ok(lintSpec(withF1(`- F1 기록 비우기 [사용자] [${word}]`)).includes(`F1: 알 수 없는 태그 [${word}]`), word);
  }
  const item = parseSpec(withF1('- F1 목록 [초안] 보기 [위험: 공개] [사용자]')).items[0];
  assert.equal(item.text, '목록 [초안] 보기');
  assert.equal(item.tag, '사용자');
});

test('a mark with its colon left out is still a mark, so a typo cannot make a risk item look safe: [위험 지우기], [위험-지우기]', () => {
  for (const [line, risk] of [
    ['- F1 지난 수업 기록 비우기 [위험 지우기] [사용자]', '지우기'],
    ['- F1 지난 수업 기록 비우기 [위험-지우기] [사용자]', '지우기'],
    ['- F1 지난 수업 기록 비우기 [위험/공개] [사용자]', '공개'],
    ['- F1 지난 수업 기록 비우기 [위험, 비용] [AI 가정]', '비용'],
    ['- F1 지난 수업 기록 비우기 [사용자] [위험 지우기]', '지우기'],
    ['- F1 지난 수업 기록 비우기 [위험!] [사용자]', '!'],
    ['- F1 지난 수업 기록 비우기 [ 위험 : 지우기 ] [사용자]', '지우기'],
  ]) {
    const spec = withF1(line);
    const [f1] = parseSpec(spec).items;
    assert.equal(f1.risk, risk, line);
    assert.equal(f1.text, '지난 수업 기록 비우기', line);
    assert.ok(['사용자', 'AI 가정'].includes(f1.tag), `${line}: 표시가 태그로 읽히지 않는다`);
    assert.deepEqual(lintSpec(spec), [], line);
    assert.equal(riskUnits(spec)[0].marked, true, `${line}: 위험 항목으로 읽힌다`);
  }
  // 줄 가운데나 케이스 줄에 있어도 그 항목의 표시다
  assert.equal(riskUnits(withF1('- F1 [위험 지우기] 지난 기록 비우기 [사용자]'))[0].marked, true);
  assert.equal(riskUnits(withF1('- F1 지난 기록 정리 [사용자]\n  - 케이스: 오래된 것 → 비움 [위험-지우기]'))[0].marked, true);
  // 표시가 아닌 말은 표시로 읽지 않는다
  for (const word of ['위험성 높음', '위험한 작업', '위험요소']) {
    assert.equal(riskUnits(withF1(`- F1 지난 기록 정리 [${word}] [사용자]`))[0].marked, false, word);
  }
});

// ---------- 위험 항목 찾기: F·R 줄과 그 케이스(접힌 칸 포함). 낱말로는 찾지 않는다 ----------

const RISKY = `---
pact: 2
topic: 정리
status: draft
---
# 정리
## 목적
기록을 삭제하지 않고 공개하지 않는다 (목적 줄은 보지 않는다)
## 범위
배포 push 결제 [위험: 비용] (범위도 보지 않는다)
## 하지 않는 것
- 유료 기능은 만들지 않는다 [위험: 비용]
## 기능
- F1 오늘 수업 출석 현황 보기 [사용자]
  - 케이스: 삭제 요청이 오면 → 확인 팝업
- F2 지난 학기 자료 비우기 [위험: 지우기] [사용자]
- F3 학생에게 결과 메일 보내기 [사용자]
  - 케이스: 주소가 틀림 → 보내지 않고 알림 [위험-공개]
## 공통 규칙
- R1 같은 이름의 파일은 덮어쓰기 전에 묻는다 [AI 가정]
- R2 출석 기록은 학기 동안 보관한다 [AI 가정]

<details><summary>그 밖의 AI 가정 2개</summary>

- R3 임시 파일은 제거한다 [위험: 지우기] [AI 가정]
  - 케이스: 실패하면 → 다시 push 한다
- R4 화면 문구는 한국어 [AI 가정]
  - 케이스: 글자가 넘침 → 말줄임 [위험 비용]

</details>

## 구조 판정
## 확인 필요
## 결정 기록
`;

test('riskUnits reads F and R lines with their cases and the folded ones, and nothing from 목적·범위·하지 않는 것', () => {
  const units = riskUnits(RISKY);
  assert.deepEqual(units.map((u) => u.id), ['F1', 'F2', 'F3', 'R1', 'R2', 'R3', 'R4']);
  assert.deepEqual(Object.fromEntries(units.map((u) => [u.id, u.marked])), {
    F1: false, F2: true, F3: true, R1: false, R2: false, R3: true, R4: true,
  }, '표시는 F·R 줄이나 그 케이스 줄(접힌 칸 포함)에 있어야 한다. 목적·범위·하지 않는 것의 표시는 보지 않는다');
  assert.deepEqual(units.map((u) => Object.keys(u).sort().join()), units.map(() => 'id,lines,marked'), '낱말을 찾는 칸은 없다');
});

test('a risk word is not a risk: without a mark the item is not a risk item, whatever it says (the spec-checker reads the meaning)', () => {
  // 표시 없이 "기록을 삭제한다"가 든 명세는 위험 항목이 없다
  const spec = withF1('- F1 지난 기록을 삭제한다 [사용자]\n  - 케이스: 외부에 공개하고 결제한다 → 비용 발생');
  assert.deepEqual(riskUnits(spec).map((u) => u.marked), [false, false]);
  assert.equal('words' in riskUnits(spec)[0], false);
  assert.deepEqual(lintSpec(spec), []);
});

test('CLI lint prints problems only: no 참고 line for risk words, with or without a mark, and the exit code follows the problems', () => {
  const d = tmp();
  const file = path.join(d, 'risky.md');
  // GOOD의 R1은 "삭제 전 확인 팝업"이다. 표시가 없어도 아무것도 출력하지 않는다
  writeFileSync(file, GOOD);
  let r = spawnSync('node', [CLI, 'lint', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, '');
  writeFileSync(file, RISKY);
  r = spawnSync('node', [CLI, 'lint', file], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  // 문제가 있으면 문제만 나오고 종료 코드는 1
  writeFileSync(file, GOOD.replace(' [사용자]', ''));
  r = spawnSync('node', [CLI, 'lint', file], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), 'F1: 태그가 없습니다 ([사용자] 또는 [AI 가정])');
  assert.doesNotMatch(r.stdout, /참고/);
  // [위험: 지우기] [사용자]와 콜론 없는 [위험 지우기] [사용자]가 태그 오류를 내지 않는다
  for (const mark of ['[위험: 지우기]', '[위험 지우기]', '[위험-지우기]']) {
    writeFileSync(file, GOOD.replace('- F1 오늘 수업 출석 현황 보기 [사용자]', `- F1 지난 기록 비우기 ${mark} [사용자]`));
    r = spawnSync('node', [CLI, 'lint', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${mark}: ${r.stdout}`);
    assert.equal(r.stdout, '', mark);
  }
});

test('the template starts a new spec with pact: 2', () => {
  const d = tmp();
  const file = spawnSync('node', [CLI, 'new', d, '새 주제'], { encoding: 'utf8' }).stdout.trim();
  assert.match(readFileSync(file, 'utf8'), /^---\npact: 2\n/);
});

// ---------- 파일 오류에는 까닭과 대신 할 일이 한 줄로 붙는다 (R6) ----------

function fsError(fn) {
  try { fn(); } catch (error) { return error; }
  throw new Error('오류가 나야 한다');
}

test('explainError puts a reason and what to do after the Node message of a file error, on one line, and leaves other errors alone', () => {
  const d = tmp();
  const missing = explainError(fsError(() => readFileSync(path.join(d, 'nope.md'), 'utf8')));
  assert.match(missing, /^ENOENT: no such file or directory/);
  assert.match(missing, /파일이나 폴더가 없다\(.*nope\.md\)/);
  assert.match(missing, /경로를 확인한다/);
  assert.match(missing, /spec\.mjs new <프로젝트> <주제>/);
  const dir = explainError(fsError(() => readFileSync(d, 'utf8')));
  assert.match(dir, /^EISDIR/);
  assert.match(dir, /자리에 폴더가 있거나 폴더여야 할 자리에 파일이 있다/);
  assert.match(dir, /손대지 말고 사용자에게 알린다/);
  writeFileSync(path.join(d, 'file'), 'x');
  const notDir = explainError(fsError(() => readFileSync(path.join(d, 'file', 'inner'), 'utf8')));
  assert.match(notDir, /^ENOTDIR/);
  assert.match(notDir, /손대지 말고 사용자에게 알린다/);
  const denied = explainError(Object.assign(new Error('EACCES: permission denied, open \'/x\''), { code: 'EACCES', path: '/x' }));
  assert.match(denied, /읽거나 쓸 권한이 없다\(\/x\)\. 사용자에게 알린다/);
  for (const line of [missing, dir, notDir, denied]) assert.doesNotMatch(line, /\n/);
  // 파일 오류가 아니면 글 그대로
  assert.equal(explainError(new Error('명세 맨 위에 frontmatter(---)가 없습니다')), '명세 맨 위에 frontmatter(---)가 없습니다');
  assert.equal(explainError('문자열'), '문자열');
});

test('CLI: a missing spec prints the Node message with a reason and what to do on one line, and exits 1', () => {
  const spec = path.join(tmp(), 'docs', 'pact', 'nope.md');
  for (const args of [['status', spec], ['lint', spec], ['set-status', spec, 'verifying']]) {
    const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 1, args.join(' '));
    const lines = r.stderr.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `${args[0]}: ${r.stderr}`);
    assert.match(lines[0], /ENOENT.*파일이나 폴더가 없다.*경로를 확인한다/, args[0]);
  }
});
