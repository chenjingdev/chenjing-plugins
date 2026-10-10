import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// 실행 산출물(체크리스트, 스케치, 스크린샷, 보고서)은 .pact/<slug>/에 둔다.
// .pact/.gitignore가 자기 폴더 전체를 무시하므로 프로젝트 .gitignore는 건드리지 않는다.
export function ensureRunDir(projectDir, slug) {
  const root = path.join(projectDir, '.pact');
  const run = path.join(root, slug);
  mkdirSync(run, { recursive: true });
  const ignore = path.join(root, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  return run;
}
