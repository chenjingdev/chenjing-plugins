// pact 실행 폴더(<프로젝트>/.pact/<run-id>/)를 찾는 도구. 훅이 하위 에이전트의 마지막 답을 어느 판의 log/에 남길지 정할 때 쓰고,
// 뒤 작업의 훅 검사도 같은 함수로 "이 호출이 어느 판 것인가"를 본다. 읽기만 한다. 폴더 만들기는 부르는 쪽 몫이다(paths.mjs의 ensureRunDir).
//
// 찾는 순서(명세 R15):
//   1. 글(하위 에이전트의 첫 지시) 안의 경로. 실행 폴더 `.pact/<run-id>`나 명세 `docs/pact/<run-id>.md`가 든다.
//   2. 없으면 cwd가 속한 프로젝트에서 가장 최근에 바뀐 진행 중(status가 done이 아닌) 명세.
// run-id는 명세 파일 이름에서 확장자를 뺀 것이다(scripts/spec.mjs run-dir).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTemplate, parseSpec } from './spec.mjs';

// run-id는 slugify가 만든 한글·영문·숫자·`-`다. 손으로 만든 명세의 `_`와 `.`도 받되, 끝의 `.`는 문장 부호로 본다.
// \w는 한글을 모르므로 쓰지 않는다. `.pact/.gitignore`, `.pact/<run-id>`는 첫 글자가 글자·숫자가 아니라 걸리지 않는다.
const ID = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_-])?`;
const RUN_RE = new RegExp(String.raw`\.pact/(${ID})`, 'gu');
const SPEC_RE = /docs\/pact\/([^\s"'`<>()[\]{},;|/]+?)\.md/gu;
// 명세도 실행 폴더도 아직 없을 때 run-id로 받아 주는 꼴. `.`가 든 이름(results.json)은 파일 이름으로 보고 받지 않는다.
const SLUG = /^[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*$/u;
// 경로 앞쪽을 거슬러 읽다가 멈추는 글자
const PATH_STOP = /[\s"'`<>()[\]{},;|:=*!?]/;
const WORKTREE = /^(.*)\/\.pact\/[^/]+\/wt(?:\/.*)?$/s;

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

function ancestors(dir) {
  const out = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    out.push(d);
    if (path.dirname(d) === d) break;
  }
  return out;
}

// worker가 보는 worktree(<프로젝트>/.pact/<run-id>/wt)에도 명세 사본이 있다. 그 경로는 원래 프로젝트로 돌린다.
const normalizeProject = (dir) => {
  const m = WORKTREE.exec(dir);
  return m ? m[1] || '/' : dir;
};

// `.pact/`나 `docs/pact/` 바로 앞에 붙은 경로 조각. 공백·따옴표·괄호 앞에서 끊는다.
function pathBefore(text, index) {
  let i = index;
  while (i > 0 && !PATH_STOP.test(text[i - 1])) i--;
  return text.slice(i, index);
}

// 이 프로젝트에 이 run-id의 명세나 실행 폴더가 실제로 있는지. 한국어는 조사가 경로에 붙어 쓰이므로("…/지키기를")
// 없으면 끝의 한글을 깎아 가며 있는 것을 찾는다. 하이픈을 넘어 깎지는 않는다(`foo-bar`가 있는 `foo`로 바뀌면 안 된다).
function locate(project, id, { trim = true } = {}) {
  const probe = (name) => ({
    runId: name,
    specExists: isFile(path.join(project, 'docs', 'pact', `${name}.md`)),
    dirExists: isDir(path.join(project, '.pact', name)),
  });
  const exact = probe(id);
  if (exact.specExists || exact.dirExists || !trim) return exact;
  const tail = /[가-힣]+$/u.exec(id);
  if (tail) {
    const stem = id.slice(0, tail.index);
    const syllables = Array.from(tail[0]);
    for (let keep = syllables.length - 1; keep >= 0; keep--) {
      const name = stem + syllables.slice(0, keep).join('');
      if (!name || /[-_.]$/.test(name)) continue;
      const hit = probe(name);
      if (hit.specExists || hit.dirExists) return hit;
    }
  }
  return exact;
}

function resolveMention({ kind, id, prefix }, cwd) {
  const trim = kind === 'run';
  // 후보 폴더가 worktree 안이면 원래 프로젝트로 돌려서 거기서 찾는다.
  const probeAt = (dir) => {
    const project = normalizeProject(dir);
    return { project, ...locate(project, id, { trim }) };
  };
  if (prefix === '') {
    // `.pact/<id>`나 `docs/pact/<id>.md`로 시작하는 상대 경로: cwd와 그 윗 폴더 중 실제로 있는 곳.
    for (const dir of ancestors(cwd)) {
      const hit = probeAt(dir);
      if (hit.specExists || hit.dirExists) return hit;
    }
    return null;
  }
  if (!prefix.endsWith('/')) return null; // `x.pact/…`처럼 다른 이름의 끝이다
  let base = prefix.slice(0, -1) || '/';
  if (base === '~' || base.startsWith('~/')) base = os.homedir() + base.slice(1);
  else if (!path.isAbsolute(base)) base = path.resolve(cwd, base);
  return probeAt(path.resolve(base));
}

// 글 안에서 실행 폴더를 가리키는 모든 곳. 프로젝트 폴더가 실제로 있고, 명세나 실행 폴더가 있거나 run-id 꼴인 것만 받는다.
// 틀린 글에서 엉뚱한 곳에 폴더를 만들지 않으려는 것이다.
export function runDirCandidates(text, cwd = process.cwd()) {
  const found = [];
  const scan = (re, kind) => {
    for (const m of String(text).matchAll(re)) {
      const hit = resolveMention({ kind, id: m[1], prefix: pathBefore(String(text), m.index) }, cwd);
      if (hit && isDir(hit.project) && (hit.specExists || hit.dirExists || SLUG.test(hit.runId))) {
        found.push({ ...hit, at: m.index });
      }
    }
  };
  scan(RUN_RE, 'run');
  scan(SPEC_RE, 'spec');
  return found;
}

// 후보가 여럿이면 실제로 있는 것이 먼저다. 실행 폴더가 있으면 2점, 그 이름의 명세가 있으면 1점: 글에 적힌 실행 폴더가 실제로 있다는 것은
// 명세 경로에서 유도한 폴더보다 강한 증거다(날짜가 없는 옛 실행 폴더 `.pact/<주제>`와 날짜가 있는 명세가 같이 적힌 옛 지시문에서도 일하는 쪽이 이긴다).
// 점수가 같으면 글에서 많이 나온 것, 그다음 먼저 나온 것.
function pickBest(found) {
  const groups = new Map();
  for (const c of found) {
    const key = `${c.project}\0${c.runId}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.at = Math.min(g.at, c.at);
    } else groups.set(key, { ...c, count: 1 });
  }
  const score = (g) => (g.dirExists ? 2 : 0) + (g.specExists ? 1 : 0);
  return [...groups.values()].sort((a, b) => score(b) - score(a) || b.count - a.count || a.at - b.at)[0] ?? null;
}

// cwd가 속한 프로젝트. 실행 폴더(worktree 포함) 안이면 그 프로젝트, 아니면 docs/pact/가 있는 가장 가까운 윗 폴더.
export function projectOfCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const abs = path.resolve(cwd);
  const inRun = /^(.*?)\/\.pact\/[^/]+(?:\/|$)/s.exec(abs);
  if (inRun) return inRun[1] || '/';
  return ancestors(abs).find((dir) => isDir(path.join(dir, 'docs', 'pact'))) ?? null;
}

// 프로젝트에서 가장 최근에 바뀐 진행 중 명세의 run-id. 진행 중은 done이 아닌 것이다. 틀 그대로 버려진 초안은 뺀다(SKILL.md).
export function latestInProgressRunId(project) {
  const dir = path.join(project, 'docs', 'pact');
  let names;
  try { names = readdirSync(dir).filter((name) => name.endsWith('.md')); } catch { return null; }
  const entries = [];
  for (const name of names) {
    try { entries.push({ name, mtime: statSync(path.join(dir, name)).mtimeMs }); } catch { /* 사라진 파일 */ }
  }
  entries.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
  for (const { name } of entries) {
    let text;
    try { text = readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    if (parseSpec(text).frontmatter.status === 'done' || isTemplate(text)) continue;
    return name.slice(0, -'.md'.length);
  }
  return null;
}

// 글(하위 에이전트의 첫 지시)과 cwd로 실행 폴더를 찾는다. 못 찾으면 null.
export function findRunDir({ text = '', cwd = process.cwd() } = {}) {
  const best = pickBest(runDirCandidates(text, cwd));
  if (best) return { project: best.project, runId: best.runId, runDir: path.join(best.project, '.pact', best.runId), via: 'prompt' };
  const project = projectOfCwd(cwd);
  const runId = project ? latestInProgressRunId(project) : null;
  return runId ? { project, runId, runDir: path.join(project, '.pact', runId), via: 'cwd' } : null;
}

const REPORT_RE = /tasks\/(\d+)-report\.md/g;
const REPORT_LINE_RE = /^[ \t>*_#-]*보고서[ \t]*[:：].*?tasks\/(\d+)-report\.md/gmu;
const distinct = (text, re) => [...new Set([...String(text).matchAll(re)].map((m) => Number(m[1])))];

// 작업 번호. worker 답 맨 끝의 `보고서: <run-dir>/tasks/<n>-report.md`가 가장 믿을 만하다 — 이 작업이 실제로 쓴 보고서 하나다.
// 없으면(BLOCKED 답 등) 첫 지시의 `작업 번호 n`, 첫 지시에 보고서 경로가 하나뿐이면 그 n, 답에 보고서 경로가 하나뿐이면 그 n.
// 첫 지시에 앞 작업 보고서 경로가 여럿 들어 있을 수 있어, 여럿이면 짐작하지 않고 null을 돌려준다.
export function taskNumber({ prompt = '', reply = '' } = {}) {
  const lines = [...String(reply).matchAll(REPORT_LINE_RE)];
  if (lines.length) return Number(lines[lines.length - 1][1]);
  const labeled = /작업\s*번호\s*(?:[:：=]|는|은|이|가)?\s*(\d+)/u.exec(String(prompt));
  if (labeled) return Number(labeled[1]);
  const fromPrompt = distinct(prompt, REPORT_RE);
  if (fromPrompt.length === 1) return fromPrompt[0];
  const fromReply = distinct(reply, REPORT_RE);
  return fromReply.length === 1 ? fromReply[0] : null;
}
