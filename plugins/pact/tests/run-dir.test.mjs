import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findRunDir, runDirCandidates, projectOfCwd, latestInProgressRunId, taskNumber } from '../scripts/run-dir.mjs';

const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pact-rundir-'));
  made.push(dir);
  return dir;
};
const ID = '2026-10-29-출결-관리';
const FEATURE = 'F1 오늘 수업 출석 현황 보기 [사용자]';

// 명세 파일을 만든다. mtime은 초 단위 숫자.
function spec(project, id, { status = 'building', feature = FEATURE, mtime } = {}) {
  const file = path.join(project, 'docs', 'pact', `${id}.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\npact: 2\ntopic: x\nstatus: ${status}\n---\n# x\n## 기능\n- ${feature}\n## 공통 규칙\n`);
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
}
const runDir = (project, id) => {
  const dir = path.join(project, '.pact', id);
  mkdirSync(dir, { recursive: true });
  return dir;
};
// 프로젝트 밖의 아무 폴더. 글 속의 경로만으로 찾는지 볼 때 cwd로 쓴다.
const elsewhere = () => tmp();

test('findRunDir reads a run-dir with Hangul in the run-id and ignores what is glued to it', () => {
  const project = tmp();
  const rd = runDir(project, ID);
  const cwd = elsewhere();
  const texts = [
    `run-dir: ${rd} , 작업 번호 1.`,
    `run-dir은 \`${rd}\`이고 worktree는 따로 있다`,
    `(${rd}).`,
    `${rd}.`,
    `"${rd}"`,
    `${rd}/tasks/1-report.md에 쓴다`,
    `${rd}를 쓴다`,
    `${rd}에서 시작`,
    `worktree: ${rd}/wt/plugins/pact`,
  ];
  for (const text of texts) {
    const found = findRunDir({ text, cwd });
    assert.equal(found?.runDir, rd, text);
    assert.equal(found.project, project);
    assert.equal(found.runId, ID);
    assert.equal(found.via, 'prompt');
  }
});

test('findRunDir turns a spec path into the run-dir without creating anything', () => {
  const project = tmp();
  const specFile = spec(project, ID);
  const found = findRunDir({ text: `명세 경로: ${specFile}\n요구 목록: …`, cwd: elsewhere() });
  assert.equal(found?.runDir, path.join(project, '.pact', ID));
  assert.equal(found.via, 'prompt');
  assert.equal(existsSync(path.join(project, '.pact')), false, '찾기만 하고 폴더는 만들지 않는다');
  // 명세 경로 뒤에 한국어 조사가 붙어도 .md가 끝을 알려 준다
  assert.equal(findRunDir({ text: `${specFile}를 읽는다`, cwd: elsewhere() })?.runDir, path.join(project, '.pact', ID));
});

test('paths inside the worktree point back to the real project, not to the spec copy in the worktree', () => {
  const project = tmp();
  const rd = runDir(project, ID);
  const wt = path.join(rd, 'wt');
  spec(wt, ID); // worktree에는 커밋된 명세 사본이 있다. 원래 프로젝트에는 아직 명세가 없는 경우부터 본다
  const text = `명세 사본: ${wt}/docs/pact/${ID}.md\n작업 공간: ${wt}/plugins/pact`;
  for (const withMainSpec of [false, true]) {
    if (withMainSpec) spec(project, ID);
    const found = findRunDir({ text, cwd: elsewhere() });
    assert.equal(found?.runDir, rd, `원래 프로젝트에 명세 ${withMainSpec ? '있음' : '없음'}`);
    assert.equal(found.project, project);
    assert.equal(found.via, 'prompt');
  }
});

test('a relative path read from inside the worktree still points at the real project', () => {
  const project = tmp();
  spec(project, ID);
  const wt = path.join(runDir(project, ID), 'wt');
  spec(wt, ID); // worktree의 명세 사본: 윗 폴더를 거슬러 올라가다 여기서 멈추면 안 된다
  const sub = path.join(wt, 'plugins', 'pact');
  mkdirSync(sub, { recursive: true });
  for (const text of [`docs/pact/${ID}.md`, `.pact/${ID}/tasks/1-report.md`, `./docs/pact/${ID}.md`]) {
    const found = findRunDir({ text, cwd: sub });
    assert.equal(found?.runDir, path.join(project, '.pact', ID), text);
    assert.equal(found.project, project, text);
    assert.equal(found.via, 'prompt', text);
  }
});

test('a ~ path and a relative path are resolved (home, and the cwd with its parent folders)', () => {
  const home = tmp();
  const project = path.join(home, 'dev', 'app');
  spec(project, ID);
  runDir(project, ID);
  // cwd만 보면 이 판이 뽑히는 상황: 더 최근에 바뀐 진행 중 명세가 따로 있다. 글의 경로가 이겨야 한다
  spec(project, '2026-10-30-더-최근', { mtime: Date.now() / 1000 + 1000 });
  const expected = path.join(project, '.pact', ID);
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const found = findRunDir({ text: `~/dev/app/.pact/${ID}/tasks/1-report.md`, cwd: elsewhere() });
    assert.equal(found?.runDir, expected);
    assert.equal(found.via, 'prompt');
  } finally {
    process.env.HOME = before;
  }
  const deep = path.join(project, 'packages', 'web');
  mkdirSync(deep, { recursive: true });
  assert.equal(findRunDir({ text: '', cwd: deep })?.runId, '2026-10-30-더-최근', '글에 경로가 없으면 cwd의 가장 최근 명세');
  for (const [text, cwd] of [
    [`.pact/${ID}/tasks/1-report.md`, deep],
    [`docs/pact/${ID}.md`, deep],
    [`./.pact/${ID}`, project],
    [`../../.pact/${ID}/wt`, deep],
  ]) {
    const found = findRunDir({ text, cwd });
    assert.equal(found?.runDir, expected, text);
    assert.equal(found.via, 'prompt', text);
  }
});

test('text that only looks like a path does not produce a run-dir', () => {
  const project = tmp();
  const missing = path.join(tmp(), 'gone', 'project');
  const texts = [
    `${missing}/.pact/2026-10-29-foo`, // 프로젝트 폴더가 없다: 거기에 만들지 않는다
    `${project}/.pact/results.json`, // run-id 꼴이 아니고 실제로도 없다
    '`.pact/.gitignore`가 `*`라 log/는 git에 들어가지 않는다', // 틀의 한 줄
    '실행 폴더는 `<프로젝트>/.pact/<run-id>`이다',
    'docs/pact/<run-id>.md',
    'x.pact/2026-10-29-foo', // 다른 이름의 끝
    '',
  ];
  for (const text of texts) assert.equal(findRunDir({ text, cwd: elsewhere() }), null, text);
  assert.deepEqual(runDirCandidates(texts.join('\n'), elsewhere()), []);
  assert.deepEqual(readdirSync(project), [], '아무것도 만들지 않는다');
});

test('a run-dir that does not exist yet is accepted when the run-id looks like one (the caller creates it)', () => {
  const project = tmp();
  const found = findRunDir({ text: `run-dir: ${project}/.pact/2026-11-01-새-판`, cwd: elsewhere() });
  assert.equal(found?.runDir, path.join(project, '.pact', '2026-11-01-새-판'));
  assert.equal(existsSync(found.runDir), false);
  // 손으로 만든 명세의 밑줄 이름도 받는다. 점이 든 이름(파일 이름)은 받지 않는다
  assert.equal(findRunDir({ text: `run-dir: ${project}/.pact/run_1`, cwd: elsewhere() })?.runDir, path.join(project, '.pact', 'run_1'));
  assert.equal(findRunDir({ text: `${project}/.pact/run.json`, cwd: elsewhere() }), null);
});

test('with several candidates, what really exists beats what is mentioned more, then more mentions, then the first', () => {
  const project = tmp();
  const real = '2026-10-20-진짜';
  const other = '2026-10-21-다른';
  spec(project, real);
  runDir(project, real);
  spec(project, other);
  runDir(project, other);
  const typo = `${project}/.pact/2026-10-22-없는-판`;
  const cwd = elsewhere();
  // 실제로 있는 것이 먼저다: 없는 곳을 세 번 말해도
  assert.equal(findRunDir({ text: `${project}/.pact/${real}\n${typo}\n${typo}\n${typo}`, cwd })?.runId, real);
  // 둘 다 있으면 많이 나온 쪽
  assert.equal(findRunDir({ text: `${project}/.pact/${other}\n${project}/.pact/${real}/tasks/1-report.md\n${project}/.pact/${real}/wt`, cwd })?.runId, real);
  // 같으면 먼저 나온 쪽
  assert.equal(findRunDir({ text: `${project}/.pact/${other}\n${project}/.pact/${real}`, cwd })?.runId, other);
});

test('an old brief naming the undated run folder and the dated spec resolves to the folder the work is in', () => {
  const project = tmp();
  spec(project, '2026-10-21-사용-대시보드'); // 명세 이름은 날짜가 있다
  const legacy = runDir(project, '사용-대시보드'); // 일하는 폴더는 날짜가 없다(0.5.0 전)
  const text = `명세: ${project}/docs/pact/2026-10-21-사용-대시보드.md\nrun-dir: ${legacy}, 작업 번호 2\nworktree: ${legacy}/wt`;
  assert.equal(findRunDir({ text, cwd: elsewhere() })?.runDir, legacy);
  // 날짜 있는 실행 폴더가 만들어져 있으면 그쪽이 이긴다(폴더와 명세가 둘 다 있다)
  const dated = runDir(project, '2026-10-21-사용-대시보드');
  assert.equal(findRunDir({ text, cwd: elsewhere() })?.runDir, dated);
});

test('a brief that names several things still finds its own run (a real worker brief mentions placeholders, the worktree and a report)', () => {
  const project = tmp();
  spec(project, ID);
  const rd = runDir(project, ID);
  const brief = [
    '## 맥락',
    '- `.pact/.gitignore`가 `*`라 log/는 git에 들어가지 않는다.',
    '- run-dir은 `<프로젝트>/.pact/<run-id>`이고 run-id는 명세 파일 이름에서 확장자를 뺀 것이다.',
    `worktree: ${rd}/wt`,
    `run-dir: ${rd} , 작업 번호 1 . 보고서는 이 run-dir의 tasks/1-report.md.`,
    '## 범위',
    `- ${rd}/wt/plugins/pact/hooks/ (새로 만든다)`,
  ].join('\n');
  assert.equal(findRunDir({ text: brief, cwd: elsewhere() })?.runDir, rd);
});

test('without a path, the run-dir of the most recently changed in-progress spec in the cwd project is used', () => {
  const project = tmp();
  spec(project, '2026-10-01-초안', { status: 'draft', mtime: 1000 });
  spec(project, '2026-10-02-만드는-중', { status: 'building', mtime: 2000 });
  spec(project, '2026-10-03-끝남', { status: 'done', mtime: 3000 });
  spec(project, '2026-10-04-틀-그대로', { status: 'draft', feature: 'F1 <기능 한 줄> [사용자]', mtime: 4000 });
  const found = findRunDir({ text: '경로 없는 지시', cwd: project });
  assert.equal(found?.runDir, path.join(project, '.pact', '2026-10-02-만드는-중'));
  assert.equal(found.via, 'cwd');
  assert.equal(latestInProgressRunId(project), '2026-10-02-만드는-중');
  // 더 최근에 바뀐 쪽이 이긴다
  utimesSync(path.join(project, 'docs', 'pact', '2026-10-01-초안.md'), 5000, 5000);
  assert.equal(findRunDir({ text: '', cwd: project })?.runId, '2026-10-01-초안');
});

test('the cwd fallback works from a sub folder and from inside a run-dir worktree, and gives up when nothing is in progress', () => {
  const project = tmp();
  spec(project, ID);
  const sub = path.join(project, 'plugins', 'pact');
  mkdirSync(sub, { recursive: true });
  assert.equal(findRunDir({ text: '', cwd: sub })?.runId, ID);
  const wtRoot = path.join(runDir(project, ID), 'wt');
  spec(wtRoot, ID); // 진짜 worktree에는 명세 사본(docs/pact/)도 있다. 윗 폴더를 거슬러 올라가다 거기서 멈추면 안 된다
  const wt = path.join(wtRoot, 'plugins', 'pact');
  mkdirSync(wt, { recursive: true });
  assert.equal(projectOfCwd(wt), project);
  assert.equal(findRunDir({ text: '', cwd: wt })?.runDir, path.join(project, '.pact', ID));

  const finished = tmp();
  spec(finished, ID, { status: 'done' });
  assert.equal(findRunDir({ text: '', cwd: finished }), null);
  assert.equal(findRunDir({ text: '', cwd: elsewhere() }), null, 'docs/pact/가 없는 폴더');
});

test('taskNumber trusts the report line at the end of the worker reply, then the brief, and does not guess between several', () => {
  const rd = '/p/.pact/2026-10-29-x';
  // 답 끝의 보고서 줄이 먼저다(이 작업이 실제로 쓴 보고서)
  assert.equal(taskNumber({ prompt: '작업 번호 2', reply: `## 상태: DONE\n보고서: ${rd}/tasks/3-report.md` }), 3);
  // 줄 앞의 목록 기호·따옴표
  assert.equal(taskNumber({ reply: `- 보고서: \`${rd}/tasks/7-report.md\`` }), 7);
  // 보고서 줄이 둘이면 마지막
  assert.equal(taskNumber({ reply: `보고서: ${rd}/tasks/1-report.md\n…\n보고서: ${rd}/tasks/2-report.md` }), 2);
  // BLOCKED 답에는 보고서 줄이 없다: 첫 지시의 작업 번호
  assert.equal(taskNumber({ prompt: `run-dir: ${rd} , 작업 번호 2. 보고서는 tasks/2-report.md`, reply: 'BLOCKED: 질문이 있다' }), 2);
  assert.equal(taskNumber({ prompt: '작업 번호: 4', reply: '' }), 4);
  assert.equal(taskNumber({ prompt: '작업 번호는 5입니다', reply: '' }), 5);
  // 첫 지시에 보고서 경로가 하나뿐이면 그 번호(reviewer의 지시)
  assert.equal(taskNumber({ prompt: `worker 보고서: ${rd}/tasks/6-report.md\nbase abc head def`, reply: '## 판정: 통과' }), 6);
  // 앞 작업 보고서가 여럿 들어 있으면 짐작하지 않는다
  assert.equal(taskNumber({ prompt: `앞 작업: ${rd}/tasks/1-report.md, ${rd}/tasks/2-report.md`, reply: 'BLOCKED: 질문' }), null);
  // 답에 보고서 경로가 하나뿐이면 그 번호
  assert.equal(taskNumber({ prompt: '', reply: 'BLOCKED: tasks/8-report.md에 쓰지 못했다' }), 8);
  assert.equal(taskNumber({}), null);
  assert.equal(taskNumber({ prompt: '지시', reply: '답' }), null);
});
