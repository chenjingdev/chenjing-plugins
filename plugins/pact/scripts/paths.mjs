import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 판 하나의 모든 것은 .pact/<run-id>/ 한 폴더에 둔다: 명세(spec.md), 승인 기록, 체크리스트, 스케치, 작업 보고, 검수 기록, 결과, 보고서, 스크린샷.
// 이 폴더는 git에 들어간다. .pact/.gitignore는 작업 중 임시 것만 뺀다: worktree(wt/)와 임시 파일(scratch/), 명세에서 다시 만드는 spec.html.
export const PACT_GITIGNORE = `# pact: 작업 중 임시 것만 뺀다. 명세·승인 기록·검수 기록·보고서·스크린샷은 git에 들어간다.
*/wt/
*/scratch/
# 명세에서 다시 만드는 파일
*/spec.html
node_modules/
.DS_Store
`;

export function writePactIgnore(root) {
  const ignore = path.join(root, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, PACT_GITIGNORE);
  return ignore;
}

export function ensureRunDir(projectDir, slug) {
  const root = path.join(projectDir, '.pact');
  const run = path.join(root, slug);
  mkdirSync(run, { recursive: true });
  writePactIgnore(root);
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
