// 명세 HTML 보기: 요약 상자의 개수, 기록·다른 저장소 줄 구분, 접힌 블록, escape, `spec.mjs html` 명령과 .pact/.gitignore 줄
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderSpecHtml } from '../scripts/spec-html.mjs';
import { PACT_GITIGNORE, ensureIgnoreLine } from '../scripts/paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'spec.mjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pact-spec-html-'));
  made.push(dir);
  return dir;
};

const SPEC = `---
pact: 3
topic: 출결 <대시보드>
status: draft
created: 2026-11-01
---
# 출결
## 목적
교수자가 \`출석\`을 빨리 본다.
둘째 줄.
## 범위
웹 화면 하나.
## 하지 않는 것
- 출석 처리 자체 [사용자]
## 기능
- F1 오늘 수업 보기 [사용자]
  - 케이스: 수업 0건 → 빈 상태 [사용자: 검수 1]
- F2 지난 학기 출석표 [사용자: 10/18 alibaba]
- F3 엑셀 내려받기 [AI 가정: 기록 10/11]
- F4 전체 삭제 [위험: 지우기] [AI 가정]
- F5 작년 방식 [사용자: 2025/10/9]
## 공통 규칙
- R1 확인 팝업 — 이유 [AI 가정: 검수 2 맡김]

<details><summary>그 밖의 AI 가정</summary>

- R2 숨은 규칙 [AI 가정]

</details>

## 검수 기준
- A1 오늘 수업이 보인다 [사용자]
## 구조 판정
화면 없음
## 확인 필요
## 결정 기록
- Ruling: 가 — 나 — 다
- Ruling: 라 — 마 — 바
`;

const html = renderSpecHtml(SPEC);
// 본문의 <li> 하나(요약 상자 뒤): 번호나 글로 찾는다. 케이스 줄이 든 항목은 안쪽 <li>에서 끊긴다
const li = (needle, source = html) => source.slice(source.indexOf('</div>')).split(/(?=<li)/).find((part) => part.includes(needle)) ?? assert.fail(`${needle} 줄이 없다`);
const summaryBox = html.match(/<div class="summary">[\s\S]*?\n<\/div>/)[0];

test('the summary box counts the tagged lines, the lines from records, those from other repos, and the risk lines', () => {
  // [사용자]: 하지 않는 것 1 + F1 + F1 케이스 + F2 + F5 + A1 = 6, [AI 가정]: F3 F4 R1 R2 = 4
  assert.match(summaryBox, /<p>\[사용자\] 6개 · \[AI 가정\] 4개 · 기록에서 온 줄 3개\(다른 저장소 1개\) · 위험 1개<\/p>/);
});

test('a line tagged [사용자: 10/18 alibaba] gets the other-repo chip, the orange side line, and is listed again in the summary box', () => {
  const f2 = li('<strong>F2</strong>');
  assert.match(f2, /<li class="other">/);
  assert.match(f2, /<span class="chip repo">다른 저장소 alibaba<\/span>/);
  assert.match(f2, /<span class="chip rec">기록 10\/18<\/span>/);
  assert.match(f2, /<span class="chip user">사용자<\/span>/);
  assert.match(summaryBox, /<h3>다른 저장소에서 온 줄<\/h3>/);
  assert.match(summaryBox, /<li><strong>F2<\/strong> 지난 학기 출석표.*다른 저장소 alibaba/);
  const body = html.slice(html.indexOf('</div>'));
  assert.equal([...body.matchAll(/class="chip repo"/g)].length, 1, '본문의 다른 저장소 칩은 이 줄 하나뿐이다');
  assert.equal([...body.matchAll(/<li class="other">/g)].length, 1, '세로선은 다른 저장소 줄에만');
});

test('[AI 가정: 기록 10/11] gets the record chip only: no other-repo chip or side line, and it is not in the other-repo list', () => {
  const f3 = li('<strong>F3</strong>');
  assert.match(f3, /<span class="chip ai">AI 가정<\/span>/);
  assert.match(f3, /<span class="chip rec">기록 10\/11<\/span>/);
  assert.doesNotMatch(f3, /다른 저장소|class="other"/);
  assert.doesNotMatch(summaryBox, /F3/);
});

test('a year in the date is kept (YYYY/M/D), and the review pair [사용자: 검수 1] / [AI 가정: 검수 2 맡김] gets a small note chip and no record chip', () => {
  assert.match(li('<strong>F5</strong>'), /<span class="chip rec">기록 2025\/10\/9<\/span>/);
  const kase = li('케이스: 수업 0건');
  assert.match(kase, /<span class="chip user">사용자<\/span><span class="chip note">검수 1<\/span>/);
  assert.doesNotMatch(kase, /chip rec|chip repo/);
  const r1 = li('<strong>R1</strong>');
  assert.match(r1, /<span class="chip note">검수 2 맡김<\/span>/);
  assert.doesNotMatch(r1, /chip rec|chip repo/);
});

test('a risk mark becomes a red chip before the tag and the line is listed in the summary box', () => {
  const f4 = li('<strong>F4</strong>');
  assert.match(f4, /<span class="chip risk">위험: 지우기<\/span><span class="chip ai">AI 가정<\/span>/);
  assert.match(summaryBox, /<h3>위험 줄<\/h3>\n<ul><li><strong>F4<\/strong> 전체 삭제/);
  // 값이 빈 표시(`[위험]`)와 태그 없이 표시만 있는 줄도 위험이다
  const bare = renderSpecHtml(SPEC.replace('- F5 작년 방식 [사용자: 2025/10/9]', '- F5 작년 방식 [위험]'));
  assert.match(li('<strong>F5</strong>', bare), /<span class="chip risk">위험<\/span><\/li>/);
  assert.match(bare, /위험 2개/);
});

test('item numbers are bold, case lines are a sub list under the item, plain sections are paragraphs and lists', () => {
  assert.match(html, /<strong>F1<\/strong> 오늘 수업 보기<span class="chip user">사용자<\/span><ul class="sub"><li>케이스: 수업 0건 → 빈 상태/);
  assert.match(html, /<h2>목적<\/h2>\n<p>교수자가 <code>출석<\/code>을 빨리 본다\.<br>둘째 줄\.<\/p>/);
  assert.match(html, /<h2>하지 않는 것<\/h2>\n<ul><li>출석 처리 자체<span class="chip user">사용자<\/span><\/li><\/ul>/);
  assert.match(html, /<h2>구조 판정<\/h2>\n<p>화면 없음<\/p>/);
});

test('a <details> block stays a folded <details>, with its summary and the items inside', () => {
  assert.match(html, /<details><summary>그 밖의 AI 가정<\/summary>\n<ul><li><strong>R2<\/strong> 숨은 규칙<span class="chip ai">AI 가정<\/span><\/li><\/ul><\/details>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
});

test('the decision record is folded as a whole, with the Ruling count in the summary; an empty 확인 필요 says 없음', () => {
  assert.match(html, /<details class="log"><summary>결정 기록 — Ruling 2개<\/summary>\n<ul><li>Ruling: 가 — 나 — 다<\/li><li>Ruling: 라 — 마 — 바<\/li><\/ul><\/details>/);
  assert.doesNotMatch(html, /<h2>결정 기록<\/h2>/);
  assert.match(html, /<h2>확인 필요<\/h2>\n<p class="none">없음<\/p>/);
  assert.doesNotMatch(renderSpecHtml(SPEC.replace('## 확인 필요\n', '## 확인 필요\n- 검수 3: 안 물은 까닭\n')), /<p class="none">/);
});

test('all text is escaped: the topic, item text, summary text and backtick code cannot inject markup, and the page has no script or external resource', () => {
  const evil = renderSpecHtml(SPEC.replace('- F1 오늘 수업 보기', '- F1 <script>alert(1)</script> "따옴표" & `<b>코드</b>`').replace('그 밖의 AI 가정', '<img src=x onerror=alert(2)>'));
  assert.doesNotMatch(evil, /<script|<img|<b>/);
  assert.match(evil, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;따옴표&quot; &amp; <code>&lt;b&gt;코드&lt;\/b&gt;<\/code>/);
  assert.match(evil, /<h1>출결 &lt;대시보드&gt;<\/h1>/);
  assert.match(evil, /<title>출결 &lt;대시보드&gt; — 명세<\/title>/);
  assert.doesNotMatch(html, /<script|<link|<iframe|src=|https?:\/\//);
});

test('a title passed in replaces the topic; text that is not a recognized tag stays text', () => {
  assert.match(renderSpecHtml(SPEC, { title: '보기' }), /<h1>보기<\/h1>/);
  const bracket = renderSpecHtml(SPEC.replace('- F1 오늘 수업 보기 [사용자]', '- F1 목록 [초안] 보기'));
  assert.match(li('<strong>F1</strong>', bracket), /목록 \[초안\] 보기<ul class="sub">/);
});

test('the empty template renders without throwing, with the placeholders escaped', () => {
  const template = readFileSync(path.join(ROOT, 'skills', 'pact', 'spec-template.md'), 'utf8');
  const out = renderSpecHtml(template);
  assert.match(out, /&lt;기능 한 줄&gt;/);
  assert.match(out, /<details><summary>그 밖의 AI 가정<\/summary>/);
  assert.match(out, /\[사용자\] 2개 · \[AI 가정\] 2개 · 기록에서 온 줄 0개\(다른 저장소 0개\) · 위험 0개/);
});

// ---------- 명령과 .pact/.gitignore ----------

function project(gitignore) {
  const dir = tmp();
  const run = path.join(dir, '.pact', '2026-11-01-출결');
  mkdirSync(run, { recursive: true });
  writeFileSync(path.join(run, 'spec.md'), SPEC);
  if (gitignore !== undefined) writeFileSync(path.join(dir, '.pact', '.gitignore'), gitignore);
  return { dir, run, spec: path.join(run, 'spec.md'), ignore: path.join(dir, '.pact', '.gitignore') };
}
const html_ = (spec) => spawnSync(process.execPath, [CLI, 'html', spec], { encoding: 'utf8' });
const count = (file) => readFileSync(file, 'utf8').split('\n').filter((l) => l === '*/spec.html').length;

test('CLI: html writes spec.html into the run dir, prints that path, and the new .pact/.gitignore already lists */spec.html', () => {
  const p = project();
  const r = html_(p.spec);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${path.join(p.run, 'spec.html')}\n`);
  assert.equal(readFileSync(path.join(p.run, 'spec.html'), 'utf8'), html);
  assert.equal(readFileSync(p.ignore, 'utf8'), PACT_GITIGNORE);
  assert.equal(count(p.ignore), 1);
  assert.equal(html_(p.spec).status, 0);
  assert.equal(count(p.ignore), 1, '다시 돌려도 줄이 두 번 붙지 않는다');
});

test('CLI: html appends */spec.html to a .pact/.gitignore written before this line existed, and leaves a hand-edited file otherwise as it was', () => {
  const old = PACT_GITIGNORE.replace('# 명세에서 다시 만드는 파일\n*/spec.html\n', '');
  assert.ok(!old.includes('spec.html'));
  const p = project(old);
  assert.equal(html_(p.spec).status, 0);
  assert.equal(readFileSync(p.ignore, 'utf8'), `${old}*/spec.html\n`);
  html_(p.spec);
  assert.equal(count(p.ignore), 1);
  const hand = project('*/wt/\n*/shots/'); // 끝에 줄바꿈이 없는 사람이 고친 파일
  assert.equal(html_(hand.spec).status, 0);
  assert.equal(readFileSync(hand.ignore, 'utf8'), '*/wt/\n*/shots/\n*/spec.html\n');
});

test('git ignores .pact/<run-id>/spec.html through the line, and still keeps spec.md', () => {
  const p = project();
  html_(p.spec);
  const git = (...args) => spawnSync('git', ['-C', p.dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  assert.equal(git('check-ignore', '-q', '.pact/2026-11-01-출결/spec.html').status, 0);
  assert.equal(git('check-ignore', '-q', '.pact/2026-11-01-출결/spec.md').status, 1);
});

test('CLI: html on a spec outside .pact/<run-id>/ fails with a line saying where specs live, and writes nothing', () => {
  const dir = tmp();
  const spec = path.join(dir, 'spec.md');
  writeFileSync(spec, SPEC);
  const r = html_(spec);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /명세는 <프로젝트>\/\.pact\/<run-id>\/spec\.md에 둡니다/);
  assert.equal(existsSync(path.join(dir, 'spec.html')), false);
  assert.equal(spawnSync(process.execPath, [CLI, 'html'], { encoding: 'utf8' }).status, 2, '명세를 안 주면 사용법');
});

test('ensureIgnoreLine appends a missing line once, keeps what is there, and creates the file when there is none', () => {
  const dir = tmp();
  ensureIgnoreLine(dir, 'a/');
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'a/\n');
  ensureIgnoreLine(dir, 'a/');
  ensureIgnoreLine(dir, 'b/');
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'a/\nb/\n');
  writeFileSync(path.join(dir, '.gitignore'), 'x\r\ny\r\n');
  ensureIgnoreLine(dir, 'y');
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'x\r\ny\r\n');
});

test('줄 가운데의 위험 표시도 위험으로 센다 (delegate의 riskItems와 같은 눈)', () => {
  const html = renderSpecHtml(SPEC.replace('- F1 오늘 수업 보기 [사용자]', '- F1 지난 자료 비우기 [위험: 지우기] 가운데 [사용자]'));
  assert.match(html, /위험 2개/);
  assert.match(html, /<strong>F1<\/strong> 지난 자료 비우기 \[위험: 지우기\] 가운데<span class="chip risk">위험<\/span>/);
});

test('결정 기록에 인용된 [위험: …] 글은 위험으로 세지 않는다', () => {
  const html = renderSpecHtml(SPEC.replace('- Ruling: 가 — 나 — 다', '- Ruling: `[위험: 지우기]` 표시를 뺐다 — 나 — 다'));
  assert.match(html, /위험 1개/);
});
