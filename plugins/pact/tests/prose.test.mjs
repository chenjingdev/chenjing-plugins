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
  assert.match(text, /spec\.mjs approve <명세> - <<'EOF'/);
  assert.match(text, /spec\.mjs delegate <명세> - <<'EOF'/);
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
  // 이 칸들은 results.json이 아니라 summary.json에 쓴다
  assert.match(verify, /먼저 `<run-dir>\/summary\.json`에 아래 칸을 채우고/);
  assert.match(verify, /results\.json은 verifier만 쓰니 이 칸들은 summary\.json에 쓴다/);
  assert.match(verify, /`decision`: 실패·의심 시나리오마다 id를 키로/);
  assert.match(verify, /칸마다 summary\.json에 있으면 그것을, 없으면 results\.json의 같은 칸을 읽는다/);
});

const SUMMARY_SHAPE = '{ "headline": "…", "todo": ["…"], "changes": ["…"], "decision": { "<시나리오 id>": "…" } }';

test('results.json is the verifier\'s alone, and verify.md, verifier.md and the README say the same about it, summary.json and the round files', () => {
  const verify = read('skills/pact/verify.md');
  const verifier = read('agents/verifier.md');
  const readme = read('README.md');
  // verify.md: results.json은 고치지 않는다, 보고 칸은 summary.json, 앞 결과는 스크립트가 남긴다, rulings는 보고서가 읽는다
  assert.match(verify, /verifier가 `<run-dir>\/results\.json`을 쓴다\. 이 파일은 verifier만 쓴다\. 당신은 고치지 않는다\. 훅이 다른 쪽의 쓰기를 막고/);
  assert.match(verify, /`report\.mjs`가 명세 `## 결정 기록`의 Ruling 줄에서 읽으니 따로 옮기지 않는다/);
  assert.doesNotMatch(verify, /`rulings` 배열에 넣는다/);
  assert.match(verify, /이 파일은 snapshot만 쓰고, 손으로 고치면 훅이 막는다/);
  assert.match(verify, /이때 스크립트가 앞 결과를 `results-round<n>\.json`으로 남긴다\(출력의 `saved_results`, 있는 round 파일은 덮어쓰지 않는다\)\. 직접 복사하지 않는다/);
  assert.doesNotMatch(verify, /먼저 `results\.json`을 `results-round<n>\.json`으로 복사해 둔다/, '메인이 복사하던 지시는 없어졌다');
  assert.match(verify, /고치려 하면 훅이 막고, 다른 길로 바뀐 것은 finish가 verifier 기록의 지문과 비교해 막는다/);
  // 완료 검사가 막는 것에 지문 비교가 들어 있다
  assert.match(verify, /완료 검사가 막는 것은 여섯 가지다/);
  assert.match(verify, /verifier가 끝난 뒤 바뀐 `results\.json`: 지금 파일의 지문이 가장 최근 verifier 기록과 다르거나, 그 기록이 없거나, 기록에 지문이 없다/);
  assert.match(verify, /옛 판\)에 verifier 기록이 하나도 없으면 지문 비교를 건너뛰고 그렇다고 `참고:`로 알린다/);
  // verifier.md: results.json만 쓴다, 보고 칸은 쓰지 않는다
  assert.match(verifier, /run-dir 맨 위의 파일 가운데 `results\.json`만 당신이 쓴다\. 다른 쪽이 쓰려 하면 훅이 막는다/);
  assert.match(verifier, /당신이 끝날 때 이 파일의 지문이 기록되고, 완료 검사가 그 지문과 비교한다/);
  assert.match(verifier, /`results-round<n>\.json`은 snapshot이 쓴다\. 이 다섯은 당신이 쓰지 않는다/);
  assert.match(verifier, /앞 결과는 snapshot이 `results-round<n>\.json`으로 남겨 두었으니 따로 복사하지 않는다/);
  assert.match(verifier, /`rulings`·`headline`·`todo`·`changes`·`decision`은 쓰지 않는다\. 보고서의 결정 기록은 `report\.mjs`가 명세에서 읽고, 나머지 칸은 메인 세션이 `summary\.json`에 쓴다/);
  assert.doesNotMatch(verifier, /"rulings"/, '결과 형식에 rulings 칸이 없다');
  // README: 파일 표, 보고 칸 절, 잠금 규칙, 지문 비교
  assert.match(readme, /\| `\.pact\/<날짜>-<주제>\/results\.json` \| 검수 결과\. verifier만 쓴다/);
  assert.match(readme, /\| `\.pact\/<날짜>-<주제>\/summary\.json` \| 보고서 맨 위 칸/);
  assert.match(readme, /### 결과 파일과 보고 칸/);
  assert.match(readme, /`report\.mjs`는 `results\.json`, `summary\.json`, 명세 `## 결정 기록`의 `Ruling:` 줄\(rulings\)을 합쳐 지금과 같은 보고서를 만든다/);
  assert.match(readme, /칸마다 `summary\.json`에 있으면 그것을, 없으면 `results\.json`의 같은 칸을 읽는다/);
  assert.match(readme, /PreToolUse\(결과 잠금\): 실행 폴더 바로 밑의 파일은 정해진 쪽만 쓴다/);
  assert.match(readme, /`results\.json`·`results-round\*\.json`은 `pact:verifier`만, `verification\.json`은 `verification\.mjs snapshot`만, `approvals\.jsonl`과 `log\/` 밑은 훅과 pact 스크립트만 쓴다/);
  assert.match(readme, /`<run-dir>\/wt\/` 밑.*명세\(`docs\/pact\/<run-id>\.md`\)가 없는 폴더는 대상이 아니다\. 옛 판도 똑같이 건다/);
  assert.match(readme, /완료 검사는 `results\.json`의 지금 sha256을 가장 최근 verifier가 끝날 때 훅이 남긴 지문과 비교한다/);
  assert.match(readme, /0\.6\.0에서 verifier가 다시 돌아 기록이 생긴 옛 판은 비교한다/);
  assert.match(readme, /출력의 `saved_results`/);
  // 세 곳이 summary.json의 모양을 같게 적는다
  for (const [name, text] of [['verify.md', verify], ['README.md', readme]]) assert.ok(text.includes(SUMMARY_SHAPE), `${name}의 summary.json 모양`);
  assert.ok(verify.includes('`headline`') && verify.includes('`todo`') && verify.includes('`changes`') && verify.includes('`decision`'));
});

test('the files the lock covers are named the same in the guidance and in the code', async () => {
  const { classifyRest } = await import('../scripts/locks.mjs');
  const readme = read('README.md');
  for (const [rest, kind] of [[['results.json'], 'results'], [['results-round1.json'], 'results'], [['verification.json'], 'verification'], [['approvals.jsonl'], 'approvals'], [['log', 'subagents.jsonl'], 'log']]) {
    assert.equal(classifyRest(rest).kind, kind, rest.join('/'));
  }
  for (const free of ['summary.json', 'report.html', 'plan.md', 'tasks', 'shots']) {
    assert.equal(classifyRest([free]), null, free);
    assert.ok(readme.includes(free.endsWith('.md') || free.endsWith('.json') || free.endsWith('.html') ? `\`${free}\`` : `\`${free}/\``), `README가 ${free}를 잠그지 않는다고 적는다`);
  }
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
  // 말은 표준 입력으로: 따옴표 안의 백틱·$가 셸에서 풀리지 않게
  assert.match(probe, /말은 표준 입력으로 넘긴다\. 따옴표 붙인 heredoc이라 말 속의 백틱·`\$`·따옴표가 셸에서 풀리지 않는다/);
  assert.match(probe, /status가 `draft`면 `approved`로 바꾼다/);
  assert.doesNotMatch(probe, /approve <명세> "<사용자 말>"/, '큰따옴표 인자는 권하지 않는다');
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

test('probe 5 teaches the risk mark in one line, and says nothing about risk words or 참고: lines (the code does not search words)', () => {
  const probe = read('skills/pact/probe.md');
  assert.ok(probe.includes('- 위험 항목에는 표시를 단다.'));
  assert.ok(probe.includes('`[위험: 지우기|공개|비용]`'));
  assert.ok(probe.includes('`- F2 지난 학기 자료 비우기 [위험: 지우기] [사용자]`'));
  assert.match(probe, /표시가 있으면 위임으로는 만들기를 시작하지 못한다/);
  // lint는 문제 줄만 출력한다
  assert.match(probe, /`node <pact>\/scripts\/spec\.mjs lint <명세>`가 아무것도 출력하지 않아야 한다\. 출력이 있으면 고친다\./);
  assert.doesNotMatch(probe, /참고:/);
  assert.doesNotMatch(probe, /위험 낱말/);
  for (const file of ['skills/pact/SKILL.md', 'skills/pact/build.md', 'README.md']) assert.doesNotMatch(read(file), /위험 낱말이 있/, file);
  assert.match(read('skills/pact/SKILL.md'), /`\[위험: 지우기\|공개\|비용\]`/);
});

test('build starts only from an approval or delegation record, and tells the worker brief where the run is', () => {
  const build = read('skills/pact/build.md');
  assert.match(build, /승인이나 위임 기록\(`<run-dir>\/approvals\.jsonl`\)이 없으면 시작하지 못한다/);
  assert.match(build, /`spec\.mjs approve`로 기록한다/);
  assert.match(build, /승인이나 위임 기록이 없으면 거절한다/);
  assert.match(build, /위임 기록이면 지금 명세를 다시 보고, 위험 항목\(`\[위험: …\]` 표시가 있는 기능·규칙 줄\)이 생겼으면 거절한다/);
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
  assert.match(readme, /spec\.mjs approve <명세> - <<'EOF'/);
  assert.match(readme, /spec\.mjs delegate <명세> - <<'EOF'/);
  assert.match(readme, /따옴표 붙인 heredoc\(`-`\)으로 표준 입력에 넣는 쪽이 안전하다/);
  assert.match(readme, /에이전트가 일하는 도중에 사용자가 친 말\(대화 기록에는 `attachment` 줄로 남는다\)은 사용자 말이다/);
  assert.match(readme, /표시가 빠졌는지는 코드가 낱말로 찾지 않는다/);
  assert.match(readme, /만드는 중이거나 검수 중이면 status는 그대로 두고 기록만 더한다/);
  assert.match(readme, /이미 검수했는데도 기록이 없으면 훅이 돌지 않는 것이니/);
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
