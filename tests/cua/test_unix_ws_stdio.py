"""The desktop transport: byte-for-byte forwarding, except the one thread configuration it points at the relay.

The WebSocket side is a stub package; no app-server, no Codex."""
import copy
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import unix_ws_stdio

PLUGIN_ROOT = Path(__file__).resolve().parents[2]/'plugins/cua'
NODE = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node'
NODE_REPL = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl'
SCRIPT = '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs'
APP = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'


def thread_config(**changes):
    """The bundled cua_repl configuration the desktop app attaches to its own threads."""
    entry = {'enabled': True, 'omit_tools_from': ['code_mode', 'deferred'], 'env_vars': [],
             'env': {'CODEX_HOME': '/Users/x/.codex', 'CUA_REPL_NODE_REPL_PATH': NODE_REPL,
                     'CUA_REPL_ENABLED_SURFACES': 'browser,computer', 'BROWSER_USE_ACCESS_PIPE_PATH': '/private/tmp/pipe'},
             'command': NODE, 'args': [SCRIPT]}
    entry.update(changes)
    return entry


def request(method='thread/start', entry=None, **params):
    return {'id': 7, 'method': method, 'params': {'cwd': '/Users/x/work 한국어', 'ephemeral': False,
            'config': {'model': 'gpt', 'mcp_servers.cua_repl': thread_config() if entry is None else entry, 'sandbox': {'a': [1, 2.5, None, True]}},
            'list': [1, {'k': 'v'}], **params}}


def line(message, **kwargs):
    return json.dumps(message, **kwargs).encode()


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/tmp', prefix='uws-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.directory = self.root/'relay'
        self.directory.mkdir(mode=0o700)
        self.launcher = self.directory/'node-repl-relay'
        self.launcher.write_text('#!/bin/sh\n')
        self.launcher.chmod(0o700)
        self.rewrite = unix_ws_stdio.RelayRewrite(str(self.launcher), NODE_REPL, NODE)


class RewriteTests(Fixture):
    def test_a_matching_request_gets_the_one_field_changed_and_the_environment_added(self):
        original = request()
        result = self.rewrite(line(original))
        expected = copy.deepcopy(original)
        env = expected['params']['config']['mcp_servers.cua_repl']['env']
        env['CUA_REPL_NODE_REPL_PATH'] = str(self.launcher)
        env['CODEX_CUA_NATIVE_RUNTIME'] = NODE_REPL
        env['CODEX_CUA_RELAY_NODE'] = NODE
        self.assertEqual(json.loads(result), expected)
        self.assertEqual(list(json.loads(result)['params']['config']['mcp_servers.cua_repl']['env']),
                         ['CODEX_HOME', 'CUA_REPL_NODE_REPL_PATH', 'CUA_REPL_ENABLED_SURFACES', 'BROWSER_USE_ACCESS_PIPE_PATH',
                          'CODEX_CUA_NATIVE_RUNTIME', 'CODEX_CUA_RELAY_NODE'], 'the rest keeps its place')
        self.assertIn('한국어'.encode('utf-8'), result, 'text stays text')
        self.assertNotIn(b'\\u', result)

    def test_the_state_directory_is_added_when_there_is_one(self):
        rewrite = unix_ws_stdio.RelayRewrite(str(self.launcher), NODE_REPL, NODE, '/private/state')
        env = json.loads(rewrite(line(request())))['params']['config']['mcp_servers.cua_repl']['env']
        self.assertEqual(env['CODEX_CUA_STATE_DIR'], '/private/state')

    def test_every_client_request_with_that_configuration_is_covered(self):
        for method in ('thread/start', 'thread/resume', 'thread/fork', 'turn/start'):
            with self.subTest(method):
                rewritten = json.loads(self.rewrite(line(request(method))))
                self.assertEqual(rewritten['params']['config']['mcp_servers.cua_repl']['env']['CUA_REPL_NODE_REPL_PATH'], str(self.launcher))
        notification = {'method': 'thread/start', 'params': request()['params']}
        self.assertEqual(json.loads(self.rewrite(line(notification)))['params']['config']['mcp_servers.cua_repl']['env']['CUA_REPL_NODE_REPL_PATH'],
                         str(self.launcher))

    def test_everything_that_is_not_exactly_that_goes_through_byte_for_byte(self):
        def with_env(**changes):
            return request(entry=thread_config(env=dict(thread_config()['env'], **changes)))
        stub = request(entry={'command': APP, 'enabled': False})
        responses = {'id': 7, 'result': {'config': {'mcp_servers.cua_repl': thread_config()}}}
        batch_write = {'id': 8, 'method': 'config/batchWrite', 'params': {'edits': [{'keyPath': 'mcp_servers.cua_repl', 'value': None}]}}
        for label, body in {
            'disabled stub of the app': line(stub),
            'unknown runtime path': line(with_env(CUA_REPL_NODE_REPL_PATH='/elsewhere/node_repl')),
            'runtime path missing': line(request(entry=thread_config(env={'X': '1'}))),
            'other command': line(request(entry=thread_config(command='/usr/bin/node'))),
            'no command': line(request(entry={k: v for k, v in thread_config().items() if k != 'command'})),
            'the relay is already named': line(with_env(CODEX_CUA_RELAY_NODE='/x')),
            'a response': line(responses),
            'a response with an error': line({'id': 7, 'error': {'code': 1, 'message': 'mcp_servers.cua_repl'}}),
            'another method, key is only a value': line(batch_write),
            'key not under config': line({'id': 9, 'method': 'thread/start', 'params': {'mcp_servers.cua_repl': thread_config()}}),
            'no params': line({'id': 9, 'method': 'x', 'mcp_servers.cua_repl': thread_config()}),
            'params is a list': line({'id': 9, 'method': 'x', 'params': [{'config': {'mcp_servers.cua_repl': thread_config()}}]}),
            'config is a list': line({'id': 9, 'method': 'x', 'params': {'config': ['mcp_servers.cua_repl']}}),
            'entry is a string': line({'id': 9, 'method': 'x', 'params': {'config': {'mcp_servers.cua_repl': 'on'}}}),
            'entry is null': line({'id': 9, 'method': 'x', 'params': {'config': {'mcp_servers.cua_repl': None}}}),
            'environment is a list': line(request(entry=thread_config(env=['CUA_REPL_NODE_REPL_PATH']))),
            'method is no string': line({'id': 9, 'method': 5, 'params': request()['params']}),
            'no method': line({'id': 9, 'params': request()['params']}),
            'a json array': line([request()]),
            'a json string': line('"mcp_servers.cua_repl"'),
            'not json, key inside': b'{"method":"x","params":{"config":{"mcp_servers.cua_repl":{',
            'not json at all': b'garbage "mcp_servers.cua_repl" garbage',
            'invalid utf-8 around the key': b'\xff\xfe {"mcp_servers.cua_repl": 1} \xff',
            'nan in the message': b'{"id":1,"method":"x","params":{"n":NaN,"config":{"mcp_servers.cua_repl":'
                                  + line(thread_config()) + b'}}}',
            'other method without the key': line({'id': 10, 'method': 'turn/start', 'params': {'input': [{'type': 'text', 'text': 'hi'}]}}),
            'a very large unrelated line': b'{"id":11,"method":"x","params":{"blob":"' + b'z' * (5 * 1024 * 1024) + b'"}}',
            'a very large line with the key but another shape': b'{"id":11,"method":"x","params":{"config":{"mcp_servers.cua_repl":1},"blob":"'
                                                                  + b'z' * (5 * 1024 * 1024) + b'"}}',
            'an empty line': b'',
            'odd whitespace': b' \t{ "id" : 12 , "method" : "ping" }  ',
        }.items():
            with self.subTest(label):
                self.assertEqual(self.rewrite(body), body)

    def test_nothing_is_rewritten_when_the_launcher_cannot_be_trusted(self):
        body = line(request())
        self.assertNotEqual(self.rewrite(body), body)
        for label, damage in {
            'it cannot run': lambda: self.launcher.chmod(0o600),
            'others can write it': lambda: self.launcher.chmod(0o777),
            'group can write it': lambda: self.launcher.chmod(0o770),
            'its directory is open': lambda: (self.launcher.chmod(0o700), self.directory.chmod(0o777)),
        }.items():
            with self.subTest(label):
                damage()
                self.assertEqual(self.rewrite(body), body)
                self.launcher.chmod(0o700)
                self.directory.chmod(0o700)
        self.launcher.unlink()
        self.assertEqual(self.rewrite(body), body, 'no launcher')
        self.launcher.symlink_to('/bin/sh')
        self.assertEqual(self.rewrite(body), body, 'a link')
        self.launcher.unlink()
        self.launcher.write_text('x')
        self.launcher.chmod(0o700)
        with patch.object(unix_ws_stdio.os, 'getuid', return_value=os.getuid()+1):
            self.assertEqual(self.rewrite(body), body, 'owned by somebody else')

    def test_a_rewritten_message_is_not_rewritten_again(self):
        once = self.rewrite(line(request()))
        self.assertEqual(self.rewrite(once), once)

    def test_only_lines_with_the_key_are_even_decoded(self):
        decoded = []
        real = unix_ws_stdio.json.loads

        def spy(*args, **kwargs):
            decoded.append(args[0])
            return real(*args, **kwargs)
        with patch.object(unix_ws_stdio.json, 'loads', side_effect=spy):
            for body in (b'{"id":1}', b'x' * 100000, b'',
                         line(request(method='turn/start', entry={'c': 1})).replace(b'mcp_servers.cua_repl', b'other')):
                self.assertEqual(self.rewrite(body), body)
            self.assertEqual(decoded, [], 'nothing without the key was decoded')
            self.rewrite(line(request()))
            self.assertEqual(len(decoded), 1, 'a line with the key is')


STUB_WEBSOCKETS = '''
import asyncio, os

class _Connection:
    async def __aenter__(self):
        return self
    async def __aexit__(self, *exc):
        return False
    async def send(self, text):
        assert isinstance(text, str)
        with open(os.environ['STUB_SENT'], 'ab') as output:
            output.write(text.encode('utf-8') + b'\\n')
    def __aiter__(self):
        self.frames = [line for line in open(os.environ['STUB_RECEIVE'], encoding='utf-8').read().split('\\n') if line]
        return self
    async def __anext__(self):
        if self.frames:
            return self.frames.pop(0)
        await asyncio.sleep(3600)

def unix_connect(path, **options):
    return _Connection()
'''


class ProcessTests(Fixture):
    """The real script, with a stub WebSocket package: what goes in on stdin, what the app-server would be sent."""

    def setUp(self):
        super().setUp()
        self.stub = self.root/'stub'
        (self.stub/'websockets').mkdir(parents=True)
        (self.stub/'websockets/__init__.py').write_text(STUB_WEBSOCKETS)
        self.sent = self.root/'sent.bin'
        self.received = self.root/'received.txt'
        self.received.write_text('')
        self.socket_dir = self.root/'sock'
        self.socket_dir.mkdir(mode=0o700)
        self.socket_path = self.socket_dir/'rpc.sock'
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(str(self.socket_path))
        self.addCleanup(self.listener.close)
        self.socket_path.chmod(0o600)

    def run_proxy(self, stdin, *extra, received=None):
        """Feed stdin; when the app-server side has something to say, wait until all of it came out first."""
        if received is not None:
            self.received.write_text(received, encoding='utf-8')
        environment = dict(os.environ, PYTHONPATH=str(self.stub), PYTHONDONTWRITEBYTECODE='1', STUB_SENT=str(self.sent), STUB_RECEIVE=str(self.received))
        child = subprocess.Popen([sys.executable, str(PLUGIN_ROOT/'unix_ws_stdio.py'), '--socket', str(self.socket_path), *extra],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
        self.addCleanup(lambda: child.kill() if child.poll() is None else None)
        try:
            child.stdin.write(stdin)
            child.stdin.flush()
        except BrokenPipeError:                                  # a transport that failed at once never reads
            pass
        output = b''
        if received:
            wanted = len(received.encode('utf-8'))
            deadline = time.monotonic()+15
            while len(output) < wanted and time.monotonic() < deadline:
                ready, _, _ = select.select([child.stdout], [], [], 0.2)
                if ready:
                    chunk = os.read(child.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    output += chunk
        try:
            child.stdin.close()
        except BrokenPipeError:
            pass
        rest, stderr = child.stdout.read(), child.stderr.read()
        child.wait(timeout=20)
        return child.returncode, output+rest, stderr, (self.sent.read_bytes() if self.sent.exists() else b'')

    def relay_arguments(self, *extra):
        return ['--relay-launcher', str(self.launcher), '--relay-native-runtime', NODE_REPL, '--relay-node', NODE, *extra]

    def test_with_the_relay_the_one_thread_configuration_is_pointed_at_it_and_everything_else_is_untouched(self):
        plain = [line({'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'desktop'}}}),
                 b'{ "id" : 2 ,"method":"turn/start", "params":{"text":"h\\u00e9llo \xed\x95\x9c"} }',
                 line({'id': 3, 'method': 'config/batchWrite', 'params': {'edits': [{'keyPath': 'mcp_servers.cua_repl', 'value': None}]}}),
                 b'{"id":4,"method":"x","params":{"blob":"' + b'z' * (3 * 1024 * 1024) + b'"}}']
        stub_app = line(request(entry={'command': APP, 'enabled': False}))
        matching = request()
        code, stdout, stderr, sent = self.run_proxy(b'\n'.join(plain[:2] + [line(matching)] + plain[2:3] + [stub_app] + plain[3:]) + b'\n',
                                                    *self.relay_arguments('--relay-state-dir', '/private/state'))
        self.assertEqual((code, stdout, stderr), (0, b'', b''))
        frames = sent.split(b'\n')[:-1]
        self.assertEqual(len(frames), 6)
        self.assertEqual(frames[0], plain[0])
        self.assertEqual(frames[1], b'{ "id" : 2 ,"method":"turn/start", "params":{"text":"h\\u00e9llo \xed\x95\x9c"} }')
        expected = copy.deepcopy(matching)
        env = expected['params']['config']['mcp_servers.cua_repl']['env']
        env.update(CUA_REPL_NODE_REPL_PATH=str(self.launcher), CODEX_CUA_NATIVE_RUNTIME=NODE_REPL, CODEX_CUA_RELAY_NODE=NODE,
                   CODEX_CUA_STATE_DIR='/private/state')
        self.assertEqual(json.loads(frames[2]), expected)
        self.assertEqual(frames[3], plain[2])
        self.assertEqual(frames[4], stub_app)
        self.assertEqual(frames[5], plain[3])

    def test_without_the_relay_arguments_the_transport_forwards_everything_as_it_always_did(self):
        body = [line(request()), line(request('thread/resume')), b'{"id":1,"method":"ping"}']
        for arguments in ([], self.relay_arguments()[:2], self.relay_arguments()[:4], ['--relay-node', NODE],
                          ['--relay-launcher', 'node-repl-relay', '--relay-native-runtime', NODE_REPL, '--relay-node', NODE],
                          ['--relay-launcher', str(self.launcher), '--relay-native-runtime', '', '--relay-node', NODE]):
            with self.subTest(arguments=arguments):
                if self.sent.exists():
                    self.sent.unlink()
                code, stdout, stderr, sent = self.run_proxy(b'\n'.join(body) + b'\n', *arguments)
                self.assertEqual((code, stdout, stderr), (0, b'', b''))
                self.assertEqual(sent, b'\n'.join(body) + b'\n')

    def test_what_the_app_server_sends_is_never_rewritten(self):
        frames = [line(request()), line({'id': 7, 'result': {'config': {'mcp_servers.cua_repl': thread_config()}}}),
                  b'{ "method" : "mcpServer/startupStatus/updated", "params" : {"name":"cua_repl"} }']
        text = b'\n'.join(frames).decode('utf-8')+'\n'
        code, stdout, stderr, sent = self.run_proxy(b'', *self.relay_arguments(), received=text)
        self.assertEqual((code, stderr, sent), (0, b'', b''))
        self.assertEqual(stdout, b'\n'.join(frames)+b'\n')

    def test_a_missing_launcher_is_a_plain_transport(self):
        self.launcher.unlink()
        body = line(request())
        code, _, stderr, sent = self.run_proxy(body+b'\n', *self.relay_arguments())
        self.assertEqual((code, stderr, sent), (0, b'', body+b'\n'))

    def test_it_stays_quiet_about_what_it_forwards(self):
        secret = request(entry=thread_config(env=dict(thread_config()['env'], BROWSER_USE_ACCESS_TOKEN='PRIVATE_TOKEN_VALUE')))
        code, stdout, stderr, _ = self.run_proxy(line(secret)+b'\n', *self.relay_arguments())
        self.assertEqual((code, stdout, stderr), (0, b'', b''))
        # A failure says what failed, not what was sent.
        os.unlink(self.socket_path)
        code, _, stderr, _ = self.run_proxy(line(secret)+b'\n', *self.relay_arguments())
        self.assertEqual(code, 1)
        self.assertNotIn(b'PRIVATE_TOKEN_VALUE', stderr)
        self.assertNotIn(str(self.root).encode(), stderr)


if __name__ == '__main__':
    unittest.main()
