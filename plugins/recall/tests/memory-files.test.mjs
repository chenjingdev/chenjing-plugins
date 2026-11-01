import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collect, name, projectDirName } from '../scripts/sources/memory-files.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'recall-mem-'));

const memory = ({ name: n, description, type, modified = '2026-10-09T12:00:00.000Z', body = '본문' }) => `---
name: ${n}
description: ${description}
metadata:
  node_type: memory
  type: ${type}
  originSessionId: abc
  modified: ${modified}
---

${body}
`;

function setup(project, files) {
  const base = tmp();
  const dir = path.join(base, projectDirName(project), 'memory');
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(dir, file), text);
  return base;
}
const run = (base, topicWords, project) => collect({ topicWords, project, env: { CLAUDE_PROJECTS_DIR: base } });

test('출처 이름과 프로젝트 폴더 이름', () => {
  assert.equal(name, '메모리 파일');
  assert.equal(projectDirName('/Users/chenjing/dev/chenjing-plugins'), '-Users-chenjing-dev-chenjing-plugins');
  assert.equal(projectDirName('/Users/chenjing/.x_y/한글'), '-Users-chenjing--x-y---');
});

test('feedback·user는 규칙 묶음, project는 예전 시도 묶음으로 오고 요지는 description, 날짜는 modified다', async () => {
  const project = '/work/demo';
  const base = setup(project, {
    'fb.md': memory({ name: 'fb', description: '명령은 적게 외우게 한다', type: 'feedback' }),
    'us.md': memory({ name: 'us', description: '사용자는 명령 설명을 짧게 원한다', type: 'user', modified: '2026-10-20T12:00:00.000Z' }),
    'pj.md': memory({ name: 'pj', description: '명령 훅이 설치 캐시 판으로 돈다', type: 'project', modified: '2026-11-01T12:00:00.000Z' }),
    'ref.md': memory({ name: 'ref', description: '명령 참고 링크', type: 'reference' }),
  });
  const { items } = await run(base, ['명령'], project);
  const sorted = [...items].sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(
    sorted.map(({ bucket, text, date, source, repo, same_repo }) => ({ bucket, text, date, source, repo, same_repo })),
    [
      { bucket: 'rules', text: '명령은 적게 외우게 한다', date: '2026-10-09', source: 'memory', repo: null, same_repo: true },
      { bucket: 'attempts', text: '명령 훅이 설치 캐시 판으로 돈다', date: '2026-11-01', source: 'memory', repo: null, same_repo: true },
      { bucket: 'rules', text: '사용자는 명령 설명을 짧게 원한다', date: '2026-10-20', source: 'memory', repo: null, same_repo: true },
    ],
  );
  assert.ok(items.every((i) => i.path.endsWith('.md') && i.overlap === 1));
});

test('낱말이 이름·description·본문 어디에도 없는 파일은 뺀다. MEMORY.md 같은 색인도 type이 없어 빠진다', async () => {
  const project = '/work/demo';
  const base = setup(project, {
    'a.md': memory({ name: 'a', description: '쉬운 말로 보고', type: 'feedback', body: '결론부터 말한다' }),
    'MEMORY.md': '- [a](a.md) — 쉬운 말로 보고\n',
  });
  assert.equal((await run(base, ['결론'], project)).items.length, 1);
  assert.equal((await run(base, ['전혀다른'], project)).items.length, 0);
});

test('description이 따옴표로 싸여 있어도 읽는다', async () => {
  const project = '/work/demo';
  const base = setup(project, { 'q.md': memory({ name: 'q', description: '"요약은 \\"목록\\"으로"', type: 'feedback' }) });
  assert.equal((await run(base, ['목록'], project)).items[0].text, '요약은 "목록"으로');
});

test('이 프로젝트의 메모리 폴더가 없으면 빈 결과다(오류가 아니다)', async () => {
  const base = tmp();
  assert.deepEqual(await run(base, ['명령'], '/work/none'), { items: [] });
});
