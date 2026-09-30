// 읽기 창을 실제 브라우저로 조작한다. 화면 사진은 OPTIVIEW_SHOTS 폴더가 있을 때만 남긴다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../../plugin/lib/server.mjs';
import { user, say, tool, toolResult, done, title, jsonl, LONG_ANSWER } from '../fixtures/transcript.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-e2e-'));
const token = 'e2e-token';
const shots = process.env.OPTIVIEW_SHOTS;
let app;
let base;
let browser;
const errors = [];

const call = (method, p, body) => fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-optiview-token': token }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
const fileA = path.join(home, 'a.jsonl');
const fileB = path.join(home, 'b.jsonl');
const cmux = (id) => ({ host: 'cmux', id });

before(async () => {
  const turns = [];
  for (let i = 1; i <= 6; i++) turns.push(user(`${i}번째 질문: 설정 값 확인해 줘`), say(`${i}번째 답입니다. 값은 ${i * 10}입니다.`), done());
  fs.writeFileSync(fileA, jsonl([title('설정 이전 작업'), ...turns, user('설정 파일 옮기고 결과 알려 줘'), say('옮기는 중입니다.', 'tool_use'), tool(), toolResult(), say(LONG_ANSWER), done(95000)]));
  fs.writeFileSync(fileB, jsonl([title('문서 정리'), user('README 다듬어 줘'), say('README의 설치 절차를 세 단계로 줄였습니다.'), done()]));
  app = createServer({ home, token });
  base = `http://127.0.0.1:${await app.listen(0)}`;
  await call('POST', '/api/hook', { event: 'session-start', sessionId: 'sess-a', transcriptPath: fileA, cwd: '/work/api-server', terminal: cmux('surf-a') });
  await call('POST', '/api/hook', { event: 'session-start', sessionId: 'sess-b', transcriptPath: fileB, cwd: '/work/docs', terminal: cmux('surf-b') });
  await call('POST', '/api/focus', { terminal: cmux('surf-a'), label: '백엔드' });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await app?.close();
  assert.deepEqual(errors, []);
});

async function open({ width = 440, height = 860, scheme = 'dark' } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}/`);
  await page.locator('#pos', { hasText: '/' }).waitFor();
  return page;
}
const pos = (page) => page.locator('#pos').textContent();
const snap = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

test('최신 답을 보이고, 긴 답은 결론만 펼치고 섹션은 접는다. 끝의 질문은 강조한다', async () => {
  const page = await open();
  try {
    assert.equal(await page.locator('#title').textContent(), '설정 이전 작업');
    assert.equal(await page.locator('#sub').textContent(), 'api-server · 백엔드');
    assert.equal(await pos(page), '7 / 7');
    assert.equal(await page.locator('#next').isDisabled(), true);
    assert.equal(await page.locator('#latest').isHidden(), true);
    assert.match(await page.locator('.lead').textContent(), /설정 이전을 마쳤습니다/);
    assert.equal(await page.locator('details.sec[open]').count(), 0);
    assert.deepEqual(await page.locator('details.sec .sec-title').allTextContents(), ['바꾼 것', '확인한 것', '남은 일']);
    assert.match(await page.locator('.ask').textContent(), /어느 쪽으로 할까요\?/);
    assert.match(await page.locator('.meta').textContent(), /1분 35초 · 도구 1회/);
    await snap(page, 'latest-folded');
    await page.locator('details.sec summary', { hasText: '확인한 것' }).click();
    assert.equal(await page.locator('details.sec[open] .table').count(), 1);
    await snap(page, 'section-open');
  } finally {
    await page.close();
  }
});

test('←·→와 방향키로 넘기고, 5개 넘게 뒤로 가면 최신 답 버튼이 나온다', async () => {
  const page = await open();
  try {
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
    assert.equal(await pos(page), '3 / 7');
    assert.equal(await page.locator('#latest').isHidden(), true);
    await page.click('#prev');
    assert.equal(await pos(page), '2 / 7');
    assert.equal(await page.locator('#latest').isVisible(), true);
    assert.match(await page.locator('#page').textContent(), /2번째 답입니다/);
    await snap(page, 'back5');
    await page.click('#latest');
    assert.equal(await pos(page), '7 / 7');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    assert.equal(await pos(page), '7 / 7');
  } finally {
    await page.close();
  }
});

test('이전 답을 보다가 새 질문이 들어오면 최신으로 가고, 작업 중으로 보인다', async () => {
  const page = await open();
  try {
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await pos(page), '5 / 7');
    fs.appendFileSync(fileA, jsonl([user('문서 예시만 고쳐 줘'), say('예시 경로를 찾는 중입니다.', 'tool_use'), tool()]));
    await call('POST', '/api/hook', { event: 'prompt', sessionId: 'sess-a', transcriptPath: fileA });
    await page.locator('#pos', { hasText: '8 / 8' }).waitFor();
    assert.match(await page.locator('.status.running').textContent(), /작업 중/);
    await snap(page, 'running');
    fs.appendFileSync(fileA, jsonl([toolResult(), say('예시 경로 네 곳을 고쳤습니다.'), done()]));
    await call('POST', '/api/hook', { event: 'stop', sessionId: 'sess-a', transcriptPath: fileA });
    await page.locator('.answer', { hasText: '예시 경로 네 곳을 고쳤습니다.' }).waitFor();
    assert.equal(await page.locator('.status.running').count(), 0);
  } finally {
    await page.close();
  }
});

test('분할을 옮기면 그 대화로 바뀌고, Claude 없는 칸이면 마지막 대화를 둔다', async () => {
  const page = await open();
  try {
    await call('POST', '/api/focus', { terminal: cmux('surf-b'), label: '문서' });
    await page.locator('#title', { hasText: '문서 정리' }).waitFor();
    assert.equal(await pos(page), '1 / 1');
    await call('POST', '/api/focus', { terminal: cmux('surf-shell'), label: '문서' });
    await page.locator('#note').waitFor();
    assert.equal(await page.locator('#title').textContent(), '문서 정리');
    assert.match(await page.locator('#note').textContent(), /Claude가 없는 칸/);
    await snap(page, 'away');
    await call('POST', '/api/focus', { terminal: cmux('surf-a'), label: '백엔드' });
    await page.locator('#title', { hasText: '설정 이전 작업' }).waitFor();
    assert.equal(await page.locator('#note').isHidden(), true);
  } finally {
    await page.close();
  }
});

test('세션을 골라 고정하면 포커스를 따라가지 않고, 따라가기로 풀린다', async () => {
  const page = await open();
  try {
    await page.click('#who');
    await page.locator('.row', { hasText: '문서 정리' }).click();
    await page.locator('#title', { hasText: '문서 정리' }).waitFor();
    assert.match(await page.locator('#sub').textContent(), /고정됨/);
    await snap(page, 'pinned');
    await call('POST', '/api/focus', { terminal: cmux('surf-a'), label: '백엔드' });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#title').textContent(), '문서 정리');
    await page.click('#follow');
    await page.locator('#title', { hasText: '설정 이전 작업' }).waitFor();
    assert.equal(await page.locator('#follow').isHidden(), true);
  } finally {
    await page.close();
  }
});

test('밝은 테마와 좁은 창', async () => {
  const page = await open({ width: 340, height: 700, scheme: 'light' });
  try {
    await page.click('#who');
    await page.click('#theme');
    await page.keyboard.press('Escape');
    await snap(page, 'narrow-theme');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.ok(bg);
  } finally {
    await page.close();
  }
});
