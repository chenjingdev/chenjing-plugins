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
  // 완료 검사가 막는 것에 지문 비교와 승인 기록 확인(검수 번호의 짝, 승인 뒤 바뀐 [사용자] 줄)이 들어 있다
  assert.match(verify, /완료 검사가 막는 것은 아홉 가지다/);
  const blocks = /완료 검사가 막는 것은 아홉 가지다\.\n((?:- .*\n)+)/.exec(verify);
  assert.ok(blocks, '막는 것의 목록');
  assert.equal(blocks[1].trim().split('\n').length, 9, '목록은 센 숫자와 같은 아홉 줄이다');
  assert.match(blocks[1], /^- spec-checker가 짚은 `검수 n`에 짝이 없는 것, 또는 spec-checker가 끝난 기록이 없는 것: 명세에 `\[사용자: 검수 n\]`, `\[AI 가정: 검수 n 맡김\]`, `## 확인 필요`의 `- 검수 n: 안 물은 까닭` 중 하나가 있어야 한다\.$/m);
  assert.match(blocks[1], /^- 승인 뒤 바뀐 `\[사용자\]` 줄: 가장 최근 승인 기록의 `\[사용자\]` 줄과 지금 명세가 다르다\. 바꿔 달라고 한 사용자 말을 인용해 `spec\.mjs approve`로 다시 기록한다\(`build\.md`\)\.$/m);
  assert.match(blocks[1], /^- 읽지 못하거나 칸의 모양이 틀린 `summary\.json`: `headline`은 글, `todo`·`changes`는 배열, `decision`은 시나리오 id를 키로 하는 객체여야 한다\.$/m);
  assert.match(verify, /verifier가 끝난 뒤 바뀐 `results\.json`: 지금 파일의 지문이 가장 최근 verifier 기록과 다르거나, 그 기록이 없거나, 기록에 지문이 없다/);
  // 지문이 어긋난 두 경우를 나눠 적는다: 코드를 고쳐야 하면 build로, 코드는 맞고 결과만 바뀌었으면 verifier만 다시
  assert.match(verify, /결과가 틀려서 코드를 고쳐야 하면 build로 되돌려 고치고 verifier로 다시 검수한다\. 코드는 맞고 `results\.json`만 바뀐 것이면 verifier만 다시 돌린다/);
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
  assert.match(readme, /코드를 고쳐야 하면 build로 되돌려 고친 뒤 verifier로 다시 검수하라고, 코드는 맞고 `results\.json`만 바뀐 것이면 verifier만 다시 돌리라고 알린다/);
  // 훅이 못 보는 길: 변수로 만든 경로, 파일에 적은 스크립트, MCP 도구(hooks.json은 그대로)
  assert.match(readme, /훅이 못 보는 길도 있다: 변수로 만든 경로, 파일에 적어 둔 스크립트, MCP 도구\(메인 세션도 CUA의 `js`로 `fs\.writeFileSync`를 불러 실행 폴더에 쓸 수 있고, MCP 도구는 `hooks\.json`의 matcher에 없다\)/);
  assert.match(readme, /이름은 대소문자를 가리지 않고 본다/);
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

// ---------- 사용자만 답할 수 있음 항목의 짝(F5)과 승인 뒤 바뀐 [사용자] 줄(F3)을 문서가 가르친다 ----------

test('spec-checker numbers the questions only the person can answer, "없음" when there are none, and reports a missing risk mark under the small things the AI decides', () => {
  const checker = read('agents/spec-checker.md');
  // 번호: 항목마다 검수 1, 검수 2 … 를 줄 맨 앞에. 코드가 짝을 본다
  assert.match(checker, /"사용자만 답할 수 있음" 항목마다 `검수 1`, `검수 2` … 번호를 줄 맨 앞에 붙인다/);
  assert.match(checker, /메인 세션이 이 번호로 명세에 짝을 달고, 코드가 승인을 기록할 때와 완료 검사에서 번호마다 짝이 있는지 본다/);
  assert.match(checker, /^검수 1\. <질문> \(기본안: …\) — <답에 따라 결과가 어떻게 달라지는지>$/m);
  assert.match(checker, /^검수 2\. …$/m);
  assert.doesNotMatch(checker, /^1\. <질문>/m, '옛 번호 목록은 없다');
  assert.match(checker, /해당하는 것이 없는 무더기에는 "없음"이라고 적는다/);
  // 빠진 위험 표시: 뜻으로 보고, 사소함 — AI가 정함에 적는다
  assert.match(checker, /\*\*위험 표시 보기\.\*\*/);
  assert.match(checker, /`\[위험: 지우기\|공개\|비용\]` 표시가 없으면 알린다/);
  assert.match(checker, /낱말이 아니라 뜻으로 본다/);
  assert.match(checker, /"사소함 — AI가 정함"에 적는다/);
  assert.match(checker, /^- <F 또는 R 번호> \[위험: 지우기\|공개\|비용\] 표시 빠짐 — /m);
  // 그대로인 것: 고정 마지막 줄
  assert.equal(checker.trimEnd().split('\n').at(-1), '질문 라운드는 이것 한 번뿐입니다.');
});

test('probe 6 teaches the three pairs for a review number, the delegated default, the missing risk mark, and probe 5 makes 검수 items the exception to "only what changes the result"', () => {
  const probe = read('skills/pact/probe.md');
  // 5: 확인 필요에는 결과를 바꾸는 것만 — 검수 항목은 예외
  assert.match(probe, /- `## 확인 필요`에는 결과를 바꾸는 것만 적는다\. 예외는 검수 항목이다\./);
  assert.match(probe, /묻지 않고 넘어갔으면 결과를 바꾸지 않아도 `- 검수 n: 안 물은 까닭` 한 줄로 적는다/);
  // 6: 번호 짝 다는 법
  assert.match(probe, /항목마다 `검수 n` 번호가 붙어 온다/);
  assert.match(probe, /번호마다 명세에 짝을 단다\. 번호마다 아래 셋 중 하나가 있어야 한다\./);
  assert.match(probe, /그 답을 반영한 줄에 `\[사용자: 검수 n\]`을 단다/);
  assert.match(probe, /사용자가 그 질문을 맡겼으면\("네가 정해"\) 반영한 줄에 `\[AI 가정: 검수 n 맡김\]`을 단다/);
  assert.match(probe, /묻지 않았으면 `## 확인 필요`에 `- 검수 n: 안 물은 까닭`으로 적는다/);
  assert.match(probe, /번호 하나라도 짝이 없으면 `approve`·`delegate`와 완료 검사가 그 번호를 알리고 거절한다/);
  // 위임 중이면 기본안
  assert.match(probe, /승인까지 맡긴 위임 중이면 묻지 않고 기본안으로 정한다/);
  assert.match(probe, /위임 중이면 까닭은 '위임이라 기본안으로 정함'이다/);
  assert.match(probe, /검수 보고서의 할 일에 저절로 올라가니/);
  // 빠진 위험 표시 달기
  assert.match(probe, /위험 표시가 빠졌다는 알림\(`<번호> \[위험: …\] 표시 빠짐`\)이 오면 그 줄의 태그 앞에 표시를 단다/);
  // 승인 기록에 [사용자] 줄이 든다
  assert.match(probe, /기록에는 그때 `\[사용자\]` 줄들도 담긴다\(바뀌면 build\.md의 "\[사용자\] 항목을 바꿀 때"\)/);
  assert.doesNotMatch(probe, /참고:/);
});

test('every heredoc example the guidance shows closes with EOF at the start of the line, and probe 6 says so', () => {
  const files = [...PROSE, path.join(ROOT, 'README.md')];
  let examples = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^([ \t]*)```[^\n]*\n([\s\S]*?)^\1```[ \t]*$/gm)) {
      if (!m[2].includes("<<'EOF'")) continue;
      examples++;
      assert.equal(m[1], '', `${rel(file)}: 코드 블록을 들여쓰지 않는다(들여쓴 EOF는 heredoc을 끝내지 못한다)`);
      const body = m[2].split('\n');
      assert.ok(body.includes('EOF'), `${rel(file)}: EOF가 줄 맨 앞에 있다`);
      assert.ok(!body.some((line) => /^\s+EOF\s*$/.test(line)), `${rel(file)}: 들여쓴 EOF가 없다`);
    }
  }
  assert.ok(examples >= 2, `heredoc 예시를 찾았다(${examples})`);
  assert.match(read('skills/pact/probe.md'), /아래 예시는 들여쓰지 않고 그대로 쓴다\. 닫는 `EOF`는 줄 맨 앞에 와야 heredoc이 끝난다\./);
});

test('build.md says what to do when a [사용자] item changes after the approval: fix the spec, quote the person, approve again, go on with the status as it is; ask once if the person edited the file', () => {
  const build = read('skills/pact/build.md');
  assert.match(build, /^## `\[사용자\]` 항목을 바꿀 때$/m);
  assert.match(build, /승인한 뒤에 `\[사용자\]` 항목\(`\[사용자\]`나 `\[사용자: …\]` 태그가 붙은 기능·규칙 줄과 그 케이스\)이 바뀌면 `pact:worker` 부르기, `snapshot`, 완료 검사가 바뀐 줄을 알리고 거절한다/);
  assert.match(build, /줄의 글, 태그, 빼기, 더하기가 모두 바뀐 것이다\. `\[AI 가정\]` 줄만 바뀐 것은 막지 않는다/);
  assert.match(build, /막혔다고 실패로 끝내지 않고 다시 승인을 받아 이어 간다/);
  assert.match(build, /사용자가 바꿔 달라고 했으면 명세를 고치고, 바꿔 달라고 한 그 말을 그대로 인용해 `spec\.mjs approve <명세> - <<'EOF'`로 다시 기록한 뒤 하던 작업을 이어 간다/);
  assert.match(build, /부탁받은 변경이라 다시 묻지 않는다\. status는 `building` 그대로다/);
  assert.match(build, /인용하는 말은 앞 기록\(승인이든 위임이든\)에 쓴 어떤 메시지보다 새것이어야 하니, 앞서 쓴 말로 다시 기록하지 못한다/);
  assert.match(build, /사용자가 명세 파일을 직접 고쳤으면 부탁한 말이 없다\. 거절이 알려 준 바뀐 줄을 보이고 이대로 두는지 한 번 묻는다\. 그 답을 인용해 다시 기록한다/);
  assert.match(build, /`\[사용자\]` 항목은 사용자가 바꾸라고 하기 전에 바꾸지 않는다/);
  // 작업 지시 칸과 BLOCKED에서 이 절로 이어진다
  assert.match(build, /승인 뒤 `\[사용자\]` 줄이 바뀌었으면 `pact:worker` 호출이 막히고/);
  assert.match(build, /바꾸라는 답을 받으면 아래 "`\[사용자\]` 항목을 바꿀 때"를 따른다/);
  // approval.mjs의 주석이 가리키는 길이 실제로 문서에 있다
  assert.match(read('scripts/approval.mjs'), /다시 승인한 뒤 이어 가는 길은 build\.md의 "\[사용자\] 항목을 바꿀 때"가 말한다/);
  assert.ok(build.includes('## `[사용자]` 항목을 바꿀 때'));
});

test('SKILL.md, verify.md and the README say the same about the review pairs, the [사용자] lines kept in the record, and what the report shows', () => {
  const skill = read('skills/pact/SKILL.md');
  assert.match(skill, /하나는 spec-checker가 '사용자만 답할 수 있음'으로 짚은 `검수 n`마다 명세에 짝이 있는지다\(`\[사용자: 검수 n\]`, `\[AI 가정: 검수 n 맡김\]`, `## 확인 필요`의 `- 검수 n: 안 물은 까닭`\./);
  assert.match(skill, /승인 뒤 `\[사용자\]` 줄이 바뀌면 `pact:worker` 부르기, `snapshot`, 완료 검사가 바뀐 줄을 알리고 거절한다/);
  assert.match(skill, /바꿔 달라고 한 사용자 말을 인용해 `approve`로 다시 기록하면 이어 간다\(`build\.md`\)\. 옛 판은 이 둘을 건너뛴다/);
  assert.match(skill, /바꾸라는 답을 받으면 명세를 고치고 그 말을 인용해 다시 승인을 기록한다/);
  const verify = read('skills/pact/verify.md');
  assert.match(verify, /명세 `## 확인 필요`의 검수 항목\(사용자에게 묻지 않고 정한 것\)은 할 일 칸에 저절로 올라간다/);
  assert.match(verify, /승인 기록\(승인인지 위임인지, 인용한 말, 승인 뒤 바뀐 `\[사용자\]` 줄과 다시 승인한 말, 옛 판 표시\)과 완료 검사의 참고 줄도 실리고/);
  assert.match(verify, /옛 판\(`pact: 1`이고 승인 기록이 없는 명세\)은 검수 번호 짝과 `\[사용자\]` 줄 확인도 건너뛴다/);
  assert.match(verify, /바꾸라는 답을 받으면 `build\.md`의 "`\[사용자\]` 항목을 바꿀 때"대로 명세를 고치고 그 말을 인용해 다시 승인을 기록한 뒤 build로 돌아간다/);
  const readme = read('README.md');
  assert.match(readme, /그때의 `\[사용자\]` 줄\(`user_lines`\)을 `approvals\.jsonl`에 한 줄 덧붙인다/);
  assert.match(readme, /- 검수 번호의 짝\(F5\): spec-checker는 '사용자만 답할 수 있음' 항목마다 `검수 1`, `검수 2` … 번호를 붙인다/);
  assert.match(readme, /짝이 빠진 번호는 그 번호를 알리고 거절한다\. 칸이 "없음"이면 통과하고, 번호도 "없음"도 읽지 못하면 거절한다/);
  assert.match(readme, /완료 검사는 새 명세에 spec-checker 기록이 없으면 거절한다/);
  assert.match(readme, /- 승인 뒤 바뀐 `\[사용자\]` 줄\(F3\): /);
  assert.match(readme, /글·태그가 바뀌었거나 줄을 빼거나 더했으면 바뀐 줄을 알리고 거절한다/);
  assert.match(readme, /사용자가 파일을 직접 고쳤으면 한 번 묻고 그 답을 인용한다\. `\[AI 가정\]` 줄만 바뀐 것은 막지 않는다/);
  assert.match(readme, /이미 기록이 있으면 승인이든 위임이든 인용하는 말이 앞 기록들에 쓴 어떤 메시지보다 새것이어야 한다/);
  assert.doesNotMatch(readme, /다시 승인하면 앞 기록의 메시지보다 새 말이어야 한다\. 위임은 처음 부탁에 있는 말이어도 된다/, '옛 문구: 위임은 같은 말로 다시 기록할 수 있다는 말은 없다');
  assert.match(readme, /옛 판은 '옛 판이라 승인 기록 없음'이라고 적는다/);
  assert.match(readme, /메시지 전문, 기록한 시각을 보이고, 앞 기록 뒤로 바뀐 `\[사용자\]` 줄은 그것을 다시 승인한 인용 옆에 둔다/);
  assert.match(readme, /명세 `## 확인 필요`의 `검수 n` 항목\(사용자에게 묻지 않고 정한 것\)은 할 일 칸에 저절로 올린다/);
  assert.match(readme, /승인 뒤 `\[사용자\]` 줄이 바뀌었으면 막는다\(옛 판은 통과\)/);
});

test('the refusals the scripts and the hook print tell only the standard-input way to pass the person\'s words, never the quoted argument form a backtick could run through', () => {
  // 큰따옴표로 감싼 인자는 긴 말 속 백틱이 셸에서 실행될 수 있다. 사용법(spec.mjs의 USAGE)도 같다.
  for (const file of ['scripts/approval.mjs', 'scripts/spec.mjs', 'scripts/verification.mjs', 'scripts/locks.mjs', 'scripts/report.mjs', 'hooks/guard.mjs']) {
    const text = read(file);
    assert.doesNotMatch(text, /(?:approve|delegate)\s+<명세>\s+"/, `${file}에 큰따옴표 인자 꼴이 없다`);
    assert.ok(!text.includes('"<사용자 말>"'), `${file}에 "<사용자 말>" 꼴이 없다`);
  }
  const approval = read('scripts/approval.mjs');
  assert.match(approval, /const approveCmd = \(verb = 'approve'\) => `spec\.mjs \$\{verb\} <명세> - <<'EOF'`;/);
  assert.match(approval, /const HEREDOC_HOW = '다음 줄에 사용자 말을, 그다음 줄 맨 앞에 EOF를 적는다';/);
});
