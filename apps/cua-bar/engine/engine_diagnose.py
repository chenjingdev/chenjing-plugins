"""A plain-text report that is safe to paste into a chat: versions, states, counts and the latest operations.

It contains no environment value, token, URL, page title, tool argument or result, and the home folder is
written as ~ (R2). Everything in it comes from the status the app shows, so it never says more than the app does,
except one line: the runtimes Codex started again for conversations that are long gone are in no list, and only
counted here.
"""
from pathlib import Path
import platform
import re

from engine_core import REASON
from engine_status import build_view

RECENT = 20
_URL = re.compile(r'[A-Za-z][A-Za-z0-9+.-]*://\S*')


def redact(text, home):
    """Home folder as ~ (only where a path component ends, never inside another name), and no URL."""
    home = Path(home)
    for variant in sorted({str(home), str(home.resolve())}, key=len, reverse=True):
        if len(variant) > 1:
            text = re.sub(re.escape(variant)+r'(?![\w.-])', '~', text)
    return _URL.sub('[url]', text)


def _count(items, key):
    found = {}
    for item in items:
        found[item[key]] = found.get(item[key], 0)+1
    return found


def _plural(count, word):
    return '%d %s%s' % (count, word, '' if count == 1 else 'es' if word.endswith('s') else 's')


def _memory(size):
    """Binary megabytes like Activity Monitor and the rows of the app; gigabytes from 1 GB up."""
    mebibytes = size/1_048_576
    if mebibytes < 1:
        return '1 MB 미만'
    if int(mebibytes+0.5) < 1024:
        return '%d MB' % int(mebibytes+0.5)
    return '%.1f GB' % (mebibytes/1024)


def diagnose_text(ctx, view=None):
    view = view or build_view(ctx)
    status = view.status_json()
    codex, host, setup = status['codex'], status['host'], status['setup']
    connections = status['connections']
    lines = ['codex-cua diagnose',
             'generated: %s' % status['generated_at'],
             'plugin: %s' % status['plugin']['version'],
             'python: %s' % platform.python_version(),
             'macos: %s' % (platform.mac_ver()[0] or 'unknown')]
    if codex['installed']:
        lines.append('codex app: %s %s, %s' % (codex['app_path'], codex['app_version'] or 'unknown version',
                                              'running (%s)' % _plural(len(codex['pids']), 'process')
                                              if codex['running'] else 'not running'))
    else:
        lines.append('codex app: not installed')
    lines.append('host: %s%s%s' % (host['state'], ' since %s' % host['since'] if host['since'] else '',
                                 ', started before this setup' if host['started_before_setup'] else ''))
    lines.append('setup: ' + ', '.join('%s=%s' % (key, setup[key]) for key in
                                       ('command', 'dependencies', 'login_environment', 'shell_environment', 'wrapper',
                                        'relay')))
    reason = view.inv.host.relay_reason
    if reason and REASON.match(reason):
        lines.append('relay left out at the last Codex start: %s' % reason)
    by_agent, by_state = _count(connections, 'agent'), _count(connections, 'state')
    lines.append('connections: %d (claude %d, codex %d); active %d, idle %d, ended %d' % (
        len(connections), by_agent.get('claude', 0), by_agent.get('codex', 0), by_state.get('active', 0),
        by_state.get('idle', 0), by_state.get('ended', 0)))
    if view.revived:
        # In no list: nobody uses these and they hold nothing. Said in plain words, for the person who pastes this.
        lines.append('Codex가 다시 켠 빈 런타임 %d개 · %s — 대화가 끝난 것이라 Codex가 곧 내려요' % (
            len(view.revived), _memory(sum(item.memory_bytes or 0 for item in view.revived))))
    left = status['leases']['maybe_left']
    lines.append('leases: the list cannot be read; may be left behind: %d (releasable now: %d)' % (
        len(left), sum(1 for item in left if item['releasable'])))
    for tool in status['other_tools']:
        clients = _count(tool['clients'], 'agent')
        lines.append('other tool: %s %s, %s, %s' % (
            tool['name'], 'running' if tool['running'] else 'not running', _plural(len(tool['pids']), 'process'),
            _plural(len(tool['clients']), 'connection') + (' (%s)' % ', '.join(
                '%s %d' % (key or 'unknown', value) for key, value in sorted(clients.items(), key=str))
                if clients else '')))
    if not status['other_tools']:
        lines.append('other tools: none')
    active = status['screen']['active_connection_id']
    lines.append('screen: %s' % ('in use by a %s connection' % active.split('-')[0] if active else 'no call in the last 10 s'))
    recent = status['activity'][:RECENT]
    lines.append('latest operations (newest first, %d of %d):' % (len(recent), len(status['activity'])))
    for item in recent:
        lines.append('  %s %s %s %s %d ms' % (item['at'], item['agent'], item['tool'],
                                              'ok' if item['ok'] else 'failed', item['ms']))
    return redact('\n'.join(lines)+'\n', ctx.home)
