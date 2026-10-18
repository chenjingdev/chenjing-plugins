"""The bridge as a real process: how it ends on stdin end and on each stop signal, and what a kill leaves behind.

The child is `mcp_stdio.py` itself. A stub module named `websockets` (first on its PYTHONPATH) hands it the fake host
of fake_host.py instead of a connection, so it connects to nothing; it runs with a temp HOME, temp state
directories and a temp working directory. The only signals sent in these tests go to the child the test started.
"""
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from fake_host import private_socket, write_registry

PLUGIN = Path(__file__).resolve().parents[2]/'plugins/cua'
TESTS = Path(__file__).resolve().parent
STUB = '''
import os, sys
sys.path.insert(0, os.environ['FAKE_HOST_TESTS'])
from fake_host import FakeHost


async def unix_connect(*args, **kwargs):
    host = FakeHost(thread_id=os.environ['FAKE_HOST_THREAD'], turn_ended=os.environ['FAKE_HOST_TURN_ENDED'],
                    log_path=os.environ['FAKE_HOST_LOG'])
    if os.environ.get('FAKE_HOST_HOLD'):
        host.hold(os.environ['FAKE_HOST_HOLD'])
    return host
'''
INITIALIZE = {'protocolVersion': '2025-06-18', 'capabilities': {}}
SECRET_CALL = {'name': 'js', 'arguments': {'code': 'PRIVATE_SCRIPT', 'title': 'PRIVATE_TITLE'}}


# Sets how SIGHUP is treated and then becomes the bridge (same pid): an ignored signal stays ignored across exec,
# so the test cannot depend on how the test runner itself was started.
LAUNCH = ('import os, signal, sys; signal.signal(signal.SIGHUP, getattr(signal, sys.argv[1])); '
          'os.execv(sys.argv[2], sys.argv[2:])')


class Child:
    """One bridge process and its MCP conversation."""
    def __init__(self, environment, cwd, ignore_hangup=False):
        self.process = subprocess.Popen([sys.executable, '-B', '-c', LAUNCH, 'SIG_IGN' if ignore_hangup else 'SIG_DFL',
                                         sys.executable, '-B', str(PLUGIN/'mcp_stdio.py')], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, cwd=str(cwd))
        self.lines = queue.Queue()
        self.ident = 0
        threading.Thread(target=self.pump, daemon=True).start()

    def pump(self):
        for line in self.process.stdout:
            self.lines.put(json.loads(line))

    def request(self, method, params=None, timeout=15):
        self.ident += 1
        message = {'jsonrpc': '2.0', 'id': self.ident, 'method': method, 'params': params or {}}
        self.process.stdin.write((json.dumps(message)+'\n').encode())
        self.process.stdin.flush()
        while True:
            reply = self.lines.get(timeout=timeout)
            if reply.get('id') == self.ident:
                return reply

    def end_input(self):
        self.process.stdin.close()

    def finish(self, timeout=15):
        code = self.process.wait(timeout)
        self.stderr = self.process.stderr.read().decode()
        return code

    def discard(self):
        # Only ever this test's own child.
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait()
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            try:
                stream.close()
            except OSError:
                pass


class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/tmp', prefix='cp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ('home', 'work', 'stub/websockets', 'endpoint'):
            (self.root/name).mkdir(parents=True, mode=0o700)
        (self.root/'stub/websockets/__init__.py').write_text(STUB)
        self.state, self.host_state, self.log = self.root/'state', self.root/'host', self.root/'fake-host.log'
        self.sock, path = private_socket(self.root/'endpoint')
        self.addCleanup(self.sock.close)
        write_registry(self.host_state, path)

    def start(self, turn_ended='ok', hold=None, ignore_hangup=False):
        environment = {'PATH': '/usr/bin:/bin', 'HOME': str(self.root/'home'), 'PYTHONDONTWRITEBYTECODE': '1',
                       'PYTHONPATH': str(self.root/'stub'), 'FAKE_HOST_TESTS': str(TESTS),
                       'FAKE_HOST_THREAD': 'process-thread', 'FAKE_HOST_TURN_ENDED': turn_ended,
                       'FAKE_HOST_LOG': str(self.log), 'FAKE_HOST_HOLD': hold or '',
                       'CODEX_CUA_STATE_DIR': str(self.state), 'CODEX_HOST_CUA_STATE_DIR': str(self.host_state)}
        child = Child(environment, self.root/'work', ignore_hangup)
        self.addCleanup(child.discard)
        return child

    def connected(self, **options):
        child = self.start(**options)
        self.assertNotIn('error', child.request('initialize', INITIALIZE))
        return child

    def host_log(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def records(self):
        return sorted((self.state/'bridges').glob('bridge-*'))

    def test_the_record_is_there_while_the_bridge_runs_and_names_its_owner(self):
        child = self.connected()
        reply = child.request('tools/call', SECRET_CALL)
        self.assertEqual(reply['result']['content'][0]['text'], 'PRIVATE_RESULT')
        [directory] = self.records()
        record = json.loads((directory/'bridge.json').read_text())
        self.assertEqual((record['pid'], record['owner_pid'], record['cwd']), (child.process.pid, os.getpid(), str(self.root/'work')))
        self.assertEqual((record['session_id'], record['host']), ('process-thread', {'pid': os.getpid(), 'relay': False}))
        self.assertEqual((len(record['scopes']), record['cleanup'], record['busy']), (1, 'open', False))
        self.assertEqual(record['control_path'], str(directory/'control.sock'))
        # The activity of this call is in the shared log, by tool name only.
        [line] = [json.loads(text) for text in (self.state/'activity.jsonl').read_text().splitlines()]
        self.assertEqual((line['tool'], line['ok'], line['session_id']), ('js', True, 'process-thread'))
        for path in (directory/'bridge.json', self.state/'activity.jsonl'):
            self.assertNotIn(b'PRIVATE', path.read_bytes())
        child.end_input()
        self.assertEqual(child.finish(), 0)

    def check_release_at_exit(self, child):
        call = child.request('tools/call', SECRET_CALL)
        self.assertNotIn('error', call)
        [directory] = self.records()
        scope = json.loads((directory/'bridge.json').read_text())['scopes'][0]
        return directory, scope

    def test_stdin_end_releases_the_open_scope_and_removes_the_record(self):
        child = self.connected()
        directory, scope = self.check_release_at_exit(child)
        child.end_input()
        self.assertEqual(child.finish(), 0)
        ended = [entry for entry in self.host_log() if entry.get('tool') == 'turn_ended']
        self.assertEqual([entry['scope'] for entry in ended], [{'session_id': scope['session_id'], 'turn_id': scope['turn_id']}])
        self.assertFalse(directory.exists())
        self.assertEqual(self.records(), [])
        self.assertEqual(child.stderr.splitlines()[-1], 'cua: owned_thread_unsubscribe_confirmed')
        self.assertNotIn('PRIVATE', child.stderr)

    def test_each_stop_signal_releases_the_open_scope_and_removes_the_record(self):
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(signal=signum.name):
                if self.log.exists():
                    self.log.unlink()
                child = self.connected()
                directory, scope = self.check_release_at_exit(child)
                child.process.send_signal(signum)
                self.assertEqual(child.finish(), 0)
                ended = [entry for entry in self.host_log() if entry.get('tool') == 'turn_ended']
                self.assertEqual([entry['scope'] for entry in ended],
                                 [{'session_id': scope['session_id'], 'turn_id': scope['turn_id']}])
                self.assertFalse(directory.exists())
                self.assertEqual(self.records(), [])

    def test_a_refusing_host_leaves_the_record_not_confirmed_and_takes_the_socket_away(self):
        child = self.connected(turn_ended='refuse')
        directory, scope = self.check_release_at_exit(child)
        child.process.send_signal(signal.SIGTERM)
        self.assertEqual(child.finish(), 0)
        self.assertEqual(self.records(), [directory])
        self.assertEqual(sorted(entry.name for entry in directory.iterdir()), ['bridge.json'])
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual((directory/'bridge.json').stat().st_mode & 0o777, 0o600)
        record = json.loads((directory/'bridge.json').read_text())
        self.assertEqual(record['cleanup'], 'not_confirmed')
        self.assertEqual(record['scopes'], [scope])
        self.assertEqual((record['busy'], record['pid']), (False, child.process.pid))
        # The pair that could not be ended is exactly the one the host was asked about.
        asked = [entry['scope'] for entry in self.host_log() if entry.get('tool') == 'turn_ended']
        self.assertEqual(asked, [{'session_id': scope['session_id'], 'turn_id': scope['turn_id']}])

    def test_a_bridge_without_an_open_scope_leaves_nothing_behind(self):
        child = self.connected()
        child.process.send_signal(signal.SIGTERM)
        self.assertEqual(child.finish(), 0)
        self.assertEqual(self.records(), [])
        self.assertEqual([entry for entry in self.host_log() if entry.get('tool') == 'turn_ended'], [])

    def test_a_bridge_that_never_connected_leaves_nothing_behind(self):
        child = self.start()
        child.end_input()
        self.assertEqual(child.finish(), 0)
        self.assertEqual(self.records(), [])

    def test_a_kill_leaves_the_record_with_the_scope_of_the_call_that_was_running(self):
        child = self.connected(hold='js')
        message = {'jsonrpc': '2.0', 'id': 50, 'method': 'tools/call', 'params': SECRET_CALL}
        child.process.stdin.write((json.dumps(message)+'\n').encode())
        child.process.stdin.flush()
        deadline = time.monotonic()+30
        while time.monotonic() < deadline and not [entry for entry in self.host_log() if entry.get('tool') == 'js']:
            threading.Event().wait(0.01)
        [directory] = self.records()
        # The scope is recorded before the call leaves, so a bridge killed mid-call still owns it.
        record = json.loads((directory/'bridge.json').read_text())
        self.assertEqual((record['busy'], len(record['scopes']), record['cleanup']), (True, 1, 'open'))
        child.process.kill()
        child.process.wait()
        self.assertEqual(self.records(), [directory])
        self.assertTrue((directory/'control.sock').exists())
        self.assertEqual(json.loads((directory/'bridge.json').read_text())['scopes'], record['scopes'])

    def test_a_state_directory_with_the_wrong_mode_means_no_records_and_the_calls_still_work(self):
        self.state.mkdir(mode=0o755)
        self.state.chmod(0o755)
        child = self.connected()
        reply = child.request('tools/call', SECRET_CALL)
        self.assertEqual(reply['result']['content'][0]['text'], 'PRIVATE_RESULT')
        self.assertEqual(list(self.state.iterdir()), [])
        child.process.send_signal(signal.SIGTERM)
        self.assertEqual(child.finish(), 0)
        # No record, but the scope the call opened was still ended on the way out.
        self.assertEqual(len([entry for entry in self.host_log() if entry.get('tool') == 'turn_ended']), 1)
        self.assertEqual(list(self.state.iterdir()), [])
        self.assertIn('cua: bridge_records_unavailable', child.stderr.splitlines())

    def test_a_bridge_started_with_hangup_ignored_keeps_running_when_hung_up(self):
        child = self.start(ignore_hangup=True)
        self.assertNotIn('error', child.request('initialize', INITIALIZE))
        child.process.send_signal(signal.SIGHUP)
        # A bridge that took the hangup as a stop would be gone well within this time.
        threading.Event().wait(1.0)
        self.assertIsNone(child.process.poll())
        self.assertIn('result', child.request('ping'))
        child.end_input()
        self.assertEqual(child.finish(), 0)

    def test_the_process_writes_fixed_event_names_to_stderr_and_nothing_else(self):
        child = self.connected()
        child.request('tools/call', SECRET_CALL)
        child.request('tools/call', {'name': 'unadvertised', 'arguments': {'code': 'PRIVATE_SCRIPT'}})
        child.end_input()
        self.assertEqual(child.finish(), 0)
        events = child.stderr.splitlines()
        self.assertTrue(events)
        for line in events:
            self.assertRegex(line, r'^cua: [a-z_]+$')
        self.assertNotIn('PRIVATE', child.stderr)


if __name__ == '__main__':
    unittest.main()
