#!/usr/bin/env node
// probe 단계의 기능 체크리스트 페이지. 고른 기능은 체크된 채로, AI 제안은 체크 해제에 (제안)과 이유를 달아
// 지도의 갈래(group)별로 묶어 보여 주고, 사용자가 고른 결과 한 줄을 일회용 로컬 서버로 받는다. 받지 못하면 채팅으로 돌아간다.
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const row = (it) => {
  const note = it.note ? ` <span class="note">— ${esc(it.note)}</span>` : '';
  const why = it.suggested ? ` <span class="sug">(제안) ${esc(it.reason)}</span>` : '';
  return `<label class="row"><input type="checkbox" class="feat" value="${esc(it.label)}"${it.suggested ? '' : ' checked'}> ${esc(it.label)}${note}${why}</label>`;
};

// 같은 갈래의 항목은 처음 나온 자리에 모은다. 갈래가 없는 항목은 제목 없이 맨 앞 묶음이 된다.
function byGroup(items) {
  const groups = new Map();
  for (const it of items ?? []) {
    const name = it.group ?? '';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(it);
  }
  return [...groups];
}

export function renderChecklist({ title, items }) {
  const rows = byGroup(items)
    .map(([name, list]) => (name ? `<h2>${esc(name)}</h2>\n` : '') + list.map(row).join('\n'))
    .join('\n');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — 기능 범위</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 720px; margin: 24px auto; padding: 0 16px; color: #222; background: #fff; }
  h2 { font-size: 16px; margin: 20px 0 4px; }
  .row { display: block; padding: 6px 0; border-bottom: 1px solid #eee; }
  .note { color: #666; } .sug { color: #a15c00; font-size: 13px; }
  textarea { width: 100%; height: 64px; margin-top: 12px; font: inherit; }
  #extra { width: 100%; font: inherit; }
  button { font: inherit; padding: 6px 16px; margin-top: 8px; }
</style></head><body>
<h1>${esc(title)}</h1>
<p>이번에 만들 기능을 고르세요. 체크된 것은 대화에서 고른 기능이고, <span class="sug">(제안)</span>은 지도에 있던 다른 아이디어나 AI가 더하자고 하는 기능입니다.</p>
${rows}
<p><label>+ 직접 추가: <input type="text" id="extra" placeholder="쉼표로 여러 개"></label></p>
<textarea id="result" readonly></textarea>
<button id="send">확인</button> <span id="done" hidden>전달됨 — 이 탭은 닫아도 됩니다. 잘못 보냈다면 채팅으로 말해 주세요</span>
<p id="fallback" hidden><button id="copy">복사</button> 자동 전달이 안 됐습니다. 복사한 줄을 채팅에 붙여넣어 주세요.</p>
<script>
  const $ = (id) => document.getElementById(id);
  const update = () => {
    const feats = [...document.querySelectorAll('.feat:checked')].map((c) => c.value);
    const extra = $('extra').value.split(',').map((s) => s.trim()).filter(Boolean);
    $('result').value = '기능: ' + feats.concat(extra).join(', ');
  };
  document.querySelectorAll('.feat, #extra').forEach((el) => (el.oninput = update));
  update();
  $('send').onclick = () =>
    fetch('/submit', { method: 'POST', body: $('result').value })
      .then((r) => { if (!r.ok) throw 0; $('done').hidden = false; $('send').disabled = true; })
      .catch(() => { $('fallback').hidden = false; });
  $('copy').onclick = () => {
    const t = $('result');
    t.select();
    (navigator.clipboard ? navigator.clipboard.writeText(t.value) : Promise.reject()).catch(() => document.execCommand('copy'));
  };
</script>
</body></html>
`;
}

function serve(runDir) {
  const pagePath = path.join(runDir, 'checklist.html');
  if (!existsSync(pagePath)) {
    console.error(`체크리스트 페이지가 없습니다: ${pagePath}`);
    return Promise.resolve(1);
  }
  const page = readFileSync(pagePath);
  const timeoutMs = Number(process.env.PACT_CHECKLIST_TIMEOUT_MS) || 600000;
  return new Promise((resolve) => {
    let timer;
    const finish = (code) => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      resolve(code);
    };
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/submit') {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          if (!body.trim()) {
            res.writeHead(400).end();
            return;
          }
          writeFileSync(path.join(runDir, 'checklist.txt'), body);
          console.log(body);
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end('ok', () => finish(0));
        });
        return;
      }
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => console.log(`페이지: http://127.0.0.1:${server.address().port}/`));
    // 시간 초과는 오류가 아니다. 0으로 끝내야 백그라운드 작업이 "실패"로 알려지지 않는다.
    timer = setTimeout(() => {
      console.log('시간 초과 — 채팅으로 기능 범위를 알려 주세요');
      finish(0);
    }, timeoutMs);
  });
}

const USAGE = `사용법:
  checklist.mjs render <input.json> <run-dir>   <run-dir>/checklist.html을 만듦
  checklist.mjs serve <run-dir>                 페이지를 띄우고 첫 제출을 checklist.txt에 쓰고 끝남`;

async function main([cmd, ...args]) {
  if (cmd === 'render' && args[1]) {
    const input = JSON.parse(readFileSync(args[0], 'utf8'));
    mkdirSync(args[1], { recursive: true });
    const out = path.join(args[1], 'checklist.html');
    writeFileSync(out, renderChecklist(input));
    console.log(out);
    return 0;
  }
  if (cmd === 'serve' && args[0]) return serve(args[0]);
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err) => {
      console.error(err.message);
      process.exitCode = 1;
    },
  );
}
