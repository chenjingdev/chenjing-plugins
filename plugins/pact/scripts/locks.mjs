// 실행 폴더(<프로젝트>/.pact/<run-id>/) 바로 밑의 기록 파일을 정해진 쪽만 쓰게 하는 규칙(명세 F1, R5, R6, R14). 훅(hooks/guard.mjs)이 부른다.
//
//   results.json, results-round*.json   검수 결과. pact:verifier만 쓴다.
//   verification.json                    검수 기록. verification.mjs snapshot만 쓴다(누가 직접 써도 막는다, verifier도).
//   approvals.jsonl, log/ 밑             승인 기록과 하위 에이전트 기록. 훅과 pact 스크립트만 쓴다(누가 직접 써도 막는다).
//
// 막지 않는 것: 읽기, `<run-dir>/wt/` 밑(worker의 작업 공간), summary.json·report.html·shots/·plan.md·tasks/ 같은 나머지 파일,
// 그리고 명세(`<프로젝트>/docs/pact/<run-id>.md`)가 실제로 없는 폴더(시험이나 개발 중 임시 `.pact/`). 옛 판(R5)도 똑같이 건다.
//
// 보는 곳은 Edit·Write·MultiEdit·NotebookEdit의 경로와 Bash의 "쓰기 꼴"이다. Bash는 셸 명령을 낱말로 나눠(shell.mjs)
//   - 리다이렉트(`>`·`>>`·`&>` …)의 대상,
//   - `tee`·`sed -i`·`perl -i`·`cp`·`mv`·`rm`·`truncate`·`touch` 같은 명령의 대상,
//   - `python -c`·`node -e`·heredoc 한 줄 스크립트의 쓰기 호출(`open(…, 'w')`, `writeFileSync` …)의 대상
// 이 잠긴 파일인지만 본다. 읽기(`cat`·`jq`·`grep`)와 pact 스크립트 호출(`node …/verification.mjs snapshot`)은 쓰기 꼴이 아니라 지나간다.
// 같은 명령에 쓰기 꼴이 같이 붙으면(`node …/report.mjs … && echo x > results.json`) 그 부분이 걸린다.
//
// 셸이 만드는 경로를 다 풀 수는 없다. 이 명령 안에서 정하지 않은 변수로 만든 경로(`$RUN/results.json`)와
// 파일에 적어 둔 스크립트(`python3 fix.py`)는 못 본다. 그 길은 R14의 지문이 막는다:
// verification.mjs finish가 results.json을 verifier가 끝날 때 남긴 지문과 비교한다.
import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSpecForRun } from './approval.mjs';
import { parseShell } from './shell.mjs';

export const VERIFIER = 'pact:verifier';

const RESULTS_NAME = /^results(?:-round[^/]*)?\.json$/;
const GLOB_SAMPLES = ['results.json', 'results-round1.json', 'verification.json', 'approvals.jsonl', 'log'];
const MAX_TEXT = 200_000;

// ---------- 경로 → 잠금 ----------

// `<실행 폴더>/` 밑의 이름들(rest)이 잠긴 것인가: { kind, name } | null.
// 잠긴 것은 바로 밑의 정해진 이름과 log/ 밑뿐이다. 그래서 wt/(worker의 작업 공간)와 tasks/·shots/ 같은 폴더 밑은 저절로 대상이 아니다.
export function classifyRest(rest) {
  const [first, ...more] = rest;
  if (!first) return null;
  if (first === 'log') return { kind: 'log', name: more.length ? `log/${more.join('/')}` : 'log/' };
  if (more.length) return null;
  if (RESULTS_NAME.test(first)) return { kind: 'results', name: first };
  if (first === 'verification.json') return { kind: 'verification', name: first };
  if (first === 'approvals.jsonl') return { kind: 'approvals', name: first };
  return null;
}

// 절대 경로 하나가 잠긴 파일인가: { kind, name, project, runId, runDir } | null.
// 가장 왼쪽의 `.pact/<run-id>`가 그 경로의 실행 폴더다(그 밑 wt/ 안에 또 `.pact/`가 있어도 worktree 몫이다).
// 명세 파일이 실제로 있는 판에만 건다. findSpec(project, runId)가 명세 경로나 null을 돌려준다.
export function lockForPath(abs, findSpec = findSpecForRun) {
  const parts = String(abs).split('/');
  const at = parts.indexOf('.pact');
  const runId = at > 0 ? parts[at + 1] : undefined;
  if (!runId) return null;
  const hit = classifyRest(parts.slice(at + 2).filter(Boolean));
  if (!hit) return null;
  const project = parts.slice(0, at).join('/') || '/';
  if (!findSpec(project, runId)) return null;
  return { ...hit, project, runId, runDir: path.join(project, '.pact', runId) };
}

// ---------- 막을 때 내는 말(R6: 까닭과 대신 할 일) ----------

export function lockMessage(hit) {
  switch (hit.kind) {
    case 'results':
      return {
        reason: `검수 결과(${hit.name})는 verifier만 쓴다.`,
        instead: hit.name === 'results.json'
          ? '결과가 틀렸으면 build로 되돌려 고치고 verifier로 다시 검수한다. 보고 칸(headline·todo·changes·decision)은 summary.json에 쓴다.'
          : '이전 결과는 snapshot을 다시 실행할 때 스크립트가 results-round<n>.json으로 남긴다. 직접 복사하거나 고치지 않는다.',
      };
    case 'verification':
      return {
        reason: `검수 기록(${hit.name})은 verification.mjs snapshot만 쓴다.`,
        instead: '검수할 코드가 바뀌었으면 worktree를 커밋하고 snapshot을 다시 실행한다.',
      };
    case 'approvals':
      return {
        reason: `승인 기록(${hit.name})은 spec.mjs approve·delegate만 쓴다.`,
        instead: '사용자가 승인한 말을 그대로 넣어 spec.mjs approve로 기록한다.',
      };
    default:
      return {
        reason: `log/ 밑의 기록(${hit.name})은 훅이 하위 에이전트의 마지막 답을 남기는 것이라 훅과 pact 스크립트만 쓴다.`,
        instead: '기록이 빠졌으면 플러그인 데이터 폴더의 hook-error.log를 보고 사용자에게 알린다.',
      };
  }
}

// ---------- 낱말 풀기 ----------

const expandTilde = (word, home) => (word === '~' || word.startsWith('~/') ? home + word.slice(1) : word);
const isUnresolved = (word) => /[$`]/.test(word);
const hasGlob = (word) => /[*?[]/.test(word);
const isDirectory = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// 명령 안에서 바뀌는 것: `cd`로 바뀐 폴더(모르면 null)와 `NAME=값`으로 정한 변수
const newState = (cwd, home) => ({ cwd: cwd || null, vars: new Map(), home });

function expand(word, state) {
  return expandTilde(word, state.home).replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (match, a, b) => {
    const name = a ?? b;
    if (state.vars.has(name)) return state.vars.get(name);
    return name === 'HOME' ? state.home : match; // 풀 수 없으면 `$`가 남아 경로로 읽지 않는다
  });
}

// 낱말 하나를 절대 경로로. 풀 수 없으면(변수, 와일드카드, 모르는 cwd) null
function resolveWord(word, state) {
  if (!word || isUnresolved(word) || hasGlob(word)) return null;
  if (!path.isAbsolute(word) && !state.cwd) return null;
  return path.resolve(state.cwd ?? '/', word);
}

function assign(state, word) {
  const k = word.indexOf('=');
  const append = word[k - 1] === '+';
  const name = word.slice(0, append ? k - 1 : k);
  state.vars.set(name, (append ? (state.vars.get(name) ?? '') : '') + word.slice(k + 1));
}

// ---------- Bash: 명령 하나씩 ----------

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const WRAPPERS = new Set(['env', 'nohup', 'exec', 'command', 'builtin', 'time', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'sudo']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const WRITE_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '>&', '<>']);
const DECLARE = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);
const TEE = new Set(['tee', 'sponge']);
const COPY = new Set(['cp', 'install', 'rsync', 'ln']);
const EVERY_OPERAND = new Set(['mv', 'rm', 'unlink', 'shred', 'rmdir', 'touch', 'truncate']);

// 앞의 `NAME=값`과 env·nohup 같은 감싸는 말을 건너뛴 첫 낱말의 자리
function commandAt(words) {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined || !(ASSIGNMENT.test(w) || WRAPPERS.has(path.basename(w)))) return i;
    i++;
    if (!ASSIGNMENT.test(w) && ['env', 'sudo'].includes(path.basename(w))) {
      while (words[i] !== undefined && (words[i].startsWith('-') || ASSIGNMENT.test(words[i]))) i++;
    }
  }
}

// 옵션이 아닌 낱말(`--` 뒤는 모두). isValueOption인 옵션(`-e 스크립트`)은 그 값도 뺀다.
function operandsWithout(args, isValueOption) {
  const out = [];
  let rest = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!rest && a === '--') { rest = true; continue; }
    if (!rest && isValueOption(a)) { i++; continue; }
    if (rest || !a.startsWith('-') || a === '-') out.push(a);
  }
  return out;
}

const operands = (args) => operandsWithout(args, () => false);

// `bash -c '…'`·`eval …`·`bash <<EOF`가 실행하는 글. 그 안의 명령도 같이 본다.
function nestedScripts(cmd, name, args) {
  if (SHELLS.has(name)) {
    const k = args.findIndex((a) => /^-[A-Za-z]*c$/.test(a));
    if (k !== -1) return args[k + 1] === undefined ? [] : [args[k + 1]];
    const script = operands(args)[0];
    return script === undefined || script === '-' ? cmd.heredocs.map((h) => h.body) : [];
  }
  return name === 'eval' && args.length ? [args.join(' ')] : [];
}

// 명령 목록을 펴서 중첩 실행한 것까지 순서대로
function flatten(commands, depth = 0) {
  const out = [];
  for (const cmd of commands) {
    out.push(cmd);
    const i = commandAt(cmd.words);
    if (depth >= 3 || cmd.words[i] === undefined) continue;
    for (const script of nestedScripts(cmd, path.basename(cmd.words[i]), cmd.words.slice(i + 1))) out.push(...flatten(parseShell(script), depth + 1));
  }
  return out;
}

const globRegex = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);

// 찾은 잠금들. 경로를 낱말에서 풀어 lockForPath로 본다.
class Hits {
  constructor(state, findSpec) {
    this.state = state;
    this.findSpec = findSpec;
    this.list = [];
  }

  add(lock) { if (lock) this.list.push(lock); }

  // 대상 낱말 하나(경로나 와일드카드)
  target(word) {
    if (!word) return;
    if (hasGlob(word) && !isUnresolved(word)) { this.glob(word); return; }
    const abs = resolveWord(word, this.state);
    if (abs) this.add(lockForPath(abs, this.findSpec));
  }

  // 마지막 칸의 와일드카드만 본다: 그 폴더에 있는 이름과 잠긴 이름 견본 가운데 맞는 것이 대상이다
  glob(word) {
    const dir = path.dirname(word);
    if (hasGlob(dir)) return;
    const abs = resolveWord(dir, this.state);
    if (!abs) return;
    let re;
    try { re = globRegex(path.basename(word)); } catch { return; } // 짝이 안 맞는 `[`는 와일드카드가 아니라 글이다
    const names = new Set(GLOB_SAMPLES);
    try { for (const name of readdirSync(abs)) names.add(name); } catch { /* 없는 폴더 */ }
    for (const name of names) if (re.test(name)) this.add(lockForPath(path.join(abs, name), this.findSpec));
  }

  // 복사·이동의 도착: 폴더면 그 밑에 원본 이름으로 생긴다
  destination(sources, dest) {
    const abs = resolveWord(dest, this.state);
    if (!abs) return;
    if (dest.endsWith('/') || isDirectory(abs)) {
      for (const src of sources) {
        if (src && !isUnresolved(src) && !hasGlob(src)) this.add(lockForPath(path.join(abs, path.basename(src)), this.findSpec));
      }
    } else this.add(lockForPath(abs, this.findSpec));
  }
}

// 명령 이름과 인자로 그 명령이 쓰는 곳들을 hits에 더한다
function commandTargets(name, args, hits) {
  const ops = operands(args);
  if (TEE.has(name) || EVERY_OPERAND.has(name)) ops.forEach((w) => hits.target(w));
  if (name === 'mv' && ops.length > 1) hits.destination(ops.slice(0, -1), ops[ops.length - 1]);
  // sed -i·perl -i: -e로 받은 스크립트 글은 대상이 아니다
  if (name === 'sed' && args.some((a) => /^--in-place(?:=|$)/.test(a) || /^-[A-Za-z]*i/.test(a))) {
    operandsWithout(args, (a) => /^(?:-[A-Za-z]*[ef]|--expression|--file)$/.test(a)).forEach((w) => hits.target(w));
  }
  if (name === 'perl' && args.some((a) => /^-[A-Za-z0-9]*i/.test(a) && !/^-[Mm]/.test(a))) {
    operandsWithout(args, (a) => /^-[A-Za-z0-9]*[eE]$/.test(a)).forEach((w) => hits.target(w));
  }
  if (name === 'dd') for (const a of args) if (a.startsWith('of=')) hits.target(a.slice(3));
  if (COPY.has(name)) {
    const t = args.findIndex((a) => a === '-t' || a === '--target-directory');
    const joined = args.find((a) => a.startsWith('--target-directory='));
    if (t !== -1 && args[t + 1] !== undefined) hits.destination(ops.filter((w) => w !== args[t + 1]), args[t + 1]);
    else if (joined) hits.destination(ops, joined.slice('--target-directory='.length));
    else if (ops.length > 1) hits.destination(ops.slice(0, -1), ops[ops.length - 1]);
  }
}

// ---------- 한 줄 스크립트(python -c, node -e, heredoc) ----------

const PYTHON = /^(?:python[0-9.]*|pypy[0-9.]*)$/;
const NODEISH = /^(?:node|nodejs|bun|deno|tsx)$/;
const NODE_VALUE_OPTIONS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--input-type', '-C', '--conditions', '--env-file']);

// 이 명령이 한 줄 스크립트로 돌리는 글들. 스크립트 파일을 돌릴 때 붙은 heredoc은 그 스크립트의 입력일 뿐이라 글로 보지 않는다.
function inlineScripts(cmd, name, args) {
  const stdin = () => [...cmd.heredocs.map((h) => h.body), ...cmd.here];
  if (PYTHON.test(name)) {
    const c = args.findIndex((a) => /^-[A-Za-z]*c$/.test(a));
    if (c !== -1) return args[c + 1] === undefined ? [] : [args[c + 1]];
    if (args.includes('-m')) return [];
    const script = args.find((a) => !a.startsWith('-') || a === '-');
    return script === undefined || script === '-' ? stdin() : [];
  }
  if (NODEISH.test(name)) {
    const e = args.findIndex((a) => /^(?:-e|-p|-pe|-ep|--eval|--print)$/.test(a));
    if (e !== -1) return args[e + 1] === undefined ? [] : [args[e + 1]];
    const joined = args.find((a) => /^--(?:eval|print)=/.test(a));
    if (joined) return [joined.slice(joined.indexOf('=') + 1)];
    if (name === 'deno' && args[0] === 'eval') return args.slice(1).filter((a) => !a.startsWith('-')).slice(0, 1);
    for (let i = 0; i < args.length; i++) {
      if (NODE_VALUE_OPTIONS.has(args[i])) { i++; continue; }
      if (args[i] === '-') return stdin();
      if (!args[i].startsWith('-')) return [];
    }
    return stdin();
  }
  return [];
}

// 쓰는 호출 → 대상으로 읽을 인자의 자리. 한 줄 스크립트에서 흔한 Python·Node 꼴만 본다.
const table = (entries) => Object.assign(Object.create(null), entries);
const QUALIFIED_CALLS = table({
  'os.remove': [0], 'os.unlink': [0], 'os.truncate': [0], 'os.rmdir': [0], 'os.removedirs': [0],
  'os.rename': [0, 1], 'os.replace': [0, 1], 'os.symlink': [1], 'os.link': [1],
  'shutil.rmtree': [0], 'shutil.move': [0, 1], 'shutil.copy': [1], 'shutil.copy2': [1], 'shutil.copyfile': [1], 'shutil.copytree': [1],
});
const FS_CALLS = table({
  writeFile: [0], writeFileSync: [0], appendFile: [0], appendFileSync: [0], createWriteStream: [0],
  unlink: [0], unlinkSync: [0], rm: [0], rmSync: [0], rmdir: [0], rmdirSync: [0], truncate: [0], truncateSync: [0],
  copyFile: [1], copyFileSync: [1], cp: [1], cpSync: [1], rename: [0, 1], renameSync: [0, 1],
});
// `fs.`·`fsp.` 없이 이름만 불러도 쓰기로 읽는 것(rm·cp·rename처럼 다른 뜻으로 흔히 쓰는 이름은 뺀다)
const BARE_FS = new Set(['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'unlinkSync', 'rmSync', 'rmdirSync', 'truncateSync', 'copyFile', 'copyFileSync', 'cpSync', 'renameSync']);
const OPEN_CALLS = new Set(['open', 'io.open', 'codecs.open', 'builtins.open', 'fs.openSync', 'fs.open', 'fsp.open', 'openSync']);
const RECEIVER_METHODS = new Set(['write_text', 'write_bytes', 'unlink', 'touch']);

const STRING_RE = /"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'|`((?:\\.|[^`\\])*)`/g;
const literalsIn = (text) => [...text.matchAll(STRING_RE)].map((m) => m[1] ?? m[2] ?? m[3]);
const withoutStrings = (text) => text.replace(STRING_RE, '""');
const IDENT = /(?<![\w$.])[A-Za-z_$][\w$]*/g;

// 문자열 안의 글을 공백으로 가린 같은 길이의 글. 문자열로 적어 둔 코드(`new_tests = """writeFileSync(…)"""`)를 호출로 읽지 않으려고
// 호출과 대입은 가린 글에서 찾고, 인자와 오른쪽 글은 같은 자리의 원래 글에서 읽는다. 따옴표 세 개(Python)와 백틱(JS)은 여러 줄이고,
// 따옴표 하나는 줄이 끝나면 닫힌 것으로 본다(주석의 아포스트로피가 뒤 코드를 삼키지 않게).
function maskStrings(code) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c !== '"' && c !== "'" && c !== '`') { out += c; i++; continue; }
    const quote = c !== '`' && code.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
    let j = i + quote.length;
    let closed = false;
    for (; j < code.length; j++) {
      if (code[j] === '\\') { j++; continue; }
      if (code.startsWith(quote, j)) { closed = true; break; }
      if (quote.length === 1 && c !== '`' && code[j] === '\n') break;
    }
    const bodyEnd = Math.min(j, code.length);
    out += quote + code.slice(i + quote.length, bodyEnd).replace(/[^\n]/g, ' ') + (closed ? quote : '');
    i = bodyEnd + (closed ? quote.length : 0);
  }
  return out;
}

// 괄호 안의 인자 글들. from은 `(` 다음 자리
function splitArgs(code, from) {
  const args = [];
  let depth = 0;
  let start = from;
  let quote = null;
  const end = Math.min(code.length, from + 3000);
  for (let i = from; i < end; i++) {
    const c = code[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) { args.push(code.slice(start, i)); return args; }
      depth--;
    } else if (c === ',' && depth === 0) { args.push(code.slice(start, i)); start = i + 1; }
  }
  args.push(code.slice(start, end));
  return args;
}

// 변수에 대입한 글: 이름 → [{ at, rhs, plain }]. plain은 `=`(아니면 `+=`·`|=`)
function assignmentsIn(code) {
  const map = new Map();
  const re = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?::\s*[\w.[\], ]+)?(\+|\|)?=(?![=>])/g;
  for (const m of maskStrings(code).matchAll(re)) {
    const from = m.index + m[0].length;
    const limit = Math.min(code.length, from + 2000);
    let depth = 0;
    let quote = null;
    let end = from;
    for (; end < limit; end++) {
      const c = code[end];
      if (quote) { if (c === '\\') end++; else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (depth <= 0 && (c === '\n' || c === ';')) break;
    }
    if (!map.has(m[1])) map.set(m[1], []);
    map.get(m[1]).push({ at: m.index, rhs: code.slice(from, end), plain: !m[2] });
  }
  return map;
}

// 글 안의 이름(변수)과 f-string·템플릿 글 안의 `{이름}`
function identsIn(text) {
  const names = new Set(withoutStrings(text).match(IDENT) ?? []);
  for (const m of text.matchAll(/\$?\{\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}

// 한 줄 스크립트에서 쓰는 호출의 대상 글들: [{ text, at }]
function writeTargets(code) {
  const out = [];
  const writes = (mode) => {
    const m = /^\s*(?:(?:mode|flags)\s*=\s*)?[urbtUR]*(?:"([^"]*)"|'([^']*)')/.exec(mode ?? '');
    return Boolean(m) && /[wax+]/.test(m[1] ?? m[2]);
  };
  for (const m of maskStrings(code).matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)) {
    const full = m[1];
    const dot = full.lastIndexOf('.');
    const last = full.slice(dot + 1);
    const at = m.index;
    const open = at + m[0].length;
    if (code[at - 1] === '.') { // 앞 표현식의 메서드: `Path(…).write_text(`는 그 줄의 앞 글이 받는 쪽이고, `require('fs').writeFileSync(`는 fs 호출이다
      const before = code.slice(0, at - 1);
      if (RECEIVER_METHODS.has(full)) {
        out.push({ text: before.slice(Math.max(before.lastIndexOf('\n'), before.lastIndexOf(';')) + 1), at });
      } else if (FS_CALLS[full] && (BARE_FS.has(full) || /require\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)\s*$/.test(before))) {
        const args = splitArgs(code, open);
        for (const i of FS_CALLS[full]) if (args[i] !== undefined) out.push({ text: args[i], at });
      }
      continue;
    }
    if (OPEN_CALLS.has(full)) {
      const args = splitArgs(code, open);
      const mode = args.find((a, i) => i > 0 && /^\s*(?:mode|flags)\s*=/.test(a)) ?? args[1];
      if (writes(mode) && args[0] !== undefined) out.push({ text: args[0], at });
      continue;
    }
    const fs = /^(?:fs|fsp|promises|fs\.promises)\.(\w+)$/.exec(full);
    const spots = QUALIFIED_CALLS[full] ?? (fs && FS_CALLS[fs[1]]) ?? (BARE_FS.has(full) ? FS_CALLS[full] : undefined);
    if (spots) {
      const args = splitArgs(code, open);
      for (const i of spots) if (args[i] !== undefined) out.push({ text: args[i], at });
    } else if (dot !== -1 && RECEIVER_METHODS.has(last)) { // `p.write_text(…)`: 점 앞 이름이 받는 쪽이다
      out.push({ text: full.slice(0, dot), at });
    }
  }
  return out;
}

// 쓰는 곳 글 전체가 문자열 하나이면 그 문자열: 경로 전체다. 아니면 null. 그 문자열을 대입한 변수 하나(`p = 'results.json'`),
// 경로를 만들 뿐인 호출(`Path('x')`, `path.resolve('x')`, `os.path.abspath('x')` …)과 cwd에 붙이는 꼴(`Path.cwd() / 'x'`, `path.join(process.cwd(), 'x')`)도 같다.
const LITERAL = String.raw`[rRuUbB]{0,2}(?:"([^"]*)"|'([^']*)'|\x60([^\x60]*)\x60)`;
const WHOLE_LITERAL = new RegExp(`^${LITERAL}$`);
const PATH_WRAPPER = /^(?:[A-Za-z_$][\w$]*\.)*(?:Path|PurePath|PurePosixPath|resolve|normalize|abspath|normpath|realpath|expanduser|fspath|str|String)\(([\s\S]*)\)(?:\.(?:resolve|absolute|expanduser|as_posix)\(\s*\))*$/;
const CWD = String.raw`(?:process\.cwd\(\)|os\.getcwd\(\)|(?:pathlib\.)?Path\.cwd\(\)|"\."|'\.')`;
const CWD_JOIN = new RegExp(String.raw`^(?:[A-Za-z_$][\w$]*\.)*(?:join|resolve)\(\s*${CWD}\s*,\s*(${LITERAL})\s*\)$`);
const CWD_SLASH = new RegExp(String.raw`^${CWD}\s*/\s*(${LITERAL})$`);
function wholeString(text, at, assigns) {
  let t = text.trim();
  for (let k = 0; k < 8; k++) {
    const m = WHOLE_LITERAL.exec(t);
    if (m) return m[1] ?? m[2] ?? m[3];
    const paren = /^\(([\s\S]*)\)$/.exec(t);
    if (paren) { t = paren[1].trim(); continue; }
    const cwd = CWD_JOIN.exec(t) ?? CWD_SLASH.exec(t);
    if (cwd) { t = cwd[1]; continue; }
    const wrapped = PATH_WRAPPER.exec(t);
    if (wrapped) { t = wrapped[1].trim(); continue; }
    if (!/^[A-Za-z_$][\w$]*$/.test(t)) return null;
    const earlier = (assigns.get(t) ?? []).filter((a) => a.at < at);
    if (!earlier.length) return null;
    t = earlier[earlier.length - 1].rhs.trim();
  }
  return null;
}

// 쓰는 곳 글 하나가 잠긴 파일을 가리키는가. 변수는 그 앞에서 가장 가까운 대입으로 풀고, 경로 조각(`os.path.join(RUN, 'results.json')`)은
// 같은 글 안의 실행 폴더 조각과 이어 본다. 상대 경로 글은 그 글이 경로 전체일 때만 cwd에 붙인다: `os.path.join(DIR, 'results.json')`의
// 조각을 cwd 밑 파일로 짐작하면 임시 폴더에 쓰는 것까지 막힌다.
function lockInTarget(text, at, assigns, state, findSpec) {
  const pool = [text];
  const seen = new Set();
  for (let k = 0; k < pool.length && k < 24; k++) {
    for (const id of identsIn(pool[k])) {
      const list = assigns.get(id);
      if (seen.has(id) || !list) continue;
      seen.add(id);
      const before = list.filter((a) => a.at < at);
      const from = before.map((a) => a.plain).lastIndexOf(true); // 마지막 `=` 대입부터 그 뒤의 `+=`까지
      for (const a of from === -1 ? before : before.slice(from)) pool.push(a.rhs);
    }
  }
  const whole = wholeString(text, at, assigns);
  const runDirs = new Set();
  const names = new Set();
  for (const raw of pool.flatMap(literalsIn)) {
    const s = expandTilde(raw, state.home);
    // 이름 조각: `'results.json'`, `'/results.json'`, `'{run}/results.json'`처럼 앞에 폴더가 없는 것
    const named = /^(results(?:-round[^/]*)?\.json|verification\.json|approvals\.jsonl|subagents\.jsonl|log)(?:\/.*)?$/.exec(s.replace(/^(?:\$?\{[^}]*\})?\/?/, ''));
    if (named) names.add(named[1]);
    if (!s || isUnresolved(s)) continue;
    const abs = path.isAbsolute(s) ? path.resolve(s) : state.cwd ? path.resolve(state.cwd, s) : null;
    if (!abs) continue;
    if (path.isAbsolute(s) || raw === whole) {
      const direct = lockForPath(abs, findSpec);
      if (direct) return direct;
    }
    // 실행 폴더 조각: 글이 `.pact/<run-id>`에서 끝나는 것(뒤에 `/`가 붙어도 된다). 그 밑 파일 경로는 조각이 아니다.
    if (/(?:^|\/)\.pact\/[^/]+\/?$/.test(s)) runDirs.add(abs);
  }
  const inRun = (dir, name) => path.join(dir, name === 'subagents.jsonl' ? 'log/subagents.jsonl' : name === 'log' ? 'log/x' : name);
  for (const name of names) {
    for (const dir of runDirs) {
      const hit = lockForPath(inRun(dir, name), findSpec);
      if (hit) return hit;
    }
  }
  return null;
}

function scriptHits(code, state, hits) {
  if (code.length > MAX_TEXT) return;
  const assigns = assignmentsIn(code);
  for (const { text, at } of writeTargets(code)) hits.add(lockInTarget(text, at, assigns, state, hits.findSpec));
}

// ---------- Bash 명령 전체 ----------

// 명령 글에서 쓰려는 잠긴 파일들: [{ kind, name, runDir, … }]. 없으면 [].
export function bashLocks(command, { cwd, home = os.homedir(), findSpec = findSpecForRun } = {}) {
  const text = String(command ?? '');
  if (!text || text.length > MAX_TEXT) return [];
  const state = newState(cwd, home);
  const hits = new Hits(state, findSpec);
  for (const cmd of flatten(parseShell(text))) {
    const words = cmd.words.map((w) => expand(w, state));
    for (const r of cmd.redirects) {
      const target = expand(r.target, state);
      if (WRITE_OPS.has(r.op) && !(r.op === '>&' && /^(?:\d+|-)$/.test(target))) hits.target(target);
    }
    const i = commandAt(words);
    if (words[i] === undefined) { // `NAME=값`만 있는 명령
      for (const w of words) if (ASSIGNMENT.test(w)) assign(state, w);
      continue;
    }
    const name = path.basename(words[i]);
    const args = words.slice(i + 1);
    if (DECLARE.has(name)) { for (const w of args) if (ASSIGNMENT.test(w)) assign(state, w); continue; }
    if (name === 'cd' || name === 'pushd') {
      const dir = operands(args)[0];
      if (dir === undefined) state.cwd = state.home;
      else if (dir === '-' || isUnresolved(dir) || hasGlob(dir)) state.cwd = null;
      else state.cwd = path.isAbsolute(dir) ? path.resolve(dir) : state.cwd ? path.resolve(state.cwd, dir) : null;
      continue;
    }
    if (name === 'popd') { state.cwd = null; continue; }
    commandTargets(name, args, hits);
    for (const script of inlineScripts(cmd, name, args)) scriptHits(script, state, hits);
  }
  return hits.list;
}

// ---------- 도구 호출 하나 ----------

const FILE_TOOLS = table({ Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' });

// 잠긴 파일을 쓰려는 호출이면 { reason, instead }, 아니면 null. verifier이면 results 꼴은 쓸 수 있다.
// 입력은 훅의 PreToolUse 입력이다. 도구가 쓰는 경로는 셸이 풀지 않으므로 `$`나 `*`도 글자 그대로의 경로다.
export function checkLocks(input, { verifier = false, findSpec = findSpecForRun, home = os.homedir() } = {}) {
  const tool = input?.tool_name;
  const toolInput = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  let hits = [];
  if (FILE_TOOLS[tool]) {
    const raw = toolInput[FILE_TOOLS[tool]];
    const hit = typeof raw === 'string' && raw ? lockForPath(path.resolve(cwd, expandTilde(raw, home)), findSpec) : null;
    if (hit) hits = [hit];
  } else if (tool === 'Bash') {
    hits = bashLocks(toolInput.command, { cwd, home, findSpec });
  }
  const blocked = hits.find((hit) => !(verifier && hit.kind === 'results'));
  return blocked ? lockMessage(blocked) : null;
}
