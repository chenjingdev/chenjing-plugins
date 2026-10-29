#!/usr/bin/env node
// probe 단계의 구조 스케치 갤러리. 기능은 같고 구조만 다른 스케치 2~3개를 나란히 보여 준다.
// 스케치는 버리는 코드라 sandbox iframe에 가두고, srcdoc은 JS 문자열로 넣어 </script>가 페이지를 깨지 않게 한다.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMainModule } from './paths.mjs';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const jsString = (s) => JSON.stringify(String(s ?? '')).replace(/</g, '\\u003c');

export function renderGallery({ title, axis, sketches }) {
  const list = sketches ?? [];
  const cards = list
    .map(
      (s) => `<section class="card">
  <h2>${esc(s.key)}. ${esc(s.caption)}</h2>
  <iframe id="frame-${esc(s.key)}" sandbox="allow-scripts" title="${esc(s.key)}"></iframe>
</section>`,
    )
    .join('\n');
  const fills = list.map((s) => `  document.getElementById(${jsString(`frame-${s.key}`)}).srcdoc = ${jsString(s.html)};`).join('\n');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — 구조 스케치</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; margin: 24px; color: #222; background: #fff; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
  .card h2 { font-size: 16px; margin: 0 0 8px; }
  iframe { width: 100%; height: 520px; border: 1px solid #ccc; border-radius: 6px; background: #fff; }
</style></head><body>
<h1>${esc(title)}</h1>
<p>기능은 같고 구조만 다릅니다 — ${esc(axis)}</p>
<p>어느 쪽이 더 맞는지, 또는 섞고 싶은 부분을 채팅으로 알려 주세요.</p>
<div class="grid">
${cards}
</div>
<script>
${fills}
</script>
</body></html>
`;
}

function main([runDir]) {
  if (!runDir) {
    console.error('사용법: gallery.mjs <run-dir>   (<run-dir>/sketches.json을 읽어 gallery.html을 만듦)');
    return 2;
  }
  const spec = JSON.parse(readFileSync(path.join(runDir, 'sketches.json'), 'utf8'));
  const sketches = (spec.sketches ?? []).map((s) => ({
    key: s.key,
    caption: s.caption,
    html: s.html ?? readFileSync(path.resolve(runDir, s.file), 'utf8'),
  }));
  const out = path.join(runDir, 'gallery.html');
  writeFileSync(out, renderGallery({ title: spec.title, axis: spec.axis, sketches }));
  console.log(out);
  return 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
