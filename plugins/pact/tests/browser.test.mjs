// 화면 도구(CUA)가 없을 때 verifier가 쓰는 머리 없는 브라우저. Chrome 계열이 없는 컴퓨터에서는 건너뛴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findBrowser, run } from '../scripts/browser.mjs';

const PAGE = `<!doctype html><meta charset="utf-8"><title>시험</title>
<label>이름 <input name="who"></label><button id="go">보내기</button><button id="boom">터짐</button><button id="del">지우기</button><p id="out"></p>
<script>
  go.onclick = () => { out.textContent = '안녕, ' + document.querySelector('[name=who]').value; };
  boom.onclick = () => { document.body.appendChild([]); };
  del.onclick = () => { out.textContent = confirm('지울까요?') ? '지웠습니다' : '그대로 둠'; };
</script>`;

async function withPage(fn) {
  const server = createServer((req, res) => { if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(PAGE); } else { res.statusCode = 404; res.end(); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}/`); } finally { server.close(); }
}
const skip = !findBrowser() && 'Chrome 계열 브라우저가 없다';

test('it types into a field found by its label, clicks a button found by its text, and leaves a PNG of the screen', { skip }, async () => {
  const shot = path.join(mkdtempSync(path.join(tmpdir(), 'pact-shot-')), 'shots/S1-1.png');
  const out = await withPage((url) => run({ url, steps: [{ do: 'type', label: '이름', text: '가' }, { do: 'click', text: '보내기' }, { do: 'waitFor', text: '안녕, 가' }, { do: 'shot', file: shot }, { do: 'eval', js: 'document.title' }] }));
  assert.equal(out.ok, true, JSON.stringify(out.steps));
  assert.equal(out.steps.at(-1).value, '시험');
  assert.match(out.text, /안녕, 가/);
  assert.deepEqual([...readFileSync(shot).subarray(0, 4)], [137, 80, 78, 71]);
});

test('an exception the screen throws comes back in errors even though every step ran', { skip }, async () => {
  const out = await withPage((url) => run({ url, steps: [{ do: 'click', text: '터짐' }] }));
  assert.equal(out.ok, true);
  assert.match(out.errors.join('\n'), /예외: TypeError/);
});

test('a step that cannot find its target stops the run and returns the text on the screen', { skip }, async () => {
  const out = await withPage((url) => run({ url, steps: [{ do: 'click', text: '없는 버튼' }, { do: 'click', text: '보내기' }] }));
  assert.equal(out.ok, false);
  assert.equal(out.steps.length, 2); // goto, 실패한 click
  assert.match(out.steps.at(-1).error, /찾지 못했다/);
  assert.match(out.text, /보내기/);
});

test('a confirm dialog is accepted unless a dialog step says to cancel it, and both are reported', { skip }, async () => {
  const out = await withPage((url) => run({ url, steps: [{ do: 'click', text: '지우기' }, { do: 'eval', js: 'out.textContent' }, { do: 'dialog', accept: false }, { do: 'click', text: '지우기' }, { do: 'eval', js: 'out.textContent' }] }));
  assert.deepEqual(out.steps.filter((s) => s.do === 'eval').map((s) => s.value), ['지웠습니다', '그대로 둠']);
  assert.deepEqual(out.dialogs.map((d) => d.answered), ['확인', '취소']);
});
