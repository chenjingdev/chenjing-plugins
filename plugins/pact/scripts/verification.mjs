#!/usr/bin/env node
// 검수를 시작할 때 명세와 코드의 내용을 기록(snapshot)해 두고, 완료 전에 결과가 그 기록에서 나온 것인지,
// 시나리오와 증거가 빠지지 않았는지 검사한다. verifier가 적은 ID와 대조하는 기록이지, 실제로 써 봤는지를
// 대신 보증하지는 않는다. 그것은 verifier의 일이다.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { lintSpec, parseSpec, setStatus, specRunDir } from './spec.mjs';
import { evidenceIssues, effectiveResult } from './evidence.mjs';
import { isMainModule } from './paths.mjs';
import { checkStart, refusalLine } from './approval.mjs';
import { latestVerifierFingerprint, logFile, resultsSha256 } from './run-log.mjs';
import { decisionOf, readSummary } from './summary.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const isSha = (value) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const slash = (value) => value.split(path.sep).join('/');
// 명세와 pact 산출물은 검수 대상 코드가 아니다.
const excluded = (value) => value === '.pact' || value.startsWith('.pact/') || value === 'docs/pact' || value.startsWith('docs/pact/') || value === '.git' || value.startsWith('.git/');

function git(dir, args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

// 추적 중인 파일의 작업 트리 내용으로 fingerprint를 만든다. 커밋 전 수정도 잡히고, 커밋이나 worktree→main 병합처럼
// 내용이 같은 이동에는 fingerprint가 바뀌지 않는다. 사용자가 메인 폴더에 둔 미추적 파일은 검수 대상이 아니라 넣지 않고
// 개수만 돌려준다.
export function sourceFingerprint(targetDir) {
  const target = realpathSync(targetDir);
  if (!lstatSync(target).isDirectory()) throw new Error('검사 대상은 폴더여야 합니다');
  const repo = git(target, ['rev-parse', '--show-toplevel'])?.trim();
  if (!repo) throw new Error('검수 대상의 Git 저장소를 확인하지 못했습니다');
  const head = git(target, ['rev-parse', '--verify', 'HEAD'])?.trim();
  if (!head) throw new Error('검수 대상의 실제 HEAD를 확인하지 못했습니다');
  const tracked = git(target, ['ls-files', '-z', '--cached', '--', '.']);
  if (tracked === null) throw new Error('대상 파일 목록을 Git에서 읽지 못했습니다');
  const others = git(target, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.']) ?? '';
  const untracked = others.split('\0').filter(Boolean).map(slash).filter((name) => !excluded(name)).sort();
  const files = {};
  const digest = createHash('sha256');
  for (const name of [...new Set(tracked.split('\0').filter(Boolean).map(slash))].sort()) {
    if (excluded(name)) continue;
    const absolute = path.resolve(target, name);
    if (!absolute.startsWith(target + path.sep)) throw new Error(`대상 밖 파일 경로입니다: ${name}`);
    let stat;
    try { stat = lstatSync(absolute); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isDirectory()) throw new Error(`하위 저장소의 내용은 아직 검사할 수 없습니다: ${name}`);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`지원하지 않는 파일 형식입니다: ${name}`);
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
    const type = stat.isSymbolicLink() ? 'link' : (stat.mode & 0o111 ? 'executable' : 'file');
    files[name] = hash(Buffer.concat([Buffer.from(`${type}\n`), bytes]));
    digest.update(`${JSON.stringify([name, files[name]])}\n`);
  }
  const common = git(target, ['rev-parse', '--git-common-dir'])?.trim();
  if (!common) throw new Error('검수 대상의 Git 작업 공간을 확인하지 못했습니다');
  return {
    fingerprint: digest.digest('hex'), files, count: Object.keys(files).length, untracked, target,
    identity: realpathSync(path.resolve(target, common)), head, repo: realpathSync(repo),
  };
}

// 명세의 fingerprint. status 줄과 `## 결정 기록`은 검수 중에도 적는 칸이라 빼고 본다.
const DECISION_LOG = /^## 결정 기록[^\n]*(?:\n[\s\S]*?)?(?=^## |(?![\s\S]))/m;
export function specIdentity(text) {
  const normalized = setStatus(String(text).replace(/\r\n/g, '\n'), 'verifying');
  return hash(normalized.replace(DECISION_LOG, ''));
}

function input(specFile, targetDir) {
  const specPath = realpathSync(specFile);
  const text = readFileSync(specPath, 'utf8');
  const issues = lintSpec(text);
  const parsed = parseSpec(text);
  const features = parsed.items.filter((item) => item.section === '기능' && /^F\d+$/.test(item.id));
  if (!features.length) issues.push('기능 F 항목이 하나 이상 필요합니다');
  const project = realpathSync(path.resolve(path.dirname(specPath), '..', '..'));
  return { specPath, text, parsed, features, project, specHash: specIdentity(text), source: sourceFingerprint(targetDir), issues };
}

// 명세에 적힌 케이스만 센다. 기능에 없는 케이스를 만들어 채우게 하지 않는다.
export function declaredCases(text) {
  let section = null;
  let feature = null;
  const counts = new Map();
  const cases = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) { section = heading[1]; feature = null; continue; }
    if (section !== '기능') continue;
    const item = /^-\s+([FR]\d+)\b/.exec(line);
    if (item) { feature = item[1].startsWith('F') ? item[1] : null; continue; }
    if (feature && /^\s+-\s+케이스:\s*\S/.test(line)) {
      const number = (counts.get(feature) || 0) + 1;
      counts.set(feature, number);
      cases.push({ id: `${feature}-C${number}`, feature });
    }
  }
  return cases;
}

function writeJson(file, data) {
  if (existsSync(file) && !lstatSync(file).isFile()) throw new Error('검수 기록은 일반 파일이어야 합니다');
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, file);
}

// 앞 결과를 results-round<n>.json으로 남긴다(명세 R13). 새 검수 기록을 만들 때 부른다: 그때 results.json은 앞 검수의 결과이고,
// verifier가 다시 검수하면서 덮어쓰기 전이다. 메인이 손으로 복사하던 것을 스크립트가 한다(결과 파일은 verifier만 쓰도록 훅이 잠근다).
// n은 이미 있는 round 번호 가운데 가장 큰 것 다음 번호이고, 있는 파일은 덮어쓰지 않는다. results.json이 없거나, 가장 높은 번호의
// round 파일과 내용이 같으면(verifier가 아직 다시 돌지 않았다) 남기지 않는다. 남겼으면 그 경로를, 아니면 null을 돌려준다.
export function archiveResults(runDir) {
  const file = path.join(runDir, 'results.json');
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const rounds = readdirSync(runDir).map((name) => /^results-round(\d+)\.json$/.exec(name)).filter(Boolean).map((m) => Number(m[1]));
  const top = Math.max(0, ...rounds);
  if (top && readFileSync(path.join(runDir, `results-round${top}.json`)).equals(bytes)) return null;
  for (let n = top + 1; ; n++) {
    const target = path.join(runDir, `results-round${n}.json`);
    try {
      copyFileSync(file, target, constants.COPYFILE_EXCL);
      return target;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

const FINGERPRINT_NOTE = '참고: 옛 판이고 verifier 기록이 없어 results.json이 verifier가 쓴 그대로인지는 확인하지 않았다';

// results.json이 가장 최근에 verifier가 끝날 때의 그대로인가(명세 R14). 훅이 그때의 sha256을 log/subagents.jsonl에 남긴다.
// 다르거나, verifier 기록이 없거나, 기록의 지문이 null이면 막는다: { issue }(까닭과 대신 할 일을 한 줄로).
// 옛 판(R5)이고 verifier 기록이 하나도 없으면 비교를 건너뛰고 { note }만 남긴다. 0.6.0에서 verifier가 다시 돌아 기록이 생긴 옛 판은 비교한다.
// results.json이 없는 것은 여기서 따로 말하지 않는다(checkVerification이 읽지 못했다고 막는다). 기록을 읽지 못하면 던진다.
export function fingerprintVerdict(specFile, runDir) {
  const latest = latestVerifierFingerprint(runDir);
  const again = '코드를 고쳐야 하면 build로 되돌려 고치고 verifier로 다시 검수한다. 코드는 맞고 results.json만 바뀐 것이면 verifier만 다시 돌린다. 보고 칸은 summary.json에 쓴다.';
  if (!latest) {
    const gate = checkStart({ specFile, purpose: 'finish' });
    if (gate.ok && gate.mode === 'legacy') return { note: FINGERPRINT_NOTE };
    return {
      issue: `이 판에 verifier가 끝난 기록이 없어 results.json을 verifier가 쓴 것인지 알 수 없다 (${logFile(runDir)}). `
        + 'pact:verifier로 검수를 돌린다. 이미 돌렸는데도 기록이 없으면 훅이 돌지 않는 것이니 플러그인 데이터 폴더의 hook-error.log를 보고 사용자에게 알린다.',
    };
  }
  const recorded = latest.results_sha256;
  if (typeof recorded !== 'string' || !recorded) {
    return { issue: `가장 최근 verifier 기록(${latest.time})에 results.json 지문이 없다(그때 results.json이 없었다). pact:verifier로 다시 검수해 results.json을 쓰게 한다.` };
  }
  const now = resultsSha256(runDir);
  if (now !== null && now !== recorded) {
    return { issue: `results.json이 가장 최근 verifier가 끝난 뒤(${latest.time}) 바뀌었다. ${again}` };
  }
  return {};
}

// 지금 검수할 명세·코드의 내용을 기록한다. 내용이 같으면 있는 기록을 그대로 쓴다.
// 내용이 바뀌었으면 새 ID를 만들고 앞 기록을 previous/history로 잇는다. 그래야 고친 뒤 다시 검수할 때
// 앞 판에서 통과한 시나리오를 그대로 인정할 수 있고, 무엇이 바뀌었는지(changed_files)도 알 수 있다.
export function snapshotVerification(specFile, targetDir, surface) {
  if (!['ui', 'command'].includes(surface)) throw new Error('surface는 ui 또는 command여야 합니다');
  const current = input(specFile, targetDir);
  if (current.issues.length) throw new Error(current.issues.join('\n'));
  if (current.parsed.frontmatter.status !== 'verifying') throw new Error('snapshot은 status가 verifying일 때만 만들 수 있습니다');
  // 검수는 승인이나 위임 기록이 있는 명세만 시작한다(F2). 옛 명세(pact: 1)는 기록 없이 통과하고 결과에 그렇다고 적는다(R5, R19).
  const gate = checkStart({ specFile: current.specPath, purpose: 'snapshot' });
  if (!gate.ok) throw new Error(refusalLine(gate));
  const notes = gate.note ? { notes: [gate.note] } : {};
  const runDir = specRunDir(current.specPath);
  const file = path.join(runDir, 'verification.json');
  let old;
  if (existsSync(file)) {
    try { old = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 깨진 기록은 새로 만든다. */ }
  }
  const sameRun = old?.version === 1 && nonempty(old.verification_id) && old.spec === current.specPath;
  const inheritedHead = isSha(old?.head) && git(current.source.target, ['merge-base', '--is-ancestor', old.head, current.source.head]) !== null;
  if (sameRun && inheritedHead && old.spec_hash === current.specHash && old.target_fingerprint === current.source.fingerprint && old.target_identity === current.source.identity && old.surface === surface) {
    return { runDir, verification: old, reused: true, changed_files: [], spec_changed: false, untracked: current.source.untracked, ...notes };
  }
  const previousFiles = sameRun && old.files && typeof old.files === 'object' ? old.files : null;
  const changed_files = previousFiles
    ? [...new Set([...Object.keys(previousFiles), ...Object.keys(current.source.files)])].sort().filter((name) => previousFiles[name] !== current.source.files[name])
    : null;
  const verification = {
    version: 1, verification_id: randomUUID(), spec: current.specPath,
    spec_hash: current.specHash, target_fingerprint: current.source.fingerprint,
    target_identity: current.source.identity, target_dir: current.source.target,
    head: current.source.head, captured_at: new Date().toISOString(), surface,
    previous: sameRun ? old.verification_id : null,
    history: sameRun ? [...(Array.isArray(old.history) ? old.history : []), old.verification_id] : [],
    files: current.source.files,
  };
  const saved_results = archiveResults(runDir); // 기록을 쓰기 전에 남긴다: 못 남기면 새 기록도 만들지 않는다
  writeJson(file, verification);
  return { runDir, verification, reused: false, changed_files, spec_changed: sameRun ? old.spec_hash !== current.specHash : null, untracked: current.source.untracked, saved_results, ...notes };
}

// 완료할 수 있는지 본다. issues가 하나라도 있으면 완료할 수 없고, warnings는 알리기만 한다.
export function checkVerification(specFile, targetDir) {
  const current = input(specFile, targetDir);
  const issues = [...current.issues];
  const warnings = [];
  if (!['verifying', 'done'].includes(current.parsed.frontmatter.status)) issues.push('완료 검사는 status가 verifying 또는 done일 때만 할 수 있습니다');
  const runDir = specRunDir(current.specPath);
  let snapshot;
  let results;
  for (const [name, assign] of [['verification.json', (value) => { snapshot = value; }], ['results.json', (value) => { results = value; }]]) {
    try { assign(JSON.parse(readFileSync(path.join(runDir, name), 'utf8'))); }
    catch { issues.push(`${name}을 읽지 못했습니다`); }
  }
  // 메인이 쓰는 보고 칸(R13). 형식이 틀리면 막고, 의심 시나리오의 결정 이유(decision)는 여기서 읽는다(없으면 results.json의 옛 칸).
  const { summary, problems } = readSummary(runDir);
  issues.push(...problems);
  if (snapshot?.version !== 1 || !nonempty(snapshot?.verification_id)) issues.push('유효한 검수 snapshot이 없습니다');
  if (snapshot?.spec !== current.specPath) issues.push('snapshot이 현재 명세를 가리키지 않습니다');
  if (!isSha(snapshot?.head)) issues.push('snapshot에 검수한 실제 HEAD가 없습니다');
  if (!nonempty(snapshot?.captured_at) || !Number.isFinite(Date.parse(snapshot.captured_at))) issues.push('snapshot의 캡처 시각이 없습니다');
  if (snapshot?.spec_hash !== current.specHash) issues.push('명세가 snapshot 이후 바뀌었습니다');
  if (snapshot?.target_fingerprint !== current.source.fingerprint || snapshot?.target_identity !== current.source.identity) issues.push('대상 내용이 snapshot과 다릅니다');
  if (!['ui', 'command'].includes(snapshot?.surface)) issues.push('snapshot의 surface가 잘못됐습니다');
  const currentId = nonempty(snapshot?.verification_id) ? snapshot.verification_id : null;
  // 이 검수의 앞 판 ID도 인정한다. 고친 뒤에는 바뀐 곳에 닿는 시나리오만 다시 돌리기 때문이다.
  const accepted = new Set([currentId, ...(Array.isArray(snapshot?.history) ? snapshot.history : [])].filter(nonempty));
  if (!nonempty(results?.verification_id) || results.verification_id !== currentId) issues.push('results.json의 verification_id가 snapshot과 다릅니다');
  if (results?.surface !== undefined && results.surface !== snapshot?.surface) issues.push('results.json의 surface가 snapshot과 다릅니다');
  if (!nonempty(results?.spec) || path.resolve(current.project, results.spec) !== current.specPath) issues.push('results.json이 현재 명세를 가리키지 않습니다');
  const scenarios = Array.isArray(results?.scenarios) ? results.scenarios : [];
  if (!scenarios.length) issues.push('시나리오가 비어 있습니다');
  const newcomers = scenarios.filter((scenario) => scenario?.kind === 'newcomer').length;
  if (newcomers < 2 || newcomers > 4) issues.push('처음 쓰는 사람 시나리오는 2~4개여야 합니다');
  const itemIds = new Set(current.parsed.items.map((item) => item.id));
  const featureCoverage = new Set();
  const ruleCoverage = new Set();
  const declared = declaredCases(current.text);
  const expectedCases = new Map(declared.map((entry) => [entry.id, entry.feature]));
  const caseCoverage = new Set();
  const ids = new Set();
  const outcomes = [];
  const carried = [];
  for (const [index, scenario] of scenarios.entries()) {
    const label = nonempty(scenario?.id) ? scenario.id : `시나리오 ${index + 1}`;
    if (!nonempty(scenario?.id)) issues.push(`${label}: id가 없습니다`);
    else if (ids.has(scenario.id)) issues.push(`${label}: id가 겹칩니다`);
    ids.add(scenario?.id);
    if (!['spec', 'case', 'newcomer'].includes(scenario?.kind)) issues.push(`${label}: kind가 잘못됐습니다`);
    if (!nonempty(scenario?.verification_id) || !accepted.has(scenario.verification_id)) issues.push(`${label}: verification_id가 이 검수의 기록에 없습니다`);
    else if (scenario.verification_id !== currentId) carried.push(label);
    const items = Array.isArray(scenario?.items) ? scenario.items : [];
    if (scenario?.items !== undefined && !Array.isArray(scenario.items)) issues.push(`${label}: items는 배열이어야 합니다`);
    if (['spec', 'case'].includes(scenario?.kind) && !items.length) issues.push(`${label}: 명세 items가 비어 있습니다`);
    for (const id of items) {
      if (!itemIds.has(id)) issues.push(`${label}: 알 수 없는 명세 항목 ${id}`);
      if (/^F\d+$/.test(id) && scenario.kind === 'spec') featureCoverage.add(id);
      if (/^R\d+$/.test(id)) ruleCoverage.add(id);
    }
    if (scenario?.kind === 'case') {
      const id = scenario.case_id;
      if (!expectedCases.has(id)) issues.push(`${label}: 선언되지 않은 case_id ${String(id)}`);
      else {
        if (caseCoverage.has(id)) issues.push(`${label}: case_id가 겹칩니다: ${id}`);
        caseCoverage.add(id);
        if (!items.includes(expectedCases.get(id))) issues.push(`${label}: case_id의 기능을 items에 적어야 합니다`);
      }
    }
    const steps = Array.isArray(scenario?.steps) ? scenario.steps : [];
    if (!steps.length) issues.push(`${label}: 단계가 비어 있습니다`);
    for (const [stepIndex, step] of steps.entries()) {
      if (!nonempty(step?.action)) issues.push(`${label} 단계 ${stepIndex + 1}: 동작이 없습니다`);
      for (const problem of evidenceIssues(step ?? {}, { runDir, surface: snapshot?.surface })) issues.push(`${label} 단계 ${stepIndex + 1}: ${problem}`);
    }
    if (!['pass', 'fail', 'doubt', 'unverified'].includes(scenario?.result)) issues.push(`${label}: result가 잘못됐습니다`);
    const result = effectiveResult(scenario ?? {}, { runDir, surface: snapshot?.surface });
    outcomes.push({ id: label, result });
    if (result === 'fail' || result === 'unverified') issues.push(`${label}: ${result} 결과는 완료할 수 없습니다`);
    if (result === 'doubt' && !nonempty(decisionOf(scenario, summary))) issues.push(`${label}: 의심을 남기는 결정 이유가 없습니다`);
  }
  for (const feature of current.features) if (!featureCoverage.has(feature.id)) issues.push(`${feature.id}: 정상 흐름 검수가 없습니다`);
  // 공통 규칙은 시나리오로 확인할 수 없는 것(화면 한 장 규칙, 글 규칙)이 있어 막지 않고 알린다.
  for (const item of current.parsed.items) if (/^R\d+$/.test(item.id) && !ruleCoverage.has(item.id)) warnings.push(`${item.id}: 이 규칙을 확인한 시나리오가 없습니다`);
  for (const entry of declared) if (!caseCoverage.has(entry.id)) issues.push(`${entry.id}: 케이스 검수가 없습니다`);
  for (const key of ['missing', 'extra', 'misunderstood']) {
    if (!Array.isArray(results?.specCheck?.[key])) issues.push(`specCheck.${key} 배열이 없습니다`);
  }
  const check = results?.specCheck ?? {};
  if (Array.isArray(check.missing) && check.missing.length) issues.push(`명세에 있는데 결과물에 없는 것이 남아 있습니다: ${check.missing.join(', ')}`);
  if (Array.isArray(check.misunderstood) && check.misunderstood.length) issues.push(`명세와 다르게 동작하는 것이 남아 있습니다: ${check.misunderstood.join(', ')}`);
  if (Array.isArray(check.extra) && check.extra.length) warnings.push(`명세에 없는데 결과물에 있는 것: ${check.extra.join(', ')}`);
  // results.json은 verifier만 쓴다(훅이 잠근다). 훅이 못 막는 길로 바뀌었는지 verifier가 끝날 때의 지문과 비교해 본다(R14).
  const notes = [];
  const verdict = fingerprintVerdict(current.specPath, runDir);
  if (verdict.issue) issues.push(verdict.issue);
  if (verdict.note) notes.push(verdict.note);
  return {
    ok: issues.length === 0, runDir, verification_id: currentId, issues: [...new Set(issues)], warnings: [...new Set(warnings)], notes, carried, outcomes,
    snapshot: snapshot ?? null, current: { spec_hash: current.specHash, target_fingerprint: current.source.fingerprint, head: current.source.head },
  };
}

// 합친 뒤 원래 프로젝트 폴더에서 돌린다. 검수한 코드가 그대로 합쳐졌고 완료 검사가 통과할 때만 status를 done으로 바꾼다.
export function finishVerification(specFile, targetDir) {
  const project = realpathSync(path.resolve(path.dirname(realpathSync(specFile)), '..', '..'));
  if (realpathSync(targetDir) !== project) throw new Error('완료는 명세가 속한 프로젝트 원래 폴더에서만 할 수 있습니다. worktree를 넘기지 마세요.');
  const checked = checkVerification(specFile, targetDir);
  if (!isSha(checked.snapshot?.head) || !isSha(checked.current.head)) checked.issues.push('완료 전에 검수 HEAD와 현재 HEAD를 모두 확인해야 합니다');
  else {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', checked.snapshot.head, checked.current.head], { cwd: targetDir, encoding: 'utf8' });
    if (result.error || result.status !== 0) checked.issues.push('검수한 HEAD가 현재 프로젝트 HEAD에 병합됐는지 확인하지 못했습니다');
  }
  checked.ok = checked.issues.length === 0;
  if (checked.ok) writeFileSync(specFile, setStatus(readFileSync(specFile, 'utf8'), 'done'));
  return checked;
}

function main([command, specFile, targetDir, surface]) {
  if (!specFile || !targetDir || !['snapshot', 'check', 'finish'].includes(command)) {
    console.error('사용법: verification.mjs snapshot <명세> <대상 폴더> <ui|command> | check <명세> <대상 폴더> | finish <명세> <프로젝트 폴더>');
    return 2;
  }
  const result = command === 'snapshot' ? snapshotVerification(specFile, targetDir, surface) : command === 'check' ? checkVerification(specFile, targetDir) : finishVerification(specFile, targetDir);
  console.log(JSON.stringify(result));
  return result.ok === false ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.log(JSON.stringify({ ok: false, issues: [error.message] })); process.exitCode = 1; }
}
