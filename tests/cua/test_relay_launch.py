"""The Codex launcher puts the relay in front of the CUA runtime, or starts exactly as it always did.

Real launcher process, fake original CLI inside a fake app, fake desktop transport; no Codex, no Chrome."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from test_desktop_cli_wrapper import FAKE, FAKE_STDIO, PRIMARY
from test_relay_install import Machine

PLUGIN_ROOT = Path(__file__).resolve().parents[2]/'plugins/cua'
TESTS = Path(__file__).resolve().parent
OVERRIDE_PREFIX = 'mcp_servers.cua_repl='


class RelayLaunchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/tmp', prefix='rln-')
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name).resolve()
        self.machine = Machine(root)
        self.plugin = self.machine.plugin
        for name in ('desktop_cli_wrapper.py', 'relay_install.py', 'runtime_paths.py'):
            shutil.copy(PLUGIN_ROOT/name, self.plugin/name)
        (self.plugin/'unix_ws_stdio.py').write_text(FAKE_STDIO)
        self.native = self.machine.native
        self.native.write_text(FAKE)
        self.native.chmod(0o700)
        self.definition = root/'definition.json'
        self.definition.write_text(json.dumps(self.machine.definition))
        self.log = root/'events.jsonl'
        self.state = root/'state'
        self.environment = dict(os.environ)
        self.environment.pop('CODEX_HOME', None)
        self.environment.pop('CODEX_CUA_STATE_DIR', None)
        self.environment.update({
            'PYTHONDONTWRITEBYTECODE': '1', 'HOME': str(self.machine.home), 'CODEX_HOST_CUA_NATIVE_CLI': str(self.native),
            'CODEX_HOST_CUA_STATE_DIR': str(self.state), 'CODEX_HOST_CUA_STARTUP_TIMEOUT': '5',
            'CODEX_HOST_CUA_SHUTDOWN_TIMEOUT': '0.4', 'FIXTURE_EVENT_FILE': str(self.log),
            'FIXTURE_ENV': 'fixture-environment-value', 'FIXTURE_TESTS_DIR': str(TESTS),
            'FIXTURE_MCP_DEFINITION': str(self.definition)})
        self.children = []
        # What a forgotten injection would hit; the launcher process gets the machine's home explicitly.
        self.sentinel = root/'sentinel-home'
        self.sentinel.mkdir()
        patcher = patch.dict(os.environ, {'HOME': str(self.sentinel)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(lambda: self.assertEqual(list(self.sentinel.iterdir()), [], 'something was written to the default home'))

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream is not None and not stream.closed:
                    stream.close()
        for event in self.events():
            try:
                os.kill(event['pid'], signal.SIGKILL)       # fake children recorded in this test folder only
            except ProcessLookupError:
                pass

    def events(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def mcp_gets(self):
        path = self.log.parent/'mcp-get.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def start(self, arguments=PRIMARY, environment=None):
        child = subprocess.Popen([sys.executable, str(self.plugin/'desktop_cli_wrapper.py'), *arguments],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 env=self.environment if environment is None else environment, cwd=str(self.temp.name))
        self.children.append(child)
        return child

    def ready(self):
        deadline = time.monotonic()+8
        while time.monotonic() < deadline:
            try:
                record = json.loads((self.state/'host.json').read_text())
                if record.get('status') == 'ready':
                    return record
            except (OSError, ValueError):
                pass
            time.sleep(0.02)
        self.fail('The launcher did not become ready')

    def finish(self, child):
        child.stdin.close()
        child.wait(timeout=5)
        self.assertEqual(child.returncode, 0, child.stderr.read().decode())

    def event(self, role):
        # The fake processes write their event a moment after the launcher says ready.
        deadline = time.monotonic()+5
        while time.monotonic() < deadline:
            found = [event for event in self.events() if event['role'] == role]
            if found:
                return found[0]
            time.sleep(0.02)
        self.fail('No ' + role + ' was started')

    def backend(self):
        return self.event('backend')

    def proxy(self):
        return self.event('proxy')

    def assert_launched_as_always(self, reason=None):
        record = self.ready()
        backend, proxy = self.backend(), self.proxy()
        self.assertEqual(backend['argv'], PRIMARY+['--listen', 'unix://'+record['socket_path']])
        self.assertEqual(proxy['argv'], ['--socket', record['socket_path']])
        self.assertIs(record['relay'], False)
        self.assertIsNone(record['relay_launcher'])
        if reason is not None:
            self.assertEqual(record['relay_reason'], reason)
        return record

    def test_with_the_bundled_definition_in_order_the_relay_goes_in_front(self):
        child = self.start()
        record = self.ready()
        launcher = self.machine.launcher
        self.assertIs(record['relay'], True)
        self.assertEqual(record['relay_launcher'], str(launcher))
        self.assertIsNone(record['relay_reason'])
        self.assertTrue(launcher.is_file())
        backend = self.backend()['argv']
        index = backend.index('app-server')
        override = [item for item in backend if item.startswith(OVERRIDE_PREFIX)]
        self.assertEqual(len(override), 1)
        self.assertEqual(backend[index-2:index], ['-c', override[0]], 'right before the subcommand, as a root-level option')
        rest = list(backend)
        position = rest.index(override[0])
        del rest[position-1:position+1]
        self.assertEqual(rest, PRIMARY+['--listen', 'unix://'+record['socket_path']], 'every argument of the app stays, in order')
        self.assertEqual(self.proxy()['argv'], ['--socket', record['socket_path'], '--relay-launcher', str(launcher),
            '--relay-native-runtime', str(self.machine.cua/'bin/node_repl'), '--relay-node', str(self.machine.cua/'bin/node')])
        # The definition was read with the app's own options, and the backend gets the environment unchanged.
        reads = self.mcp_gets()
        self.assertEqual(len(reads), 2)
        self.assertEqual(reads[0]['argv'], ['-c', 'features.code_mode_host=true', '-c',
            'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true', '-c',
            'plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=true', 'mcp', 'get', 'cua_repl', '--json'])
        self.assertEqual(reads[1]['argv'][:-4], reads[0]['argv'][:-4]+['-c', override[0]])
        expected = hashlib.sha256(b'fixture-environment-value').hexdigest()
        self.assertEqual({read['fixture_hash'] for read in reads}, {expected})
        self.assertEqual(self.backend()['fixture_hash'], expected)
        self.finish(child)

    def test_the_state_directory_of_the_launcher_reaches_the_relay(self):
        self.environment['CODEX_CUA_STATE_DIR'] = '/private/tmp/state-of-the-relay'
        child = self.start()
        record = self.ready()
        self.assertIs(record['relay'], True)
        override = next(item for item in self.backend()['argv'] if item.startswith(OVERRIDE_PREFIX))
        self.assertIn('CODEX_CUA_STATE_DIR = "/private/tmp/state-of-the-relay"', override)
        self.assertEqual(self.proxy()['argv'][-2:], ['--relay-state-dir', '/private/tmp/state-of-the-relay'])
        self.finish(child)

    def test_the_stable_copy_is_refreshed_at_every_primary_start(self):
        self.machine.plan()                                     # creates the copy
        (self.machine.data/'relay/relay.mjs').write_text('stale')
        shutil.rmtree(self.machine.data/'relay/node-repl-relay', ignore_errors=True)
        (self.machine.data/'relay/node-repl-relay').unlink()
        self.finish_after(self.start())
        for name in ('relay.mjs', 'node-repl-relay'):
            self.assertEqual((self.machine.data/'relay'/name).read_bytes(), (PLUGIN_ROOT/'relay'/name).read_bytes())

    def finish_after(self, child):
        self.ready()
        self.finish(child)

    def refuse(self, change, reason):
        change(self.machine.definition)
        self.definition.write_text(json.dumps(self.machine.definition))
        child = self.start()
        self.assert_launched_as_always(reason)
        self.assertEqual(len(self.mcp_gets()), 1, 'the second read never happens')
        self.finish(child)

    def test_a_field_nobody_knows_starts_codex_exactly_as_before(self):
        self.refuse(lambda definition: definition.update(supports_parallel_tool_calls=True), 'unknown_field')

    def test_a_secret_looking_environment_name_starts_codex_exactly_as_before(self):
        self.refuse(lambda definition: definition['transport']['env'].update(SERVICE_API_KEY='PRIVATE'), 'secret_env')

    def test_another_command_starts_codex_exactly_as_before(self):
        self.refuse(lambda definition: definition['transport'].update(command='/usr/bin/node'), 'not_bundled')

    def test_another_runtime_starts_codex_exactly_as_before(self):
        self.refuse(lambda definition: definition['transport']['env'].update(CUA_REPL_NODE_REPL_PATH='/elsewhere/proxy'), 'not_bundled')

    def test_a_cli_that_cannot_answer_starts_codex_exactly_as_before(self):
        self.environment['FIXTURE_MCP_MODE'] = 'exit'
        child = self.start()
        self.assert_launched_as_always('definition_unreadable')
        self.finish(child)

    def test_a_cli_that_does_not_answer_in_time_costs_a_few_seconds_at_most(self):
        self.environment['FIXTURE_MCP_MODE'] = 'hang'
        started = time.monotonic()
        child = self.start()
        self.assert_launched_as_always('definition_unreadable')
        self.assertLess(time.monotonic()-started, 8)
        self.finish(child)

    def test_a_cli_that_reads_the_override_differently_starts_codex_exactly_as_before(self):
        self.environment['FIXTURE_MCP_MODE'] = 'ignore_override'
        child = self.start()
        self.assert_launched_as_always('override_rejected')
        self.assertEqual(len(self.mcp_gets()), 2)
        self.finish(child)

    def test_a_missing_stable_copy_or_missing_support_directory_starts_codex_exactly_as_before(self):
        shutil.rmtree(self.machine.data)
        child = self.start()
        self.assert_launched_as_always('stable_copy')
        self.assertEqual(self.mcp_gets(), [])
        self.assertFalse(self.machine.data.exists())
        self.finish(child)

    def test_a_plugin_without_its_relay_files_starts_codex_exactly_as_before(self):
        shutil.rmtree(self.plugin/'relay')
        child = self.start()
        self.assert_launched_as_always('stable_copy')
        self.finish(child)

    def test_a_missing_install_module_starts_codex_exactly_as_before(self):
        (self.plugin/'relay_install.py').unlink()
        child = self.start()
        self.assert_launched_as_always('unavailable')
        self.assertEqual(self.mcp_gets(), [])
        self.finish(child)

    def test_missing_plugin_cache_of_the_app_starts_codex_exactly_as_before(self):
        shutil.rmtree(self.machine.codex_home/'plugins')
        child = self.start()
        self.assert_launched_as_always('plugin_entry')
        self.finish(child)

    def test_other_commands_do_not_even_read_the_definition(self):
        for arguments in (['--version'], ['app-server', 'generate-ts', '--out', '/fixture'],
                          ['app-server', '--analytics-default-enabled', '-c', 'default_permissions=fixture']):
            with self.subTest(arguments=arguments):
                child = self.start(arguments)
                child.communicate(timeout=5)
                self.assertEqual(child.returncode, 0)
        self.assertEqual(self.mcp_gets(), [])
        self.assertFalse((self.machine.data/'relay').exists())

    def test_a_second_primary_start_does_not_touch_the_relay_files_or_ask_again(self):
        first = self.start()
        record = self.ready()
        reads = len(self.mcp_gets())
        before = (self.machine.data/'relay/relay.mjs').stat().st_ino
        second = self.start()
        stdout, stderr = second.communicate(timeout=5)
        self.assertEqual(second.returncode, 0, stderr.decode())
        self.assertEqual(json.loads(stdout)['argv'], PRIMARY, 'the duplicate runs the original CLI untouched')
        self.assertEqual(len(self.mcp_gets()), reads)
        self.assertEqual((self.machine.data/'relay/relay.mjs').stat().st_ino, before)
        self.assertEqual(json.loads((self.state/'host.json').read_text())['relay_launcher'], record['relay_launcher'])
        self.finish(first)


if __name__ == '__main__':
    unittest.main()
