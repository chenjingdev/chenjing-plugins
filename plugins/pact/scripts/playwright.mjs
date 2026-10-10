#!/usr/bin/env node
// verify 단계의 브라우저 도구. 프로젝트에 Playwright가 있으면 그것을 쓰고, 없으면 pact 전용 폴더에 한 번 설치한다.
// 프로젝트의 package.json은 건드리지 않는다. JSON 결과만 stdout으로, 안내와 설치 로그는 stderr로 보낸다.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// 1.55.0은 Node 26에서 브라우저 압축 해제가 멈춰서 1.63.0으로 올렸다.
export const PLAYWRIGHT_VERSION = '1.63.0';

const found = (root) => {
  const dir = path.join(root, 'node_modules', 'playwright');
  try {
    return { dir, version: JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version };
  } catch {
    return null;
  }
};

export function resolvePlaywright(projectDir, dataDir) {
  const own = found(projectDir);
  if (own) return { source: 'project', modulePath: own.dir };
  // pact가 깐 것은 지금 버전일 때만 쓴다. 예전 버전이면 없는 것으로 보고 다시 깐다.
  const pact = found(path.join(dataDir, 'playwright'));
  if (pact?.version === PLAYWRIGHT_VERSION) return { source: 'pact', modulePath: pact.dir };
  return null;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', process.stderr, process.stderr] });
  if (r.error || r.status !== 0) throw new Error(`실패: ${cmd} ${args.join(' ')}`);
}

// 패키지가 있어도 브라우저를 내려받지 않았을 수 있다(@playwright/test만 쓰는 프로젝트 등).
function hasBrowser(modulePath) {
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(modulePath)}).chromium.executablePath())`], {
    encoding: 'utf8',
  });
  return r.status === 0 && Boolean(r.stdout) && existsSync(r.stdout);
}

function ensure(projectDir) {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA || path.join(homedir(), '.pact');
  let pw = resolvePlaywright(projectDir, dataDir);
  if (!pw) {
    const prefix = path.join(dataDir, 'playwright');
    if (process.env.PACT_NO_INSTALL === '1') {
      console.error(`Playwright가 없고 PACT_NO_INSTALL=1이라 설치하지 않습니다 (${prefix})`);
      return 2;
    }
    console.error(`Playwright ${PLAYWRIGHT_VERSION}과 Chromium을 ${prefix}에 설치합니다 (처음 한 번, 수백 MB)`);
    mkdirSync(prefix, { recursive: true });
    run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', `playwright@${PLAYWRIGHT_VERSION}`]);
    run(process.execPath, [path.join(prefix, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium']);
    pw = resolvePlaywright(projectDir, dataDir);
    if (!pw) throw new Error(`설치했지만 Playwright를 찾지 못했습니다: ${prefix}`);
  }
  if (!hasBrowser(pw.modulePath)) {
    if (process.env.PACT_NO_INSTALL === '1') {
      console.error(`Playwright는 있지만 Chromium이 없고 PACT_NO_INSTALL=1이라 내려받지 않습니다 (${pw.modulePath})`);
      return 2;
    }
    console.error('Chromium을 내려받습니다 (처음 한 번, 수백 MB)');
    run(process.execPath, [path.join(pw.modulePath, 'cli.js'), 'install', 'chromium']);
    if (!hasBrowser(pw.modulePath)) throw new Error('Chromium을 내려받았지만 실행 파일을 찾지 못했습니다');
  }
  console.log(JSON.stringify(pw));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, projectDir] = process.argv.slice(2);
  if (cmd !== 'ensure') {
    console.error('사용법: playwright.mjs ensure <projectDir>');
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = ensure(projectDir ?? process.cwd());
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  }
}
