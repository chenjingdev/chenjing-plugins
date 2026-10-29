import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// 이 파일이 `node <파일>`로 직접 실행된 것인지. 스크립트 맨 끝의 `if (isMainModule(import.meta.url)) { … }`가 쓴다.
// 실제 경로끼리 비교한다. import.meta.url은 심볼릭 링크를 푼 경로인데 process.argv[1]은 풀지 않아서, 둘을 그대로 비교하면
// 플러그인 폴더가 링크로 걸려 있을 때 검사가 늘 거짓이 되고 스크립트가 아무 출력 없이 종료 코드 0으로 끝난다.
// (finish가 조용히 통과하는 꼴이다.) hooks/guard.mjs는 pact 모듈을 정적으로 불러오지 않으려고 같은 검사를 따로 둔다.
export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
