import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(PACT, ...p), 'utf8');
const skill = read('skills', 'recall', 'SKILL.md');
const FORBIDDEN = ['MUST', '예외 없이', '반드시 스킬', 'No exceptions'];

test('SKILL.md: name은 recall, description은 켜질 때와 pact:recall로 불리는 것을 적고, 금지 문구가 없다', () => {
  const m = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(skill);
  assert.ok(m, 'frontmatter');
  assert.equal(m[1], 'recall');
  for (const w of ['이거 전에 어떻게 됐더라', '예전에 해 봤던가', '기록 찾아봐', '지난번에 왜 실패했지', 'pact:recall']) assert.ok(m[2].includes(w), w);
  assert.ok(!skill.includes('recall:recall'), '따로 설치하던 때의 이름이 남아 있지 않다');
  for (const w of FORBIDDEN) assert.ok(!skill.includes(w), `SKILL.md contains ${w}`);
  assert.ok(!m[2].includes('반드시'));
});

test('SKILL.md: 도구 위치(pact 폴더 밑 scripts/recall), 명령, 전하는 법을 담는다', () => {
  assert.match(skill, /Base directory에서 두 단계 위가 pact 폴더/);
  assert.match(skill, /node <pact>\/scripts\/recall\/recall\.mjs <주제 낱말…> --project <지금 프로젝트 절대 경로>/);
  assert.match(skill, /2~5개/);
  assert.match(skill, /못 읽음/);
  assert.match(skill, /파일을 만들지 않는다/);
  assert.match(skill, /다른 스킬이 불렀으면/);
});

test('README: recall 스킬 칸에 환경 변수 표와 파일을 만들지 않는다는 말을 담고, 옛 설치 줄이 없다', () => {
  const readme = read('README.md');
  assert.match(readme, /^## recall 스킬$/m);
  for (const v of ['HONCHO_BASE_URL', 'HONCHO_WORKSPACE_ID', 'HONCHO_USER_NAME', 'HONCHO_API_BEARER_TOKEN', 'HONCHO_ENV_FILE', 'RECALL_ROOTS', 'RECALL_BUDGET_MS', 'RECALL_REQUEST_MS', 'CLAUDE_PROJECTS_DIR']) {
    assert.ok(readme.includes(`| \`${v}\` |`), v);
  }
  assert.match(readme, /^### 파일을 만들지 않는다$/m);
  assert.match(readme, /node plugins\/pact\/scripts\/recall\/recall\.mjs/);
  assert.ok(!readme.includes('plugin install recall'));
  assert.ok(!readme.includes('recall:recall'));
});

test('marketplace.json: recall 플러그인 항목은 없고 pact 항목이 skills/recall을 싣는다', () => {
  const market = JSON.parse(readFileSync(path.join(PACT, '..', '..', '.claude-plugin', 'marketplace.json'), 'utf8'));
  const names = market.plugins.map((p) => p.name);
  assert.ok(!names.includes('recall'));
  const pactEntry = market.plugins[names.indexOf('pact')];
  assert.deepEqual(pactEntry.skills, ['./skills/pact', './skills/recall']);
});
