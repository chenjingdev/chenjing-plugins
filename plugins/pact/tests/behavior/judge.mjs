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
export function countQuestions(text) {
  const plain = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/"[^"\n]*"/g, '')
    .replace(/“[^”\n]*”/g, '');
  return (plain.match(/[?？]/g) ?? []).length;
}

const LIMIT = /hit your (session|usage|weekly) limit|usage limit reached|rate limit/i;

export function hitLimit(transcript) {
  return transcript.flat().some((e) => e?.type === 'result' && LIMIT.test(String(e.result ?? '')));
}

const WRAP_OFFER = /이 정도면|정리해도 될까|정리할까요|정리해 ?볼까|정리하면 될까|명세(를|로) (써|쓸|정리|작성)/;
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

const specFiles = (work) => files(path.join(work, 'docs', 'pact')).filter((f) => f.endsWith('.md')).map((f) => path.join(work, 'docs', 'pact', f));

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

export function judge(check, transcript, workdir, fixtureDir) {
  switch (check.kind) {
    case 'firstReplyQuestionCount':
      return countQuestions(replyOf(transcript, 0)) <= check.max;
    case 'replyNotMatch':
      return !new RegExp(check.pattern, 'm').test(replyOf(transcript, check.turn));
    case 'replyMatch':
      return new RegExp(check.pattern, 'm').test(replyOf(transcript, check.turn));
    case 'skillInvoked':
      return transcript.flat().flatMap(contentOf).some((c) => c.type === 'tool_use' && c.name === 'Skill' && c.input?.skill === check.name);
    case 'agentNotInvoked':
      return !transcript
        .flat()
        .flatMap(contentOf)
        .some((c) => c.type === 'tool_use' && (c.name === 'Agent' || c.name === 'Task') && c.input?.subagent_type === check.name);
    case 'questionsBeforeWrapOffer': {
      let asked = 0;
      for (let i = 0; i < transcript.length; i++) {
        const reply = replyOf(transcript, i);
        if (wrappedUp(transcript, i)) break;
        if (countQuestions(reply) > 0) asked++;
      }
      return asked <= check.max;
    }
    case 'noFileCreated': {
      const re = globRe(check.glob);
      const before = new Set(files(fixtureDir));
      return !files(workdir).some((f) => re.test(f) && !before.has(f));
    }
    case 'fileChanged': {
      const a = path.join(workdir, check.path);
      const b = path.join(fixtureDir, check.path);
      if (!existsSync(a)) return false;
      return !existsSync(b) || readFileSync(a, 'utf8') !== readFileSync(b, 'utf8');
    }
    case 'specLint': {
      const specs = specFiles(workdir);
      return specs.length > 0 && specs.every((f) => lintSpec(readFileSync(f, 'utf8')).length === 0);
    }
    case 'specMaxLines': {
      const specs = specFiles(workdir);
      return specs.length > 0 && specs.every((f) => openLines(readFileSync(f, 'utf8')).length <= check.max);
    }
    case 'specOpenAiAssumptionsMax': {
      const specs = specFiles(workdir);
      return specs.length > 0 && specs.every((f) => openAiAssumptions(readFileSync(f, 'utf8')) <= check.max);
    }
    default:
      throw new Error(`알 수 없는 check: ${check.kind}`);
  }
}
