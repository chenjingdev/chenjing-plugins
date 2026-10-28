import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { snapshotVerification, checkVerification, finishVerification, sourceFingerprint, declaredCases, archiveResults, fingerprintVerdict } from '../scripts/verification.mjs';
import { parseSpec, setStatus, userLinesOf } from '../scripts/spec.mjs';
import { LEGACY_NOTE } from '../scripts/approval.mjs';
import { appendRecord, resultsSha256 } from '../scripts/run-log.mjs';
import { makeWorld, grantApproval, runSpec, checkerReply } from './approval-world.mjs';

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
// 새 명세(pact: 2)는 승인 기록이 있어야 snapshot이 되고, 완료 검사는 spec-checker가 끝난 기록과 [사용자] 줄의 지문도 본다.
// 훅과 스크립트가 쓰는 꼴로 한 줄씩 미리 둔다. approvedText는 승인할 때의 명세(안 주면 지금 명세), checkerMessage는 spec-checker의 답이다.
function seedApproval(project, runId, spec, text, { kind = 'approve', checker = true, checkerMessage = checkerReply(), time = '2026-10-25T00:10:00.000Z' } = {}) {
  const run = path.join(project, '.pact', runId);
  mkdirSync(run, { recursive: true });
  if (checker) appendRecord(run, { time: '2026-10-25T00:00:00.000Z', agent_type: 'pact:spec-checker', agent_id: 'agent-c', task: null, message: checkerMessage });
  const entry = {
    version: 1, kind, quote: '승인', message: '승인', message_uuid: `uuid-${time}`, message_time: time, answer_question: null,
    transcript: '/none', session_id: 's', recorded_at: time, spec, spec_checker_time: kind === 'approve' ? '2026-10-25T00:00:00.000Z' : null, user_lines: userLinesOf(text),
  };
  writeFileSync(path.join(run, 'approvals.jsonl'), `${JSON.stringify(entry)}\n`, { flag: 'a' });
  return run;
}

function fixture({ specText = SPEC, surface = 'command', repo = true, approved = false, approvedText = specText, checker = true, checkerMessage } = {}) {
  const project = mkdtempSync(path.join(tmpdir(), 'pact-verification-'));
  const spec = path.join(project, 'docs/pact/2026-10-25-list.md');
  mkdirSync(path.dirname(spec), { recursive: true });
  writeFileSync(spec, specText);
  if (approved) seedApproval(project, '2026-10-25-list', spec, approvedText, { checker, checkerMessage });
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

// ---------- snapshot은 승인 기록이 있어야 한다(명세 F2, R8, R19) ----------

// 승인 기록 시험용: 명세가 든 프로젝트를 git 저장소로 만든다(snapshot은 하지 않는다)
function repoWorld(options) {
  const w = makeWorld(options);
  writeFileSync(path.join(w.project, 'app.js'), 'export const answer = 1;\n');
  writeFileSync(path.join(w.project, '.gitignore'), '.pact/\ndocs/pact/\n');
  git(w.project, 'init', '-q');
  git(w.project, 'config', 'user.name', 'Pact Test');
  git(w.project, 'config', 'user.email', 'pact@example.test');
  git(w.project, 'add', '.');
  git(w.project, 'commit', '-qm', 'initial');
  return w;
}

test('snapshot is refused without an approval record on a new spec (pact: 2), and says what to do', () => {
  const w = repoWorld({ status: 'verifying' });
  assert.throws(() => snapshotVerification(w.spec, w.project, 'command'), (error) => {
    assert.match(error.message, /승인 기록이 없다/);
    assert.match(error.message, /spec\.mjs approve <명세> - <<'EOF'/);
    assert.doesNotMatch(error.message, /"<사용자 말>"/, '큰따옴표 인자 꼴은 알리지 않는다');
    assert.doesNotMatch(error.message, /\n/);
    return true;
  });
  assert.equal(existsSync(path.join(w.run, 'verification.json')), false, '기록이 없으면 검수 기록도 만들지 않는다');
  const r = spawnSync(process.execPath, [CLI, 'snapshot', w.spec, w.project, 'command'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.match(out.issues[0], /승인 기록이 없다/);
  // 옛 판(pact: 1)이라도 draft였던 명세는 새 규칙이라 같다. status가 verifying이 아니면 status 쪽 까닭이 먼저다
  const old = repoWorld({ pact: 1, status: 'verifying' });
  writeFileSync(old.spec, setStatus(readFileSync(old.spec, 'utf8'), 'draft'));
  assert.throws(() => snapshotVerification(old.spec, old.project, 'command'), /verifying/);
});

test('snapshot goes on when a record exists, and an old spec (pact: 1) goes on without one and says so in the result', () => {
  const w = repoWorld({ status: 'draft' });
  grantApproval(w);
  assert.equal(runSpec(w, ['set-status', w.spec, 'verifying']).status, 0);
  const made = snapshotVerification(w.spec, w.project, 'command');
  assert.equal(made.reused, false);
  assert.equal(made.notes, undefined, '기록이 있으면 참고가 없다');
  assert.equal(snapshotVerification(w.spec, w.project, 'command').reused, true, '같은 입력이면 있는 기록을 쓴다');

  const old = repoWorld({ pact: 1, status: 'verifying' });
  const result = snapshotVerification(old.spec, old.project, 'command');
  assert.deepEqual(result.notes, [LEGACY_NOTE]);
  assert.equal(LEGACY_NOTE, '참고: 옛 판이라 승인 기록 없음');
  const again = snapshotVerification(old.spec, old.project, 'command');
  assert.equal(again.reused, true);
  assert.deepEqual(again.notes, [LEGACY_NOTE], '재사용한 기록에도 알린다');
  const cli = spawnSync(process.execPath, [CLI, 'snapshot', old.spec, old.project, 'command'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout).notes, [LEGACY_NOTE]);
});

// ---------- 결과 파일은 verifier가 끝날 때 그대로여야 한다(명세 F1, R14) ----------

const NEW_SPEC = SPEC.replace('pact: 1', 'pact: 2');
// verifier가 끝났다는 훅의 기록 한 줄: 지금 results.json의 지문이 든다
function verifierStopped(f, extra = {}) {
  appendRecord(f.capture.runDir, { time: new Date().toISOString(), agent_type: 'pact:verifier', agent_id: 'agent-v', task: null, message: '통과', results_sha256: resultsSha256(f.capture.runDir), ...extra });
}
const issuesOf = (checked) => checked.issues.join('\n');

test('(f) finish passes when results.json is what the latest verifier left, and says nothing extra', () => {
  const f = fixture({ specText: NEW_SPEC, approved: true });
  verifierStopped(f);
  const checked = checkVerification(f.spec, f.project);
  assert.equal(checked.ok, true, issuesOf(checked));
  assert.deepEqual(checked.notes, []);
  const finished = finishVerification(f.spec, f.project);
  assert.equal(finished.ok, true, issuesOf(finished));
  assert.equal(parseSpec(readFileSync(f.spec, 'utf8')).frontmatter.status, 'done');
});

test('(f) a results.json that changed after the verifier stopped is refused, with why and what to do, and the spec is not marked done', () => {
  const f = fixture({ specText: NEW_SPEC, approved: true });
  verifierStopped(f);
  f.results.headline = '손으로 고친 결론';
  f.save();
  for (const checked of [checkVerification(f.spec, f.project), finishVerification(f.spec, f.project)]) {
    assert.equal(checked.ok, false);
    const mine = checked.issues.find((issue) => /verifier가 끝난 뒤/.test(issue));
    assert.ok(mine, issuesOf(checked));
    assert.match(mine, /results\.json이 가장 최근 verifier가 끝난 뒤\(\d{4}-\d\d-\d\dT[\d:.]+Z\) 바뀌었다/);
    // 두 경우를 나눠 알린다: 코드를 고쳐야 하면 build로, 코드는 맞고 results.json만 바뀌었으면 verifier만 다시
    assert.match(mine, /코드를 고쳐야 하면 build로 되돌려 고치고 verifier로 다시 검수한다\. 코드는 맞고 results\.json만 바뀐 것이면 verifier만 다시 돌린다\./);
    assert.match(mine, /보고 칸은 summary\.json에 쓴다/);
    assert.doesNotMatch(mine, /\n/, '까닭과 대신 할 일은 한 줄이다');
  }
  assert.equal(parseSpec(readFileSync(f.spec, 'utf8')).frontmatter.status, 'verifying');
  // verifier가 다시 검수하고 끝나면 새 지문이 기록되어 다시 통과한다
  verifierStopped(f);
  assert.equal(finishVerification(f.spec, f.project).ok, true);
});

test('(f) the latest verifier record is the one that counts: an older fingerprint does not make a changed file pass, nor a newer one an unchanged file fail', () => {
  const f = fixture({ specText: NEW_SPEC, approved: true });
  const first = resultsSha256(f.capture.runDir);
  verifierStopped(f); // 지문 = first
  f.results.scenarios[0].summary = '다시 검수한 결과';
  f.save();
  assert.equal(checkVerification(f.spec, f.project).ok, false, '첫 기록의 지문과 달라졌다');
  verifierStopped(f); // 지문 = 지금
  assert.equal(checkVerification(f.spec, f.project).ok, true);
  const second = resultsSha256(f.capture.runDir);
  assert.notEqual(first, second);
  // 옛 지문으로 되돌린 파일은 가장 최근 기록과 다르다
  f.results.scenarios[0].summary = undefined;
  f.save();
  assert.equal(resultsSha256(f.capture.runDir), first);
  assert.match(issuesOf(checkVerification(f.spec, f.project)), /바뀌었다/);
});

test('(f) a new spec with no verifier record at all is refused, and the hint says to run the verifier and where the hook error log is', () => {
  const f = fixture({ specText: NEW_SPEC, approved: true });
  const checked = finishVerification(f.spec, f.project);
  assert.equal(checked.ok, false);
  const mine = checked.issues.find((issue) => /verifier가 끝난 기록이 없어/.test(issue));
  assert.ok(mine, issuesOf(checked));
  assert.match(mine, /results\.json을 verifier가 쓴 것인지 알 수 없다/);
  assert.match(mine, /pact:verifier로 검수를 돌린다/);
  assert.match(mine, /훅이 돌지 않는 것이니 플러그인 데이터 폴더의 hook-error\.log를 보고 사용자에게 알린다/);
  assert.doesNotMatch(mine, /\n/);
  assert.deepEqual(checked.notes, []);
  assert.equal(parseSpec(readFileSync(f.spec, 'utf8')).frontmatter.status, 'verifying');
  // spec-checker·worker 기록은 verifier 기록이 아니다
  appendRecord(f.capture.runDir, { time: new Date().toISOString(), agent_type: 'pact:worker', agent_id: 'w', task: 1, message: '끝', results_sha256: resultsSha256(f.capture.runDir) });
  assert.match(issuesOf(checkVerification(f.spec, f.project)), /verifier가 끝난 기록이 없어/);
});

test('(f) a latest verifier record whose fingerprint is null (results.json was missing then) or absent is refused', () => {
  for (const extra of [{ results_sha256: null }, { results_sha256: undefined }, { results_sha256: '' }, { results_sha256: 42 }]) {
    const f = fixture({ specText: NEW_SPEC, approved: true });
    verifierStopped(f, extra);
    const checked = checkVerification(f.spec, f.project);
    assert.equal(checked.ok, false, JSON.stringify(extra));
    const mine = checked.issues.find((issue) => /지문이 없다/.test(issue));
    assert.ok(mine, issuesOf(checked));
    assert.match(mine, /가장 최근 verifier 기록\(\d{4}-.*Z\)에 results\.json 지문이 없다\(그때 results\.json이 없었다\)/);
    assert.match(mine, /pact:verifier로 다시 검수해 results\.json을 쓰게 한다/);
  }
  // 앞 기록은 멀쩡해도 가장 최근 기록이 null이면 거절한다
  const f = fixture({ specText: NEW_SPEC, approved: true });
  verifierStopped(f);
  verifierStopped(f, { results_sha256: null });
  assert.match(issuesOf(checkVerification(f.spec, f.project)), /지문이 없다/);
});

test('(f) an old spec (pact: 1) with no verifier record skips the comparison and says so with a 참고 line; with a record it is compared like any other', () => {
  const f = fixture(); // pact: 1, 승인 기록 없음, verifier 기록 없음
  const checked = checkVerification(f.spec, f.project);
  assert.equal(checked.ok, true, issuesOf(checked));
  assert.deepEqual(checked.notes, ['참고: 옛 판이고 verifier 기록이 없어 results.json이 verifier가 쓴 그대로인지는 확인하지 않았다']);
  const finished = finishVerification(f.spec, f.project);
  assert.equal(finished.ok, true, issuesOf(finished));
  assert.equal(finished.notes.length, 1);
  // 0.6.0에서 verifier가 다시 돌아 기록이 생기면 비교한다
  const g = fixture();
  verifierStopped(g);
  assert.deepEqual(checkVerification(g.spec, g.project).notes, []);
  assert.equal(checkVerification(g.spec, g.project).ok, true);
  g.results.headline = '손으로 고침';
  g.save();
  const changed = checkVerification(g.spec, g.project);
  assert.equal(changed.ok, false);
  assert.match(issuesOf(changed), /verifier가 끝난 뒤.*바뀌었다/);
  // 옛 명세라도 그 뒤에 승인 기록이 생겼으면 옛 판처럼 건너뛰지 않는다
  const h = fixture();
  mkdirSync(h.capture.runDir, { recursive: true });
  writeFileSync(path.join(h.capture.runDir, 'approvals.jsonl'), `${JSON.stringify({ version: 1, kind: 'delegate', quote: '끝까지 알아서 해' })}\n`);
  assert.match(issuesOf(checkVerification(h.spec, h.project)), /verifier가 끝난 기록이 없어/);
});

test('(f) a missing results.json is reported by the existing "could not read" issue, not as a changed file', () => {
  const f = fixture({ specText: NEW_SPEC, approved: true });
  verifierStopped(f);
  rmSync(path.join(f.capture.runDir, 'results.json'));
  const checked = checkVerification(f.spec, f.project);
  assert.match(issuesOf(checked), /results\.json을 읽지 못했습니다/);
  assert.doesNotMatch(issuesOf(checked), /바뀌었다/);
  // 읽을 수 없는 기록은 거절로 끝난다(느슨해지지 않는다)
  const g = fixture({ specText: NEW_SPEC, approved: true, checker: false }); // log/subagents.jsonl 자리를 폴더로 만들 것이라 기록 파일을 미리 두지 않는다
  mkdirSync(path.join(g.capture.runDir, 'log', 'subagents.jsonl'), { recursive: true });
  assert.throws(() => checkVerification(g.spec, g.project), /EISDIR/);
  const r = spawnSync(process.execPath, [CLI, 'finish', g.spec, g.project], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).ok, false);
  assert.equal(parseSpec(readFileSync(g.spec, 'utf8')).frontmatter.status, 'verifying');
});

test('(f) fingerprintVerdict on its own: nothing, an issue, or a note', () => {
  const f = fixture({ specText: NEW_SPEC, approved: true });
  assert.match(fingerprintVerdict(f.spec, f.capture.runDir).issue, /verifier가 끝난 기록이 없어/);
  verifierStopped(f);
  assert.deepEqual(fingerprintVerdict(f.spec, f.capture.runDir), {});
  const old = fixture();
  assert.deepEqual(Object.keys(fingerprintVerdict(old.spec, old.capture.runDir)), ['note']);
});

test('(f) CLI finish prints the refusal as JSON and exits 1; check passes the note along', () => {
  const f = fixture({ specText: NEW_SPEC, approved: true });
  verifierStopped(f);
  f.results.headline = '바뀜';
  f.save();
  const r = spawnSync(process.execPath, [CLI, 'finish', f.spec, f.project], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.match(out.issues.join('\n'), /verifier로 다시 검수한다/);
  const old = fixture();
  const checkOut = spawnSync(process.execPath, [CLI, 'check', old.spec, old.project], { encoding: 'utf8' });
  assert.equal(checkOut.status, 0, checkOut.stdout);
  assert.match(JSON.parse(checkOut.stdout).notes[0], /^참고: 옛 판이고 verifier 기록이 없어/);
});

// ---------- summary.json: 의심의 결정 이유(decision)는 메인이 쓰는 summary.json에 있다(R13) ----------

test('a doubt\'s decision may be in summary.json (by scenario id) or, in an old run, in results.json; with neither the doubt blocks', () => {
  const f = fixture();
  f.results.scenarios[0].result = 'doubt';
  f.save();
  assert.match(issuesOf(checkVerification(f.spec, f.project)), /S1: 의심을 남기는 결정 이유가 없습니다/);
  const summaryFile = path.join(f.capture.runDir, 'summary.json');
  writeFileSync(summaryFile, JSON.stringify({ headline: '됐다', decision: { S1: '그대로 둔다. 저장 버튼이 있어서다.' } }));
  const ok = checkVerification(f.spec, f.project);
  assert.equal(ok.ok, true, issuesOf(ok));
  // 다른 시나리오의 이유는 이 의심의 이유가 아니다. 비었거나 글이 아닌 것도 이유가 아니다
  for (const decision of [{ C1: '다른 시나리오' }, { S1: '' }, { S1: '   ' }, { S1: 3 }, {}]) {
    writeFileSync(summaryFile, JSON.stringify({ decision }));
    assert.match(issuesOf(checkVerification(f.spec, f.project)), /S1: 의심을 남기는 결정 이유가 없습니다/, JSON.stringify(decision));
  }
  // summary.json이 없고 results.json에 이유가 있는 옛 판은 그대로 통과한다
  rmSync(summaryFile);
  f.results.scenarios[0].decision = '옛 판: results.json에 적은 이유';
  f.save();
  assert.equal(checkVerification(f.spec, f.project).ok, true);
  // 칸마다 summary.json이 먼저이고 없으면 results.json의 것이다: 이유 하나만 summary.json에 있어도 나머지 옛 이유는 읽힌다
  f.results.scenarios[1].result = 'doubt';
  f.results.scenarios[1].decision = '옛 이유';
  f.results.scenarios[0].decision = undefined;
  f.save();
  writeFileSync(summaryFile, JSON.stringify({ decision: { S1: '새 이유' } }));
  assert.equal(checkVerification(f.spec, f.project).ok, true);
});

test('a summary.json that cannot be read, or has a field of the wrong shape, blocks with a line that says which; no summary.json is fine', () => {
  const f = fixture();
  assert.equal(checkVerification(f.spec, f.project).ok, true);
  const summaryFile = path.join(f.capture.runDir, 'summary.json');
  for (const [text, pattern] of [
    ['{ 깨짐', /summary\.json을 읽지 못했습니다/],
    ['[1, 2]', /summary\.json은 JSON 객체여야 합니다/],
    ['"글"', /summary\.json은 JSON 객체여야 합니다/],
    [JSON.stringify({ headline: 3 }), /summary\.json의 headline은 글이어야 합니다/],
    [JSON.stringify({ todo: '하나' }), /summary\.json의 todo는 배열이어야 합니다/],
    [JSON.stringify({ changes: { a: 1 } }), /summary\.json의 changes는 배열이어야 합니다/],
    [JSON.stringify({ decision: ['S1'] }), /summary\.json의 decision은 시나리오 id를 키로 하는 객체여야 합니다/],
  ]) {
    writeFileSync(summaryFile, text);
    const checked = checkVerification(f.spec, f.project);
    assert.equal(checked.ok, false, text);
    assert.match(issuesOf(checked), pattern, text);
  }
  writeFileSync(summaryFile, JSON.stringify({ headline: '됐다', todo: [], changes: [], decision: {} }));
  assert.equal(checkVerification(f.spec, f.project).ok, true);
  mkdirSync(path.join(f.capture.runDir, 'sub'), { recursive: true });
  rmSync(summaryFile);
  mkdirSync(summaryFile); // 파일 자리에 폴더
  assert.match(issuesOf(checkVerification(f.spec, f.project)), /summary\.json을 읽지 못했습니다: EISDIR/);
});

// ---------- 고친 뒤 다시 검수할 때 앞 결과를 스크립트가 남긴다(R13) ----------

const roundFiles = (runDir) => readdirSync(runDir).filter((name) => /^results-round/.test(name)).sort();
// 고친 코드를 커밋해 snapshot이 새 verification_id를 만들게 한다
function fixAndCommit(f, n) {
  writeFileSync(path.join(f.project, 'app.js'), `export const answer = ${100 + n};\n`);
  git(f.project, 'commit', '-qam', `fix ${n}`);
}

test('(h) a new snapshot after a fix saves the earlier results as results-round<n>.json and never overwrites an earlier round', () => {
  const f = fixture();
  const run = f.capture.runDir;
  const v1 = readFileSync(path.join(run, 'results.json'));
  assert.deepEqual(roundFiles(run), [], '처음 snapshot에는 앞 결과가 없다');
  assert.equal(f.capture.saved_results, null);

  fixAndCommit(f, 1);
  const second = snapshotVerification(f.spec, f.project, 'command');
  assert.equal(second.reused, false);
  assert.equal(second.saved_results, path.join(run, 'results-round1.json'));
  assert.deepEqual(readFileSync(path.join(run, 'results-round1.json')), v1);
  assert.deepEqual(readFileSync(path.join(run, 'results.json')), v1, 'results.json은 그대로다(verifier가 다시 쓴다)');

  // verifier가 다시 검수해 results.json을 새로 쓴다
  f.results.verification_id = second.verification.verification_id;
  f.results.scenarios[0].verification_id = second.verification.verification_id;
  f.results.scenarios[0].summary = '다시 검수한 결과';
  f.save();
  const v2 = readFileSync(path.join(run, 'results.json'));
  assert.notDeepEqual(v2, v1);

  fixAndCommit(f, 2);
  const third = snapshotVerification(f.spec, f.project, 'command');
  assert.equal(third.saved_results, path.join(run, 'results-round2.json'));
  assert.deepEqual(readFileSync(path.join(run, 'results-round2.json')), v2);
  assert.deepEqual(readFileSync(path.join(run, 'results-round1.json')), v1, '앞 round 파일은 덮어쓰지 않는다');
  assert.deepEqual(roundFiles(run), ['results-round1.json', 'results-round2.json']);
});

test('(h) a snapshot that reuses the capture saves nothing, and neither does one made before any results exist', () => {
  const f = fixture();
  const again = snapshotVerification(f.spec, f.project, 'command');
  assert.equal(again.reused, true);
  assert.equal(again.saved_results, undefined);
  assert.deepEqual(roundFiles(f.capture.runDir), []);
  // results.json이 아직 없을 때 새 기록을 만들면 남길 것이 없다
  const g = fixture();
  rmSync(path.join(g.capture.runDir, 'results.json'));
  fixAndCommit(g, 1);
  const next = snapshotVerification(g.spec, g.project, 'command');
  assert.equal(next.reused, false);
  assert.equal(next.saved_results, null);
  assert.deepEqual(roundFiles(g.capture.runDir), []);
});

test('(h) when the verifier has not run again since the last save, the same results are not saved twice', () => {
  const f = fixture();
  const run = f.capture.runDir;
  fixAndCommit(f, 1);
  assert.equal(snapshotVerification(f.spec, f.project, 'command').saved_results, path.join(run, 'results-round1.json'));
  fixAndCommit(f, 2); // verifier를 다시 부르기 전에 한 번 더 고쳤다: results.json은 아직 앞 검수의 것이다
  const again = snapshotVerification(f.spec, f.project, 'command');
  assert.equal(again.reused, false);
  assert.equal(again.saved_results, null);
  assert.deepEqual(roundFiles(run), ['results-round1.json']);
});

test('(h) round files that are already there (from the old way, by hand, with gaps) are never overwritten; the next number follows the highest', () => {
  const f = fixture();
  const run = f.capture.runDir;
  writeFileSync(path.join(run, 'results-round1.json'), '손으로 남긴 1');
  writeFileSync(path.join(run, 'results-round4.json'), '손으로 남긴 4');
  writeFileSync(path.join(run, 'results-round1-check.json'), '이름이 다른 파일은 번호로 세지 않는다');
  fixAndCommit(f, 1);
  const saved = snapshotVerification(f.spec, f.project, 'command').saved_results;
  assert.equal(saved, path.join(run, 'results-round5.json'));
  assert.equal(readFileSync(path.join(run, 'results-round1.json'), 'utf8'), '손으로 남긴 1');
  assert.equal(readFileSync(path.join(run, 'results-round4.json'), 'utf8'), '손으로 남긴 4');
  assert.deepEqual(roundFiles(run), ['results-round1-check.json', 'results-round1.json', 'results-round4.json', 'results-round5.json']);
});

test('(h) archiveResults: copies the bytes, is exclusive, and a results.json it cannot read stops the new snapshot before anything is written', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pact-archive-'));
  assert.equal(archiveResults(dir), null, 'results.json이 없다');
  writeFileSync(path.join(dir, 'results.json'), Buffer.from('{"한글":1}\n'));
  assert.equal(archiveResults(dir), path.join(dir, 'results-round1.json'));
  assert.deepEqual(readFileSync(path.join(dir, 'results-round1.json')), Buffer.from('{"한글":1}\n'));
  assert.equal(archiveResults(dir), null, '같은 내용은 다시 남기지 않는다');
  writeFileSync(path.join(dir, 'results.json'), '{"둘째":2}\n');
  assert.equal(archiveResults(dir), path.join(dir, 'results-round2.json'));

  const f = fixture();
  const file = path.join(f.capture.runDir, 'verification.json');
  const before = readFileSync(file, 'utf8');
  rmSync(path.join(f.capture.runDir, 'results.json'));
  mkdirSync(path.join(f.capture.runDir, 'results.json')); // 읽을 수 없다
  fixAndCommit(f, 1);
  assert.throws(() => snapshotVerification(f.spec, f.project, 'command'), /EISDIR/);
  assert.equal(readFileSync(file, 'utf8'), before, '앞 결과를 못 남기면 새 검수 기록도 만들지 않는다');
});

test('(h) CLI snapshot prints saved_results in its JSON', () => {
  const f = fixture();
  fixAndCommit(f, 1);
  const r = spawnSync(process.execPath, [CLI, 'snapshot', f.spec, f.project, 'command'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).saved_results, path.join(f.capture.runDir, 'results-round1.json'));
});

test('(f) report.mjs prints the completion check line with the fingerprint refusal, or the 참고 line for an old spec with no verifier record', () => {
  const REPORT = fileURLToPath(new URL('../scripts/report.mjs', import.meta.url));
  const report = (f) => spawnSync(process.execPath, [REPORT, f.capture.runDir], { encoding: 'utf8' });
  const old = fixture();
  const oldOut = report(old);
  assert.equal(oldOut.status, 0, oldOut.stderr);
  const oldLines = oldOut.stdout.trim().split('\n');
  assert.equal(oldLines[2], '완료 검사: 통과');
  assert.equal(oldLines[3], '참고: 옛 판이고 verifier 기록이 없어 results.json이 verifier가 쓴 그대로인지는 확인하지 않았다');
  const f = fixture({ specText: NEW_SPEC, approved: true });
  verifierStopped(f);
  assert.equal(report(f).stdout.trim().split('\n')[2], '완료 검사: 통과');
  f.results.headline = '손으로 고침';
  f.save();
  const changed = report(f).stdout;
  assert.match(changed, /^완료 검사: 막힘 1개 — results\.json이 가장 최근 verifier가 끝난 뒤\(.*\) 바뀌었다\. 코드를 고쳐야 하면 build로 되돌려 고치고 verifier로 다시 검수한다\. 코드는 맞고 results\.json만 바뀐 것이면 verifier만 다시 돌린다\./m);
  const bare = fixture({ specText: NEW_SPEC, approved: true });
  assert.match(report(bare).stdout, /^완료 검사: 막힘 1개 — 이 판에 verifier가 끝난 기록이 없어/m);
});

// ---------- 승인 기록: 검수 번호의 짝(F5)과 승인 뒤 바뀐 [사용자] 줄(F3)을 완료 검사가 본다 ----------

const TWO_QUESTIONS = checkerReply(['출석을 몇 분 뒤에 닫을까요?', '결석 사유를 학생도 볼 수 있나요?']); // 검수 1·2
const PAIRED = (extra = '') => `${NEW_SPEC.replace('- F1 목록을 연다 [사용자]', '- F1 목록을 연다 [사용자: 검수 1]')}${extra}`;
const withRule = (text, rule) => text.replace('## 공통 규칙\n', `## 공통 규칙\n${rule}\n`);
const blocked = (checked, pattern) => {
  assert.equal(checked.ok, false, issuesOf(checked));
  const mine = checked.issues.find((issue) => pattern.test(issue));
  assert.ok(mine, issuesOf(checked));
  assert.doesNotMatch(mine, /\n/, '까닭과 대신 할 일은 한 줄이다');
  return mine;
};

test('(a) the completion check and finish name the review number whose pair is missing, and the spec is not marked done', () => {
  const f = fixture({ specText: PAIRED(), approved: true, checkerMessage: TWO_QUESTIONS });
  verifierStopped(f);
  for (const checked of [checkVerification(f.spec, f.project), finishVerification(f.spec, f.project)]) {
    const mine = blocked(checked, /명세의 짝이 없다/);
    assert.match(mine, /검수 2\("결석 사유를 학생도 볼 수 있나요\?"\)에 명세의 짝이 없다/);
    assert.doesNotMatch(mine, /검수 1/, '짝이 있는 번호는 알리지 않는다');
    assert.match(mine, /\[사용자: 검수 n\].*\[AI 가정: 검수 n 맡김\].*## 확인 필요에 "- 검수 n: 안 물은 까닭"/);
  }
  assert.equal(parseSpec(readFileSync(f.spec, 'utf8')).frontmatter.status, 'verifying');
  // 번호가 둘 다 빠지면 둘 다 알린다
  const none = fixture({ specText: NEW_SPEC, approved: true, checkerMessage: TWO_QUESTIONS });
  verifierStopped(none);
  assert.match(blocked(checkVerification(none.spec, none.project), /명세의 짝이 없다/), /검수 1\(.*\), 검수 2\(/);
});

test('(a) each of the three pairs for 검수 2 lets the completion check and finish through', () => {
  for (const [label, text] of [
    ['## 확인 필요의 - 검수 2', PAIRED('## 확인 필요\n- 검수 2: 사용자가 바쁘다고 해서 묻지 않았다\n')],
    ['위임이라 기본안으로 정함', PAIRED('## 확인 필요\n- 검수 2: 위임이라 기본안으로 정함\n')],
    ['[AI 가정: 검수 2 맡김]', withRule(PAIRED(), '- R2 결석 사유 공개 여부 — 사용자가 맡겼다 [AI 가정: 검수 2 맡김]')],
    ['[사용자: 검수 2]', withRule(PAIRED(), '- R2 결석 사유는 학생도 본다 [사용자: 검수 2]')],
  ]) {
    const f = fixture({ specText: text, approved: true, checkerMessage: TWO_QUESTIONS });
    verifierStopped(f);
    const checked = checkVerification(f.spec, f.project);
    assert.equal(checked.ok, true, `${label}: ${issuesOf(checked)}`);
    const finished = finishVerification(f.spec, f.project);
    assert.equal(finished.ok, true, `${label}: ${issuesOf(finished)}`);
    assert.equal(parseSpec(readFileSync(f.spec, 'utf8')).frontmatter.status, 'done');
  }
});

test('(b) a spec-checker record that says "사용자만 답할 수 있음: 없음" passes, and a record whose numbers cannot be read is refused', () => {
  for (const message of [checkerReply(), '## 사용자만 답할 수 있음\n- 없음', '사용자만 답할 수 있음: 없음']) {
    const f = fixture({ specText: NEW_SPEC, approved: true, checkerMessage: message });
    verifierStopped(f);
    assert.equal(checkVerification(f.spec, f.project).ok, true, message);
  }
  for (const message of ['', '## 이미 답이 있음\n- 없음', '## 사용자만 답할 수 있음\n1. 질문 (기본안: …)']) {
    const f = fixture({ specText: NEW_SPEC, approved: true, checkerMessage: message });
    verifierStopped(f);
    assert.match(blocked(checkVerification(f.spec, f.project), /읽지 못했다/), /pact:spec-checker를 다시 불러/, message);
  }
});

test('(c) a new spec with no spec-checker record is refused, with where the hook error log is; an old spec (pact: 1) is not asked for one', () => {
  const f = fixture({ specText: NEW_SPEC, approved: true, checker: false });
  verifierStopped(f);
  for (const checked of [checkVerification(f.spec, f.project), finishVerification(f.spec, f.project)]) {
    const mine = blocked(checked, /spec-checker가 끝난 기록이 없다/);
    assert.match(mine, /^이 판에 spec-checker가 끝난 기록이 없다 \(.*log[/\\]subagents\.jsonl\)\. pact:spec-checker로 명세를 검수하고 결과를 명세에 반영한다\./);
    assert.match(mine, /훅이 돌지 않는 것이니 플러그인 데이터 폴더의 hook-error\.log를 보고 사용자에게 알린다\(log\/에 직접 쓰지 않는다\)/);
  }
  assert.equal(parseSpec(readFileSync(f.spec, 'utf8')).frontmatter.status, 'verifying');
  // 다른 에이전트의 기록은 spec-checker 기록이 아니다
  appendRecord(f.capture.runDir, { time: new Date().toISOString(), agent_type: 'pact:reviewer', agent_id: 'r', task: 1, message: '## 사용자만 답할 수 있음\n없음' });
  assert.match(issuesOf(checkVerification(f.spec, f.project)), /spec-checker가 끝난 기록이 없다/);
  // 옛 판은 기록이 없어도, 검수 번호 짝도 [사용자] 줄도 보지 않는다
  const old = fixture();
  verifierStopped(old);
  const checked = checkVerification(old.spec, old.project);
  assert.equal(checked.ok, true, issuesOf(checked));
  assert.deepEqual(checked.notes, []);
});

test('(c) a new spec with no approval record at all is refused by the completion check, since there is nothing to compare the [사용자] lines with', () => {
  const f = fixture({ specText: NEW_SPEC, approved: true });
  verifierStopped(f);
  rmSync(path.join(f.capture.runDir, 'approvals.jsonl'));
  const mine = blocked(checkVerification(f.spec, f.project), /승인 기록이 없다/);
  assert.match(mine, /spec\.mjs approve <명세> - <<'EOF'/);
  assert.equal(finishVerification(f.spec, f.project).ok, false);
});

test('(d) a [사용자] line that changed after the approval is named by the completion check and refused by snapshot, until it is approved again', () => {
  const f = fixture({ specText: NEW_SPEC, approved: true });
  verifierStopped(f);
  const changed = NEW_SPEC.replace('목록을 연다', '목록을 내보낸다');
  writeFileSync(f.spec, changed);
  for (const checked of [checkVerification(f.spec, f.project), finishVerification(f.spec, f.project)]) {
    const mine = blocked(checked, /승인 뒤 \[사용자\] 줄이 바뀌었다/);
    assert.match(mine, /F1 바뀜\("목록을 연다 \[사용자\]" → "목록을 내보낸다 \[사용자\]"\)/);
    assert.match(mine, /바꿔 달라고 한 사용자 말을 인용해 spec\.mjs approve <명세> - <<'EOF'로 다시 기록한다/);
    assert.match(mine, /사용자가 파일을 직접 고쳤으면 한 번 묻고 그 답을 인용한다/);
    assert.doesNotMatch(mine, /"<사용자 말>"/);
  }
  assert.equal(parseSpec(readFileSync(f.spec, 'utf8')).frontmatter.status, 'verifying');
  assert.throws(() => snapshotVerification(f.spec, f.project, 'command'), (error) => /승인 뒤 \[사용자\] 줄이 바뀌었다.*F1 바뀜/.test(error.message) && !/\n/.test(error.message));
  const cli = spawnSync(process.execPath, [CLI, 'snapshot', f.spec, f.project, 'command'], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(JSON.parse(cli.stdout).issues[0], /승인 뒤 \[사용자\] 줄이 바뀌었다/);
  // 다시 승인하면(더 새 기록) snapshot이 되고, 완료 검사에서 이 이유로는 막히지 않는다
  seedApproval(f.project, '2026-10-25-list', f.spec, changed, { checker: false, time: '2026-10-25T00:20:00.000Z' });
  const again = snapshotVerification(f.spec, f.project, 'command');
  assert.equal(again.reused, false);
  assert.doesNotMatch(issuesOf(checkVerification(f.spec, f.project)), /승인 뒤 \[사용자\] 줄이 바뀌었다/);
});

test('(d) every kind of change to a [사용자] line is caught by the completion check: text, tag, case line, a line left out, a line added', () => {
  const edits = {
    글: [(t) => t.replace('목록을 연다', '목록을 내보낸다'), /F1 바뀜/],
    태그: [(t) => t.replace('다른 사람의 자료를 보이지 않는다 [사용자]', '다른 사람의 자료를 보이지 않는다 [AI 가정]'), /R1 태그가 바뀜\(\[AI 가정\]\)/],
    '케이스 줄': [(t) => t.replace('자료가 없음 → 빈 상태 표시', '자료가 없음 → 안내 문구 표시'), /F1 바뀜\("케이스: 자료가 없음 → 빈 상태 표시" → "케이스: 자료가 없음 → 안내 문구 표시"\)/],
    빼기: [(t) => t.replace('- R1 다른 사람의 자료를 보이지 않는다 [사용자]\n', ''), /R1 빠짐/],
    더하기: [(t) => `${t}- R2 새 규칙 [사용자]\n`, /R2 더해짐\("새 규칙 \[사용자\]"\)/],
  };
  for (const [label, [edit, pattern]] of Object.entries(edits)) {
    const f = fixture({ specText: NEW_SPEC, approved: true });
    verifierStopped(f);
    writeFileSync(f.spec, edit(NEW_SPEC));
    assert.match(blocked(checkVerification(f.spec, f.project), /승인 뒤 \[사용자\] 줄이 바뀌었다/), pattern, label);
  }
});

test('(e) only an [AI 가정] line changed since the approval: snapshot and the completion check pass', () => {
  const v1 = withRule(NEW_SPEC, '- R2 화면 문구는 한국어 — 한국어 사용자라서 [AI 가정]');
  const v2 = v1.replace('화면 문구는 한국어 — 한국어 사용자라서', '화면 문구는 영어 — 해외 사용자라서');
  const f = fixture({ specText: v2, approvedText: v1, approved: true }); // 승인은 v1, 지금 명세와 snapshot은 v2
  verifierStopped(f);
  const checked = checkVerification(f.spec, f.project);
  assert.equal(checked.ok, true, issuesOf(checked));
  assert.equal(finishVerification(f.spec, f.project).ok, true);
});

test('(f) an old spec (pact: 1) is not asked about review numbers or [사용자] lines; once an approval record exists for it, it is', () => {
  const old = fixture({ specText: SPEC.replace('목록을 연다', '목록을 내보낸다') });
  verifierStopped(old);
  assert.equal(checkVerification(old.spec, old.project).ok, true, '옛 판: 기록이 없으니 견줄 줄도 없다');
  // 옛 명세라도 그 뒤에 기록이 생겼는데 spec-checker 기록과 [사용자] 줄이 없다
  const h = fixture();
  verifierStopped(h);
  writeFileSync(path.join(h.capture.runDir, 'approvals.jsonl'), `${JSON.stringify({ version: 1, kind: 'delegate', quote: '끝까지 알아서 해' })}\n`);
  const issues = issuesOf(checkVerification(h.spec, h.project));
  assert.match(issues, /spec-checker가 끝난 기록이 없다/);
  assert.match(issues, /가장 최근 위임 기록에 \[사용자\] 줄이 없어 승인 뒤 바뀐 줄이 있는지 확인하지 못한다/);
  // 기록이 있는 옛 판은 새 규칙으로 통과한다
  const g = fixture({ specText: SPEC, approved: true });
  verifierStopped(g);
  assert.equal(checkVerification(g.spec, g.project).ok, true);
});

test('(f) a record with no [사용자] lines (one written by hand) is refused until the spec is approved again, and approving again repairs it', () => {
  const f = fixture({ specText: NEW_SPEC, approved: true });
  verifierStopped(f);
  const file = path.join(f.capture.runDir, 'approvals.jsonl');
  const entry = JSON.parse(readFileSync(file, 'utf8'));
  delete entry.user_lines;
  writeFileSync(file, `${JSON.stringify(entry)}\n`);
  assert.match(blocked(checkVerification(f.spec, f.project), /가장 최근 승인 기록에 \[사용자\] 줄이 없어/), /다시 기록한다/);
  assert.throws(() => snapshotVerification(f.spec, f.project, 'command'), /가장 최근 승인 기록에 \[사용자\] 줄이 없어/);
  seedApproval(f.project, '2026-10-25-list', f.spec, NEW_SPEC, { checker: false, time: '2026-10-25T00:30:00.000Z' });
  assert.equal(checkVerification(f.spec, f.project).ok, true);
});

test('(f) the review-number and [사용자]-line refusals reach the CLI: check prints them as issues and exits 1, and report.mjs puts them in the 완료 검사 line', () => {
  const REPORT = fileURLToPath(new URL('../scripts/report.mjs', import.meta.url));
  const f = fixture({ specText: PAIRED(), approved: true, checkerMessage: TWO_QUESTIONS });
  verifierStopped(f);
  const check = spawnSync(process.execPath, [CLI, 'check', f.spec, f.project], { encoding: 'utf8' });
  assert.equal(check.status, 1);
  assert.match(JSON.parse(check.stdout).issues.join('\n'), /검수 2\(.*\)에 명세의 짝이 없다/);
  const report = spawnSync(process.execPath, [REPORT, f.capture.runDir], { encoding: 'utf8' });
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /^완료 검사: 막힘 1개 — spec-checker가 '사용자만 답할 수 있음'으로 짚은 검수 2\(/m);
});

test('(g) report.mjs after a real completion check: its 참고 lines are in report.html, an old spec says so, the approval and the 검수 items are on the page, and a changed [사용자] line is warned about', () => {
  const REPORT = fileURLToPath(new URL('../scripts/report.mjs', import.meta.url));
  const run = (f) => {
    const r = spawnSync(process.execPath, [REPORT, f.capture.runDir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return { lines: r.stdout.trim().split('\n'), html: readFileSync(path.join(f.capture.runDir, 'report.html'), 'utf8') };
  };
  // 옛 판: 참고 줄이 화면에 있고 옛 판이라고 적힌다
  const old = run(fixture());
  assert.equal(old.lines[3], '참고: 옛 판이고 verifier 기록이 없어 results.json이 verifier가 쓴 그대로인지는 확인하지 않았다');
  assert.match(old.html, /<p class="meta">참고: 옛 판이고 verifier 기록이 없어 results\.json이 verifier가 쓴 그대로인지는 확인하지 않았다<\/p>/);
  assert.match(old.html, /<h2>승인 기록<\/h2>\n<p class="missing">옛 판이라 승인 기록 없음<\/p>/);
  // 새 명세: 승인 기록과 확인 필요의 검수 항목
  const spec = PAIRED('## 확인 필요\n- 검수 2: 위임이라 기본안으로 정함\n');
  const f = fixture({ specText: spec, approved: true, checkerMessage: TWO_QUESTIONS });
  verifierStopped(f);
  const ok = run(f);
  assert.equal(ok.lines[2], '완료 검사: 통과');
  assert.match(ok.html, /<strong>승인<\/strong> <span class="meta">기록 2026-10-25T00:10:00\.000Z · 메시지 2026-10-25T00:10:00\.000Z<\/span>/);
  assert.match(ok.html, /<p class="quote">승인<\/p>/);
  assert.match(ok.html, /<h2>할 일<\/h2><ul><li>검수 2: 위임이라 기본안으로 정함 \(질문: 결석 사유를 학생도 볼 수 있나요\?\)<\/li><\/ul>/);
  assert.doesNotMatch(ok.html, /class="meta">참고/);
  assert.doesNotMatch(ok.html, /아직 다시 승인되지 않았습니다/);
  // 승인한 뒤 [사용자] 줄이 바뀌었다: 완료 검사 줄과 보고서가 모두 알린다
  writeFileSync(f.spec, spec.replace('목록을 연다', '목록을 내보낸다'));
  const changed = run(f);
  assert.match(changed.lines.join('\n'), /^완료 검사: 막힘 \d개 — .*승인 뒤 \[사용자\] 줄이 바뀌었다/m);
  assert.match(changed.html, /<p class="missing">승인 뒤 바뀐 \[사용자\] 줄이 아직 다시 승인되지 않았습니다\. 아래 승인 기록에 있습니다\.<\/p>/);
  assert.match(changed.html, /<span class="tag">바뀜<\/span>F1 <del>목록을 연다 \[사용자: 검수 1\] \/ 케이스: 자료가 없음 → 빈 상태 표시<\/del> <ins>목록을 내보낸다 \[사용자: 검수 1\] \/ 케이스: 자료가 없음 → 빈 상태 표시<\/ins>/);
});
