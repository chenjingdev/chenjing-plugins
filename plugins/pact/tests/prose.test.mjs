// 프롬프트 파일(스킬, 에이전트)과 코드가 서로 맞물리는 곳만 본다: 글이 부르는 명령·에이전트·파일이 실제로 있는지,
// 훅과 스크립트가 읽는 답의 칸 이름이 글에 그대로 있는지. 글의 문장은 붙들지 않는다. 문장이 값을 하는지는 견주기 실험(docs/evidence)이 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : [];
  });
const PROSE = [...walk(path.join(ROOT, 'skills')), ...walk(path.join(ROOT, 'agents'))];
const GUIDANCE = [...PROSE, path.join(ROOT, 'README.md')];
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const rel = (p) => path.relative(ROOT, p);
const AGENTS = readdirSync(path.join(ROOT, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const out = {};
  for (const line of (m?.[1] ?? '').split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

test('the agents are worker, reviewer and verifier, each with a name, a description and a model', () => {
  assert.deepEqual([...AGENTS].sort(), ['reviewer', 'verifier', 'worker']);
  for (const a of AGENTS) {
    const fm = frontmatter(read(`agents/${a}.md`));
    assert.equal(fm.name, a);
    assert.ok(fm.description, `${a} description`);
    assert.ok(fm.model, `${a} model`);
  }
});

test('the reviewer cannot edit files and no agent but the main session spawns agents: the tool list says so, not a sentence', () => {
  const reviewer = frontmatter(read('agents/reviewer.md')).disallowedTools ?? '';
  for (const tool of ['Edit', 'Write', 'Agent']) assert.match(reviewer, new RegExp(`\\b${tool}\\b`));
  assert.match(frontmatter(read('agents/verifier.md')).disallowedTools ?? '', /\bAgent\b/);
});

test('every pact agent the guidance names exists, and the hook knows the same set', async () => {
  const { PACT_AGENTS } = await import('../hooks/guard.mjs');
  assert.deepEqual([...PACT_AGENTS].sort(), AGENTS.map((a) => `pact:${a}`).sort());
  for (const file of GUIDANCE) {
    for (const [, name] of readFileSync(file, 'utf8').matchAll(/`pact:([a-z-]+)`/g)) {
      if (name === 'pact' || name === 'recall') continue; // 스킬
      assert.ok(AGENTS.includes(name), `${rel(file)}가 없는 에이전트 pact:${name}을 부른다`);
    }
  }
});

test('every script the guidance tells the model to run exists', () => {
  let seen = 0;
  for (const file of GUIDANCE) {
    for (const [, name] of readFileSync(file, 'utf8').matchAll(/<pact>\/scripts\/([\w/-]+\.mjs)/g)) {
      seen++;
      assert.ok(existsSync(path.join(ROOT, 'scripts', name)), `${rel(file)}가 없는 스크립트 ${name}을 부른다`);
    }
  }
  assert.ok(seen > 10, `스크립트 호출을 찾았다(${seen})`);
});

test('every spec.mjs and verification.mjs subcommand the guidance uses is one the script takes', () => {
  const takes = { 'spec.mjs': read('scripts/spec.mjs'), 'verification.mjs': read('scripts/verification.mjs'), 'checklist.mjs': read('scripts/checklist.mjs') };
  for (const file of PROSE) {
    for (const [, script, sub] of readFileSync(file, 'utf8').matchAll(/<pact>\/scripts\/(spec\.mjs|verification\.mjs|checklist\.mjs) ([a-z-]+)/g)) {
      assert.ok(takes[script].includes(`'${sub}'`), `${rel(file)}: ${script} ${sub}`);
    }
  }
});

test('the files a step hands off to exist', () => {
  for (const file of PROSE) {
    for (const [, name] of readFileSync(file, 'utf8').matchAll(/`((?:probe|build|verify|spec-template)\.md)`/g)) {
      assert.ok(existsSync(path.join(ROOT, 'skills/pact', name)), `${rel(file)} → ${name}`);
    }
  }
  assert.match(read('skills/pact/probe.md').trimEnd(), /다음: build\.md$/);
  assert.match(read('skills/pact/build.md').trimEnd(), /다음: verify\.md$/);
});

test('the reply fields the hook and the scripts read are the ones the agents are told to write', async () => {
  // 훅은 worker 답의 `## 걱정·위험` 칸을 꺼내 reviewer 지시 끝에 `## worker 걱정`으로 붙인다.
  const worker = read('agents/worker.md');
  for (const field of ['## 상태: DONE | BLOCKED', '## 정한 것', '## 걱정·위험', '<run-dir>/tasks/<n>-report.md']) assert.ok(worker.includes(field), `worker: ${field}`);
  const reviewer = read('agents/reviewer.md');
  for (const field of ['## worker 걱정', '## worker 걱정 처리', '## 판정: 통과 | 고칠 것 있음']) assert.ok(reviewer.includes(field), `reviewer: ${field}`);
  assert.ok(read('scripts/concerns.mjs').includes('걱정·위험'));
  // 완료 검사가 읽는 results.json의 칸
  const verifier = read('agents/verifier.md');
  for (const field of ['"verification_id"', '"surface"', '"scenarios"', '"kind"', '"items"', '"result"', '"steps"', '"shot"', '"output"', '"exitCode"', '"specCheck"', 'case_id']) assert.ok(verifier.includes(field), `verifier: ${field}`);
  for (const kind of ['spec', 'case', 'acceptance', 'newcomer']) assert.ok(verifier.includes(`"kind": "${kind}"`), `verifier kind ${kind}`);
  for (const result of ['pass', 'fail', 'doubt', 'unverified']) assert.ok(verifier.includes(`\`${result}\``), `verifier result ${result}`);
  // 보고서 맨 위 칸
  const verify = read('skills/pact/verify.md');
  for (const field of ['"headline"', '"todo"', '"changes"', '"decision"']) assert.ok(verify.includes(field), `verify: ${field}`);
});

test('the spec template is one the lint reads, and the tags the guidance teaches are the ones the code parses', async () => {
  const { parseSpec } = await import('../scripts/spec.mjs');
  const parsed = parseSpec(read('skills/pact/spec-template.md'));
  assert.equal(parsed.frontmatter.status, 'draft');
  assert.ok(parsed.items.some((item) => item.id === 'F1') && parsed.items.some((item) => item.id === 'A1'));
  const probe = read('skills/pact/probe.md');
  for (const tag of ['[사용자]', '[AI 가정]', '[위험: 지우기|공개|비용]', '## 검수 기준', '## 하지 않는 것', '## 확인 필요', '## 결정 기록', '## 구조 판정']) assert.ok(probe.includes(tag), `probe: ${tag}`);
});

test('the files the lock covers are named the same in the guidance and in the code', async () => {
  const { classifyRest } = await import('../scripts/locks.mjs');
  for (const [rest, kind] of [[['results.json'], 'results'], [['results-round1.json'], 'results'], [['verification.json'], 'verification'], [['approvals.jsonl'], 'approvals'], [['log', 'subagents.jsonl'], 'log']]) {
    assert.equal(classifyRest(rest).kind, kind, rest.join('/'));
  }
  for (const free of ['summary.json', 'report.html', 'plan.md', 'tasks', 'shots']) assert.equal(classifyRest([free]), null, free);
  const verifier = read('agents/verifier.md');
  for (const name of ['results.json', 'verification.json', 'approvals.jsonl', 'summary.json']) assert.ok(verifier.includes(`\`${name}\``), `verifier: ${name}`);
});

test('every heredoc example the guidance shows closes with EOF at the start of the line', () => {
  let examples = 0;
  for (const file of GUIDANCE) {
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
  assert.ok(examples >= 1, `heredoc 예시를 찾았다(${examples})`);
});

test('the refusals the scripts print tell only the standard-input way to pass the person\'s words', () => {
  // 큰따옴표로 감싼 인자는 긴 말 속 백틱이 셸에서 실행될 수 있다.
  for (const file of ['scripts/approval.mjs', 'scripts/spec.mjs', 'scripts/verification.mjs', 'scripts/locks.mjs', 'scripts/report.mjs', 'hooks/guard.mjs']) {
    const text = read(file);
    assert.doesNotMatch(text, /(?:approve|delegate)\s+<명세>\s+"/, `${file}에 큰따옴표 인자 꼴이 없다`);
    assert.ok(!text.includes('"<사용자 말>"'), `${file}에 "<사용자 말>" 꼴이 없다`);
  }
});

test('the guidance calls nothing from other plugins, and the skill description says only when to use it', () => {
  for (const file of PROSE) {
    const text = readFileSync(file, 'utf8');
    for (const ns of ['superpowers:', 'tiers:', 'proto:']) assert.ok(!text.includes(ns), `${rel(file)} contains ${ns}`);
  }
  const fm = frontmatter(read('skills/pact/SKILL.md'));
  assert.equal(fm.name, 'pact');
  assert.match(fm.description, /때/);
});

test('the browser the verifier falls back to is documented where it is told to look: the top of browser.mjs', () => {
  const head = read('scripts/browser.mjs').split('import ')[0];
  for (const step of ['goto', 'click', 'type', 'press', 'upload', 'waitFor', 'shot', 'eval']) assert.ok(head.includes(`"do": "${step}"`), `browser.mjs 머리말: ${step}`);
  assert.ok(read('agents/verifier.md').includes('scripts/browser.mjs'));
  assert.ok(read('skills/pact/verify.md').includes('scripts/browser.mjs'));
});

test('plugin.json, the marketplace entry and the README name the same version', () => {
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(manifest.name, 'pact');
  assert.match(read('README.md'), new RegExp(`^## ${manifest.version.replaceAll('.', '\\.')}에서 바뀐 것`, 'm'));
});
