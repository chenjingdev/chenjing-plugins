// 셸 명령을 낱말과 리다이렉트로 나누는 도구(훅의 결과 잠금이 쓴다). 실행하지 않고 글만 나눈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShell } from '../scripts/shell.mjs';

const words = (text) => parseShell(text).map((c) => c.words);
const redirects = (text) => parseShell(text).flatMap((c) => c.redirects);

test('words are split on blanks, quotes are removed, and a quoted operator is a plain character', () => {
  assert.deepEqual(words(`echo "a > b" 'c; d' e\\ f`), [['echo', 'a > b', 'c; d', 'e f']]);
  assert.deepEqual(words(`FOO=1 BAR="a b" cmd arg`), [['FOO=1', 'BAR=a b', 'cmd', 'arg']]);
  assert.deepEqual(words(`echo $'a\\'b' "x\\"y" a"b"c`), [['echo', "a'b", 'x"y', 'abc']]);
  assert.deepEqual(redirects(`echo "a > b" 'c > d'`), [], '따옴표 안의 >는 리다이렉트가 아니다');
});

test('commands are separated by ; & && || | and newlines, and a comment runs to the end of its line', () => {
  assert.deepEqual(words('a b; c && d || e | f & g\nh # i > j\nk'), [['a', 'b'], ['c'], ['d'], ['e'], ['f'], ['g'], ['h'], ['k']]);
  assert.deepEqual(redirects('echo hi # > results.json'), []);
  assert.deepEqual(words('a\\\n b'), [['a', 'b']], '줄 끝 역슬래시는 줄을 잇는다');
});

test('redirects: the operator and its target, attached or apart, with or without a file number', () => {
  assert.deepEqual(redirects('echo x > a'), [{ op: '>', target: 'a' }]);
  assert.deepEqual(redirects('echo x>>a 2>b'), [{ op: '>>', target: 'a' }, { op: '>', target: 'b' }]);
  assert.deepEqual(redirects('cmd 2>&1 >out'), [{ op: '>&', target: '1' }, { op: '>', target: 'out' }]);
  assert.deepEqual(redirects('cmd &> all; cmd &>> all2; cmd >| f; cmd < in'), [
    { op: '&>', target: 'all' }, { op: '&>>', target: 'all2' }, { op: '>|', target: 'f' }, { op: '<', target: 'in' },
  ]);
  assert.deepEqual(parseShell('echo a > b c').map((c) => c.words), [['echo', 'a', 'c']], '대상 뒤의 낱말은 명령의 인자다');
  assert.deepEqual(parseShell('> only'), [{ words: [], redirects: [{ op: '>', target: 'only' }], heredocs: [], here: [] }], '낱말 없이 리다이렉트만 있어도 명령이다');
});

test('a heredoc body belongs to its command and is text, not commands', () => {
  const [cmd, next] = parseShell(`python3 - <<'EOF'\nopen('x', 'w')\n> not a redirect\nEOF\necho done`);
  assert.deepEqual(cmd.words, ['python3', '-']);
  assert.deepEqual(cmd.heredocs, [{ body: "open('x', 'w')\n> not a redirect", quoted: true }]);
  assert.deepEqual(cmd.redirects, []);
  assert.deepEqual(next.words, ['echo', 'done']);
  // 같은 줄의 리다이렉트와 <<-, 따옴표 없는 구분자
  const [tabbed] = parseShell('cat > f <<-EOT\n\tbody\n\tEOT\n');
  assert.deepEqual(tabbed.redirects, [{ op: '>', target: 'f' }]);
  assert.deepEqual(tabbed.heredocs, [{ body: '\tbody', quoted: false }]);
  // 구분자 줄이 없으면 끝까지가 본문이다
  assert.equal(parseShell('cat <<EOF\na\nb')[0].heredocs[0].body, 'a\nb');
  // 여러 heredoc과 here-string
  const [two] = parseShell(`cmd <<A <<B\n1\nA\n2\nB\n`);
  assert.deepEqual(two.heredocs.map((h) => h.body), ['1', '2']);
  assert.deepEqual(parseShell(`python3 - <<< "print(1)"`)[0].here, ['print(1)']);
});

test('commands inside $( ), backticks and ( ) come out too, and a heredoc inside $( ) stays text (the git commit idiom)', () => {
  assert.deepEqual(words('(cd x && echo y > z); echo $(date) `id`'), [['cd', 'x'], ['echo', 'y'], ['date'], ['id'], ['echo', '$()', '``']]);
  assert.deepEqual(redirects('(cd x && echo y > z)'), [{ op: '>', target: 'z' }]);
  const commit = parseShell(`git commit -m "$(cat <<'EOF'\nfeat: a > b (c) echo x > results.json\nEOF\n)" && echo ok`);
  assert.deepEqual(commit.map((c) => c.words[0]), ['cat', 'git', 'echo']);
  assert.deepEqual(commit[0].heredocs.map((h) => h.body), ['feat: a > b (c) echo x > results.json']);
  assert.deepEqual(commit.flatMap((c) => c.redirects), [], '커밋 메시지 안의 > 는 리다이렉트가 아니다');
  assert.deepEqual(commit[1].words, ['git', 'commit', '-m', '$()']);
  assert.deepEqual(words('echo "$(echo x > f)"'), [['echo', 'x'], ['echo', '$()']]);
});

test('variables stay as written, so a caller can tell what it could not resolve', () => {
  assert.deepEqual(words('cp a "$RUN/results.json" ${OTHER:-x}/y'), [['cp', 'a', '$RUN/results.json', '${OTHER:-x}/y']]);
});

test('odd input never throws or loops: unbalanced quotes, parens, empty text, and deep nesting', () => {
  for (const text of ['', '   ', 'echo "unclosed', "echo 'unclosed", 'echo $(unclosed', 'echo `unclosed', 'echo )', '(((((', 'cat <<', 'cat <<EOF', '>', '>>', '2>', 'a | | b', ';;;', '\\']) {
    assert.ok(Array.isArray(parseShell(text)), JSON.stringify(text));
  }
  assert.ok(Array.isArray(parseShell(`echo ${'`'.repeat(40)}`)));
  assert.ok(parseShell(`echo ${'$('.repeat(200)}x${')'.repeat(200)}`).length > 0);
  assert.deepEqual(parseShell(undefined), []);
});
