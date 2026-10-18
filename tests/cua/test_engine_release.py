"""Targeted release of a session whose owner is gone: one browser call under that session, then the end of that turn."""
import json
import os
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch
import uuid

import engine_release
import engine_status
import host_mcp
from engine_support import DECOY, NOW, OWN_THREAD, SESSION_A, SESSION_C, SESSION_D, EngineCase, FakeHost, State, at

FAST = {'boot': 0.5, 'call': 0.5, 'end': 0.5, 'cleanup': 0.5}


async def counts_three(params):
    return {'content': [{'type': 'text', 'text': DECOY+'\n@@count 3\n'+DECOY}]}


async def ends_quietly(params):
    return {'content': [{'type': 'text', 'text': '{}'}]}


class ReleaseCase(EngineCase):
    def setUp(self):
        super().setUp()
        self.start_world()
        self.host_socket()
        self.script = self.chrome_plugin()
        self.hosts = []
        self.tools = {'js': counts_three, 'turn_ended': ends_quietly}

        async def connect(**kwargs):
            host = FakeHost(self.tools)
            self.hosts.append(host)
            return host
        patcher = patch.object(host_mcp, 'unix_connect', AsyncMock(side_effect=connect))
        self.connect = patcher.start()
        self.addCleanup(patcher.stop)

    def dead(self, name='d1', pid=7001, session=SESSION_C, kind='bridge', last=1000, **fields):
        builder = self.state.bridge if kind == 'bridge' else self.state.relay
        return builder(name, pid, NOW-5000, cwd='/work/dead', scopes=[State.scope(session, last=at(last))],
                       cleanup='open', **fields)

    def release(self, sessions, user=False, **options):
        return engine_release.release_sessions(self.context(), sessions, user=user, options=dict(FAST, **options))

    def calls(self):
        [host] = self.hosts
        return host.calls


class SuccessTests(ReleaseCase):
    def test_one_browser_call_under_the_dead_session_then_the_end_of_that_turn(self):
        directory = self.dead()
        result = self.release([SESSION_C])[SESSION_C]
        self.assertEqual(result, {'released': True, 'reason': None, 'tab_count': 3})
        [host] = self.hosts
        js, ended, *own = host.calls
        turn = js['_meta']['x-codex-turn-metadata']['turn_id']
        self.assertEqual(str(uuid.UUID(turn)), turn)
        self.assertEqual(uuid.UUID(turn).version, 4)
        meta = {'thread_id': OWN_THREAD, 'threadId': OWN_THREAD,
                'x-codex-turn-metadata': {'session_id': SESSION_C, 'turn_id': turn}}
        self.assertEqual(js, {'threadId': OWN_THREAD, 'server': 'cua_repl', 'tool': 'js', '_meta': meta,
                              'arguments': {'code': engine_release.release_code(self.script.resolve()),
                                            'title': engine_release.TITLE}})
        self.assertEqual(ended, {'threadId': OWN_THREAD, 'server': 'cua_repl', 'tool': 'turn_ended', '_meta': meta,
                                 'arguments': {'hook_event_name': 'Stop', 'session_id': SESSION_C, 'turn_id': turn}})
        # Whatever the short-lived thread does for itself when it leaves concerns its own session only.
        self.assertTrue(all(call['arguments']['session_id'] == OWN_THREAD for call in own))
        methods = [message.get('method') for message in host.received]
        self.assertEqual(methods[:4], ['initialize', 'initialized', 'thread/start', 'mcpServerStatus/list'])
        self.assertEqual(methods[-1], 'thread/unsubscribe')
        self.assertEqual([message['params'] for message in host.received if message.get('method') == 'thread/start'],
                         [{'ephemeral': True, 'cwd': os.getcwd()}])
        self.assertTrue(host.closed)
        self.assertFalse(directory.exists())          # the record held nothing else

    def test_only_the_count_leaves_the_engine(self):
        self.dead()
        result = engine_release.release_session_command(self.context(), SESSION_C, options=FAST)
        self.assertEqual(result, {'ok': True, 'released': True, 'reason': None, 'tab_count': 3})
        printed = json.dumps(result)
        for secret in ('TITLE_SENTINEL', 'SECRET_SENTINEL', 'private.example', 'https'):
            self.assertNotIn(secret, printed)

    def test_the_code_only_counts_tabs_and_names_no_session_or_page(self):
        code = engine_release.release_code(Path('/plugin root/scripts/browser-client.mjs'))
        self.assertEqual(code.count('import('), 1)
        self.assertIn('import("/plugin root/scripts/browser-client.mjs")', code)
        self.assertIn('agent.browsers.get("chrome")', code)
        self.assertIn('nodeRepl.write("@@count " + (await c.tabs.list()).length);', code)
        for forbidden in ('url', 'title', 'screenshot', 'claimTab', 'close', 'goto', SESSION_C):
            self.assertNotIn(forbidden, code)
        tricky = engine_release.release_code(Path('/a"b\\c\n/scripts/browser-client.mjs'))
        self.assertIn(r'import("/a\"b\\c\n/scripts/browser-client.mjs")', tricky)

    def test_several_sessions_share_one_short_lived_thread_and_each_gets_its_own_turn(self):
        self.dead('d1', 7001, SESSION_C)
        self.dead('d2', 7002, SESSION_D)
        results = self.release([SESSION_C, SESSION_D])
        self.assertEqual({key: value['released'] for key, value in results.items()}, {SESSION_C: True, SESSION_D: True})
        self.assertEqual(len(self.hosts), 1)
        calls = self.calls()
        pairs = [(call['tool'], call['_meta']['x-codex-turn-metadata']['session_id']) for call in calls]
        self.assertEqual(pairs[:4], [('js', SESSION_C), ('turn_ended', SESSION_C), ('js', SESSION_D), ('turn_ended', SESSION_D)])
        turns = {call['_meta']['x-codex-turn-metadata']['turn_id'] for call in calls[:4]}
        self.assertEqual(len(turns), 2)
        self.assertEqual(self.state.names('bridge'), [])

    def test_the_scopes_of_the_released_session_leave_every_dead_record_and_the_rest_stays(self):
        both = self.state.bridge('d1', 7001, NOW-5000, scopes=[State.scope(SESSION_C), State.scope(SESSION_D)], cleanup='open')
        relay = self.dead('d2', 7101, SESSION_C, kind='relay')
        self.release([SESSION_C])
        self.assertEqual([item['session_id'] for item in json.loads((both/'bridge.json').read_text())['scopes']], [SESSION_D])
        self.assertFalse(relay.exists())

    def test_a_failure_leaves_the_records_alone(self):
        directory = self.dead()
        self.tools['turn_ended'] = AsyncMock(return_value={'isError': True, 'content': []})
        self.assertFalse(self.release([SESSION_C])[SESSION_C]['released'])
        self.assertEqual(len(json.loads((directory/'bridge.json').read_text())['scopes']), 1)


class RefusalTests(ReleaseCase):
    def refused(self, session, user=False):
        result = self.release([session], user=user)[session]
        self.assertEqual(self.hosts, [], 'a refused session must not even connect to the host')
        self.assertFalse(result['released'])
        return result['reason']

    def test_a_session_nobody_recorded_is_not_found(self):
        self.assertEqual(self.refused(SESSION_A), 'not_found')

    def test_a_session_id_that_is_not_one_is_not_found(self):
        for bad in ('', '../../etc', 'x'*300, 'a b', None, 5):
            self.assertEqual(self.release([bad])[bad]['reason'], 'not_found')
        self.assertEqual(self.hosts, [])

    def test_a_session_whose_scopes_are_all_closed_is_not_found(self):
        self.state.bridge('d1', 7001, NOW-5000, session_id=SESSION_C, scopes=[])
        self.assertEqual(self.refused(SESSION_C), 'not_found')

    def test_a_session_that_ended_before_chrome_started_is_not_found(self):
        self.dead(last=1000)
        self.machine.add(5000, 1, self.commands.chrome, start=NOW-100)
        self.assertEqual(self.refused(SESSION_C), 'not_found')

    def test_a_session_a_live_record_lists_is_live(self):
        self.dead()
        self.add_runtime(2000, NOW-890)
        self.state.relay('r1', 2001, NOW-890, root_pid=2000, runtime_pid=2002, scopes=[State.scope(SESSION_C)])
        self.assertEqual(self.refused(SESSION_C), 'session_live')
        self.assertEqual(self.refused(SESSION_C, user=True), 'session_live')

    def test_the_current_session_of_a_live_bridge_is_live_even_with_no_open_scope(self):
        self.dead()
        self.add_claude(500)
        self.add_bridge(4242, 500, NOW-900)
        self.state.bridge('a1', 4242, NOW-900, owner_pid=500, session_id=SESSION_C)
        self.assertEqual(self.refused(SESSION_C), 'session_live')

    def test_a_live_session_is_refused_even_when_no_dead_record_lists_it(self):
        self.add_runtime(2000, NOW-890)
        self.state.relay('r1', 2001, NOW-890, root_pid=2000, runtime_pid=2002, scopes=[State.scope(SESSION_C)])
        self.assertEqual(self.refused(SESSION_C), 'session_live')

    def test_a_codex_thread_session_needs_the_users_click(self):
        self.dead('d2', 7101, SESSION_D, kind='relay')
        self.assertEqual(self.refused(SESSION_D), 'needs_user')
        self.assertTrue(self.release([SESSION_D], user=True)[SESSION_D]['released'])

    def test_a_session_a_dead_bridge_also_lists_does_not_need_the_click(self):
        self.dead('d1', 7001, SESSION_C)
        self.dead('d2', 7101, SESSION_C, kind='relay')
        self.assertTrue(self.release([SESSION_C])[SESSION_C]['released'])

    def test_a_session_that_became_live_while_the_host_was_connecting_is_refused_before_any_call(self):
        self.dead()

        def a_relay_takes_the_session():
            self.add_runtime(2000, NOW-890)
            self.state.relay('r1', 2001, NOW-890, root_pid=2000, runtime_pid=2002, scopes=[State.scope(SESSION_C)])

        async def connect(**kwargs):
            host = FakeHost(self.tools)
            host.hooks['mcpServerStatus/list'] = a_relay_takes_the_session
            self.hosts.append(host)
            return host
        self.connect.side_effect = connect
        result = self.release([SESSION_C])[SESSION_C]
        self.assertEqual(result['reason'], 'session_live')
        # Nothing was called under the session; at most the short-lived thread ended its own turn.
        self.assertTrue(all(call['arguments']['session_id'] == OWN_THREAD for call in self.hosts[0].calls))


class OldHostScopeTests(ReleaseCase):
    """The same bridge on its second host: session D is its own, session C is what it left on the first."""
    WRITER = 'bridge-4242-%d' % (NOW-900)

    def live_bridge(self):
        self.add_claude(500)
        self.add_bridge(4242, 500, NOW-900)
        return self.state.bridge('a1', 4242, NOW-900, owner_pid=500, cwd='/work/x', session_id=SESSION_D, cleanup='open',
                                 scopes=[State.scope(SESSION_C, first=at(2000), last=at(1900)), State.scope(SESSION_D)])

    def test_the_current_session_is_live_and_the_older_scope_is_released_without_the_users_click(self):
        self.live_bridge()
        results = self.release([SESSION_D, SESSION_C])
        self.assertEqual(results[SESSION_D], {'released': False, 'reason': 'session_live', 'tab_count': None})
        self.assertEqual(results[SESSION_C], {'released': True, 'reason': None, 'tab_count': 3})
        sessions = {call['_meta']['x-codex-turn-metadata']['session_id'] for call in self.calls() if call['tool'] == 'js'}
        self.assertEqual(sessions, {SESSION_C})

    def test_the_release_is_remembered_the_live_record_is_left_alone_and_it_is_never_repeated(self):
        directory = self.live_bridge()
        before = (directory/'bridge.json').read_bytes()
        self.assertTrue(self.release([SESSION_C])[SESSION_C]['released'])
        self.assertEqual((directory/'bridge.json').read_bytes(), before)
        data = json.loads((self.state.root/'engine-released.json').read_text())
        self.assertEqual([(item['writer'], item['session_id']) for item in data['released']], [(self.WRITER, SESSION_C)])
        self.assertEqual(oct((self.state.root/'engine-released.json').stat().st_mode & 0o777), '0o600')
        hosts = len(self.hosts)
        self.assertEqual(self.release([SESSION_C])[SESSION_C]['reason'], 'not_found')
        self.assertEqual(len(self.hosts), hosts)                                       # no connection, no browser call

    def test_a_failed_release_is_not_remembered_and_can_be_tried_again(self):
        self.live_bridge()
        self.tools['turn_ended'] = AsyncMock(return_value={'isError': True, 'content': []})
        self.assertEqual(self.release([SESSION_C])[SESSION_C]['reason'], 'cleanup_not_confirmed')
        self.assertFalse((self.state.root/'engine-released.json').exists())
        self.tools['turn_ended'] = ends_quietly
        self.assertTrue(self.release([SESSION_C])[SESSION_C]['released'])

    def test_a_session_a_live_relay_serves_is_live_whoever_else_lists_it(self):
        self.live_bridge()
        self.add_runtime(2000, NOW-890)
        self.state.relay('r1', 2001, NOW-890, root_pid=2000, runtime_pid=2002, scopes=[State.scope(SESSION_C)])
        self.assertEqual(self.release([SESSION_C])[SESSION_C]['reason'], 'session_live')
        self.assertEqual(self.hosts, [])


class HostTests(ReleaseCase):
    def test_no_host_is_not_running_and_nothing_is_started(self):
        self.dead()
        self.machine.remove(1200)
        result = self.release([SESSION_C])[SESSION_C]
        self.assertEqual(result, {'released': False, 'reason': 'not_running', 'tab_count': None})
        self.assertEqual((self.hosts, self.machine.commands[-1][0]), ([], '/bin/ps'))
        (self.host_dir/'host.json').unlink()
        self.assertEqual(self.release([SESSION_C])[SESSION_C]['reason'], 'not_running')

    def test_a_socket_that_cannot_be_reached_is_not_running(self):
        self.dead()
        (self.host_dir/'run/rpc.sock').unlink()
        self.assertEqual(self.release([SESSION_C])[SESSION_C]['reason'], 'not_running')

    def test_a_host_that_refuses_the_thread_cannot_confirm(self):
        self.dead()

        async def connect(**kwargs):
            host = FakeHost(self.tools)
            host.errors['thread/start'] = {'code': -32000, 'message': 'no'}
            self.hosts.append(host)
            return host
        self.connect.side_effect = connect
        self.assertEqual(self.release([SESSION_C])[SESSION_C], {'released': False, 'reason': 'cleanup_not_confirmed', 'tab_count': None})

    def test_a_host_that_does_not_answer_in_time_is_a_timeout(self):
        self.dead()

        async def connect(**kwargs):
            host = FakeHost(self.tools)
            host.hang.add('initialize')
            self.hosts.append(host)
            return host
        self.connect.side_effect = connect
        self.assertEqual(self.release([SESSION_C], boot=0.3)[SESSION_C]['reason'], 'timeout')

    def test_a_server_that_is_not_the_bundled_cua_is_not_used(self):
        self.dead()

        async def connect(**kwargs):
            host = FakeHost(self.tools, plugin_id='something-else')
            self.hosts.append(host)
            return host
        self.connect.side_effect = connect
        result = self.release([SESSION_C])[SESSION_C]
        self.assertEqual((result['released'], result['reason']), (False, 'cleanup_not_confirmed'))
        self.assertEqual(self.hosts[0].calls, [])          # nothing was ever called on it


class MechanismFailureTests(ReleaseCase):
    def test_without_the_chrome_plugin_a_targeted_release_is_unsupported(self):
        self.dead()
        self.script.unlink()
        self.assertEqual(self.release([SESSION_C])[SESSION_C], {'released': False, 'reason': 'unsupported', 'tab_count': None})
        self.assertEqual(self.hosts, [])

    def test_the_apps_own_copy_of_the_plugin_is_the_fallback(self):
        self.dead()
        self.script.unlink()
        bundled = self.app/'Contents/Resources/plugins/openai-bundled/plugins/chrome/scripts/browser-client.mjs'
        bundled.parent.mkdir(parents=True)
        bundled.write_text('// bundled')
        os.chmod(bundled, 0o644)
        self.assertTrue(self.release([SESSION_C])[SESSION_C]['released'])
        self.assertIn(str(bundled), self.calls()[0]['arguments']['code'])

    def test_a_script_other_users_can_write_is_not_imported(self):
        self.dead()
        os.chmod(self.script, 0o664)
        self.assertEqual(self.release([SESSION_C])[SESSION_C]['reason'], 'unsupported')

    def test_an_app_version_that_would_climb_out_of_the_cache_folder_is_not_used(self):
        self.dead()
        import plistlib
        plist = self.app/'Contents/Info.plist'
        info = plistlib.loads(plist.read_bytes())
        info['CFBundleShortVersionString'] = '../chrome/'+info['CFBundleShortVersionString']
        plist.write_bytes(plistlib.dumps(info))
        self.assertEqual(self.release([SESSION_C])[SESSION_C]['reason'], 'unsupported')

    def test_a_browser_call_that_fails_or_prints_no_count_is_unsupported_and_the_pair_is_not_ended(self):
        directory = self.dead()
        for result in ({'isError': True, 'content': [{'type': 'text', 'text': '@@count 2'}]},
                       {'content': [{'type': 'text', 'text': 'Error running code: ReferenceError'}]},
                       {'content': [{'type': 'image', 'data': 'x'}]}, 'text'):
            self.hosts.clear()
            self.tools['js'] = AsyncMock(return_value=result)
            self.assertEqual(self.release([SESSION_C])[SESSION_C], {'released': False, 'reason': 'unsupported', 'tab_count': None})
            self.assertTrue(all(call['arguments'].get('session_id') == OWN_THREAD
                                for call in self.hosts[0].calls if call['tool'] == 'turn_ended'))
        self.assertTrue(directory.exists())

    def test_the_host_answering_with_an_error_cannot_confirm(self):
        self.dead()

        async def refuses(params):
            return {'__error__': {'code': -32000, 'message': 'PRIVATE_NATIVE_ERROR'}}
        self.tools['js'] = refuses
        result = self.release([SESSION_C])[SESSION_C]
        self.assertEqual((result['released'], result['reason']), (False, 'cleanup_not_confirmed'))
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_a_browser_call_that_never_returns_times_out_but_the_pair_is_still_ended_on_a_best_effort_basis(self):
        directory = self.dead()

        async def hangs(params):
            import asyncio
            await asyncio.sleep(3600)
        self.tools['js'] = hangs
        result = self.release([SESSION_C], call=0.2)[SESSION_C]
        self.assertEqual(result, {'released': False, 'reason': 'timeout', 'tab_count': None})
        foreign = [call for call in self.calls() if call['_meta']['x-codex-turn-metadata']['session_id'] == SESSION_C]
        self.assertEqual([call['tool'] for call in foreign], ['js', 'turn_ended'])
        self.assertTrue(directory.exists())

    def test_an_end_of_turn_that_is_refused_or_times_out_keeps_the_count_and_the_record(self):
        directory = self.dead()
        self.tools['turn_ended'] = AsyncMock(return_value={'isError': True, 'content': []})
        result = self.release([SESSION_C])[SESSION_C]
        self.assertEqual(result, {'released': False, 'reason': 'cleanup_not_confirmed', 'tab_count': 3})

        async def hangs(params):
            import asyncio
            await asyncio.sleep(3600)
        self.hosts.clear()
        self.tools['turn_ended'] = hangs
        result = self.release([SESSION_C], end=0.2)[SESSION_C]
        self.assertEqual(result, {'released': False, 'reason': 'timeout', 'tab_count': 3})
        self.assertTrue(directory.exists())

    def test_one_failing_session_does_not_stop_the_others(self):
        self.dead('d1', 7001, SESSION_C)
        self.dead('d2', 7002, SESSION_D)

        async def js(params):
            if params['_meta']['x-codex-turn-metadata']['session_id'] == SESSION_C:
                return {'isError': True, 'content': []}
            return await counts_three(params)
        self.tools['js'] = js
        results = self.release([SESSION_C, SESSION_D])
        self.assertEqual((results[SESSION_C]['reason'], results[SESSION_D]['released']), ('unsupported', True))
        self.assertEqual(self.state.names('bridge'), ['bridge-d1'])


class BoundaryTests(ReleaseCase):
    def test_status_never_runs_a_targeted_release_or_touches_the_host(self):
        self.dead()
        with patch.object(engine_release, 'release_sessions', side_effect=AssertionError('not from status')):
            engine_status.status(self.context())
        self.connect.assert_not_called()

    def test_the_mcp_entry_points_know_nothing_of_the_engine(self):
        plugin = Path(engine_release.__file__).parent
        for name in ('host_mcp.py', 'mcp_stdio.py', 'bridge_control.py'):
            text = (plugin/name).read_text()
            self.assertNotIn('engine_', text, name)
            self.assertNotIn('release_session', text, name)


if __name__ == '__main__':
    unittest.main()
