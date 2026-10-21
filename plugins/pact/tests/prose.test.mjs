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

test('SKILL.md description says when to use it, without forcing words', () => {
  const fm = frontmatter(read('skills/pact/SKILL.md'));
  assert.equal(fm.name, 'pact');
  for (const w of ['MUST', '반드시', 'always']) assert.ok(!fm.description.includes(w), `description contains ${w}`);
});

test('SKILL.md routes by every status and has the light path', () => {
  const text = read('skills/pact/SKILL.md');
  assert.ok(text.includes('가벼운 길'));
  for (const s of ['draft', 'approved', 'building', 'verifying', 'done']) assert.ok(text.includes(`\`${s}\``), s);
});

test('probe.md keeps the conversation rules and calls its tools', () => {
  const text = read('skills/pact/probe.md');
  for (const s of ['한 메시지에 질문 하나', '[사용자]', '[AI 가정]', 'checklist.mjs', 'gallery.mjs', 'pact:spec-checker']) {
    assert.ok(text.includes(s), s);
  }
  assert.match(text, /set-status <명세> approved/);
});

test('probe.md hands off to build.md on its last line', () => {
  assert.equal(read('skills/pact/probe.md').trimEnd().split('\n').at(-1), '다음: build.md');
});

test('build.md checks git, uses worker and reviewer, records Rulings', () => {
  const text = read('skills/pact/build.md');
  for (const s of ['git-state.mjs', 'pact:worker', 'pact:reviewer', 'BLOCKED', 'Ruling:', 'pact/<slug>']) {
    assert.ok(text.includes(s), s);
  }
  assert.match(text, /set-status <명세> building/);
  assert.equal(text.trimEnd().split('\n').at(-1), '다음: verify.md');
});

test('the report is written for the person who approved the spec: plain fields on top, working notes folded', () => {
  const verifier = read('agents/verifier.md');
  assert.match(verifier, /## 사람이 읽는 칸/);
  assert.match(verifier, /30초 안에 알아듣게/);
  assert.match(verifier, /단계의 `action`은 스크린샷 아래에 붙는다/);
  assert.ok(verifier.includes('"summary": "…"'));
  assert.match(verifier, /당신이 지어낸 이름은 쓰지 않는다/);
  assert.match(verifier, /`summary`를 새 결과로 고쳐 쓰고/);
  const verify = read('skills/pact/verify.md');
  assert.match(verify, /## 보고서 맨 위/);
  for (const field of ['`headline`', '`todo`', '`changes`', '`decision`']) assert.ok(verify.includes(field), field);
  assert.match(verify, /첫 문장이 결론이다/);
  assert.match(verify, /쉬운 말로 풀 수 없는 기술 세부는 맨 위에 올리지 않는다/);
  assert.match(verify, /`headline`에도 화면 없이 확인했다고 쓴다/);
  assert.match(verify, /한 항목에 한 문장이고, 정할 것이면 추천을 붙인다/);
  assert.match(verify, /나중에 부탁할 일도 언제인지와 함께 넣는다/);
  assert.match(verify, /여기서는 열지 않는다/);
  assert.match(verify, /남긴 이유를 그 시나리오의 `decision`에 적는다/);
  assert.match(verify, /채팅은 보고서 맨 위와 같은 말로 보낸다/);
});

test('verify.md runs the verifier, builds the report, merges locally and asks only before push', () => {
  const text = read('skills/pact/verify.md');
  for (const s of ['pact:verifier', 'report.mjs', 'merge --no-ff', 'push']) assert.ok(text.includes(s), s);
  assert.match(text, /set-status <명세> done/);
});

test('build and verify never ask the user to review a plan or pick an execution mode', () => {
  for (const f of ['build.md', 'verify.md']) {
    const text = read(`skills/pact/${f}`);
    for (const s of ['계획을 검토', '실행 방식']) assert.ok(!text.includes(s), `${f} contains ${s}`);
  }
});

test('delegation is not approval: probe asks for the one approval separately', () => {
  const probe = read('skills/pact/probe.md');
  assert.ok(probe.includes('위임은 승인이 아니다'));
  assert.ok(!probe.includes('바로 시작해도'), 'skip line must not read as "start building"');
  assert.match(read('skills/pact/SKILL.md'), /명세 승인은 확인 질문이 아니라 계약/);
  assert.match(read('skills/pact/build.md'), /status가 `draft`면 build하지 않는다/);
});

test('build resumes an existing worktree instead of recreating it, and scopes workers to absolute worktree paths', () => {
  const build = read('skills/pact/build.md');
  assert.match(build, /`<run-dir>\/wt`가 이미 있으면/);
  assert.match(build, /worktree 안의 절대 경로/);
  assert.match(build, /`untracked`/);
  assert.match(read('agents/worker.md'), /worktree 밖.*읽기만/);
});

test('verify commits the spec before merging and has a no-browser fallback', () => {
  const verify = read('skills/pact/verify.md');
  assert.ok(verify.indexOf('진행 기록') > 0 && verify.indexOf('진행 기록') < verify.indexOf('merge --no-ff'));
  assert.match(verify, /화면 없이/);
  assert.equal(verify.trimEnd().split('\n').at(-1), '다음: 끝 — 사용자에게 보고서를 보여 준다');
});

test('one question means one question mark: no follow-up question tacked on', () => {
  assert.match(read('skills/pact/SKILL.md'), /물음표는 하나/);
  assert.match(read('skills/pact/probe.md'), /물음표는 하나/);
});

test('spec size is given in numbers the behavior test checks, and the template shows the fold', () => {
  const probe = read('skills/pact/probe.md');
  assert.match(probe, /펼친 부분은 40줄/);
  assert.match(probe, /펼쳐 두는 `\[AI 가정\]` 항목은 5개까지/);
  assert.match(probe, /검수를 반영한 뒤에도/);
  assert.match(read('skills/pact/spec-template.md'), /<details><summary>/);
});

const CUA = 'mcp__cua__js';
const OLD_CUA = 'mcp__plugin_cua_cua__js';

test('screens are checked with Codex CUA, not Playwright', () => {
  for (const file of PROSE) assert.ok(!/playwright\.mjs|Playwright 스크립트/.test(readFileSync(file, 'utf8')), `${rel(file)} still uses Playwright`);
  const verifier = read('agents/verifier.md');
  assert.ok(verifier.includes(CUA));
  assert.match(verifier, /ToolSearch.*select:mcp__cua__js.*select:mcp__plugin_cua_cua__js/);
  assert.ok(read('skills/pact/SKILL.md').includes(CUA) && read('skills/pact/SKILL.md').includes(OLD_CUA));
  assert.match(verifier, /createBrowserTab\("chrome"/);
  assert.match(verifier, /getScreenshot\(\{ emit: false \}\)/);
  assert.match(verifier, /shots\/<시나리오 id>-<단계 번호>\.jpg/);
  assert.match(verifier, /tab\.close\(\)/);
  assert.match(verifier, /화면 없이/);
  assert.match(read('skills/pact/verify.md'), /Codex CUA/);
  assert.match(read('skills/pact/SKILL.md'), /Codex CUA/);
});

test('deferred minors: worktree leftovers, cross-platform open, merge message, reply wait, stopping the server', () => {
  const verify = read('skills/pact/verify.md');
  assert.match(verify, /`--force`는 쓰지 않는다/);
  assert.match(verify, /merge --no-ff --no-edit/);
  const skill = read('skills/pact/SKILL.md');
  assert.match(skill, /xdg-open/);
  assert.match(skill, /틀 그대로/);
  assert.match(read('skills/pact/build.md'), /답은 알림으로 온다/);
  assert.match(read('skills/pact/probe.md'), /서버를 멈춘다: /);
});

test('deferred minors: description says only when, worker wording, read-only agents keep Bash to reading', () => {
  const d = frontmatter(read('skills/pact/SKILL.md')).description;
  assert.ok(!d.includes('가늠'), 'description should say when, not how');
  assert.ok(!read('agents/worker.md').includes('짐작하지'));
  for (const a of ['agents/spec-checker.md', 'agents/reviewer.md']) assert.match(read(a), /Bash는 읽기와 시험 실행에만/);
});

test('probe spreads a wide feature map first, then goes down branch by branch, then narrows', () => {
  const probe = read('skills/pact/probe.md');
  const order = ['## 1. 넓게 펼치기', '## 2. 타고 내려가기', '## 3. 좁히기', 'checklist.mjs render', '## 5. 명세 작성'].map((s) => probe.indexOf(s));
  order.forEach((at, k) => assert.ok(at > (k ? order[k - 1] : -1), `step ${k} out of order`));
  assert.ok(probe.includes('`- <갈래>: <아이디어> · <아이디어> · <아이디어>`'));
  assert.match(probe, /갈래는 5~8개/);
  assert.match(probe, /기능 전체를 펼쳐 보이기 전에는 한 기능으로 깊이 들어가지 않는다/);
  assert.match(probe, /거른 것만 내놓고/);
  assert.match(probe, /"group"/);
  for (const gone of ['예시 답 목록을 붙이지 않는다', '실제 장면을 묻는 열린 질문']) assert.ok(!probe.includes(gone), gone);
  assert.match(probe, /추천 뒤에 "괜찮을까요\?"를 붙이지 않는다/);
});

test('the spec stays short: later-round branches on one line, decision log left for after approval', () => {
  const probe = read('skills/pact/probe.md');
  assert.ok(probe.includes('`- 다음 판 후보: <갈래>, <갈래>` 한 줄로'));
  assert.match(probe, /`## 결정 기록`은 비워 둔다/);
});

test('no single-default confirm questions: offer real directions with a recommendation instead', () => {
  const skill = read('skills/pact/SKILL.md');
  assert.ok(!skill.includes('틀린 거나 빠진 게 있어요?'));
  assert.match(skill, /선택지는 내놓기 전에 거른다/);
  assert.match(skill, /대비책으로 이미 품은 안/);
  assert.match(skill, /거르고 남은 안이 하나면 묻지 않는다/);
  assert.match(skill, /선택지 수를 맞추려고 안을 지어내지 않는다/);
  assert.match(skill, /들러리 안을 붙여 고르는 질문처럼 꾸민 것도 같다/);
  assert.match(read('skills/pact/probe.md'), /들러리 안을 붙여 고르는 질문처럼 꾸미지도 않는다/);
  for (const file of PROSE) assert.ok(!readFileSync(file, 'utf8').includes('방향 2~3개'), `${rel(file)} still asks for a fixed number of directions`);
  assert.match(skill, /기본안 하나를 내밀고 맞는지 묻는 것도 확인 질문/);
  assert.match(read('skills/pact/probe.md'), /"맞음"밖에 할 말이 없는 질문/);
});

test('first end-to-end run: friction fixes stay in the guidance', () => {
  const probe = read('skills/pact/probe.md');
  assert.match(probe, /\*\*맡겼을 때\.\*\*/);
  assert.match(probe, /스케치 없이 정했다\(위임\)/);
  assert.match(probe, /페이지를 열기 전에 채팅으로 먼저 알린다/);
  assert.match(probe, /오류가 아니다/);
  assert.match(probe, /— <이유> \[AI 가정\]/);
  assert.match(probe, /\(AI 제안에 동의\)/);
  assert.match(probe, /검수자도 틀린다/);
  assert.match(read('skills/pact/spec-template.md'), /— <이유> \[AI 가정\]/);
  const checker = read('agents/spec-checker.md');
  assert.match(checker, /\(AI 제안에 동의\)/);
  assert.match(checker, /확인 안 함/);
  const build = read('skills/pact/build.md');
  assert.match(build, /`untracked`\(미추적 파일\)에 있든 그 파일만 커밋한다/);
  assert.match(build, /세 번째 검토는 없다/);
  assert.match(build, /무엇을 맡겼는지 한 줄/);
  assert.match(read('skills/pact/SKILL.md'), /무엇을 하는지 쉬운 말로 한 줄/);
  const verify = read('skills/pact/verify.md');
  assert.match(verify, /cua\.getState\(\)/);
  assert.match(verify, /처음부터 다시 돌리지 않는다/);
  assert.match(verify, /results-round<n>\.json/);
  const verifier = read('agents/verifier.md');
  assert.match(verifier, /## 다시 검수/);
  assert.match(verifier, /화면 도구 없음/);
});
