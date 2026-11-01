import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RECALL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(RECALL, ...p), 'utf8');
const plugin = JSON.parse(read('.claude-plugin', 'plugin.json'));
const skill = read('skills', 'recall', 'SKILL.md');
const FORBIDDEN = ['MUST', '예외 없이', '반드시 스킬', 'No exceptions'];

test('plugin.json: 이름, 첫 판, 작성자, 한국어 한 줄 설명', () => {
  assert.equal(plugin.name, 'recall');
  assert.equal(plugin.version, '0.1.0');
  assert.deepEqual(plugin.author, { name: 'chenjing' });
  assert.ok(!plugin.description.includes('\n'));
  for (const w of ['Honcho', 'pact 기록', '메모리 파일', '예전 시도', '실패와 원인', '미룬 아이디어', '지키라는 규칙']) assert.ok(plugin.description.includes(w), w);
});

test('SKILL.md: name은 recall, description은 켜질 때를 적고, 금지 문구가 없다', () => {
  const m = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(skill);
  assert.ok(m, 'frontmatter');
  assert.equal(m[1], 'recall');
  for (const w of ['이거 전에 어떻게 됐더라', '예전에 해 봤던가', '기록 찾아봐', '지난번에 왜 실패했지', 'recall:recall']) assert.ok(m[2].includes(w), w);
  for (const w of FORBIDDEN) assert.ok(!skill.includes(w), `SKILL.md contains ${w}`);
  assert.ok(!m[2].includes('반드시'));
});

test('SKILL.md: 도구 위치, 명령, 전하는 법을 담는다', () => {
  assert.match(skill, /Base directory에서 두 단계 위가 recall 폴더/);
  assert.match(skill, /node <recall>\/scripts\/recall\.mjs <주제 낱말…> --project <지금 프로젝트 절대 경로>/);
  assert.match(skill, /2~5개/);
  assert.match(skill, /못 읽음/);
  assert.match(skill, /파일을 만들지 않는다/);
  assert.match(skill, /다른 스킬이 불렀으면/);
});

test('README: 환경 변수 표와 파일을 만들지 않는다는 말을 담는다', () => {
  const readme = read('README.md');
  for (const v of ['HONCHO_BASE_URL', 'HONCHO_WORKSPACE_ID', 'HONCHO_USER_NAME', 'HONCHO_API_BEARER_TOKEN', 'HONCHO_ENV_FILE', 'RECALL_ROOTS', 'RECALL_BUDGET_MS', 'RECALL_REQUEST_MS', 'CLAUDE_PROJECTS_DIR']) {
    assert.ok(readme.includes(`| \`${v}\` |`), v);
  }
  assert.match(readme, /^## 파일을 만들지 않는다$/m);
});

test('marketplace.json: recall 항목이 pact 앞에 있고 설명이 plugin.json과 같다', () => {
  const market = JSON.parse(readFileSync(path.join(RECALL, '..', '..', '.claude-plugin', 'marketplace.json'), 'utf8'));
  const names = market.plugins.map((p) => p.name);
  assert.equal(names.filter((n) => n === 'recall').length, 1);
  assert.ok(names.indexOf('recall') < names.indexOf('pact'));
  assert.deepEqual(market.plugins[names.indexOf('recall')], {
    name: 'recall',
    description: plugin.description,
    source: './plugins/recall',
    skills: ['./skills/recall'],
  });
});
