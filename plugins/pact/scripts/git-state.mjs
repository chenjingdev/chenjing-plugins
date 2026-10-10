#!/usr/bin/env node
// build 단계를 시작하기 전에 작업 폴더가 git 저장소인지, 어느 브랜치인지, 안 커밋된 변경이 있는지 본다.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const git = (dir, ...args) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  return r.error || r.status !== 0 ? null : r.stdout.trim();
};

export function gitState(dir) {
  if (git(dir, 'rev-parse', '--is-inside-work-tree') !== 'true') return { repo: false, branch: null, dirty: false };
  const branch = git(dir, 'symbolic-ref', '--short', '-q', 'HEAD') || null;
  const dirty = Boolean(git(dir, 'status', '--porcelain'));
  return { repo: true, branch, dirty };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(gitState(process.argv[2] ?? process.cwd())));
}
