#!/usr/bin/env node
// build 단계를 시작하기 전에 작업 폴더가 git 저장소인지, 어느 브랜치인지, 안 커밋된 변경이 있는지 본다.
import { spawnSync } from 'node:child_process';
import { isMainModule } from './paths.mjs';

const git = (dir, ...args) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  return r.error || r.status !== 0 ? null : r.stdout.trim();
};

// dirty는 추적 중인 파일의 변경만 본다. .env나 메모 같은 미추적 파일은 worktree로 섞이지도 합치기를 막지도 않으므로
// untracked로 따로 알려 주기만 한다. `.pact/` 밑(명세, 승인 기록, 검수 기록, 보고서)은 pact 자신의 것이라 사용자 작업이 아니다:
// changed·untracked에 넣지 않고 pact로 따로 돌려준다. build와 verify가 이 판의 폴더를 커밋한다.
const PACT_PATH = /(^|\/)\.pact\//;
export function gitState(dir) {
  if (git(dir, 'rev-parse', '--is-inside-work-tree') !== 'true') return { repo: false, branch: null, dirty: false, changed: [], untracked: [], pact: [] };
  const branch = git(dir, 'symbolic-ref', '--short', '-q', 'HEAD') || null;
  const r = spawnSync('git', ['status', '--porcelain=v1', '-z'], { cwd: dir, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    const reason = r.error?.message || r.stderr?.trim() || `종료 코드 ${r.status}, 신호 ${r.signal ?? '없음'}`;
    throw new Error(`git status 조회 실패: ${reason}`);
  }
  const entries = (r.stdout ?? '').split('\0').filter(Boolean);
  const changed = [];
  const untracked = [];
  const pact = [];
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i].slice(0, 2);
    const file = entries[i].slice(3);
    const renamed = code !== '??' && (code.includes('R') || code.includes('C'));
    if (renamed) i++; // 이름 바꾸기는 원래 이름이 다음 항목에 온다
    if (PACT_PATH.test(file)) pact.push(file);
    else if (code === '??') untracked.push(file);
    else changed.push(file);
  }
  return { repo: true, branch, dirty: changed.length > 0, changed, untracked, pact };
}

if (isMainModule(import.meta.url)) {
  try {
    console.log(JSON.stringify(gitState(process.argv[2] ?? process.cwd())));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
