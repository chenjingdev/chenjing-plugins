// cua.chenjing.org. The files (the dmg, SHA256SUMS.txt, install.sh) are static assets, served before this script
// runs; release.json says which release they are. This script answers the addresses that are not files: / and
// /download (the dmg, handed out at once the way unified-login's /download does), /install (the text an agent
// reads) and /version (what install.sh reads).
import release from './release.json';

const noCache = { 'cache-control': 'no-cache' };

function text(body) {
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', ...noCache } });
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
브라우저로 받기: ${origin}
`;
}

// A Mac's browser gets the dmg at once. Anything else (a phone, curl, an agent) cannot use it there, so it gets
// one line on where to open it and the terminal line.
function download(request, origin) {
  const agent = request.headers.get('user-agent') ?? '';
  if (agent.startsWith('Mozilla/') && agent.includes('Macintosh')) {
    return new Response(null, { status: 302, headers: { location: `${origin}/${release.file}`, ...noCache } });
  }
  return text(`맥의 브라우저에서 이 주소를 열면 CUA Bar dmg가 받아져요.
터미널에서는: curl -fsSL ${origin}/install.sh | sh
`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/':
      case '/download':
        return download(request, url.origin);
      case '/install':
        return text(installText(url.origin));
      case '/version':
        return Response.json({ ...release, download: `${url.origin}/${release.file}` }, { headers: noCache });
      default:
        return env.ASSETS.fetch(request);
    }
  },
};
