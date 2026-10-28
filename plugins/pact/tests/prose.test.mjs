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
  // 승인은 말이 아니라 기록이다: 사용자 말을 그대로 넣는 approve, 승인까지 맡긴다는 말만 넣는 delegate
  assert.match(text, /spec\.mjs approve <명세> "<사용자 말>"/);
  assert.match(text, /spec\.mjs delegate <명세> "<사용자 말>"/);
  assert.doesNotMatch(text, /set-status <명세> approved/, 'approved는 승인 기록 없이 바꾸지 않는다');
});

test('probe.md hands off to build.md on its last line', () => {
  assert.equal(read('skills/pact/probe.md').trimEnd().split('\n').at(-1), '다음: build.md');
});

test('build.md checks git, uses worker and reviewer, records Rulings', () => {
  const text = read('skills/pact/build.md');
  for (const s of ['git-state.mjs', 'pact:worker', 'pact:reviewer', 'BLOCKED', 'Ruling:', 'pact/<run-id>']) {
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
  assert.match(text, /verification\.mjs finish <명세> <프로젝트>/);
  assert.doesNotMatch(text, /scripts\/spec\.mjs set-status <명세> done/);
});

test('repair keeps the two-review cap and screenshots for every step', () => {
  const build = read('skills/pact/build.md');
  const verifier = read('agents/verifier.md');
  assert.ok(build.includes('이 두 번째 검토에서도 고칠 것이 있으면 당신이 직접 고치고 완료 기준 명령을 돌린 뒤 넘어간다. 세 번째 검토는 없다.'));
  assert.ok(verifier.includes('모든 시나리오의 모든 단계에 스크린샷이 있어야 사용자가 보고서만 보고 판단할 수 있다.'));
  assert.match(verifier, /unverified/);
  assert.match(verifier, /HTTP.*통과시키지 않는다/);
});

test('build and verify never ask the user to review a plan or pick an execution mode', () => {
  for (const f of ['build.md', 'verify.md']) {
    const text = read(`skills/pact/${f}`);
    for (const s of ['계획을 검토', '실행 방식']) assert.ok(!text.includes(s), `${f} contains ${s}`);
  }
});

test('approval and delegation are recorded from the person\'s own words: an answer to the approval question is an approval, only words that hand over the approval are a delegation, a risk item always needs an approval', () => {
  const probe = read('skills/pact/probe.md');
  // 승인 질문의 답은 승인이고 그 말을 그대로 approve에 넣는다
  assert.ok(probe.includes('승인 질문의 답으로 온 "승인", "ㄱㄱ", "좋아, 만들어", "진행해"는 승인이다'));
  assert.match(probe, /그 말을 그대로 `approve`에 넣는다/);
  assert.match(probe, /"승인"처럼 짧은 말은 사용자 메시지 전체와 같아야 맞는다/);
  assert.match(probe, /질문 도구\(AskUserQuestion\)로 고른 답도 같다/);
  assert.match(probe, /이 질문은 spec-checker가 끝난 뒤에 한다/);
  // 승인까지 맡긴다는 말만 delegate: 질문 하나의 답으로 온 "알아서"는 그 질문만 맡긴 것
  assert.match(probe, /승인까지 맡긴다는 말\("끝까지 알아서 해", "승인 없이 만들어"\)만 위임이다/);
  assert.match(probe, /"알아서", "네가 정해", "몰라", "기본안대로"는 그 질문만 맡긴 것이다/);
  assert.match(probe, /위임으로 치지 않고 4의 승인 질문을 따로 한다/);
  // 위험 항목이 있으면 위임이어도 승인을 받는다
  assert.match(probe, /위험 항목이 있으면 위임이어도 승인을 받는다/);
  assert.match(probe, /`delegate`가 거절한다/);
  assert.match(probe, /만들기를 시작할 때\(`set-status building`, `pact:worker`\) 명세를 다시 보고/);
  assert.match(probe, /승인이나 위임 기록이 없으면 build로 가지 않는다/);
  assert.ok(!probe.includes('바로 시작해도'), 'skip line must not read as "start building"');
  assert.ok(!probe.includes('위임은 승인이 아니다'), '옛 문구: 승인까지 맡긴다는 말은 이제 위임 기록이다');
  assert.match(read('skills/pact/SKILL.md'), /명세 승인은 확인 질문이 아니라 계약/);
  assert.match(read('skills/pact/build.md'), /status가 `draft`면 build하지 않는다/);
});

test('probe 5 teaches the risk mark, and what to do with the 참고: lines lint prints', () => {
  const probe = read('skills/pact/probe.md');
  assert.ok(probe.includes('`[위험: 지우기|공개|비용]`'));
  assert.ok(probe.includes('`- F2 지난 학기 자료 비우기 [위험: 지우기] [사용자]`'));
  assert.match(probe, /표시가 있으면 위임으로는 만들기를 시작하지 못한다/);
  assert.ok(probe.includes('lint의 위험 `참고:` 줄은 정말 위험 항목이면 표시를 달고 아니면 그대로 둔다'));
  assert.match(probe, /`참고:`로 시작하는 줄은 문제가 아니다/);
  assert.doesNotMatch(probe, /lint[^\n]*아무것도 출력하지 않아야/, 'lint가 참고를 출력하니 옛 문구는 맞지 않는다');
  assert.match(read('skills/pact/SKILL.md'), /`\[위험: 지우기\|공개\|비용\]`/);
});

test('build starts only from an approval or delegation record, and tells the worker brief where the run is', () => {
  const build = read('skills/pact/build.md');
  assert.match(build, /승인이나 위임 기록\(`<run-dir>\/approvals\.jsonl`\)이 없으면 시작하지 못한다/);
  assert.match(build, /`spec\.mjs approve`로 기록한다/);
  assert.match(build, /승인이나 위임 기록이 없으면 거절한다/);
  assert.match(build, /위임 기록이면 지금 명세를 다시 보고, 위험 항목/);
  assert.match(build, /참고: 옛 판이라 승인 기록 없음/);
  assert.match(build, /frontmatter `pact: 1`/);
  assert.match(build, /run-dir은 `<프로젝트>\/\.pact\/<run-id>`의 절대 경로로 적는다/);
  assert.match(build, /`pact:worker` 호출이 막히고/);
  const skill = read('skills/pact/SKILL.md');
  assert.match(skill, /## 승인과 위임 기록/);
  assert.match(skill, /하위 에이전트는 이 명령과 `set-status`를 부르지 못한다/);
});

test('a new spec starts with pact: 2, and the README says how approval, delegation and the hook work', () => {
  assert.match(read('skills/pact/spec-template.md'), /^---\npact: 2\n/);
  const readme = read('README.md');
  assert.ok(readme.includes('approvals.jsonl'));
  assert.match(readme, /spec\.mjs approve  <명세> "<사용자 말>"/);
  assert.match(readme, /spec\.mjs delegate <명세> "<사용자 말>"/);
  assert.match(readme, /정리해서 10자 이하인 짧은 말\("승인"\)은 메시지 전체와 같아야 하고/);
  assert.match(readme, /`참고: 옛 판이라 승인 기록 없음`/);
  assert.match(readme, /`spec\.mjs new`는 `pact: 2`로 쓴다/);
  assert.match(readme, /메인 세션이 `pact:worker`를 부를 때/);
  assert.match(readme, /맥락 칸에 run-dir과 작업 번호를 넣는다/);
  assert.doesNotMatch(readme, /PreToolUse: 지금은 아무것도 막지 않는다/);
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
  assert.ok(verifier.includes('mcp__cua_repl.js') && verifier.includes(OLD_CUA));
  assert.match(verifier, /ToolSearch.*CUA·JavaScript/);
  assert.ok(read('skills/pact/SKILL.md').includes(CUA) && read('skills/pact/SKILL.md').includes(OLD_CUA));
  assert.match(verifier, /createBrowserTab\("<browsers에서 고른 이름>"/);
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
  assert.match(verify, /changed_files/);
  assert.match(verify, /results-round<n>\.json/);
  const verifier = read('agents/verifier.md');
  assert.match(verifier, /## 다시 검수/);
  assert.match(verifier, /화면 도구 없음/);
});
