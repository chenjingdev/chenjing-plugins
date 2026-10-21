// cua.chenjing.org. The files (the dmg, SHA256SUMS.txt, install.sh) are static assets, served before this script
// runs; release.json says which release they are. This script answers the addresses that are not files: the
// page, /download (the dmg), /install (the text an agent reads) and /version (what install.sh reads).
import release from './release.json';

const noCache = { 'cache-control': 'no-cache' };

function text(body) {
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', ...noCache } });
}

function megabytes(bytes) {
  return (bytes / 1e6).toFixed(1);
}

function installText(origin) {
  return `CUA Bar 설치 (맥, Apple Silicon, macOS 14 이상)

이 맥의 터미널에서 실행하세요:
curl -fsSL ${origin}/install.sh | sh

이 한 줄이 하는 일:
- 최신 CUA Bar(판 ${release.version}) dmg를 받아 SHA-256을 확인합니다.
- CUABar.app을 /Applications에 깝니다. 쓸 수 없으면 ~/Applications에 깝니다. 이미 같거나 새 판이 있으면 받지 않습니다.
- 앱을 켭니다. 메뉴 막대에 아이콘이 생깁니다.

켜진 뒤에는 앱이 Claude Code의 cua 플러그인과 연결 설정을 확인합니다. 플러그인이 없으면 앱 창의 [설치] 버튼으로 깝니다.
브라우저로 받기: ${origin}/download
`;
}

function page(origin) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CUA Bar</title>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1d1d1f; --muted: #6e6e73; --card: #f5f5f7; --accent: #0071e3; }
@media (prefers-color-scheme: dark) { :root { --bg: #000000; --fg: #f5f5f7; --muted: #a1a1a6; --card: #1c1c1e; --accent: #2997ff; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif; }
main { max-width: 600px; margin: 0 auto; padding: 56px 16px; }
h1 { font-size: 32px; margin: 0 0 8px; }
h2 { font-size: 17px; margin: 32px 0 8px; }
p { margin: 0 0 16px; color: var(--muted); word-break: keep-all; }
.button { display: inline-block; background: var(--accent); color: #ffffff; text-decoration: none; padding: 10px 22px; border-radius: 10px; font-weight: 600; }
pre { background: var(--card); padding: 12px 14px; border-radius: 10px; font-size: 14px; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.hash { overflow-wrap: anywhere; }
small, small a { color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>CUA Bar</h1>
<p>Codex를 평소처럼 켜도 Claude가 CUA로 바로 붙게 하고, 메뉴 막대에서 연결 상태를 보는 맥 앱이에요.</p>
<p><a class="button" href="/download">dmg 받기</a></p>
<p><small>판 ${release.version} · ${megabytes(release.size)}MB · Apple Silicon · macOS 14 이상 · Developer ID 서명과 Apple 공증</small></p>
<h2>터미널 한 줄</h2>
<pre>curl -fsSL ${origin}/install.sh | sh</pre>
<h2>에이전트에게 맡기기</h2>
<pre>CUA Bar를 설치해 줘. ${origin}/install</pre>
<p style="margin-top: 32px"><small class="hash">SHA-256 ${release.sha256} · <a href="/SHA256SUMS.txt">SHA256SUMS.txt</a> · <a href="${release.release}">GitHub 릴리스</a></small></p>
</main>
</body>
</html>
`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/':
        return new Response(page(url.origin), { headers: { 'content-type': 'text/html; charset=utf-8', ...noCache } });
      case '/download':
        return new Response(null, { status: 302, headers: { location: `${url.origin}/${release.file}`, ...noCache } });
      case '/install':
        return text(installText(url.origin));
      case '/version':
        return Response.json({ ...release, download: `${url.origin}/${release.file}` }, { headers: noCache });
      default:
        return env.ASSETS.fetch(request);
    }
  },
};
