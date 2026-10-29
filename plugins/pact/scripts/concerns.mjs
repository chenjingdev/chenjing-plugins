// worker 보고의 걱정을 reviewer에게 넘기는 데 쓰는 글 도구(명세 F6, R16). 파일을 읽지 않는 함수만 둔다.
// 훅(hooks/guard.mjs)이 log/의 worker 답에서 걱정을 꺼내(concernsOf) reviewer를 부르는 Agent 호출의 prompt와
// reviewer에게 보내는 SendMessage의 message 끝에 붙인다(withConcerns).
//
// worker는 마지막 답에 `## 걱정·위험` 칸을 두고 칸 아래에 걱정을 한 줄씩 쓴다. 없으면 '없음'이다(agents/worker.md).
// 이 컴퓨터의 진짜 worker 답 122개로 본 모양: 칸 제목은 모두 `## 걱정·위험`이고, 119개는 칸 바로 뒤가 마지막 줄 `보고서: <경로>`다.
// 칸 안에 빈 줄이 있는 답이 15개, 보고서 줄 없이 끝나는 답이 2개, 다음 제목으로 끝나는 답이 1개다.

export const CONCERNS_HEADING = '## worker 걱정';

// 칸 제목. 단계와 강조 표시는 가리지 않고, 제목 줄만 본다(머리말 속 "`걱정·위험` 칸에 적었다"는 제목이 아니다).
const SECTION_HEADING = /^[ \t]*#{1,6}[ \t]*[*_]*[ \t]*걱정(.*)$/u;
// 제목 뒤에 콜론으로 이어 쓴 글은 칸의 첫 줄이다(`## 걱정·위험: 없음`). 콜론이 없는 뒤 글(`## 걱정되는 점`)은 칸 글이 아니다.
const HEADING_INLINE = /^[^:：]*[:：][ \t]*(.*)$/u;
// 칸이 끝나는 곳: 다음 제목, 또는 worker 답의 마지막 줄 `보고서: <경로>`. 칸 안의 빈 줄은 끝이 아니다.
const SECTION_END = /^[ \t]*(?:#{1,6}[ \t]+\S|[*_]*보고서[*_]*[ \t]*[:：])/u;
// 목록 표시(`-`, `*`, `1.`)와 줄 앞뒤의 강조 표시를 벗긴 글
const bare = (line) => line.trim()
  .replace(/^(?:[-*+•]|\d+[.)])(?:[ \t]+|$)/u, '')
  .replace(/^[*_`~]+/u, '').replace(/[*_`~]+$/u, '').trim();
// '없음'뿐인 줄. 뒤에 글이 이어지면(`없음. 다만 …`, `없음에 가깝지만`) 걱정이 있는 글이니 붙인다 — 걱정을 조용히 떨어뜨리는 쪽이 더 나쁘다.
const NONE = /^(?:해당[ \t]*)?(?:없음|없다|없습니다|없어요)[ \t]*[.!。]*$|^(?:none|n\/a|nothing)[ \t]*[.!]*$/iu;

// worker 마지막 답에서 걱정 칸의 글. 칸이 없거나 비었거나 '없음'뿐이면 null.
// 제목이 여럿이면 마지막 것이 칸이다(답 앞쪽에 인용한 글에 같은 제목이 있어도 진짜 칸은 끝에 있다).
export function concernsOf(reply) {
  if (typeof reply !== 'string') return null;
  const lines = reply.split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SECTION_HEADING.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return null;
  const inline = HEADING_INLINE.exec(SECTION_HEADING.exec(lines[start])[1])?.[1] ?? '';
  const body = inline ? [inline] : [];
  for (let i = start + 1; i < lines.length && !SECTION_END.test(lines[i]); i++) body.push(lines[i]);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const said = body.map(bare).filter(Boolean);
  if (!said.length || said.every((line) => NONE.test(line))) return null;
  return body.join('\n');
}

// 글에 worker 걱정 칸이 이미 있는지. 제목 줄이 `worker`와 `걱정`을 둘 다 말하면 있는 것이다 — 메인 세션이 손으로 단
// `## worker가 남긴 걱정(상태 …)`도 같다. reviewer 답의 `## worker 걱정 처리`는 붙은 칸이 아니다.
export function hasConcernsSection(text) {
  return String(text ?? '').split(/\r?\n/).some((line) => /^[ \t]*#{1,6}[ \t]*\S/u.test(line)
    && /worker/i.test(line) && /걱정/u.test(line) && !/걱정[ \t]*처리/u.test(line));
}

// 글 끝에 `## worker 걱정` 칸을 붙인 새 글. 원래 글은 한 글자도 바꾸지 않고, 빈 줄 하나를 사이에 둔다.
export function withConcerns(text, concerns) {
  const base = String(text ?? '');
  const gap = !base || base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n';
  return `${base}${gap}${CONCERNS_HEADING}\n${concerns}`;
}

// 글에서 훅이 붙인 걱정 칸 앞까지. reviewer의 첫 지시를 읽어 판과 작업 번호를 정할 때(scripts/run-log.mjs), 걱정 글 속의 `작업 번호 3`이나
// 다른 판·보고서 경로가 지시 본문의 것으로 읽히지 않게 한다. 훅은 칸을 맨 끝에 붙이므로, 글의 맨 마지막 제목 줄이 `## worker 걱정`이고 그 앞에 글이 있을 때만 자른다.
// 메인 세션이 손으로 쓴 칸은 뒤에 다른 제목이 이어지는 것이 보통이라 그대로 읽는다. 걱정 글에는 제목 줄이 들어갈 수 없다(concernsOf가 제목에서 칸을 끝낸다).
export function withoutConcerns(text) {
  const s = String(text ?? '');
  const lines = s.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^[ \t]*#{1,6}[ \t]+\S/u.test(lines[i])) continue;
    if (lines[i].trimEnd() !== CONCERNS_HEADING) return s;
    const before = lines.slice(0, i).join('\n').trimEnd();
    return before || s;
  }
  return s;
}
