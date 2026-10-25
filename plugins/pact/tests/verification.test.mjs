import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { snapshotVerification, checkVerification, finishVerification, sourceFingerprint, declaredCases } from '../scripts/verification.mjs';
import { parseSpec, setStatus } from '../scripts/spec.mjs';

const CLI = fileURLToPath(new URL('../scripts/verification.mjs', import.meta.url));
const SPEC = `---
pact: 1
topic: 목록
status: verifying
---
# 목록
## 기능
- F1 목록을 연다 [사용자]
  - 케이스: 자료가 없음 → 빈 상태 표시
## 공통 규칙
- R1 다른 사람의 자료를 보이지 않는다 [사용자]
`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=', 'base64');
function git(dir, ...args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture({ specText = SPEC, surface = 'command', repo = true } = {}) {
  const project = mkdtempSync(path.join(tmpdir(), 'pact-verification-'));
  const spec = path.join(project, 'docs/pact/2026-10-25-list.md');
  mkdirSync(path.dirname(spec), { recursive: true });
  writeFileSync(spec, specText);
  writeFileSync(path.join(project, 'app.js'), 'export const answer = 1;\n');
  if (repo) {
    git(project, 'init', '-q');
    git(project, 'config', 'user.name', 'Pact Test');
    git(project, 'config', 'user.email', 'pact@example.test');
    writeFileSync(path.join(project, '.gitignore'), '.pact/\ndocs/pact/\nignored.txt\n');
    git(project, 'add', '.');
    git(project, 'commit', '-qm', 'initial');
  }
  const capture = snapshotVerification(spec, project, surface);
  const step = surface === 'ui' ? { action: '화면 열기', shot: 'screen.png' } : { action: '명령 실행', output: 'ok', exitCode: 0 };
  if (surface === 'ui') writeFileSync(path.join(capture.runDir, 'screen.png'), PNG);
  const scenario = (id, kind, items, extra = {}) => ({ id, title: id, kind, items, result: 'pass', verification_id: capture.verification.verification_id, steps: [{ ...step }], ...extra });
  const results = {
    spec: path.relative(project, spec), verification_id: capture.verification.verification_id, surface,
    scenarios: [scenario('S1', 'spec', ['F1']), scenario('C1', 'case', ['F1', 'R1'], { case_id: 'F1-C1' }), scenario('N1', 'newcomer', []), scenario('N2', 'newcomer', [])],
    specCheck: { missing: [], extra: [], misunderstood: [] },
  };
  const save = () => writeFileSync(path.join(capture.runDir, 'results.json'), JSON.stringify(results));
  save();
  return { project, spec, capture, results, save };
}

test('normal flows, declared cases and R rules covered by a case can finish', () => {
  const f = fixture({ repo: true });
  const checked = checkVerification(f.spec, f.project);
  assert.equal(checked.ok, true, checked.issues.join('\n'));
  const finished = finishVerification(f.spec, f.project);
  assert.equal(finished.ok, true, finished.issues.join('\n'));
  assert.equal(parseSpec(readFileSync(f.spec, 'utf8')).frontmatter.status, 'done');
  assert.equal(checkVerification(f.spec, f.project).ok, true, 'status transition is normalized');
});

test('source fingerprint follows tracked content, ignores untracked files, and survives a commit', () => {
  const f = fixture({ repo: true });
  const before = sourceFingerprint(f.project);
  writeFileSync(path.join(f.project, 'new.js'), 'new content');
  const untracked = sourceFingerprint(f.project);
  assert.equal(untracked.fingerprint, before.fingerprint, 'untracked files are not part of the product');
  assert.deepEqual(untracked.untracked, ['new.js']);
  git(f.project, 'add', 'new.js');
  const added = sourceFingerprint(f.project).fingerprint;
  assert.notEqual(added, before.fingerprint);
  git(f.project, 'commit', '-qm', 'add source');
  assert.equal(sourceFingerprint(f.project).fingerprint, added);
  writeFileSync(path.join(f.project, 'ignored.txt'), 'not shipped');
  assert.equal(sourceFingerprint(f.project).fingerprint, added);
  writeFileSync(path.join(f.project, 'app.js'), 'export const answer = 9;\n');
  assert.notEqual(sourceFingerprint(f.project).fingerprint, added, 'uncommitted edits to tracked files count');
  assert.equal(checkVerification(f.spec, f.project).ok, false);
});

test('unchanged input reuses the capture, but changed input never restamps old results', () => {
  const f = fixture();
  const repeated = snapshotVerification(f.spec, f.project, 'command');
  assert.equal(repeated.reused, true);
  assert.equal(repeated.verification.verification_id, f.results.verification_id);
  const originalResults = readFileSync(path.join(f.capture.runDir, 'results.json'), 'utf8');
  writeFileSync(path.join(f.project, 'app.js'), 'export const answer = 2;\n');
  const next = snapshotVerification(f.spec, f.project, 'command');
  assert.notEqual(next.verification.verification_id, f.results.verification_id);
  assert.equal(readFileSync(path.join(f.capture.runDir, 'results.json'), 'utf8'), originalResults);
  assert.equal(checkVerification(f.spec, f.project).ok, false);
});

test('spec content changes invalidate receipts and phase eligibility is checked separately', () => {
  const f = fixture();
  writeFileSync(f.spec, setStatus(SPEC, 'building'));
  const building = checkVerification(f.spec, f.project);
  assert.equal(building.ok, false);
  assert.match(building.issues.join('\n'), /status가 verifying 또는 done/);
  assert.doesNotMatch(building.issues.join('\n'), /명세가 snapshot 이후/);
  writeFileSync(f.spec, SPEC.replace('목록을 연다', '목록을 내보낸다'));
  assert.match(checkVerification(f.spec, f.project).issues.join('\n'), /명세가 snapshot 이후/);
});

test('draft, approved and building phases cannot reuse receipts to finish', () => {
  const f = fixture();
  for (const status of ['draft', 'approved', 'building']) {
    writeFileSync(f.spec, setStatus(SPEC, status));
    assert.throws(() => snapshotVerification(f.spec, f.project, 'command'), /verifying/);
    const checked = finishVerification(f.spec, f.project);
    assert.equal(checked.ok, false, status);
    assert.equal(parseSpec(readFileSync(f.spec, 'utf8')).frontmatter.status, status);
  }
  writeFileSync(f.spec, SPEC);
  assert.equal(finishVerification(f.spec, f.project).ok, true);
  assert.equal(finishVerification(f.spec, f.project).ok, true, 'done is idempotent');
});

test('history rewritten at identical bytes creates a new capture rather than trapping the old HEAD', () => {
  const f = fixture();
  const parent = git(f.project, 'rev-parse', 'HEAD');
  git(f.project, 'commit', '--allow-empty', '-qm', 'first verification head');
  const first = snapshotVerification(f.spec, f.project, 'command');
  // The previous snapshot was reusable, so capture a branch-only head explicitly.
  const file = path.join(first.runDir, 'verification.json');
  const recorded = JSON.parse(readFileSync(file, 'utf8'));
  recorded.head = git(f.project, 'rev-parse', 'HEAD');
  writeFileSync(file, JSON.stringify(recorded));
  git(f.project, 'reset', '--hard', parent);
  git(f.project, 'commit', '--allow-empty', '-qm', 'rewritten head');
  const next = snapshotVerification(f.spec, f.project, 'command');
  assert.equal(next.reused, false);
  assert.notEqual(next.verification.verification_id, recorded.verification_id);
});

test('an empty feature set and invalid specs cannot receive a snapshot', () => {
  const f = fixture();
  writeFileSync(f.spec, SPEC.replace('- F1 목록을 연다 [사용자]\n  - 케이스: 자료가 없음 → 빈 상태 표시\n', ''));
  assert.throws(() => snapshotVerification(f.spec, f.project, 'command'), /F 항목/);
  writeFileSync(f.spec, SPEC.replace('[사용자]', '[unknown]'));
  assert.throws(() => snapshotVerification(f.spec, f.project, 'command'), /알 수 없는 태그/);
});

test('coverage cannot be claimed by the wrong scenario kind or an unrelated case id', () => {
  const f = fixture();
  f.results.scenarios[0].kind = 'newcomer';
  f.results.scenarios[1].case_id = 'F1-C2';
  f.results.scenarios[1].items = ['F1'];
  f.save();
  const checked = checkVerification(f.spec, f.project);
  const issues = checked.issues.join('\n');
  assert.match(issues, /F1: 정상 흐름/);
  assert.match(checked.warnings.join('\n'), /R1: 이 규칙/);
  assert.doesNotMatch(issues, /R1/, 'an unchecked rule warns but does not block');
  assert.match(issues, /F1-C1: 케이스/);
  assert.match(issues, /선언되지 않은 case_id/);
});

test('features without cases are allowed and R can be covered in a newcomer scenario', () => {
  const f = fixture({ specText: SPEC.replace('  - 케이스: 자료가 없음 → 빈 상태 표시\n', '') });
  f.results.scenarios.splice(1, 1);
  f.results.scenarios[1].items = ['R1'];
  f.save();
  assert.equal(checkVerification(f.spec, f.project).ok, true);
  assert.deepEqual(declaredCases(SPEC), [{ id: 'F1-C1', feature: 'F1' }]);
});

test('empty scenarios, duplicate ids, missing steps and missing scenario receipts block done', () => {
  const f = fixture();
  f.results.scenarios[1].id = 'S1';
  f.results.scenarios[2].steps = [];
  delete f.results.scenarios[3].verification_id;
  f.save();
  const issues = checkVerification(f.spec, f.project).issues.join('\n');
  assert.match(issues, /id가 겹칩니다/);
  assert.match(issues, /단계가 비어/);
  assert.match(issues, /verification_id/);
  f.results.scenarios = [];
  f.save();
  assert.match(checkVerification(f.spec, f.project).issues.join('\n'), /시나리오가 비어/);
});

test('fail and unverified always block; doubt needs a decision', () => {
  const f = fixture();
  for (const result of ['fail', 'unverified', 'invalid']) {
    f.results.scenarios[0].result = result;
    f.save();
    assert.equal(checkVerification(f.spec, f.project).ok, false, result);
  }
  f.results.scenarios[0].result = 'doubt';
  f.save();
  assert.match(checkVerification(f.spec, f.project).issues.join('\n'), /결정 이유/);
  f.results.scenarios[0].decision = '관측된 지연은 허용하며 이유를 보고서에 남깁니다.';
  f.save();
  assert.equal(checkVerification(f.spec, f.project).ok, true);
});

test('command evidence needs output and exitCode on every step', () => {
  const f = fixture();
  f.results.scenarios[0].steps.push({ action: '두 번째 명령', output: 'ok' });
  f.save();
  assert.equal(checkVerification(f.spec, f.project).ok, false);
  f.results.scenarios[0].steps[1].exitCode = 0;
  f.save();
  assert.equal(checkVerification(f.spec, f.project).ok, true);
});

test('UI evidence is required per step and rejects fake images and escaped real paths', () => {
  const f = fixture({ surface: 'ui' });
  assert.equal(checkVerification(f.spec, f.project).ok, true);
  f.results.scenarios[0].steps.push({ action: '다음 화면', output: 'ok', exitCode: 0 });
  f.save();
  assert.equal(checkVerification(f.spec, f.project).ok, false, 'output does not replace UI screenshot');
  f.results.scenarios[0].steps.pop();
  writeFileSync(path.join(f.capture.runDir, 'screen.png'), 'not an image');
  f.save();
  assert.equal(checkVerification(f.spec, f.project).ok, false);
  const outside = path.join(f.project, '.pact', 'outside.png');
  writeFileSync(outside, PNG);
  symlinkSync(outside, path.join(f.capture.runDir, 'escape.png'));
  f.results.scenarios[0].steps[0].shot = 'escape.png';
  f.save();
  assert.match(checkVerification(f.spec, f.project).issues.join('\n'), /실제 경로가 실행 폴더 밖/);
});

test('finish rejects a worktree target and an unmerged verification HEAD', () => {
  const f = fixture({ repo: true });
  const wt = path.join(tmpdir(), `pact-wt-${randomUUID()}`);
  git(f.project, 'worktree', 'add', '-qb', 'verification', wt);
  writeFileSync(path.join(wt, 'app.js'), 'export const answer = 3;\n');
  git(wt, 'add', 'app.js');
  git(wt, 'commit', '-qm', 'worktree implementation');
  const capture = snapshotVerification(f.spec, wt, 'command');
  f.results.verification_id = capture.verification.verification_id;
  for (const scenario of f.results.scenarios) scenario.verification_id = capture.verification.verification_id;
  f.save();
  assert.throws(() => finishVerification(f.spec, wt), /원래 폴더/);
  // A manual copy has the same bytes, but the verified worktree commit is not merged.
  writeFileSync(path.join(f.project, 'app.js'), readFileSync(path.join(wt, 'app.js')));
  assert.equal(checkVerification(f.spec, f.project).ok, true);
  assert.match(finishVerification(f.spec, f.project).issues.join('\n'), /병합/);
  git(f.project, 'reset', '--hard', 'HEAD');
  git(f.project, 'merge', '--ff-only', 'verification');
  assert.equal(finishVerification(f.spec, f.project).ok, true);
  git(f.project, 'worktree', 'remove', wt);
});

test('CLI check and finish return JSON and never mark a blocked run done', () => {
  const f = fixture();
  f.results.scenarios[0].result = 'fail';
  f.save();
  const result = spawnSync(process.execPath, [CLI, 'finish', f.spec, f.project], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(parseSpec(readFileSync(f.spec, 'utf8')).frontmatter.status, 'verifying');
});

test('Git and HEAD failures do not fall back to a filesystem-only completion', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'pact-no-git-'));
  writeFileSync(path.join(project, 'file.js'), 'source');
  assert.throws(() => sourceFingerprint(project), /Git 저장소/);
  git(project, 'init', '-q');
  assert.throws(() => sourceFingerprint(project), /실제 HEAD/);
});

test('snapshot spec identity and all specCheck arrays are mandatory', () => {
  const f = fixture();
  const file = path.join(f.capture.runDir, 'verification.json');
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  snapshot.spec = path.join(f.project, 'docs/pact/another-spec.md');
  delete snapshot.head;
  writeFileSync(file, JSON.stringify(snapshot));
  delete f.results.specCheck;
  f.save();
  const issues = checkVerification(f.spec, f.project).issues.join('\n');
  assert.match(issues, /snapshot이 현재 명세/);
  assert.match(issues, /실제 HEAD가 없습니다/);
  assert.match(issues, /specCheck.missing/);
  assert.match(issues, /specCheck.extra/);
  assert.match(issues, /specCheck.misunderstood/);
});

test('a Ruling added to the decision log does not invalidate the snapshot', () => {
  const f = fixture();
  writeFileSync(f.spec, `${SPEC}## 결정 기록\n- Ruling: 빈 상태 글은 "자료 없음" — 짧아서 — 없음\n`);
  const checked = checkVerification(f.spec, f.project);
  assert.equal(checked.ok, true, checked.issues.join('\n'));
  assert.equal(snapshotVerification(f.spec, f.project, 'command').reused, true);
});

test('after a fix the new snapshot links to the previous one, lists changed files, and earlier-round results still count', () => {
  const f = fixture();
  const first = f.capture.verification.verification_id;
  writeFileSync(path.join(f.project, 'app.js'), 'export const answer = 2;\n');
  git(f.project, 'commit', '-qam', 'fix');
  const next = snapshotVerification(f.spec, f.project, 'command');
  assert.equal(next.reused, false);
  assert.equal(next.verification.previous, first);
  assert.deepEqual(next.verification.history, [first]);
  assert.deepEqual(next.changed_files, ['app.js']);
  assert.equal(next.spec_changed, false);
  assert.equal(checkVerification(f.spec, f.project).ok, false, 'the top-level id must be the new one');
  f.results.verification_id = next.verification.verification_id;
  f.results.scenarios[0].verification_id = next.verification.verification_id;
  f.save();
  const checked = checkVerification(f.spec, f.project);
  assert.equal(checked.ok, true, checked.issues.join('\n'));
  assert.deepEqual(checked.carried, ['C1', 'N1', 'N2']);
  f.results.scenarios[1].verification_id = 'someone-elses-id';
  f.save();
  assert.match(checkVerification(f.spec, f.project).issues.join('\n'), /C1: verification_id/);
});

test('an untracked file in the project does not block finish', () => {
  const f = fixture();
  writeFileSync(path.join(f.project, 'memo.txt'), '메모');
  assert.equal(checkVerification(f.spec, f.project).ok, true);
  assert.equal(finishVerification(f.spec, f.project).ok, true);
});

test('extra things in the result only warn; missing and misunderstood block', () => {
  const f = fixture();
  f.results.specCheck.extra = ['도움말 버튼'];
  f.save();
  const checked = checkVerification(f.spec, f.project);
  assert.equal(checked.ok, true, checked.issues.join('\n'));
  assert.match(checked.warnings.join('\n'), /도움말 버튼/);
  f.results.specCheck.missing = ['내보내기'];
  f.save();
  assert.match(checkVerification(f.spec, f.project).issues.join('\n'), /내보내기/);
});

test('a non-zero exit code is evidence when the case expects an error', () => {
  const f = fixture();
  f.results.scenarios[1].steps = [{ action: '값 없이 실행하면 1로 끝난다', output: '오류: 값이 없습니다', exitCode: 1 }];
  f.save();
  const checked = checkVerification(f.spec, f.project);
  assert.equal(checked.ok, true, checked.issues.join('\n'));
});
