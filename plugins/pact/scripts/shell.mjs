// 셸 명령 글을 낱말과 리다이렉트로 나눈다. 훅(scripts/locks.mjs)이 Bash 명령에서 "무엇을 쓰는가"만 보려는 것이라
// 실행하지 않고, 모르는 문법은 낱말로 남긴다. 따옴표 안의 `>`·`;`는 연산자가 아니고, heredoc 본문은 명령이 아니라 글이다.
// 이 파일이 하는 일은 여기까지다. 어떤 명령이 무엇을 쓰는지는 locks.mjs가 정한다.
//
// parseShell(글) → 명령 목록. 명령 하나는
//   words      따옴표를 벗긴 낱말. 첫 낱말이 명령 이름이다. `$(…)`·백틱은 `$()`·` `` `로 대신 두고, `${…}`·`$NAME`은 글자 그대로 둔다.
//   redirects  [{ op, target }]  `>`·`>>`·`>|`·`>&`·`&>`·`&>>`·`<`·`<&`·`<>` 같은 연산자와 그 대상 낱말
//   heredocs   [{ body, quoted }]  `<<`·`<<-`로 붙은 본문
//   here       `<<<` 뒤의 낱말
// `$(…)`·백틱·`( … )` 안의 명령도 같은 목록에 나온다(안쪽 것이 바깥 명령보다 앞에 온다).
// `sh -c '…'` 같은 중첩 실행은 풀지 않는다. 그것은 부르는 쪽 몫이다.

const newCommand = () => ({ words: [], redirects: [], heredocs: [], here: [] });
const MAX_DEPTH = 6;

export function parseShell(source, depth = 0) {
  const src = String(source ?? '');
  const out = [];
  if (depth > MAX_DEPTH) return out;
  let pos = 0;

  const readSingle = () => {
    const end = src.indexOf("'", pos);
    const text = end === -1 ? src.slice(pos) : src.slice(pos, end);
    pos = end === -1 ? src.length : end + 1;
    return text;
  };

  // `$'…'`: 역슬래시로 이스케이프한 작은따옴표를 넘긴다
  const readAnsiC = () => {
    let text = '';
    while (pos < src.length) {
      const c = src[pos];
      if (c === '\\' && pos + 1 < src.length) { text += src[pos + 1]; pos += 2; continue; }
      if (c === "'") { pos++; break; }
      text += c;
      pos++;
    }
    return text;
  };

  // 짝이 맞는 `}`의 자리(없으면 끝)
  const braceEnd = (from) => {
    let level = 0;
    for (let i = from; i < src.length; i++) {
      if (src[i] === '{') level++;
      else if (src[i] === '}' && --level === 0) return i;
    }
    return src.length - 1;
  };

  // 백틱 명령: 이스케이프하지 않은 다음 백틱까지
  const readBacktick = () => {
    let text = '';
    while (pos < src.length) {
      const c = src[pos];
      if (c === '\\' && src[pos + 1] === '`') { text += '`'; pos += 2; continue; }
      if (c === '`') { pos++; break; }
      text += c;
      pos++;
    }
    return text;
  };

  // 큰따옴표 안: `$(…)`와 백틱은 명령으로 읽고, `$NAME`·`${…}`는 글자 그대로 둔다.
  const readDouble = () => {
    let text = '';
    while (pos < src.length) {
      const c = src[pos];
      if (c === '"') { pos++; return text; }
      if (c === '\\') {
        const next = src[pos + 1];
        if (next === undefined) { pos++; break; }
        if (next === '\n') { pos += 2; continue; }
        if ('$`"\\'.includes(next)) { text += next; pos += 2; continue; }
        text += c;
        pos++;
        continue;
      }
      if (c === '$' && src[pos + 1] === '(') { pos += 2; list(true); text += '$()'; continue; }
      if (c === '$' && src[pos + 1] === '{') { const end = braceEnd(pos + 1); text += src.slice(pos, end + 1); pos = end + 1; continue; }
      if (c === '`') { pos++; out.push(...parseShell(readBacktick(), depth + 1)); text += '``'; continue; }
      text += c;
      pos++;
    }
    return text;
  };

  // 명령 목록 하나. nested이면 짝이 맞는 `)`에서 끝난다.
  function list(nested) {
    let cmd = newCommand();
    let word = null; // 만드는 중인 낱말. 없으면 null
    let quoted = false; // 그 낱말에 따옴표나 역슬래시가 있었나(heredoc 구분자가 따옴표 붙었는지, fd 숫자인지)
    let redirect = null; // 다음 낱말이 대상인 리다이렉트 연산자
    let hereSpec = null; // `<<` 뒤 다음 낱말이 구분자
    const pending = []; // 본문을 기다리는 heredoc

    const endWord = () => {
      if (word === null) return;
      if (hereSpec) { pending.push({ cmd, delimiter: word, strip: hereSpec.strip, quoted }); hereSpec = null; }
      else if (redirect === '<<<') { cmd.here.push(word); redirect = null; }
      else if (redirect) { cmd.redirects.push({ op: redirect, target: word }); redirect = null; }
      else cmd.words.push(word);
      word = null;
      quoted = false;
    };
    const endCommand = () => {
      endWord();
      redirect = null;
      hereSpec = null;
      if (cmd.words.length || cmd.redirects.length || cmd.here.length || pending.some((p) => p.cmd === cmd)) out.push(cmd);
      cmd = newCommand();
    };
    // 줄바꿈 바로 뒤에서: 기다리는 heredoc의 본문을 구분자 줄까지 읽는다
    const readBodies = () => {
      while (pending.length) {
        const p = pending.shift();
        const lines = [];
        while (pos < src.length) {
          const eol = src.indexOf('\n', pos);
          const line = (eol === -1 ? src.slice(pos) : src.slice(pos, eol)).replace(/\r$/, '');
          pos = eol === -1 ? src.length : eol + 1;
          if ((p.strip ? line.replace(/^\t+/, '') : line) === p.delimiter) break;
          lines.push(line);
        }
        p.cmd.heredocs.push({ body: lines.join('\n'), quoted: p.quoted });
      }
    };
    const add = (text) => { word = (word ?? '') + text; };

    while (pos < src.length) {
      const c = src[pos];
      if (c === '\n') { pos++; endCommand(); if (pending.length) readBodies(); continue; }
      if (c === ' ' || c === '\t' || c === '\r') { endWord(); pos++; continue; }
      if (c === '#' && word === null) { const eol = src.indexOf('\n', pos); pos = eol === -1 ? src.length : eol; continue; }
      if (c === '\\') {
        const next = src[pos + 1];
        if (next === undefined) { pos++; continue; }
        if (next === '\n') { pos += 2; continue; }
        add(next); quoted = true; pos += 2;
        continue;
      }
      if (c === "'") { pos++; add(readSingle()); quoted = true; continue; }
      if (c === '"') { pos++; add(readDouble()); quoted = true; continue; }
      if (c === '$') {
        const next = src[pos + 1];
        if (next === '(') { pos += 2; list(true); add('$()'); continue; }
        if (next === "'") { pos += 2; add(readAnsiC()); quoted = true; continue; }
        if (next === '{') { const end = braceEnd(pos + 1); add(src.slice(pos, end + 1)); pos = end + 1; continue; }
        add(c); pos++;
        continue;
      }
      if (c === '`') { pos++; out.push(...parseShell(readBacktick(), depth + 1)); add('``'); continue; }
      if (c === '(') { endCommand(); pos++; list(true); continue; }
      if (c === ')') { endCommand(); pos++; if (nested) return; continue; }
      if (c === '&' && src[pos + 1] === '>') {
        endWord();
        const op = src[pos + 2] === '>' ? '&>>' : '&>';
        pos += op.length;
        redirect = op;
        continue;
      }
      if (c === ';' || c === '|' || c === '&') { endCommand(); pos++; continue; }
      if (c === '>' || c === '<') {
        // `2>file`의 2는 파일 번호이고 낱말이 아니다
        if (word !== null && !quoted && /^\d+$/.test(word)) { word = null; } else endWord();
        if (src[pos + 1] === '(') { pos += 2; list(true); add(`${c}()`); continue; } // 프로세스 치환
        const op = (c === '>' ? /^(?:>>|>\||>&|>)/ : /^(?:<<<|<<-|<<|<&|<>|<)/).exec(src.slice(pos, pos + 3))[0];
        pos += op.length;
        if (op === '<<' || op === '<<-') hereSpec = { strip: op === '<<-' };
        else redirect = op;
        continue;
      }
      add(c);
      pos++;
    }
    endCommand();
  }

  list(false);
  return out;
}
