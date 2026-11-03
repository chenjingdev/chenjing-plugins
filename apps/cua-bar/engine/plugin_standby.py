"""The cuabar plugin's MCP while it stands by (plugin_host): no tools, and instructions that say why.

Standard library only, and it never starts Codex, installs anything or reads the screen. It answers initialize, ping
and tools/list (empty) until Claude closes stdin.
"""
import json
import sys

VERSION = '0.9.2'
REASONS = {
    'app_mcp': ('cuabar plugin: CUA Bar handles CUA on this Mac through its own `cuabar` MCP (tools `mcp__cuabar__…`), '
                'so this plugin stands by and has no tools. To use the plugin instead, the user quits CUA Bar, turns off '
                'its login item and runs `claude mcp remove -s user cuabar`, then starts a new Claude session.'),
    'app_running': ('cuabar plugin: CUA Bar is running on this Mac, so this plugin stands by and has no tools; CUA Bar '
                    'and its own `cuabar` MCP serve CUA. To use the plugin instead, the user quits CUA Bar and turns '
                    'off its login item, then starts a new Claude session.'),
    'setup_failed': ('cuabar plugin: setting up the CUA engine failed, so this plugin has no tools. Tell the user; '
                     '`/mcp reconnect plugin:cuabar:cuabar` tries the setup again, and '
                     '`~/.local/bin/codex-cua doctor --json` shows what is missing.'),
}


def instructions(reason, detail=None):
    text = REASONS.get(reason, REASONS['setup_failed'])
    return text + (' Reason: ' + detail if reason == 'setup_failed' and detail else '')


def answer(message, text):
    """The reply to one JSON-RPC message, or None for a notification."""
    if not isinstance(message, dict) or 'id' not in message:
        return None
    method, ident = message.get('method'), message['id']
    if method == 'initialize':
        params = message.get('params') if isinstance(message.get('params'), dict) else {}
        protocol = params.get('protocolVersion')
        result = {'protocolVersion': protocol if isinstance(protocol, str) else '2025-06-18',
                  'capabilities': {'tools': {}}, 'serverInfo': {'name': 'cuabar', 'version': VERSION},
                  'instructions': text}
    elif method == 'ping':
        result = {}
    elif method == 'tools/list':
        result = {'tools': []}
    else:
        return {'jsonrpc': '2.0', 'id': ident, 'error': {'code': -32601, 'message': text}}
    return {'jsonrpc': '2.0', 'id': ident, 'result': result}


def main(arguments=None):
    arguments = sys.argv[1:] if arguments is None else arguments
    text = instructions(arguments[0] if arguments else 'setup_failed', arguments[1] if len(arguments) > 1 else None)
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except ValueError:
            continue
        reply = answer(message, text)
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + '\n')
            sys.stdout.flush()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
