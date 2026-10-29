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

test('worker reports with Ruling lines and a status of DONE or BLOCKED, and writes every worry in its own field whatever the status', () => {
  const text = read('agents/worker.md');
  assert.ok(text.includes('Ruling:'));
  assert.ok(text.includes('Ruling: <무엇을 정했나> — <왜> — <틀리면 무엇을 잃나>'));
  // 상태는 둘이다. 걱정은 상태가 아니라 칸에 쓴다(F7, R16)
  assert.ok(!text.includes('DONE_WITH_CONCERNS'), 'DONE_WITH_CONCERNS는 없어졌다');
  assert.ok(!text.includes('PARTIAL'), 'PARTIAL도 없어졌다');
  assert.match(text, /^## 상태: DONE \| BLOCKED$/m);
  assert.match(text, /상태는 둘이다\. 끝냈으면 `DONE`, 멈추고 물어야 하면 `BLOCKED`다\. 마음에 걸리는 것은 상태와 상관없이 `## 걱정·위험`에 쓴다\. 없으면 "없음"이다\./);
  assert.match(text, /^## 걱정·위험\n- <마음에 걸리는 것 한 줄에 하나\. 메인 세션이 봐야 할 것, 지시 안의 모순> \(없으면 "없음"\)\n보고서: <run-dir>\/tasks\/<n>-report\.md$/m);
  assert.match(text, /훅이 이 칸을 reviewer의 작업 지시 끝에 붙이고 reviewer가 걱정마다 맞는지 보니, 한 줄에 하나씩 쓴다/);
  // 마지막 줄은 그대로다: 훅이 작업 번호를 이 줄에서 읽는다
  assert.match(text, /\n보고서: <run-dir>\/tasks\/<n>-report\.md\n```/);
});

test('worker uses the commit trailer its own harness gives and does not raise a trailer that differs from the brief or from other commits as a worry (R17)', () => {
  const text = read('agents/worker.md');
  assert.match(text, /커밋 꼬리말\(`Co-Authored-By` 등\)은 당신의 하네스가 주는 대로 쓴다\. 지시나 다른 곳의 꼬리말과 다르다는 것은 걱정으로 올리지 않는다\./);
  assert.match(text, /^5\. 작업 하나가 끝나면 worktree 안에서 커밋한다\. push는 하지 않는다\. 커밋 꼬리말/m, '커밋하는 단계에서 말한다');
});

test('reviewer answers every worry attached to its brief in a "## worker 걱정 처리" field: whether it is true and whether to fix it now, "없음" when none is attached', () => {
  const text = read('agents/reviewer.md');
  // 입력: 지시 끝에 붙은 걱정은 훅이 붙인 worker의 주장이다
  assert.match(text, /- 지시 끝의 `## worker 걱정`\(없을 수 있다\)\. worker가 마지막 답의 `## 걱정·위험`에 쓴 것을 훅이 붙였다\. 이것도 확인하지 않은 주장이다\./);
  assert.match(text, /- \*\*worker 걱정\*\*: 지시 끝에 `## worker 걱정`이 있으면 걱정마다 diff와 파일로 맞는지 보고 이번에 고칠지 정한다\. 이번에 고칠 것은 `## 지적`에도 올린다\./);
  // 결과 형식: 지적 다음, 판정 앞. 판정이 맨 끝에 남는다
  const format = /## 결과 — 이 형식 그대로\n\n```\n([\s\S]*?)\n```/.exec(text)?.[1] ?? '';
  const headings = format.split('\n').filter((line) => /^## /.test(line));
  assert.deepEqual(headings, ['## 명세 대조', '## 지적', '## worker 걱정 처리', '## 판정: 통과 | 고칠 것 있음']);
  assert.match(format, /^## worker 걱정 처리\n- <걱정 한 줄 요약> — 맞음 \| 틀림 \| 확인 못 함 — 이번에 고친다 \| 안 고친다\(<이유>\)  \(붙은 걱정이 없으면 "없음"\)\n## 판정/m);
  // 처리하는 법
  assert.match(text, /지시 끝에 `## worker 걱정`이 붙어 있으면 걱정마다 한 줄씩 `## worker 걱정 처리`에 적는다: 맞는지, 이번에 고칠지\./);
  assert.match(text, /붙은 걱정이 없으면 "없음"이라고 쓴다\./);
  assert.match(text, /이번에 고치기로 한 것은 `## 지적`의 중요 이상에 올리니 판정이 `고칠 것 있음`이 된다\./);
  assert.match(text, /안 고치는 걱정은 이유를 적는다/);
  assert.match(text, /두 번째 검토 메시지 끝에 붙은 걱정은 고친 뒤의 worker 답의 것이다\. 같은 형식으로 처리한다\./);
  assert.equal(text.trimEnd().split('\n').at(-1).includes('고칠 것 있음'), true, '판정을 말하는 문단이 맨 끝이다');
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

test('build.md: the brief carries no commit trailer, the worker status is DONE or BLOCKED, and the worker worries reach the reviewer through the hook while the main session reads them', async () => {
  const build = read('skills/pact/build.md');
  assert.ok(!build.includes('DONE_WITH_CONCERNS'), '옛 3.2는 없어졌다');
  assert.ok(!build.includes('PARTIAL'));
  assert.doesNotMatch(build, /걱정을 읽고 검토자에게 같이 넘긴다/);
  // 작업 지시(네 칸)에 꼬리말을 넣지 않는다(R17)
  assert.match(build, /커밋 꼬리말\(`Co-Authored-By`, 세션 줄\)은 네 칸 어디에도 넣지 않는다\. worker가 자기 하네스가 주는 꼬리말을 쓴다\. 꼬리말이 다르다는 것은 걱정으로 올라오지 않는다\./);
  // 3.2: 상태는 둘, 걱정은 읽고 알릴 것을 본다, 넘기는 일은 훅이 한다
  assert.match(build, /^2\. 답장의 상태를 본다\. 상태는 `DONE`과 `BLOCKED` 둘이다\. `## 걱정·위험`이 "없음"이 아니면 읽고 사용자에게 알릴 것이 있는지 본다/m);
  assert.match(build, /걱정을 검토자에게 넘기는 일은 훅이 한다\. 직접 옮겨 적지 않는다\./);
  // 3.3: 번호는 늘 맨 앞에, 훅이 붙이는 것, 붙지 않는 때, 번호를 못 읽을 때의 거절, reviewer의 처리 칸, 처리 칸이 "없음"일 때
  assert.match(build, /보고서 경로는 이 작업 것\(`<run-dir>\/tasks\/<n>-report\.md`\)이다\. reviewer 지시 맨 앞에 늘 `작업 번호 n`을 적는다\./);
  assert.doesNotMatch(build, /다른 작업의 보고서 경로를 같이 적으면 `작업 번호 n`도 적는다/, '조건부 규칙은 없어졌다');
  assert.match(build, /훅이 이 경로로 판을 찾고 그 번호로 그 작업의 가장 최근 worker 답에서 `## 걱정·위험` 칸을 꺼내 지시 끝에 `## worker 걱정`으로 붙인다\./);
  assert.match(build, /걱정이 "없음"이거나 그 번호의 worker 기록이 없으면 붙이지 않는다\./);
  assert.match(build, /판은 찾았는데 작업 번호를 못 읽으면 훅이 호출을 막고 까닭과 대신 할 일을 한 줄로 알린다\./);
  assert.match(build, /reviewer는 답의 `## worker 걱정 처리`에 걱정마다 맞는지, 이번에 고칠지를 적는다\./);
  assert.match(build, /worker 답의 `## 걱정·위험`이 "없음"이 아닌데 reviewer 답의 `## worker 걱정 처리`가 "없음"이거나 아예 없으면, 같은 reviewer에 `## worker 걱정` 제목을 달아 SendMessage로 넘긴다\. 이 답이 첫 검토의 판정이고, 두 번째 검토로 세지 않는다\./);
  // 3.5: 두 번째 검토도 같은 길이다. 세 번째 검토는 없다는 문장은 그대로 이어진다
  assert.match(build, /reviewer는 이름 없이 띄우고, 두 번째 검토는 `to`에 agentId를 쓰고 글에 이 작업 보고서 경로를 넣는다\. 그러면 훅이 고친 뒤의 worker 답의 걱정을 message 끝에 `## worker 걱정`으로 붙인다\./);
  assert.ok(build.includes('한 번 더 검토받는다. reviewer는 이름 없이 띄우고,'), '두 번째 검토 문장 안에 있다');
  assert.ok(build.includes('이 두 번째 검토에서도 고칠 것이 있으면 당신이 직접 고치고 완료 기준 명령을 돌린 뒤 넘어간다. 세 번째 검토는 없다.'));
  // 문서와 코드가 같은 제목·칸 이름을 말한다
  const { CONCERNS_HEADING } = await import('../scripts/concerns.mjs');
  assert.equal(CONCERNS_HEADING, '## worker 걱정');
  for (const [name, text] of [['build.md', build], ['reviewer.md', read('agents/reviewer.md')], ['README.md', read('README.md')]]) {
    assert.ok(text.includes(`\`${CONCERNS_HEADING}\``), `${name}가 붙는 제목 ${CONCERNS_HEADING}를 말한다`);
  }
  assert.ok(read('agents/worker.md').includes('## 걱정·위험'));
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
  assert.match(blocks[1], /^- 승인 기록과 `\[사용자\]` 줄: 새 명세에 승인 기록이 하나도 없거나, 가장 최근 기록에 `\[사용자\]` 줄이 없어 견줄 수 없거나, 승인 뒤 `\[사용자\]` 줄이 바뀌었다\(가장 최근 승인 기록의 `\[사용자\]` 줄과 지금 명세가 다르다\)\. 바꿔 달라고 한 사용자 말을 인용해 `spec\.mjs approve`로 다시 기록한다\(`build\.md`\)\.$/m);
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
  // 옛 판 줄은 report.mjs가 보고서 맨 위 상자에 붙인다: 메인이 headline에 또 쓰지 않는다
  assert.match(build, /`set-status`가 `참고: 옛 판이라 승인 기록 없음`을 알려도 보고서에는 따로 적지 않는다\. `report\.mjs`가 보고서 맨 위 상자와 승인 기록 칸에 옛 판 줄을 붙이니 `summary\.json`의 headline에 또 쓰지 않는다\./);
  assert.doesNotMatch(build, /보고서에도 그렇다고 적는다/);
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
  // 다시 부르면 앞 회차의 번호 다음부터: 겹치면 묻지 않은 새 질문이 앞 회차의 짝으로 지나간다
  assert.match(checker, /번호는 1부터 붙이되, 명세에 `검수 n` 번호가 이미 있으면\(`\[사용자: 검수 n\]`, `\[AI 가정: 검수 n 맡김\]`, `## 확인 필요`의 `- 검수 n:`\) 앞 회차에 붙은 번호이니 그 가운데 가장 큰 번호 다음부터 붙인다/);
  assert.match(checker, /번호가 겹치면 앞 회차의 짝이 새 질문의 짝으로 읽혀 묻지 않은 질문이 지나간다/);
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
  assert.match(probe, /답은 기능·규칙 줄이나 그 케이스에 단다\. `\[AI 가정\]` 항목의 케이스 줄에 달아도 되고, 그 케이스 줄만 `\[사용자\]` 줄로 지켜진다\(build\.md\)/);
  assert.match(probe, /태그는 줄 끝에 달고 콜론은 반각 `:`으로 쓴다\. 목적·범위 칸이나 줄 가운데에 단 태그, 전각 콜론 `：`의 태그는 짝으로 세지 않는다/);
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
  assert.match(build, /`\[AI 가정\]` 항목 밑의 케이스 줄에 `\[사용자\]`나 `\[사용자: …\]` 태그가 붙어 있으면\(검수 질문에 사용자가 답한 케이스\) 그 줄만 `\[사용자\]` 줄이다\. 머리 줄과 다른 케이스 줄은 알아서 고쳐도 되지만 그 케이스 줄은 사용자가 바꾸라고 하기 전에 바꾸지 않는다/);
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
  assert.match(readme, /짝으로 세는 태그는 기능·공통 규칙 항목의 줄\(머리 줄과 케이스 줄, 접힌 칸 포함\) 끝에 단 것이다\. lint가 태그로 읽는 규칙 그대로라서 목적·범위 칸의 태그, 줄 가운데의 태그, 전각 콜론\(`：`\)의 태그는 세지 않는다\(전각 콜론이면 거절 문구가 그렇다고 알린다\)/);
  assert.match(readme, /spec-checker는 번호를 1부터 붙이되 명세에 이미 번호가 있으면 가장 큰 번호 다음부터 붙인다/);
  assert.match(readme, /답에 같은 이름의 머리말이 있어도 `#` 제목 칸을 먼저 보고, 번호나 "없음"을 읽은 칸을 고른다/);
  assert.match(readme, /`\[AI 가정\]` 항목 밑 케이스 줄에 `\[사용자\]` 태그가 붙어 있으면\(검수 질문에 사용자가 답한 케이스\) 머리 줄은 빼고 그 줄만 따로 들어간다\(`F3\/1`: 그 항목의 `\[사용자\]` 케이스 줄 가운데 첫째\)/);
  assert.match(readme, /그래서 머리 줄과 다른 케이스 줄은 AI가 고쳐도 걸리지 않고, F5가 짝으로 센 줄은 F3가 지킨다/);
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

test('plugin.json is at 0.6.0', () => {
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(manifest.name, 'pact');
  assert.equal(manifest.version, '0.6.0');
});

test('the README lists what 0.6.0 changed in one short section, and says how the hook hands the worker worries to the reviewer, in the brief and in a message', () => {
  const readme = read('README.md');
  const section = /^## 0\.6\.0에서 바뀐 것\n([\s\S]*?)(?=\n## )/m.exec(readme)?.[1] ?? '';
  const bullets = section.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(bullets.length, 8, '바뀐 것 여덟 가지가 한 줄씩이다');
  const names = ['훅', '승인·위임 기록', '결과 잠금', '`summary.json`', '검수 번호 짝', '`[사용자]` 줄 확인', 'worker 걱정 넘기기', 'worker 상태'];
  names.forEach((name, i) => assert.ok(bullets[i].startsWith(`- ${name}: `), `${i + 1}번째는 ${name}: ${bullets[i]}`));
  assert.ok(bullets.every((line) => line.length < 260), '한 줄이 짧다');
  assert.match(bullets[0], /pact와 상관없는 호출은 읽지도 않고 통과시킨다\(메인 세션이 agent id 꼴 `to`로 보내는 SendMessage만 받는 쪽을 찾으려고 `log\/`를 읽는다\)\./);
  assert.match(bullets[6], /reviewer를 부를 때 훅이 그 작업의 worker 답에서 `## 걱정·위험`을 꺼내 지시 끝에 `## worker 걱정`으로 붙이고, reviewer는 답의 `## worker 걱정 처리`에 걱정마다 어떻게 했는지 적는다/);
  assert.match(bullets[7], /`DONE`과 `BLOCKED` 둘이다\. 마음에 걸리는 것은 상태와 상관없이 `## 걱정·위험`에 쓰고, 작업 지시에는 커밋 꼬리말을 넣지 않는다/);
  // 훅 절: 항목 머리말이 순서대로 다 있다(worker 걱정 항목을 더하다 다른 항목을 지우지 않았는지)
  const hook = /^## 훅\n([\s\S]*?)(?=\n## )/m.exec(readme)?.[1] ?? '';
  const hookBullets = hook.split('\n').filter((line) => line.startsWith('- '));
  const heads = ['- PreToolUse: ', '- PreToolUse(결과 잠금): ', '- 한계(결과 잠금): ', '- PreToolUse(worker 걱정): ', '- 한계: ', '- SubagentStop: ', '- 훅이 고장나도 대화를 막지 않는다. '];
  assert.equal(hookBullets.length, heads.length, hookBullets.map((line) => line.slice(0, 20)).join(' / '));
  heads.forEach((head, i) => assert.ok(hookBullets[i].startsWith(head), `${i + 1}번째 항목은 "${head}"로 시작한다: ${hookBullets[i].slice(0, 30)}`));
  // 머리말: 상관없는 호출은 읽지 않는다. 예외는 메인 세션의 SendMessage 하나다(guard.mjs 머리말과 같은 말)
  assert.match(hook, /아무것도 읽지 않고 바로 통과시킨다\(메인 세션이 agent id 꼴 `to`로 보내는 SendMessage만 예외다\. 받는 쪽이 reviewer인지 `log\/`를 읽어 본다\)\./);
  // worker 걱정 항목
  assert.match(hook, /- PreToolUse\(worker 걱정\): 메인 세션이 `pact:reviewer`를 부르면 지시문의 판\(보고서 경로의 run-dir\)과 작업 번호\(`작업 번호 n`, 없으면 보고서 경로가 하나일 때 그 번호\)로 `log\/`에서 그 작업의 가장 최근 worker 답을 찾아 `## 걱정·위험` 칸을 지시 끝에 `## worker 걱정`으로 붙이고 통과시킨다\(입력의 다른 칸은 그대로 둔다\)\./);
  assert.match(hook, /판은 찾았는데 작업 번호를 못 읽으면 걱정이 말없이 빠지지 않게 호출을 막고, 까닭과 대신 할 일\(지시 맨 앞에 `작업 번호 3`처럼 작업 번호를 숫자로 적어 다시 부른다\)을 한 줄로 알린다\./);
  assert.match(hook, /지시문에서 판을 못 찾았을 때, 그 번호의 worker 기록이 없을 때, 걱정이 '없음'이거나 비었을 때, 이미 `## worker 걱정`이 있을 때는 그대로 통과한다\./);
  assert.match(hook, /메인 세션이 같은 reviewer에 SendMessage로 보낼 때도, `to`가 `log\/`에 reviewer로 남은 agent id이면 그 작업의 가장 최근 worker 답\(고친 뒤의 답\)의 걱정을 message 끝에 붙인다\./);
  assert.match(hook, /이쪽은 막지 않고 그대로 통과한다: `to`가 agent id가 아니거나 `log\/`에 없을 때, 그 reviewer의 작업 번호를 모를 때, 글이 그 reviewer의 작업과 다른 작업 번호를 말할 때, 이미 `## worker 걱정`이 있을 때, worker 기록이 없거나 걱정이 없을 때\./);
  assert.match(hook, /걱정은 worker 보고서가 아니라 `log\/`의 worker 답에서 가져온다\./);
  assert.match(hook, /에이전트에 이름을 붙여 이름으로 보내면 받는 쪽을 알 수 없어 붙이지 않는다\./);
  assert.match(hook, /SendMessage는 글에 pact 흔적이 없어도 `to`가 id 꼴이면 cwd 프로젝트\(또는 글이 가리키는 프로젝트\)의 `\.pact\/` 밑 `log\/`를 읽어 받는 쪽을 찾는다\. pact 프로젝트가 아니면 읽을 것이 없고, 아무것도 쓰지 않는다\./);
  // 한계: tiers와 같이 켜졌을 때(메인이 정함)
  assert.match(hook, /- 한계: tiers 플러그인의 delegate가 켜져 있으면 같은 `pact:reviewer` 호출에 tiers\(model 고정\)와 pact\(걱정 붙이기\)가 둘 다 입력을 바꾸고, 어느 쪽이 남는지는 정해져 있지 않다\(불확실\)\. tiers delegate는 기본으로 꺼져 있다\./);
  // SubagentStop: reviewer의 작업 번호는 훅이 붙인 걱정 칸 앞까지 읽는다
  assert.match(hook, /`pact:reviewer`의 작업 번호는 첫 지시에서 훅이 붙인 `## worker 걱정` 칸 앞까지만 읽는다\. 걱정 글 속의 번호와 경로가 작업 번호와 판을 바꾸지 않게 한다\./);
  assert.ok(!readme.includes('DONE_WITH_CONCERNS') && !readme.includes('PARTIAL'));
});

test('the README lists the shell writes the hook cannot read in its own 한계 item, and says a result file changed that way is caught by the fingerprint of the completion check (R14)', () => {
  const readme = read('README.md');
  const lines = readme.split('\n');
  const limit = lines.find((line) => line.startsWith('- 한계(결과 잠금): '));
  assert.ok(limit, '한계(결과 잠금) 항목');
  for (const form of ['`perl -e`', '`ruby -e`', '`awk`', '`sed`의 `w` 명령', '`curl -o`', '`tar -C`', 'python의 `os.open`', 'node의 `fs.openSync`', '`fs.promises.writeFile`']) {
    assert.ok(limit.includes(form), `훅이 못 보는 쓰기 꼴에 ${form}이 있다`);
  }
  assert.match(limit, /셸 한 줄 안의 쓰기 가운데 읽지 못하는 꼴이 있다: `perl -e`·`ruby -e`·`awk`, `sed`의 `w` 명령, `curl -o`, `tar -C`, python의 `os\.open`, node의 `fs\.openSync`·`fs\.promises\.writeFile`\. 이 꼴들은 막지 않는다\./);
  assert.match(limit, /위 결과 잠금 항목에 적은 못 보는 길\(변수로 만든 경로, 파일에 적어 둔 스크립트, MCP 도구\)도 마찬가지다\./);
  assert.match(limit, /이 길들로 `results\.json`을 바꾸면 완료 검사의 지문 비교가 잡는다\. 지문은 verifier가 끝날 때 훅이 남긴 `results\.json`의 sha256이고, 지금 파일과 다르면 완료 검사가 막는다\./);
  // 지문이 지키는 것은 results.json 하나다: 승인 기록과 log/(verifier 지문 기록 포함)는 같은 길로 써도 잡는 그물이 없다
  assert.match(limit, /지문이 지키는 것은 `results\.json` 하나다\. 같은 꼴로 `approvals\.jsonl`\(승인 기록\)이나 `log\/`\(verifier 지문 기록 포함\)에 쓰면 잡는 그물이 없다\./);
  assert.match(limit, /꾸민 승인 기록으로 만들기가 시작되고\(승인 기록은 시작할 때 인용을 다시 맞춰 보지 않는다\. 다시 맞춰 보는 것은 위임 기록뿐이다\), `log\/`의 verifier 줄을 꾸미면\(완료 검사는 `log\/`의 가장 최근 verifier 줄을 믿는다\) `results\.json` 비교도 지나간다\./);
  assert.match(limit, /이 장치는 실수와 흔한 꼼수를 막는 것이고 일부러 속이는 쓰기까지 막지는 않는다\. 승인 기록의 인용은 보고서에 보이니 사용자가 거기서 본다\./);
  assert.doesNotMatch(limit, /결과 파일을 바꾸면/, '결과 파일이라고 뭉뚱그려 말하지 않는다: 지문이 지키는 것은 results.json이다');
  // 결과 잠금 항목의 못 보는 길 문장은 그대로 있고, 한계 항목은 그 바로 뒤에 온다
  const lockIndex = lines.findIndex((line) => line.startsWith('- PreToolUse(결과 잠금): '));
  assert.ok(lines[lockIndex].includes('훅이 못 보는 길도 있다: 변수로 만든 경로, 파일에 적어 둔 스크립트, MCP 도구'));
  assert.equal(lines.indexOf(limit), lockIndex + 1);
  // 결과 잠금 항목과 결과 파일 절의 "그물"도 results.json으로 좁혔다. 승인 기록과 log/는 지키지 않는다고 한계 항목을 가리킨다
  assert.ok(lines[lockIndex].endsWith('그 길로 `results.json`을 바꾸면 완료 검사의 지문 비교가 막는다. `approvals.jsonl`과 `log/`는 지문이 지키지 않는다(아래 한계).'));
  assert.ok(!readme.includes('그 길은 완료 검사의 지문 비교가 막는다'), '지문이 막는 범위를 뭉뚱그린 옛 문장은 없다');
  assert.match(readme, /로 `results\.json`이 바뀐 것을 잡는 마지막 그물이다\. `approvals\.jsonl`과 `log\/`는 이 그물이 지키지 않는다\(훅 절의 한계\)\./);
  // 쓰기 꼴 목록은 이 항목에만 있다
  assert.equal(readme.split('`perl -e`').length - 1, 1, '쓰기 꼴 목록은 한계 항목에만 있다');
});

test('README and probe.md say that a delegation never takes an AskUserQuestion answer (R2), that a command a person typed counts through its arguments (R9), and that the report shows an old edition at the top (R5)', () => {
  const readme = read('README.md');
  const probe = read('skills/pact/probe.md');
  // R2: 질문 도구의 답은 승인에만
  assert.match(readme, /# 승인까지 맡긴다는 말: .*\(사용자가 직접 쓴 말만, 질문 도구의 답은 안 된다\)/);
  assert.match(readme, /# 승인 질문의 답: .*\(질문 도구의 답도 된다\)/);
  assert.match(readme, /단 질문 도구의 답은 승인에만 쓴다\./);
  assert.match(readme, /위임은 질문 도구의 답을 받지 않는다\(R2\): 질문 하나의 답으로 온 "알아서"는 그 질문만 맡긴 것이라, `delegate`에 넣으면 질문 도구의 답이라고 거절하고 승인 질문의 답이면 `approve`로 기록하라고 알린다\./);
  assert.match(readme, /위임은 사용자가 직접 쓴 말\(친 말, 일하는 도중에 친 말, 슬래시 명령의 인자\)을 인용한다\. 같은 말을 직접 쓴 것도 있으면 그쪽으로 기록한다\./);
  assert.match(readme, /다만 코드가 가려내는 것은 질문 도구의 답뿐이다\. 채팅으로 물은 질문에 사용자가 친 답은 코드가 가리지 못하니 `probe\.md`를 따른다\(질문 하나의 답은 위임으로 치지 않는다\)\./);
  assert.match(readme, /질문 도구의 답으로 만든 옛 위임 기록\(기록에 `answer_question`이 있다\)도 거절한다\. 사용자에게 승인을 다시 받아 `approve`로 기록하거나, 직접 쓴 새 말을 인용해 `delegate`로 다시 기록하면 이어 간다\./);
  assert.match(probe, /질문 도구\(AskUserQuestion\)로 고른 답은 `delegate`가 거절한다\. 승인 질문의 답이면 `approve`로 기록하고, 위임은 사용자가 직접 쓴 말을 인용한다\./);
  assert.match(probe, /질문 도구\(AskUserQuestion\)로 고른 답도 같다\. 승인은 명세 경로와 요지를 본 뒤의 명시적인 답에만 해당한다\./, '승인에는 질문 도구의 답을 그대로 쓴다');
  // R9: 슬래시 명령의 인자
  assert.match(readme, /작업 알림, 대화 요약, 인자 없는 명령 메시지, `system-reminder`/);
  assert.match(readme, /- 슬래시 명령의 인자\(R9\): 사람이 친 슬래시 명령\(`\/pact:pact 출결 앱 만들어 줘\. 끝까지 알아서 해`\)의 인자 글도 사용자 말이다\./);
  assert.match(readme, /origin이 human이고 `<command-args>`에 글이 있는 줄만 읽고, 인용은 그 인자 글에 대고 맞춰 본다\. 명령 이름과 태그는 뺀다\./);
  assert.match(readme, /인자가 없거나 비었거나 공백뿐인 명령, origin이 없는 내장 명령\(`\/effort`, `\/mcp` 등\), 모델이 Skill 도구로 부른 스킬의 인자\(assistant의 `tool_use`로만 남는다\)는 사용자 말이 아니다\./);
  assert.match(readme, /맞춰 보는 기준은 그냥 친 메시지와 같다\. 정리해서 10자 이하인 짧은 말은 인자 전체와 같아야 하고, 그보다 길면 인자의 일부여도 된다\. 위 예에서 `끝까지 알아서 해`\(7자\)만 인용하면 거절하고, 인자 전체나 `만들어 줘\. 끝까지 알아서 해`\(11자\)처럼 10자를 넘는 부분을 인용하면 기록한다\./);
  // 문장 하나로 맞춰 보는 예외는 없다: 어느 메시지든 R3가 같다
  assert.doesNotMatch(readme, /인자 안의 문장 하나|문장 하나와 같/);
  assert.match(probe, /위임으로 인용하는 말도 승인과 같은 기준으로 맞춰 본다\. 짧은 말\(띄어쓰기·문장부호를 뺀 10자 이하\)은 메시지 전체와 같아야 하고, 그보다 길게 인용하면 일부여도 된다\./);
  assert.match(probe, /`\/pact:pact` 뒤에 적은 말\(명령 인자\)도 사용자가 직접 쓴 말이라 위임으로 인용할 수 있고, 이때는 인자 전체가 메시지다\. "\/pact:pact 출결 앱 만들어 줘\. 끝까지 알아서 해"에서 "끝까지 알아서 해"만 넣으면 거절되니 인자 전체나 "만들어 줘\. 끝까지 알아서 해"를 넣는다\./);
  assert.doesNotMatch(probe, /"끝까지 알아서 해"로 위임할 수 있다/, '짧은 말만 인용해도 된다는 옛 문구는 없다');
  // R5: 옛 판 표시는 맨 위 상자에도 있고 스크립트가 붙인다
  assert.match(readme, /보고서 맨 위 상자와 승인 기록 칸에 '옛 판이라 승인 기록 없음'이라고 적는다/);
  assert.match(readme, /이 줄은 맨 위 상자에도 늘 있다\. 메인 세션이 `summary\.json`에 쓴 headline과 상관없이 스크립트가 붙이고, 새 판에는 없다\./);
});
