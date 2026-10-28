// 스크립트를 링크 경로로 불러도 직접 실행 검사가 참이어야 한다.
// import.meta.url은 링크를 푼 경로이고 process.argv[1]은 풀지 않아서, URL끼리 비교하던 옛 검사는 링크로 설치된 곳에서
// 아무 출력 없이 종료 코드 0으로 끝났다(finish가 조용히 통과하는 꼴).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainModule } from '../scripts/paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pact-paths-'));
  made.push(dir);
  return dir;
};

const SCRIPTS = ['spec', 'verification', 'report', 'checklist', 'gallery', 'git-state'];

function run(script, cwd) {
  const r = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('isMainModule compares real paths: true for the file itself and for a link to it, false for another file', () => {
  const dir = tmp();
  const real = path.join(dir, 'tool.mjs');
  writeFileSync(real, '');
  const link = path.join(dir, 'tool-link.mjs');
  symlinkSync(real, link);
  const other = path.join(dir, 'other.mjs');
  writeFileSync(other, '');
  const url = pathToFileURL(real).href;
  assert.equal(isMainModule(url, real), true);
  assert.equal(isMainModule(url, link), true, '링크로 부르면 argv[1]은 링크 경로다');
  assert.equal(isMainModule(url, other), false);
  assert.equal(isMainModule(url, undefined), false, 'argv[1]이 없다(node -e, REPL)');
  assert.equal(isMainModule(url, path.join(dir, 'missing.mjs')), false, '없는 파일이어도 던지지 않는다');
});

test('every script that can be run directly still runs, and prints the same, when the plugin folder is reached through a symbolic link', () => {
  const work = tmp();
  const link = path.join(work, 'plugin-link');
  symlinkSync(ROOT, link);
  const cwd = tmp(); // git 저장소가 아닌 폴더: git-state도 한 줄을 출력한다
  mkdirSync(path.join(cwd, 'x'));
  for (const name of SCRIPTS) {
    const direct = run(path.join(ROOT, 'scripts', `${name}.mjs`), cwd);
    const linked = run(path.join(link, 'scripts', `${name}.mjs`), cwd);
    assert.ok(direct.stdout || direct.stderr, `${name}: 실제 경로로 돌리면 출력이 있다`);
    assert.deepEqual(linked, direct, `${name}: 링크 경로로 돌려도 같다`);
  }
});

test('a linked script keeps its exit code: an unverified spec cannot finish through a link (the silent exit 0 was the dangerous part)', () => {
  const work = tmp();
  const link = path.join(work, 'plugin-link');
  symlinkSync(ROOT, link);
  const spec = path.join(work, 'spec.md');
  writeFileSync(spec, '---\npact: 2\nstatus: verifying\n---\n# x\n');
  const r = spawnSync(process.execPath, [path.join(link, 'scripts', 'verification.mjs'), 'finish', spec, work], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /"ok":false/);
});
