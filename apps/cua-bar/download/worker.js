// cua.chenjing.org. The files (the dmg, SHA256SUMS.txt, install.sh) are static assets, served before this script
// runs; release.json says which release they are. This script answers the addresses that are not files: / and
// /download (the dmg, handed out at once the way unified-login's /download does), /install (the text an agent
// reads) and /version (what install.sh and the app's own update read).
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

앱 하나만 깔면 됩니다. Claude 플러그인은 따로 깔지 않습니다. 앱이 켜지면 묻지 않고 Claude Code에 cuabar MCP를 깔고
Codex 연결에 필요한 엔진을 준비합니다. 쓰는 법은 MCP가 Claude에게 알려 줍니다. 새 Claude 대화부터 CUA가 붙고, 이미 열려 있는 대화에는 붙지 않습니다.
로그인 셸의 시작 파일(zsh는 ~/.zshenv)에도 Codex가 켜질 때만 읽는 몇 줄을 넣어, 재부팅 뒤 macOS가 다시 연 Codex에도 붙게 합니다. 터미널에는 영향이 없고 앱을 지우면 그 줄도 지웁니다.
잘 깔렸는지는 메뉴 막대 아이콘의 창에서 '점검' 탭이 항목마다 보여 줍니다.
Claude Code가 아직 없으면 그 줄은 점검 탭에만 보이고(카드와 아이콘은 문제로 보이지 않습니다), 생긴 뒤에 한 번 깝니다.
Codex 앱이 아직 없으면 창의 카드가 받는 곳을 알려 주고, 그동안은 아무것도 깔지 않다가 Codex가 깔린 뒤에 한 번 깝니다.
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
