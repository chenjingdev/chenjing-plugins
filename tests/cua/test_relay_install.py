"""The relay installation: stable copy, the plan for the Codex launcher, and the bridge's identity check.

Fake Mac, fake native CLI, no Codex, no Chrome, no real support directory."""
import asyncio
import contextlib
import copy
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import fake_native_cli
import relay_install
import setup
from relay_install import RelayRefused
from test_runtime_paths import fake_app
from toml_subset import parse_override, parse_value

PLUGIN_ROOT = Path(__file__).resolve().parents[2]/'plugins/cua'
APP_ARGUMENTS = ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled',
                 '-c', 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true']


class FakeCli:
    """The native CLI as `plan_relay` runs it (see fake_native_cli), with failures on demand."""

    def __init__(self, definition):
        self.definition = definition
        self.calls = []
        self.fail = {}          # call number -> 'exit' | 'timeout' | 'oserror' | 'garbage' | 'list'
        self.ignore_override = False
        self.alter_env = None   # function(env) -> env, to play a CLI that reads the override differently

    def shown(self, table):
        return fake_native_cli.shown(table)

    def __call__(self, command, **kwargs):
        index = command.index('mcp')
        flags = command[1:index]
        self.calls.append(SimpleNamespace(command=command, flags=flags, kwargs=kwargs))
        mode = self.fail.get(len(self.calls))
        if mode == 'timeout':
            raise subprocess.TimeoutExpired(command, kwargs.get('timeout'))
        if mode == 'oserror':
            raise OSError('PRIVATE_CLI_ERROR')
        if mode == 'exit':
            return SimpleNamespace(returncode=1, stdout=b'')
        if mode == 'garbage':
            return SimpleNamespace(returncode=0, stdout=b'not json')
        if mode == 'list':
            return SimpleNamespace(returncode=0, stdout=b'[]')
        answer = fake_native_cli.mcp_get(flags, self.definition, self.ignore_override, self.alter_env)
        return SimpleNamespace(returncode=0, stdout=json.dumps(answer).encode())


class Machine:
    """A fake Mac: a home with the support directory, an original app with CUA assets, its plugin cache."""

    def __init__(self, root):
        self.root = root
        self.home = root/'home'
        self.home.mkdir(mode=0o700)
        self.app, self.native, cua = fake_app(root/'Applications')
        self.cua = cua.resolve()
        self.codex_home = self.home/'.codex'
        self.data = self.home/'.local/share/codex-cua'
        self.data.mkdir(parents=True, mode=0o700)
        self.plugin = root/'plugin'
        shutil.copytree(PLUGIN_ROOT/'relay', self.plugin/'relay')
        self.version = 'fixture'
        node, node_repl = self.cua/'bin/node', self.cua/'bin/node_repl'
        script = self.cua/'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs'
        self.env = {
            'NODE_REPL_TRUSTED_SERVICES': '{"browser":"@oai/browser-desktop/service","sky":"@oai/sky/service"}',
            'NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME': 'Control "Chrome" \\ together with the plugin. \u2014 \ud55c\uad6d\uc5b4 \U0001F600\nsecond line\ttab',
            'CUA_REPL_NODE_REPL_PATH': str(node_repl), 'CODEX_HOME': str(self.codex_home),
            'BROWSER_USE_CODEX_APP_VERSION': self.version, 'CUA_REPL_ENABLED_SURFACES': 'browser,computer',
            'SKY_CUA_SERVICE_PATH': str(self.codex_home/'computer-use/Codex Computer Use.app'), 'EMPTY': ''}
        self.definition = {
            'name': 'cua_repl', 'enabled': True, 'disabled_reason': None,
            'transport': {'type': 'stdio', 'command': str(node), 'args': [str(script)], 'env': copy.deepcopy(self.env),
                          'env_vars': [], 'cwd': None},
            'enabled_tools': ['js', 'js_reset', 'turn_ended'], 'disabled_tools': None,
            'startup_timeout_sec': 120.0, 'tool_timeout_sec': None}
        self.entry = {'command': str(node), 'args': [str(script)], 'enabled': True,
                      'enabled_tools': ['js', 'js_reset', 'turn_ended'], 'omit_tools_from': ['code_mode', 'deferred'],
                      'startup_timeout_sec': 120, 'tools': {'js': {'output_token_limit': 25000}}, 'env_vars': [],
                      'env': copy.deepcopy(self.env)}
        self.write_plugin()
        self.cli = FakeCli(self.definition)
        self.environment = {'HOME': str(self.home), 'PATH': '/usr/bin:/bin'}

    def write_plugin(self, entry=None, directory=None, manifest=None, codex_home=None):
        directory = (codex_home or self.codex_home)/'plugins/cache/openai-bundled/unified-computer-use'/(directory or self.version)
        (directory/'.codex-plugin').mkdir(parents=True, exist_ok=True)
        (directory/'.codex-plugin/plugin.json').write_text(json.dumps(manifest or {'name': 'unified-computer-use', 'version': self.version}))
        (directory/'.mcp.json').write_text(json.dumps({'mcpServers': {'cua_repl': self.entry if entry is None else entry}}))
        return directory

    def plan(self, arguments=None, environment=None, cli=None):
        return relay_install.plan_relay(self.native, APP_ARGUMENTS if arguments is None else arguments,
                                        self.environment if environment is None else environment,
                                        self.plugin, run=cli or self.cli)

    @property
    def launcher(self):
        return self.data/'relay/node-repl-relay'


class MachineCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/tmp', prefix='rin-')
        self.addCleanup(self.temp.cleanup)
        self.machine = Machine(Path(self.temp.name).resolve())


class TomlTests(unittest.TestCase):
    def test_text_round_trips_through_an_independent_reader(self):
        value = {'plain': 'x', 'quote"d': 'say "hi"', 'back\\slash': 'C:\\dir\\file', 'tabs': 'a\tb\nc\r\nd\x08\x0c',
                 'controls': '\x00\x01\x1f\x7f', 'unicode': '\u00e9 \ud55c\uad6d\uc5b4 \u2014', 'astral': '\U0001F600',
                 'empty': '', 'braces': '{"a":"b"} = [1, 2] # not a comment', 'with space': {'n': [1, -2, 3.5, 1e16, True, False]},
                 'float': 120.0, 'list': [], 'table': {}, 'nested': [{'a': [['b']]}]}
        text = relay_install.toml_value(value)
        self.assertTrue(text.isascii())
        self.assertNotIn('\n', text)
        self.assertEqual(parse_value(text), value)

    def test_what_toml_cannot_say_is_refused(self):
        for value in (None, float('nan'), float('inf'), '\ud800', {1: 'x'}, ('a',), object(), {'a': None}):
            with self.subTest(value=repr(value)):
                with self.assertRaises(ValueError):
                    relay_install.toml_value(value)


class ArgumentTests(unittest.TestCase):
    def test_config_flags_keep_the_order_of_every_configuration_option(self):
        arguments = ['-c', 'a=1', '--enable', 'f', 'app-server', '--analytics-default-enabled', '--config=b=2',
                     '-c', 'c=3', '-c=e=5', '--disable', 'g', '--enable=h', '--listen']
        self.assertEqual(relay_install.config_flags(arguments), ['-c', 'a=1', '--enable', 'f', '--config=b=2', '-c', 'c=3',
                                                                  '-c=e=5', '--disable', 'g', '--enable=h'])
        self.assertEqual(relay_install.config_flags(['-c', 'a=1', '-c']), ['-c', 'a=1'], 'an option without its value is dropped')

    def test_the_subcommand_is_the_first_argument_that_is_no_root_option(self):
        self.assertEqual(relay_install.subcommand_index(APP_ARGUMENTS), 2)
        self.assertEqual(relay_install.subcommand_index(['app-server']), 0)
        self.assertEqual(relay_install.subcommand_index(['--enable', 'x', '--config=y=1', '-c=z=1', '-c', 'k=1', 'app-server']), 6)
        with self.assertRaises(RelayRefused):
            relay_install.subcommand_index(['-c', 'a=1'])


class PlanTests(MachineCase):
    def test_the_override_reproduces_every_field_and_changes_only_the_environment(self):
        plan, reason = self.machine.plan()
        self.assertIsNone(reason)
        key, table = parse_override(plan.override)
        self.assertEqual(key, 'mcp_servers.cua_repl')
        definition = self.machine.definition
        transport = definition['transport']
        env = dict(transport['env'])
        env.update(CUA_REPL_NODE_REPL_PATH=str(self.machine.launcher),
                   CODEX_CUA_NATIVE_RUNTIME=transport['env']['CUA_REPL_NODE_REPL_PATH'],
                   CODEX_CUA_RELAY_NODE=transport['command'])
        self.assertEqual(table, {
            'command': transport['command'], 'args': transport['args'], 'env': env, 'enabled': True,
            'enabled_tools': definition['enabled_tools'], 'omit_tools_from': ['code_mode', 'deferred'],
            'startup_timeout_sec': 120.0, 'tools': {'js': {'output_token_limit': 25000}}})
        # Read back by the CLI itself: the same definition, and the environment is the only difference.
        shown = self.machine.cli.shown(table)
        self.assertEqual({k: v for k, v in shown.items() if k != 'transport'}, {k: v for k, v in definition.items() if k != 'transport'})
        self.assertEqual({k: v for k, v in shown['transport'].items() if k != 'env'},
                         {k: v for k, v in transport.items() if k != 'env'})
        changed = {name for name in set(env) | set(transport['env']) if env.get(name) != transport['env'].get(name)}
        self.assertEqual(changed, {'CUA_REPL_NODE_REPL_PATH', 'CODEX_CUA_NATIVE_RUNTIME', 'CODEX_CUA_RELAY_NODE'})
        self.assertEqual(plan.launcher, self.machine.launcher)
        self.assertEqual((plan.node, plan.native_runtime), (transport['command'], transport['env']['CUA_REPL_NODE_REPL_PATH']))

    def test_the_override_sits_before_the_subcommand_and_nothing_else_moves(self):
        plan, _ = self.machine.plan()
        self.assertEqual(plan.arguments[:2], APP_ARGUMENTS[:2])
        self.assertEqual(plan.arguments[2], '-c')
        self.assertTrue(plan.arguments[3].startswith('mcp_servers.cua_repl='))
        self.assertEqual(plan.arguments[4:], APP_ARGUMENTS[2:])
        self.assertLess(plan.arguments.index(plan.override), plan.arguments.index('app-server'))
        self.assertEqual(len(plan.arguments), len(APP_ARGUMENTS) + 2)

    def test_the_definition_is_read_twice_with_the_app_s_own_options_and_the_same_environment(self):
        environment = dict(self.machine.environment, CODEX_CUA_STATE_DIR='/private/state', SOMETHING='else')
        plan, _ = self.machine.plan(environment=environment)
        first, second = self.machine.cli.calls
        self.assertEqual(first.flags, ['-c', 'features.code_mode_host=true', '-c', 'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true'])
        # The override stands where it stands in the real start: after the root-level options, before the subcommand's own.
        self.assertEqual(second.flags, ['-c', 'features.code_mode_host=true', '-c', plan.override, '-c',
                                        'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true'])
        self.assertEqual(second.flags, relay_install.config_flags(plan.arguments), 'same options in the same order as the start')
        for call in (first, second):
            self.assertEqual(call.command[0], str(self.machine.native))
            self.assertEqual(call.command[-4:], ['mcp', 'get', 'cua_repl', '--json'])
            self.assertIs(call.kwargs['env'], environment)
            self.assertLessEqual(call.kwargs['timeout'], 5)
            self.assertIs(call.kwargs['stdin'], subprocess.DEVNULL)
            self.assertIs(call.kwargs['stderr'], subprocess.DEVNULL)

    def test_options_in_the_attached_form_reach_the_cli_and_keep_their_place(self):
        arguments = ['-c=features.code_mode_host=true', 'app-server', '--analytics-default-enabled', '--config=a.b=1']
        plan, reason = self.machine.plan(arguments=arguments)
        self.assertIsNone(reason)
        self.assertEqual(plan.arguments[0], '-c=features.code_mode_host=true')
        self.assertEqual(plan.arguments[1:3], ['-c', plan.override])
        self.assertEqual(plan.arguments[3:], arguments[1:])
        first, second = self.machine.cli.calls
        self.assertEqual(first.flags, ['-c=features.code_mode_host=true', '--config=a.b=1'])
        self.assertEqual(second.flags, ['-c=features.code_mode_host=true', '-c', plan.override, '--config=a.b=1'])

    def test_the_state_directory_is_passed_on_only_when_the_launcher_has_one(self):
        plan, _ = self.machine.plan()
        self.assertNotIn('CODEX_CUA_STATE_DIR', parse_override(plan.override)[1]['env'])
        self.assertNotIn('--relay-state-dir', plan.proxy_arguments())
        plan, _ = self.machine.plan(environment=dict(self.machine.environment, CODEX_CUA_STATE_DIR='/private/state'))
        self.assertEqual(parse_override(plan.override)[1]['env']['CODEX_CUA_STATE_DIR'], '/private/state')
        self.assertEqual(plan.proxy_arguments()[-2:], ['--relay-state-dir', '/private/state'])
        plan, _ = self.machine.plan(environment=dict(self.machine.environment, CODEX_CUA_STATE_DIR='relative/state'))
        self.assertNotIn('CODEX_CUA_STATE_DIR', parse_override(plan.override)[1]['env'])

    def test_the_proxy_gets_the_verified_paths(self):
        plan, _ = self.machine.plan()
        self.assertEqual(plan.proxy_arguments(), ['--relay-launcher', str(self.machine.launcher),
            '--relay-native-runtime', str(self.machine.cua/'bin/node_repl'), '--relay-node', str(self.machine.cua/'bin/node'),
            '--relay-script', str(self.machine.cua/'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')])

    def test_optional_fields_of_the_definition_are_reproduced_too(self):
        definition = self.machine.definition
        definition['transport']['env_vars'] = ['PATH', 'HOME']
        definition['disabled_tools'] = ['js_reset']
        definition['tool_timeout_sec'] = 30
        definition['startup_timeout_sec'] = 7.5
        self.machine.entry.update(env_vars=['PATH', 'HOME'], disabled_tools=['js_reset'], tool_timeout_sec=30, startup_timeout_sec=7.5)
        self.machine.write_plugin()
        plan, reason = self.machine.plan()
        self.assertIsNone(reason)
        table = parse_override(plan.override)[1]
        self.assertEqual((table['env_vars'], table['disabled_tools'], table['tool_timeout_sec'], table['startup_timeout_sec']),
                         (['PATH', 'HOME'], ['js_reset'], 30, 7.5))

    def test_a_definition_without_the_hidden_fields_is_reproduced_without_them(self):
        for key in ('omit_tools_from', 'tools'):
            del self.machine.entry[key]
        self.machine.write_plugin()
        plan, reason = self.machine.plan()
        self.assertIsNone(reason)
        self.assertEqual(set(parse_override(plan.override)[1]), {'command', 'args', 'env', 'enabled', 'enabled_tools', 'startup_timeout_sec'})

    def test_the_refreshed_stable_copy_is_what_the_override_points_at(self):
        self.assertFalse(self.machine.launcher.exists())
        plan, _ = self.machine.plan()
        self.assertTrue(self.machine.launcher.is_file())
        self.assertEqual(relay_install.relay_files_status(self.machine.data), 'ready')
        self.assertEqual(parse_override(plan.override)[1]['env']['CUA_REPL_NODE_REPL_PATH'], str(self.machine.launcher))


class RefusalTests(MachineCase):
    """Every refusal means: no relay, Codex starts as it would without one. The reason is a fixed code word."""

    def refused(self, reason, **kwargs):
        plan, why = self.machine.plan(**kwargs)
        self.assertIsNone(plan)
        self.assertEqual(why, reason)
        return why

    def change(self, mutate):
        mutate(self.machine.definition)
        return self.machine

    def test_a_field_this_code_cannot_reproduce_means_no_relay(self):
        for label, mutate in (('top level', lambda d: d.update(supports_parallel_tool_calls=True)),
                              ('startup readiness', lambda d: d.update(startup_readiness='catalog')),
                              ('transport', lambda d: d['transport'].update(experimental_environment='remote'))):
            with self.subTest(label):
                self.change(mutate)
                self.refused('unknown_field')
                self.machine.definition.pop('supports_parallel_tool_calls', None)
                self.machine.definition.pop('startup_readiness', None)
                self.machine.definition['transport'].pop('experimental_environment', None)

    def test_an_environment_name_that_looks_secret_means_no_relay(self):
        for name in ('API_TOKEN', 'my_secret', 'DB_PASSWORD', 'SOME_KEY', 'AUTH_HEADER', 'apikey', 'Oauth_token', 'passwd_secret'):
            with self.subTest(name):
                self.machine.definition['transport']['env'][name] = 'PRIVATE_VALUE'
                self.refused('secret_env')
                del self.machine.definition['transport']['env'][name]

    def test_only_the_bundled_stdio_server_gets_the_relay(self):
        node = self.machine.definition['transport']['command']
        cases = {
            'other command': lambda d: d['transport'].update(command='/usr/bin/node'),
            'other script': lambda d: d['transport'].update(args=['/elsewhere/cua-repl.mjs']),
            'extra argument': lambda d: d['transport'].update(args=d['transport']['args'] + ['--flag']),
            'no argument': lambda d: d['transport'].update(args=[]),
            'other runtime': lambda d: d['transport']['env'].update(CUA_REPL_NODE_REPL_PATH='/elsewhere/proxy.mjs'),
            'runtime missing': lambda d: d['transport']['env'].pop('CUA_REPL_NODE_REPL_PATH'),
            'relative command': lambda d: d['transport'].update(command='node'),
            'other transport': lambda d: d.update(transport={'type': 'streamable_http', 'url': 'https://example.invalid/mcp'}),
            'no transport': lambda d: d.pop('transport'),
            'disabled': lambda d: d.update(enabled=False),
            'disabled with a reason': lambda d: d.update(disabled_reason='requirements'),
            'other name': lambda d: d.update(name='node_repl'),
            'working directory': lambda d: d['transport'].update(cwd='/somewhere'),
            'environment is not text': lambda d: d['transport']['env'].update(NUMBER=1),
            'tool list is not a list': lambda d: d.update(enabled_tools='js'),
            'timeout is not a number': lambda d: d.update(startup_timeout_sec='soon'),
            'timeout is a boolean': lambda d: d.update(tool_timeout_sec=True),
            'env_vars are objects': lambda d: d['transport'].update(env_vars=[{'name': 'PATH', 'source': 'local'}]),
        }
        for label, mutate in cases.items():
            with self.subTest(label):
                machine = Machine(Path(tempfile.mkdtemp(dir=self.temp.name)).resolve())
                mutate(machine.definition)
                plan, reason = machine.plan()
                self.assertIsNone(plan)
                self.assertEqual(reason, 'not_bundled', label)
        self.assertEqual(node, self.machine.definition['transport']['command'])

    def test_a_relay_that_is_already_there_is_not_wrapped_again(self):
        for name in ('CODEX_CUA_NATIVE_RUNTIME', 'CODEX_CUA_RELAY_NODE', 'CODEX_CUA_STATE_DIR'):
            with self.subTest(name):
                self.machine.definition['transport']['env'][name] = '/x'
                self.refused('relay_env_present')
                del self.machine.definition['transport']['env'][name]

    def test_a_missing_or_unsafe_stable_copy_means_no_relay(self):
        shutil.rmtree(self.machine.data)
        self.refused('stable_copy')
        self.assertEqual(len(self.machine.cli.calls), 0, 'the CLI is not even asked')
        self.machine.data.mkdir(mode=0o755)
        self.refused('stable_copy')
        self.machine.data.chmod(0o700)
        shutil.rmtree(self.machine.plugin/'relay')
        self.refused('stable_copy')
        shutil.copytree(PLUGIN_ROOT/'relay', self.machine.plugin/'relay')
        (self.machine.plugin/'relay/relay.mjs').write_text('// cut off here')
        self.refused('stable_copy')
        self.assertFalse((self.machine.data/'relay/relay.mjs').exists(), 'a half-written source never becomes the stable copy')
        shutil.copy(PLUGIN_ROOT/'relay/relay.mjs', self.machine.plugin/'relay/relay.mjs')
        (self.machine.data/'relay').mkdir(mode=0o755)
        self.refused('stable_copy')

    def test_a_launcher_that_others_could_replace_means_no_relay(self):
        self.machine.plan()
        for mode in (0o770, 0o707, 0o777):
            self.machine.launcher.chmod(mode)
            with patch.object(relay_install, 'refresh_relay_files', return_value=self.machine.launcher):
                self.refused('launcher_untrusted')
        self.machine.launcher.chmod(0o700)

    def test_the_native_cli_has_to_belong_to_an_original_app(self):
        stray = self.machine.root/'stray-codex'
        stray.write_text('x')
        stray.chmod(0o700)
        plan, reason = relay_install.plan_relay(stray, APP_ARGUMENTS, self.machine.environment, self.machine.plugin, run=self.machine.cli)
        self.assertEqual((plan, reason), (None, 'not_original_cli'))

    def test_a_cli_that_cannot_answer_means_no_relay(self):
        for number in (1, 2):
            for mode in ('exit', 'timeout', 'oserror', 'garbage', 'list'):
                with self.subTest(call=number, mode=mode):
                    cli = FakeCli(self.machine.definition)
                    cli.fail[number] = mode
                    self.refused('definition_unreadable', cli=cli)

    def test_a_cli_that_reads_the_override_differently_means_no_relay(self):
        cli = FakeCli(self.machine.definition)
        cli.ignore_override = True
        self.refused('override_rejected', cli=cli)
        cli = FakeCli(self.machine.definition)
        cli.alter_env = lambda env: {key: value for key, value in env.items() if key != 'CODEX_CUA_RELAY_NODE'}
        self.refused('override_rejected', cli=cli)
        cli = FakeCli(self.machine.definition)
        cli.alter_env = lambda env: dict(env, EXTRA='x')
        self.refused('override_rejected', cli=cli)

    def test_text_that_toml_cannot_carry_means_no_relay(self):
        for machine_env in (self.machine.definition['transport']['env'], self.machine.entry['env']):
            machine_env['LONE'] = json.loads('"\\ud800"')
        self.machine.write_plugin()
        self.refused('unrepresentable')

    def test_a_launch_without_a_subcommand_is_no_launch(self):
        self.refused('not_a_launch', arguments=['-c', 'features.x=true'])

    def test_nothing_unexpected_escapes(self):
        with patch.object(relay_install, 'bundled_definition', side_effect=RuntimeError('PRIVATE')):
            self.refused('unexpected')

    def test_the_hidden_fields_must_come_from_the_plugin_version_of_this_app(self):
        directory = self.machine.write_plugin()
        manifests = directory/'.codex-plugin/plugin.json'
        mcp = directory/'.mcp.json'
        base = json.loads(mcp.read_text())
        problems = {
            'no plugin cache for this version': lambda: shutil.rmtree(directory),
            'cache of another version only': lambda: (shutil.rmtree(directory), self.machine.write_plugin(directory='other')),
            'manifest of another version': lambda: manifests.write_text(json.dumps({'name': 'unified-computer-use', 'version': 'other'})),
            'manifest of another plugin': lambda: manifests.write_text(json.dumps({'name': 'other', 'version': 'fixture'})),
            'manifest is not json': lambda: manifests.write_text('{'),
            'entry file is not json': lambda: mcp.write_text('{'),
            'entry file has no server': lambda: mcp.write_text(json.dumps({'mcpServers': {}})),
            'entry file others can write': lambda: mcp.chmod(0o666),
            'entry disagrees about the environment': lambda: self.machine.write_plugin(dict(self.machine.entry, env=dict(self.machine.env, CODEX_HOME='/x'))),
            'entry disagrees about the command': lambda: self.machine.write_plugin(dict(self.machine.entry, command='/usr/bin/node')),
            'entry disagrees about the tools': lambda: self.machine.write_plugin(dict(self.machine.entry, enabled_tools=['js'])),
            'entry has a timeout the CLI does not show': lambda: self.machine.write_plugin({k: v for k, v in self.machine.entry.items() if k != 'startup_timeout_sec'}),
            'entry has a field nobody knows': lambda: self.machine.write_plugin(dict(self.machine.entry, supports_parallel_tool_calls=True)),
            'entry has a working directory': lambda: self.machine.write_plugin(dict(self.machine.entry, cwd='.')),
            'tools hold something TOML cannot say': lambda: self.machine.write_plugin(dict(self.machine.entry, tools={'js': {'limit': None}})),
            'omit_tools_from is no list': lambda: self.machine.write_plugin(dict(self.machine.entry, omit_tools_from='deferred')),
        }
        for label, damage in problems.items():
            with self.subTest(label):
                shutil.rmtree(self.machine.codex_home/'plugins', ignore_errors=True)
                self.machine.write_plugin()
                damage()
                self.refused('plugin_entry')
        self.assertEqual(base['mcpServers']['cua_repl']['omit_tools_from'], ['code_mode', 'deferred'])

    def test_the_plugin_has_to_be_where_the_cli_found_it(self):
        self.machine.definition['transport']['env']['CODEX_HOME'] = '/somewhere/else'
        self.refused('plugin_entry')
        self.machine.definition['transport']['env']['CODEX_HOME'] = str(self.machine.codex_home)
        self.machine.definition['transport']['env']['BROWSER_USE_CODEX_APP_VERSION'] = '1.2.3'
        self.refused('plugin_entry')
        self.machine.definition['transport']['env']['BROWSER_USE_CODEX_APP_VERSION'] = 'fixture'
        elsewhere = self.machine.root/'other-codex-home'
        self.machine.definition['transport']['env']['CODEX_HOME'] = str(elsewhere)
        self.machine.entry['env']['CODEX_HOME'] = str(elsewhere)
        self.machine.write_plugin(codex_home=elsewhere)
        plan, reason = self.machine.plan(environment=dict(self.machine.environment, CODEX_HOME=str(elsewhere)))
        self.assertIsNone(reason, 'an explicit CODEX_HOME is followed')


class StableCopyTests(MachineCase):
    def mode(self, path):
        return stat.S_IMODE(path.stat().st_mode)

    def test_the_copy_is_private_complete_and_runnable(self):
        launcher = relay_install.refresh_relay_files(self.machine.plugin, self.machine.data)
        directory = self.machine.data/'relay'
        self.assertEqual(launcher, directory/'node-repl-relay')
        self.assertEqual((self.mode(directory), self.mode(launcher), self.mode(directory/'relay.mjs')), (0o700, 0o700, 0o600))
        for name in ('relay.mjs', 'node-repl-relay'):
            self.assertEqual((directory/name).read_bytes(), (PLUGIN_ROOT/'relay'/name).read_bytes())
        self.assertEqual(sorted(path.name for path in directory.iterdir()), ['node-repl-relay', 'relay.mjs'])
        self.assertEqual(relay_install.relay_files_status(self.machine.data), 'ready')

    def test_a_refresh_leaves_identical_files_alone_and_replaces_changed_ones_atomically(self):
        relay_install.refresh_relay_files(self.machine.plugin, self.machine.data)
        directory = self.machine.data/'relay'
        before = {name: (directory/name).stat().st_ino for name in ('relay.mjs', 'node-repl-relay')}
        relay_install.refresh_relay_files(self.machine.plugin, self.machine.data)
        self.assertEqual(before, {name: (directory/name).stat().st_ino for name in before})
        (directory/'relay.mjs').write_text('stale copy from an older plugin version')
        (directory/'node-repl-relay').chmod(0o755)
        replaced = []
        real = os.replace
        with patch.object(relay_install.os, 'replace', side_effect=lambda a, b: (replaced.append((Path(a).read_bytes(), Path(b).name)), real(a, b))[1]):
            relay_install.refresh_relay_files(self.machine.plugin, self.machine.data)
        # Each file was complete before it was renamed over the old one.
        self.assertEqual(sorted(name for _, name in replaced), ['node-repl-relay', 'relay.mjs'])
        for content, name in replaced:
            self.assertEqual(content, (PLUGIN_ROOT/'relay'/name).read_bytes())
        self.assertEqual(self.mode(directory/'node-repl-relay'), 0o700)
        self.assertEqual(sorted(path.name for path in directory.iterdir()), ['node-repl-relay', 'relay.mjs'])

    def test_a_symbolic_link_in_the_way_is_replaced_not_followed(self):
        directory = self.machine.data/'relay'
        directory.mkdir(mode=0o700)
        outside = self.machine.root/'outside.txt'
        outside.write_text('untouched')
        (directory/'relay.mjs').symlink_to(outside)
        relay_install.refresh_relay_files(self.machine.plugin, self.machine.data)
        self.assertEqual(outside.read_text(), 'untouched')
        self.assertFalse((directory/'relay.mjs').is_symlink())
        self.assertEqual(relay_install.relay_files_status(self.machine.data), 'ready')

    def test_a_refresh_needs_a_private_support_directory_and_a_plain_relay_directory(self):
        self.machine.data.chmod(0o755)
        with self.assertRaises(RelayRefused):
            relay_install.refresh_relay_files(self.machine.plugin, self.machine.data)
        self.machine.data.chmod(0o700)
        elsewhere = self.machine.root/'elsewhere'
        elsewhere.mkdir(mode=0o700)
        (self.machine.data/'relay').symlink_to(elsewhere)
        with self.assertRaises(RelayRefused):
            relay_install.refresh_relay_files(self.machine.plugin, self.machine.data)
        self.assertEqual(list(elsewhere.iterdir()), [])
        shutil.rmtree(self.machine.data)
        with self.assertRaises(RelayRefused):
            relay_install.refresh_relay_files(self.machine.plugin, self.machine.data)
        self.assertFalse(self.machine.data.exists(), 'the support directory is setup\'s to create')

    def test_status_tells_ready_from_missing_from_invalid(self):
        data = self.machine.data
        directory = data/'relay'
        self.assertEqual(relay_install.relay_files_status(data), 'missing')
        relay_install.refresh_relay_files(self.machine.plugin, data)
        self.assertEqual(relay_install.relay_files_status(data), 'ready')
        launcher, script = directory/'node-repl-relay', directory/'relay.mjs'
        broken = {
            'missing': {
                'no launcher': lambda: launcher.unlink(),
                'no script': lambda: script.unlink(),
                'no directory': lambda: shutil.rmtree(directory),
                'empty directory': lambda: [path.unlink() for path in directory.iterdir()],
            },
            'invalid': {
                'script cut off': lambda: script.write_text(script.read_text()[:500]),
                'launcher cut off': lambda: launcher.write_text(launcher.read_text()[:200]),
                'script empty': lambda: script.write_text(''),
                'launcher not executable': lambda: launcher.chmod(0o600),
                'launcher others can write': lambda: launcher.chmod(0o770),
                'script others can write': lambda: script.chmod(0o666),
                'launcher is a directory': lambda: (launcher.unlink(), launcher.mkdir()),
                'script is a link': lambda: (script.unlink(), script.symlink_to(PLUGIN_ROOT/'relay/relay.mjs')),
                'directory open to others': lambda: directory.chmod(0o755),
                'directory is a link': lambda: (shutil.rmtree(directory), directory.symlink_to(self.machine.root)),
            },
        }
        for expected, damages in broken.items():
            for label, damage in damages.items():
                with self.subTest(label):
                    shutil.rmtree(directory, ignore_errors=True) if directory.exists() and not directory.is_symlink() else None
                    if directory.is_symlink():
                        directory.unlink()
                    relay_install.refresh_relay_files(self.machine.plugin, data)
                    damage()
                    self.assertEqual(relay_install.relay_files_status(data), expected)

    def test_removal_takes_the_directory_and_only_that(self):
        relay_install.refresh_relay_files(self.machine.plugin, self.machine.data)
        (self.machine.data/'start-desktop-cli.sh').write_text('keep')
        relay_install.remove_relay_files(self.machine.data)
        self.assertFalse((self.machine.data/'relay').exists())
        self.assertEqual((self.machine.data/'start-desktop-cli.sh').read_text(), 'keep')
        relay_install.remove_relay_files(self.machine.data)             # nothing to remove is fine
        target = self.machine.root/'precious'
        target.mkdir()
        (target/'file').write_text('x')
        (self.machine.data/'relay').symlink_to(target)
        relay_install.remove_relay_files(self.machine.data)
        self.assertFalse((self.machine.data/'relay').is_symlink())
        self.assertEqual((target/'file').read_text(), 'x')


class WriteWatch:
    """Records every place the relay copy code creates, replaces or removes something while it runs."""

    def __init__(self):
        self.paths = []

    def __enter__(self):
        real = {'replace': os.replace, 'mkstemp': tempfile.mkstemp, 'mkdir': Path.mkdir, 'rmtree': shutil.rmtree}
        watch = self

        def replace(source, target, *args, **kwargs):
            watch.paths += [str(source), str(target)]
            return real['replace'](source, target, *args, **kwargs)

        def mkstemp(*args, **kwargs):
            watch.paths.append(str(kwargs.get('dir')))
            return real['mkstemp'](*args, **kwargs)

        def mkdir(path, *args, **kwargs):
            watch.paths.append(str(path))
            return real['mkdir'](path, *args, **kwargs)

        def rmtree(path, *args, **kwargs):
            watch.paths.append(str(path))
            return real['rmtree'](path, *args, **kwargs)
        self.stack = contextlib.ExitStack()
        for owner, name, function in ((os, 'replace', replace), (tempfile, 'mkstemp', mkstemp),
                                      (Path, 'mkdir', mkdir), (shutil, 'rmtree', rmtree)):
            self.stack.enter_context(patch.object(owner, name, function))
        return self

    def __exit__(self, *exc):
        self.stack.close()


class RootInjectionTests(MachineCase):
    """The stable copy goes where the caller says, never to the home directory the process happens to have."""

    def setUp(self):
        super().setUp()
        self.sentinel = self.machine.root/'sentinel-home'          # what a forgotten injection would hit
        self.sentinel.mkdir()
        for patcher in (patch.dict(os.environ, {'HOME': str(self.sentinel)}), patch.object(Path, 'home', return_value=self.sentinel)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def assert_only_inside(self, watch, root):
        self.assertTrue(watch.paths, 'the watch saw nothing, so it proves nothing')
        for path in watch.paths:
            self.assertTrue(path == str(root) or path.startswith(str(root)+os.sep), path+' is outside '+str(root))
        self.assertEqual(list(self.sentinel.iterdir()), [], 'something was written to the default home')

    def test_the_given_support_directory_is_the_only_place_the_copy_is_written(self):
        with WriteWatch() as watch:
            relay_install.refresh_relay_files(self.machine.plugin, self.machine.data)
        self.assert_only_inside(watch, self.machine.data)
        self.assertEqual(relay_install.relay_files_status(self.machine.data), 'ready')
        with WriteWatch() as watch:
            relay_install.remove_relay_files(self.machine.data)
        self.assert_only_inside(watch, self.machine.data)

    def test_setup_and_the_launch_plan_use_the_home_they_are_given(self):
        with WriteWatch() as watch:
            self.assertTrue(setup.install_relay(self.machine.plugin, self.machine.home))
        self.assert_only_inside(watch, self.machine.data)
        shutil.rmtree(self.machine.data/'relay')
        with WriteWatch() as watch:                              # the launcher's environment names the home
            plan, reason = self.machine.plan()
        self.assertIsNone(reason)
        self.assert_only_inside(watch, self.machine.data)
        shutil.rmtree(self.machine.data/'relay')
        other = self.machine.root/'other-home'
        (other/'.local/share/codex-cua').mkdir(parents=True, mode=0o700)
        with WriteWatch() as watch:                              # an explicit home beats the environment
            relay_install.plan_relay(self.machine.native, APP_ARGUMENTS, self.machine.environment, self.machine.plugin,
                                     home=other, run=self.machine.cli)
        self.assert_only_inside(watch, other/'.local/share/codex-cua')
        self.assertFalse((self.machine.data/'relay').exists())

    def test_without_any_root_the_default_home_is_used_and_that_is_what_the_guards_catch(self):
        # Nothing names a home here, so the copy goes where the process home points: the sentinel. This is the
        # fall-back the other tests must never reach; the test runner fails a run in which it happens.
        (self.sentinel/'.local/share/codex-cua').mkdir(parents=True, mode=0o700)
        plan, reason = relay_install.plan_relay(self.machine.native, APP_ARGUMENTS, {'PATH': '/usr/bin'}, self.machine.plugin,
                                                run=self.machine.cli)
        self.assertTrue((self.sentinel/'.local/share/codex-cua/relay/node-repl-relay').is_file())
        self.assertFalse((self.machine.data/'relay').exists())


class TrustedLauncherTests(MachineCase):
    def test_only_a_plain_file_of_this_user_that_nobody_else_can_write(self):
        relay_install.refresh_relay_files(self.machine.plugin, self.machine.data)
        launcher = self.machine.launcher
        self.assertTrue(relay_install.trusted_launcher(launcher))
        launcher.chmod(0o755)
        self.assertTrue(relay_install.trusted_launcher(launcher))
        for mode in (0o775, 0o757, 0o777, 0o722):
            launcher.chmod(mode)
            self.assertFalse(relay_install.trusted_launcher(launcher), oct(mode))
        launcher.chmod(0o600)
        self.assertFalse(relay_install.trusted_launcher(launcher), 'a launcher that cannot run is of no use')
        launcher.chmod(0o700)
        with patch.object(relay_install.os, 'getuid', return_value=os.getuid()+1):
            self.assertFalse(relay_install.trusted_launcher(launcher))
        self.machine.launcher.parent.chmod(0o770)
        self.assertFalse(relay_install.trusted_launcher(launcher))
        self.machine.launcher.parent.chmod(0o700)
        launcher.unlink()
        self.assertFalse(relay_install.trusted_launcher(launcher))
        launcher.symlink_to(PLUGIN_ROOT/'relay/node-repl-relay')
        self.assertFalse(relay_install.trusted_launcher(launcher))
        launcher.unlink()
        launcher.mkdir()
        self.assertFalse(relay_install.trusted_launcher(launcher))


def relay_entry(machine, **changes):
    """What `config/read` shows for the relay, as a config.toml-shaped object."""
    transport = machine.definition['transport']
    env = dict(transport['env'])
    env.update(CUA_REPL_NODE_REPL_PATH=str(machine.launcher), CODEX_CUA_NATIVE_RUNTIME=str(machine.cua/'bin/node_repl'),
               CODEX_CUA_RELAY_NODE=transport['command'])
    entry = {'command': transport['command'], 'args': list(transport['args']), 'env': env, 'enabled': True,
             'omit_tools_from': ['code_mode', 'deferred'], 'tools': {'js': {'output_token_limit': 25000}}}
    entry.update(changes)
    return entry


class TransportTests(MachineCase):
    def check(self, entry):
        return relay_install.transport_is_relay(entry, self.machine.cua, self.machine.launcher)

    def test_the_exact_relay_is_accepted(self):
        self.assertTrue(self.check(relay_entry(self.machine)))
        entry = relay_entry(self.machine)
        self.assertTrue(self.check({'transport': {'type': 'stdio', **{k: entry[k] for k in ('command', 'args', 'env')}}}),
                        'the nested shape of `mcp get` is understood too')

    def test_look_alikes_are_not(self):
        machine = self.machine
        env = lambda **changes: dict(relay_entry(machine)['env'], **changes)
        cases = {
            'other launcher': relay_entry(machine, env=env(CUA_REPL_NODE_REPL_PATH=str(machine.data/'relay/other'))),
            'launcher beside the real one': relay_entry(machine, env=env(CUA_REPL_NODE_REPL_PATH=str(machine.data/'relay/../relay/./node-repl-relay.sh'))),
            'bundled runtime itself (no relay)': relay_entry(machine, env=env(CUA_REPL_NODE_REPL_PATH=str(machine.cua/'bin/node_repl'))),
            'other native runtime': relay_entry(machine, env=env(CODEX_CUA_NATIVE_RUNTIME='/elsewhere/node_repl')),
            'native runtime missing': relay_entry(machine, env={k: v for k, v in env().items() if k != 'CODEX_CUA_NATIVE_RUNTIME'}),
            'native runtime is the launcher': relay_entry(machine, env=env(CODEX_CUA_NATIVE_RUNTIME=str(machine.launcher))),
            'other node': relay_entry(machine, env=env(CODEX_CUA_RELAY_NODE='/usr/bin/node')),
            'other command': relay_entry(machine, command='/usr/bin/node'),
            'other script': relay_entry(machine, args=['/elsewhere/cua-repl.mjs']),
            'extra argument': relay_entry(machine, args=relay_entry(machine)['args'] + ['--x']),
            'no environment': relay_entry(machine, env=None),
            'arguments are not text': relay_entry(machine, args=[1]),
            'a string': 'relay',
            'nothing': None,
            'a list': [],
        }
        for label, entry in cases.items():
            with self.subTest(label):
                self.assertFalse(self.check(entry))

    def test_paths_that_name_the_same_files_are_the_same(self):
        link = self.machine.root/'alias'
        link.symlink_to(self.machine.cua)
        entry = relay_entry(self.machine)
        entry['command'] = str(link/'bin/node')
        entry['env']['CODEX_CUA_RELAY_NODE'] = str(link/'bin/node')
        entry['env']['CODEX_CUA_NATIVE_RUNTIME'] = str(link/'bin/node_repl')
        self.assertTrue(self.check(entry))


class FakeAdapter:
    def __init__(self, machine, socket_path):
        self.native_cua_root = machine.cua
        self.rpc = SimpleNamespace(socket_path=socket_path)


class AcceptRelayTests(MachineCase):
    def setUp(self):
        super().setUp()
        relay_install.refresh_relay_files(self.machine.plugin, self.machine.data)
        self.state = self.machine.root/'host-state'
        self.state.mkdir(mode=0o700)
        self.socket = '/private/tmp/host/run-1/rpc.sock'
        self.adapter = FakeAdapter(self.machine, Path(self.socket))
        patcher = patch.dict(os.environ, {'CODEX_HOST_CUA_STATE_DIR': str(self.state)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def registry(self, **changes):
        record = {'schema_version': 1, 'status': 'ready', 'relay': True, 'relay_launcher': str(self.machine.launcher),
                  'socket_path': self.socket, 'mechanism': 'original_app_server_unix_websocket'}
        record.update(changes)
        path = self.state/'host.json'
        path.write_text(json.dumps(record))
        path.chmod(0o600)

    def accept(self, answer, adapter=None, selected=None):
        asked = []

        async def request(method, params):
            asked.append((method, params))
            if isinstance(answer, Exception):
                raise answer
            return answer
        result = asyncio.run(relay_install.accept_relay(adapter or self.adapter, request, {'pluginId': None} if selected is None else selected,
                                                        home=self.machine.home))
        return result, asked

    def test_config_read_that_shows_the_relay_is_enough(self):
        accepted, asked = self.accept({'config': {'mcp_servers': {'cua_repl': relay_entry(self.machine)}}})
        self.assertTrue(accepted)
        self.assertEqual(asked, [('config/read', {'includeLayers': False})])

    def test_config_read_that_shows_something_else_is_final(self):
        self.registry()       # a registry that says "relay" cannot overrule what the host reports
        for entry in (relay_entry(self.machine, command='/usr/bin/node'),
                      relay_entry(self.machine, env=dict(relay_entry(self.machine)['env'], CODEX_CUA_NATIVE_RUNTIME='/elsewhere/node_repl')),
                      relay_entry(self.machine, env=dict(relay_entry(self.machine)['env'], CUA_REPL_NODE_REPL_PATH=str(self.machine.data/'relay/other'))),
                      'garbage'):
            with self.subTest(entry=str(entry)[:40]):
                self.assertFalse(self.accept({'config': {'mcp_servers': {'cua_repl': entry}}})[0])

    def test_a_host_that_does_not_show_the_server_is_judged_by_the_registry(self):
        shown_nothing = (None, {}, {'config': None}, {'config': {}}, {'config': {'mcp_servers': {}}},
                         {'config': {'mcp_servers': {'cua_repl': None}}}, {'config': {'mcp_servers': {'other': {}}}},
                         RuntimeError('config/read is not supported'))
        self.registry()
        for answer in shown_nothing:
            with self.subTest(answer=repr(answer)[:50]):
                self.assertTrue(self.accept(answer)[0])

    def test_the_registry_has_to_name_this_relay_on_this_host(self):
        for changes in ({'relay': False}, {'relay': 'yes'}, {'relay_launcher': str(self.machine.data/'relay/other')},
                        {'relay_launcher': None}, {'socket_path': '/private/tmp/host/run-2/rpc.sock'}, {'status': 'closed'},
                        {'status': 'stopping', 'stopping_at': '2026-10-21T00:00:00Z'}, {'schema_version': 2}):
            with self.subTest(changes=changes):
                self.registry(**changes)
                self.assertFalse(self.accept(None)[0])
        record = json.loads((self.state/'host.json').read_text())
        record.pop('relay')
        (self.state/'host.json').write_text(json.dumps(record))
        self.assertFalse(self.accept(None)[0], 'a registry without the flag means no relay')

    def test_an_unreadable_or_unsafe_registry_is_no_evidence(self):
        self.assertFalse(self.accept(None)[0])                         # none at all
        self.registry()
        (self.state/'host.json').chmod(0o644)
        self.assertFalse(self.accept(None)[0])
        (self.state/'host.json').chmod(0o600)
        self.state.chmod(0o755)
        self.assertFalse(self.accept(None)[0])
        self.state.chmod(0o700)
        (self.state/'host.json').write_text('{')
        self.assertFalse(self.accept(None)[0])

    def test_the_launcher_has_to_be_a_file_only_this_user_can_write(self):
        entry = {'config': {'mcp_servers': {'cua_repl': relay_entry(self.machine)}}}
        self.registry()
        for mode in (0o775, 0o757, 0o777):
            self.machine.launcher.chmod(mode)
            self.assertFalse(self.accept(entry)[0], oct(mode))
            self.assertFalse(self.accept(None)[0], oct(mode))
        self.machine.launcher.chmod(0o700)
        self.assertTrue(self.accept(entry)[0])
        outside = self.machine.root/'outside-launcher'
        outside.write_text('#!/bin/sh\n')
        outside.chmod(0o700)
        self.machine.launcher.unlink()
        self.machine.launcher.symlink_to(outside)
        self.assertFalse(self.accept(entry)[0], 'a link is not a regular file')
        self.assertFalse(self.accept(None)[0])
        self.machine.launcher.unlink()
        self.assertFalse(self.accept(entry)[0], 'no launcher at all')

    def test_a_server_that_reports_a_plugin_is_never_the_relay(self):
        shown = {'config': {'mcp_servers': {'cua_repl': relay_entry(self.machine)}}}
        self.registry()
        for plugin in ('unrelated-plugin@market', 'unified-computer-use@somewhere-else', ''):
            accepted, asked = self.accept(shown, selected={'name': 'cua_repl', 'pluginId': plugin})
            self.assertFalse(accepted, plugin)
            self.assertEqual(asked, [], 'the host is not even asked')
        self.assertTrue(self.accept(shown, selected={'name': 'cua_repl'})[0], 'a server without any plugin id is judged by its transport')

    def test_the_answer_is_asked_for_once_per_boot_and_not_on_every_pass(self):
        shown = {'config': {'mcp_servers': {'cua_repl': relay_entry(self.machine)}}}
        asked = []

        def new_boot():
            async def request(method, params):                  # every boot has its own request function
                asked.append(method)
                return shown
            return request

        async def passes(request):
            return [await relay_install.accept_relay(self.adapter, request, {'pluginId': None}, home=self.machine.home) for _ in range(5)]
        first = new_boot()
        self.assertEqual(asyncio.run(passes(first)), [True]*5)
        self.assertEqual(asked, ['config/read'])
        shown['config']['mcp_servers']['cua_repl'] = relay_entry(self.machine, command='/usr/bin/node')
        self.assertEqual(asyncio.run(passes(first)), [True]*5, 'the same boot keeps its answer')
        self.assertEqual(asked, ['config/read'])
        self.assertEqual(asyncio.run(passes(new_boot())), [False]*5, 'the next boot decides again')
        self.assertEqual(asked, ['config/read', 'config/read'])

    def test_without_a_verified_bundled_runtime_nothing_is_accepted(self):
        adapter = FakeAdapter(self.machine, Path(self.socket))
        adapter.native_cua_root = None
        accepted, asked = self.accept({'config': {'mcp_servers': {'cua_repl': relay_entry(self.machine)}}}, adapter)
        self.assertFalse(accepted)
        self.assertEqual(asked, [], 'the host is not even asked')

    def test_another_runtime_root_is_another_runtime(self):
        other = FakeAdapter(self.machine, Path(self.socket))
        other.native_cua_root = self.machine.root/'other/cua_node'
        self.assertFalse(self.accept({'config': {'mcp_servers': {'cua_repl': relay_entry(self.machine)}}}, other)[0])



class RelayThreadServerTests(MachineCase):
    """What a Claude bridge gives its own thread: the launcher's verified table from the host record, with its name."""

    def setUp(self):
        super().setUp()
        plan, reason = self.machine.plan()
        self.assertIsNone(reason)
        self.table = plan.table
        self.owner = 'bridge-4242-1792345678'

    def registry(self, **changes):
        record = {'schema_version': 1, 'status': 'ready', 'relay': True, 'relay_launcher': str(self.machine.launcher),
                  'relay_config': copy.deepcopy(self.table)}
        record.update(changes)
        return record

    def server(self, registry=Ellipsis, owner=None, cua_root=Ellipsis):
        return relay_install.relay_thread_server(self.registry() if registry is Ellipsis else registry,
                                                 self.machine.cua if cua_root is Ellipsis else cua_root,
                                                 owner, home=self.machine.home)

    def test_the_table_is_the_override_of_the_launcher(self):
        _, value = parse_override(self.machine.plan()[0].override)
        self.assertEqual(self.table, value)

    def test_the_bridge_gets_the_table_with_its_name_in_the_relay_environment_only(self):
        server = self.server(owner=self.owner)
        expected = copy.deepcopy(self.table)
        expected['env']['CODEX_CUA_OWNER'] = self.owner
        self.assertEqual(server, expected)
        registry = self.registry()
        self.server(registry, owner=self.owner)['env']['CHANGED'] = 'x'
        self.assertEqual(registry['relay_config'], self.table, 'the record is never changed')

    def test_a_name_that_is_not_a_bridge_name_is_left_out(self):
        for owner in (None, '', 'relay-1-2', 'bridge-1-2 extra', 42):
            self.assertEqual(self.server(owner=owner), self.table, owner)

    def test_anything_short_of_the_verified_relay_of_this_home_means_no_relay(self):
        other = self.machine.data/'relay/other'
        changed = copy.deepcopy(self.table)
        changed['env']['CUA_REPL_NODE_REPL_PATH'] = str(other)
        native = copy.deepcopy(self.table)
        native['command'] = '/usr/bin/node'
        for registry in (self.registry(relay=False), self.registry(relay='yes'), self.registry(relay_launcher=str(other)),
                         self.registry(relay_launcher=None), self.registry(relay_config=None),
                         self.registry(relay_config=[1, 2]), self.registry(relay_config=changed),
                         self.registry(relay_config=native), {}, None, 'host'):
            self.assertIsNone(self.server(registry, owner=self.owner), registry)
        self.assertIsNone(self.server(owner=self.owner, cua_root=None))
        self.assertIsNone(self.server(owner=self.owner, cua_root=self.machine.root/'other/cua_node'))

    def test_a_launcher_others_can_write_is_not_used(self):
        self.machine.launcher.chmod(0o777)
        self.assertIsNone(self.server(owner=self.owner))


if __name__ == '__main__':
    unittest.main()
