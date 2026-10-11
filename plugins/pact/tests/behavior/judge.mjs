// 행동 시험의 판정 함수. transcript는 턴 배열이고, 턴은 claude -p stream-json 이벤트 배열이다.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { lintSpec } from '../../scripts/spec.mjs';

const contentOf = (ev) => (ev?.type === 'assistant' ? ev.message?.content ?? [] : []);
const at = (transcript, turn) => transcript.at(turn ?? -1) ?? [];

export function replyOf(transcript, turn = -1) {
  return at(transcript, turn)
    .flatMap(contentOf)
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

// 코드와 인용("…", “…”) 안의 물음표는 사용자에게 묻는 질문이 아니다.
// 가린 자리는 같은 길이의 \u0001로 채워 원문과 위치가 맞는다.
const hide = (m) => m.replace(/[^\n]/g, '\u0001');
const maskQuoted = (text) =>
  text
    .replace(/```[\s\S]*?```/g, hide)
    .replace(/`[^`\n]*`/g, hide)
    .replace(/"[^"\n]*"/g, hide)
    .replace(/“[^”\n]*”/g, hide);

export function countQuestions(text) {
  return (maskQuoted(text).match(/[?？]/g) ?? []).length;
}

// 사용자에게 묻는 물음표가 붙은 문장들(원문 그대로). 한 문장에 물음표가 여럿이어도 한 번만 낸다.
export function questionSentences(text) {
  const masked = maskQuoted(text);
  const found = [];
  const seen = new Set();
  for (const m of masked.matchAll(/[?？]+/g)) {
    const before = masked.slice(0, m.index);
    let start = 0;
    for (const b of before.matchAll(/\n|[.!?？！。](?=\s)/g)) start = b.index + b[0].length;
    if (seen.has(start)) continue;
    seen.add(start);
    const sentence = text.slice(start, m.index + m[0].length).trim();
    if (sentence) found.push(sentence);
  }
  return found;
}

const LIMIT = /hit your (session|usage|weekly) limit|usage limit reached|rate limit/i;

export function hitLimit(transcript) {
  return transcript.flat().some((e) => e?.type === 'result' && LIMIT.test(String(e.result ?? '')));
}

// 기능 지도의 갈래 줄: "- <갈래>: <아이디어> · <아이디어>". 아이디어가 둘 이상 붙은 줄만 센다.
const branchLines = (text) => text.split('\n').filter((line) => /^\s*[-*]\s+[^:：\n]{1,40}[:：]\s*\S.*[·,，/]/.test(line));
export function mapBranches(text) {
  return branchLines(text).length;
}

const WRAP_OFFER =/이 정도면|정리해도 될까|정리할까요|정리해 ?볼까|정리하면 될까|명세(를|로) (써|쓸|정리|작성)/;
// 정리 제안 없이 다음 단계(기능 체크리스트, 명세 만들기)로 넘어간 턴도 대화가 끝난 것으로 본다.
const NEXT_STAGE = /checklist\.mjs|spec\.mjs new/;
const movedOn = (turn) =>
  turn.flatMap(contentOf).some((c) => c.type === 'tool_use' && NEXT_STAGE.test(JSON.stringify(c.input ?? {})));

// 이 턴에서 대화(probe 1단계)가 끝났나: 정리를 제안했거나 다음 단계로 넘어갔다.
export const wrappedUp = (transcript, i) => WRAP_OFFER.test(replyOf(transcript, i)) || movedOn(transcript.at(i) ?? []);

function files(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === '.git' || name === 'node_modules') return [];
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

const globRe = (glob) =>
  new RegExp(
    '^' +
      glob
        .split('**')
        .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
        .join('.*') +
      '$',
  );

// 새 앱을 하위 폴더에 만들면 명세도 그 아래 docs/pact에 생긴다. worktree(.pact/…/wt) 안의 사본은 뺀다.
const specFiles = (work) =>
  files(work)
    .filter((f) => /(^|\/)docs\/pact\/[^/]+\.md$/.test(f) && !f.startsWith('.pact/'))
    .map((f) => path.join(work, f));

// 사용자가 화면에서 보는 줄: 접힌 <details> 안은 빼고 여는 줄만 남긴다.
function openLines(text) {
  let inside = 0;
  const open = [];
  for (const line of text.trimEnd().split('\n')) {
    const opens = (line.match(/<details/g) ?? []).length;
    if (!inside || opens) open.push(line);
    inside += opens;
    inside -= (line.match(/<\/details>/g) ?? []).length;
    if (inside < 0) inside = 0;
  }
  return open;
}

function openAiAssumptions(text) {
  return openLines(text).filter((line) => /^\s*-\s+[FR]\d+.*\[AI 가정(:[^\]]*)?\]\s*$/.test(line)).length;
}

const norm = (transcript, turn = -1) => (turn < 0 ? transcript.length + turn : turn);
const inTurn = (turn, texts) => texts.map((text) => ({ turn, text }));
const verdict = (pass, reason, match = []) => ({ pass, reason, match });

// 답 안에서 패턴이 걸린 줄들. 여러 줄에 걸친 패턴이면 걸린 덩어리를 그대로 낸다.
function matchedLines(reply, pattern) {
  const re = new RegExp(pattern, 'm');
  const lines = reply.split('\n').filter((line) => re.test(line));
  if (lines.length) return lines;
  const whole = re.exec(reply);
  return whole ? [whole[0]] : [];
}

const specLabel = '명세 파일 없음';

// 판정과 이유. reason은 사람이 읽는 한 줄(통과해도 채운다).
// match는 대화 문장과 관련된 검사에서만 채운다: {turn(0부터), text(답에서 걸린 문장·줄 그대로)}.
export function explain(check, transcript, workdir, fixtureDir) {
  switch (check.kind) {
    case 'firstReplyQuestionCount': {
      const reply = replyOf(transcript, 0);
      const n = countQuestions(reply);
      const pass = n <= check.max;
      return verdict(pass, `물음표 ${n} ${pass ? '≤' : '>'} ${check.max}`, inTurn(0, questionSentences(reply)));
    }
    case 'firstReplyBranches': {
      const reply = replyOf(transcript, 0);
      const lines = branchLines(reply);
      const pass = lines.length >= check.min;
      return verdict(pass, `갈래 ${lines.length} ${pass ? '≥' : '<'} ${check.min}`, inTurn(0, lines));
    }
    case 'repliesMatchingMax': {
      const re = new RegExp(check.pattern, 'm');
      const turns = transcript.map((_, i) => i).filter((i) => re.test(replyOf(transcript, i)));
      const pass = turns.length <= check.max;
      return verdict(
        pass,
        `패턴이 걸린 턴 ${turns.length} ${pass ? '≤' : '>'} ${check.max}`,
        turns.flatMap((i) => inTurn(i, matchedLines(replyOf(transcript, i), check.pattern))),
      );
    }
    case 'replyNotMatch': {
      const turn = norm(transcript, check.turn);
      const lines = matchedLines(replyOf(transcript, check.turn), check.pattern);
      return lines.length
        ? verdict(false, `턴 ${turn} 답에 금지 패턴이 걸림`, inTurn(turn, lines))
        : verdict(true, `턴 ${turn} 답에 금지 패턴이 없음`);
    }
    case 'replyMatch': {
      const turn = norm(transcript, check.turn);
      const lines = matchedLines(replyOf(transcript, check.turn), check.pattern);
      return lines.length ? verdict(true, `턴 ${turn} 답에서 패턴을 찾음`, inTurn(turn, lines)) : verdict(false, '패턴을 찾지 못함');
    }
    case 'skillInvoked': {
      const pass = transcript.flat().flatMap(contentOf).some((c) => c.type === 'tool_use' && c.name === 'Skill' && c.input?.skill === check.name);
      return verdict(pass, pass ? `${check.name} 스킬을 부름` : `${check.name} 스킬을 부르지 않음`);
    }
    case 'agentNotInvoked': {
      const called = transcript
        .flat()
        .flatMap(contentOf)
        .some((c) => c.type === 'tool_use' && (c.name === 'Agent' || c.name === 'Task') && c.input?.subagent_type === check.name);
      return verdict(!called, called ? `${check.name} 에이전트를 부름` : `${check.name} 에이전트를 부르지 않음`);
    }
    case 'questionsBeforeWrapOffer': {
      const asking = [];
      for (let i = 0; i < transcript.length; i++) {
        if (wrappedUp(transcript, i)) break;
        if (countQuestions(replyOf(transcript, i)) > 0) asking.push(i);
      }
      const pass = asking.length <= check.max;
      return verdict(
        pass,
        `질문한 턴 ${asking.length} ${pass ? '≤' : '>'} ${check.max}`,
        asking.flatMap((i) => inTurn(i, questionSentences(replyOf(transcript, i)))),
      );
    }
    case 'noFileCreated': {
      const re = globRe(check.glob);
      const before = new Set(files(fixtureDir));
      const created = files(workdir).filter((f) => re.test(f) && !before.has(f));
      return created.length ? verdict(false, `새로 생긴 파일: ${created.join(', ')}`) : verdict(true, '새로 생긴 파일 없음');
    }
    case 'fileChanged': {
      const a = path.join(workdir, check.path);
      const b = path.join(fixtureDir, check.path);
      if (!existsSync(a)) return verdict(false, `${check.path}가 없음`);
      const changed = !existsSync(b) || readFileSync(a, 'utf8') !== readFileSync(b, 'utf8');
      return verdict(changed, changed ? `${check.path}가 바뀜` : `${check.path}가 바뀌지 않음`);
    }
    case 'specLint': {
      const specs = specFiles(workdir);
      if (!specs.length) return verdict(false, specLabel);
      for (const f of specs) {
        const [first] = lintSpec(readFileSync(f, 'utf8'));
        if (first) return verdict(false, first);
      }
      return verdict(true, '명세 검사 오류 없음');
    }
    case 'specMaxLines': {
      const specs = specFiles(workdir);
      if (!specs.length) return verdict(false, specLabel);
      const worst = Math.max(...specs.map((f) => openLines(readFileSync(f, 'utf8')).length));
      const pass = worst <= check.max;
      return verdict(pass, `펼친 줄 ${worst} ${pass ? '≤' : '>'} ${check.max}`);
    }
    case 'specOpenAiAssumptionsMax': {
      const specs = specFiles(workdir);
      if (!specs.length) return verdict(false, specLabel);
      const worst = Math.max(...specs.map((f) => openAiAssumptions(readFileSync(f, 'utf8'))));
      const pass = worst <= check.max;
      return verdict(pass, `펼친 AI 가정 ${worst} ${pass ? '≤' : '>'} ${check.max}`);
    }
    default:
      throw new Error(`알 수 없는 check: ${check.kind}`);
  }
}

export const judge = (check, transcript, workdir, fixtureDir) => explain(check, transcript, workdir, fixtureDir).pass;
