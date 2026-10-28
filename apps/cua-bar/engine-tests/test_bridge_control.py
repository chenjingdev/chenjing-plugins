"""The record owner and control endpoint on their own, against a stand-in adapter: where they live and what they refuse.

How they behave with a real connection, scopes and releases is in test_bridge_lifecycle.py.
"""
import asyncio
import json
import os
from pathlib import Path
import signal
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import bridge_control


class Adapter:
    """Just what BridgeControl needs from the connection."""
    def __init__(self, cleanup='none'):
        self.active_tool_calls, self.scopes = 0, {}
        self.on_change = self.on_call = None
        self.cleanup, self.released = cleanup, []

    def snapshot(self):
        return {'host': None, 'session_id': None, 'turn_id': None, 'connected_at': None, 'last_call_at': None,
                'busy': self.active_tool_calls > 0, 'scopes': [], 'cleanup': self.cleanup}

    async def release_scopes(self, wait=None, budget=None):
        self.released.append((wait, budget))
        return {'released': True, 'reason': None, 'scope_count': 1}


class ControlTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # A short path: the control socket lives inside it and Unix socket paths are limited to 104 bytes.
        self.temp = tempfile.TemporaryDirectory(dir='/tmp', prefix='bc')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root/'home'
        self.home.mkdir()
        environment = patch.dict(os.environ, {'HOME': str(self.home)})
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop('CODEX_CUA_STATE_DIR', None)

    async def started(self, **options):
        control = bridge_control.BridgeControl(Adapter(), **options)
        await control.start()
        self.addAsyncCleanup(control.finalize)
        return control

    async def test_a_refused_browser_is_noted_in_the_state_folder_as_a_release_does(self):
        control = await self.started()
        self.assertEqual(control.adapter.on_browser_blocked, control.record_browser_blocked)
        control.record_browser_blocked('26.1023.50603')
        note = json.loads((control.state/'browser-blocked.json').read_text())
        self.assertEqual((note['schema_version'], note['app_version']), (1, '26.1023.50603'))
        (control.state/'browser-blocked.json').unlink()
        control.record_browser_blocked(None)
        self.assertFalse((control.state/'browser-blocked.json').exists(), 'no version, nothing to note')
        await control.finalize()
        self.assertIsNone(control.adapter.on_browser_blocked)
        control.record_browser_blocked('26.1023.50603')
        self.assertFalse((control.state/'browser-blocked.json').exists(), 'nothing after the end')

    async def test_a_call_with_no_relay_in_front_is_one_activity_line_that_names_the_bridges_folder(self):
        control = await self.started()
        control.record_call('js', True, 12, 'session', False)
        control.record_call('js', True, 3, 'session', True)       # the relay in front of the runtime writes that one
        lines = [json.loads(line) for line in (control.state/'activity.jsonl').read_text().splitlines()]
        self.assertEqual([(line['writer'], line['tool'], line['ms'], line['cwd']) for line in lines],
                         [(control.writer_id, 'js', 12, os.getcwd())])

    async def test_the_line_of_a_failed_call_says_why_in_one_word(self):
        control = await self.started()
        control.record_call('js', False, 30001, 'session', False, 'timeout')
        control.record_call('js', False, 5, 'session', False, 'PRIVATE words')
        control.record_call('js', False, 5, 'session', False)
        control.record_call('js', True, 5, 'session', False, 'timeout')
        lines = [json.loads(line) for line in (control.state/'activity.jsonl').read_text().splitlines()]
        self.assertEqual([line.get('error') for line in lines], ['timeout', 'error', 'error', None])
        self.assertNotIn('error', lines[3])
        self.assertNotIn('PRIVATE', (control.state/'activity.jsonl').read_text())

    async def test_the_line_of_a_failed_call_keeps_its_error_text_only_while_the_person_asks_for_it(self):
        control = await self.started()
        control.record_call('js', False, 5, 'session', False, 'error', ['ReferenceError: PRIVATE is not defined'])
        settings = control.state/'settings.json'
        settings.write_text('{"schema_version": 1, "error_text": true}')
        settings.chmod(0o600)
        control.record_call('js', False, 5, 'session', False, 'error', ['ReferenceError: y\n  at line 1', ''])
        control.record_call('js', False, 5, 'session', False, 'error', [])
        control.record_call('js', True, 5, 'session', False, None, ['not kept for a call that worked'])
        lines = [json.loads(line) for line in (control.state/'activity.jsonl').read_text().splitlines()]
        self.assertEqual([line.get('error_text') for line in lines], [None, 'ReferenceError: y at line 1', None, None])
        self.assertNotIn('PRIVATE', (control.state/'activity.jsonl').read_text(), 'nothing before it was asked for')

    async def test_default_location_is_the_private_codex_cua_bridges_directory(self):
        control = await self.started()
        state = self.home/'Library/Caches/codex-cua'
        self.assertEqual(control.state, state)
        self.assertTrue(control.directory.name.startswith('bridge-'))
        self.assertEqual(control.directory.parent, state/'bridges')
        for private in (state, state/'bridges', control.directory):
            self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o700, str(private))
        await control.finalize()
        self.assertEqual(list((state/'bridges').iterdir()), [])

    async def test_an_absolute_state_directory_variable_moves_the_records_and_a_relative_one_is_ignored(self):
        with patch.dict(os.environ, {'CODEX_CUA_STATE_DIR': str(self.root/'elsewhere')}):
            control = await self.started()
        self.assertEqual(control.directory.parent, self.root/'elsewhere/bridges')
        self.assertFalse((self.home/'Library').exists())
        with patch.dict(os.environ, {'CODEX_CUA_STATE_DIR': 'relative/state'}):
            other = await self.started()
        self.assertEqual(other.state, self.home/'Library/Caches/codex-cua')

    async def test_a_state_directory_other_people_can_reach_is_refused_and_left_alone(self):
        state = self.root/'state'
        state.mkdir(mode=0o755)
        state.chmod(0o755)
        control = bridge_control.BridgeControl(Adapter(), state)
        with self.assertRaises(RuntimeError):
            await control.start()
        self.assertEqual(list(state.iterdir()), [])
        self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o755)

    async def test_a_symlink_or_file_in_place_of_the_state_directory_is_refused(self):
        target = self.root/'target'
        target.mkdir(mode=0o700)
        link = self.root/'link'
        link.symlink_to(target)
        for state in (link, self.root/'plain-file'):
            if state.name == 'plain-file':
                state.write_text('x')
            control = bridge_control.BridgeControl(Adapter(), state)
            with self.assertRaises(Exception):
                await control.start()
        self.assertEqual(list(target.iterdir()), [])

    async def test_a_bridges_directory_other_people_can_reach_is_refused(self):
        state = self.root/'state'
        (state/'bridges').mkdir(parents=True, mode=0o700)
        (state/'bridges').chmod(0o750)
        with self.assertRaises(RuntimeError):
            await bridge_control.BridgeControl(Adapter(), state).start()
        self.assertEqual(list((state/'bridges').iterdir()), [])

    async def test_a_socket_path_that_cannot_be_bound_leaves_no_directory_behind(self):
        state = self.root/('x'*90)/'state'
        control = bridge_control.BridgeControl(Adapter(), state)
        with self.assertRaises(OSError):
            await control.start()
        self.assertEqual(list((state/'bridges').iterdir()), [])
        self.assertIsNone(control.adapter.on_change)
        self.assertIsNone(control.adapter.on_call)

    async def test_release_asks_the_adapter_to_wait_two_and_a_half_seconds_and_nothing_else(self):
        control = await self.started()
        reader, writer = await asyncio.open_unix_connection(control.control_path)
        writer.write(json.dumps({'action': 'release', 'pid': control.pid, 'started_at': control.started_at}).encode()+b'\n')
        reply = json.loads(await asyncio.wait_for(reader.readline(), 5))
        writer.close()
        self.assertEqual(reply, {'released': True, 'reason': None, 'scope_count': 1})
        self.assertEqual(control.adapter.released, [(2.5, None)])

    async def test_the_record_is_replaced_in_one_rename_and_never_half_written(self):
        control = await self.started()
        seen = []
        for _ in range(50):
            control.refresh()
            seen.append(json.loads((control.directory/'bridge.json').read_text())['pid'])
        self.assertEqual(set(seen), {os.getpid()})
        self.assertEqual(sorted(entry.name for entry in control.directory.iterdir()), ['bridge.json', 'control.sock'])

    async def test_a_record_that_cannot_be_written_is_skipped_and_written_again_later(self):
        control = await self.started()
        with patch.object(bridge_control.records, 'write_json_atomic', side_effect=OSError):
            control.refresh()
        control.adapter.cleanup = 'open'
        control.refresh()
        self.assertEqual(json.loads((control.directory/'bridge.json').read_text())['cleanup'], 'open')

    async def test_the_last_write_removes_the_directory_or_leaves_it_not_confirmed(self):
        control = await self.started()
        directory = control.directory
        await control.stop()
        self.assertFalse((directory/'control.sock').exists())
        await control.finalize()
        self.assertFalse(directory.exists())
        control = await self.started()
        control.adapter.cleanup = 'open'
        await control.finalize()
        self.assertEqual(sorted(entry.name for entry in control.directory.iterdir()), ['bridge.json'])
        self.assertEqual(json.loads((control.directory/'bridge.json').read_text())['cleanup'], 'not_confirmed')
        # Nothing writes after the last write.
        control.refresh()
        control.record_call('js', True, 1, 'session', False)
        self.assertEqual(json.loads((control.directory/'bridge.json').read_text())['cleanup'], 'not_confirmed')
        self.assertFalse((self.home/'Library/Caches/codex-cua/activity.jsonl').exists())


if __name__ == '__main__':
    unittest.main()


CUA_REPL = '/App/cua_node/bin/node /App/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs'
RELAY = '/App/cua_node/bin/node /home/.local/share/codex-cua/relay/relay.mjs'
MINE = 'bridge-4242-1792345678'


class RuntimeTests(unittest.IsolatedAsyncioTestCase):     # the control makes an asyncio lock
    """On its way out a bridge ends the runtimes whose relay record names it, and nothing else."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/tmp', prefix='bc')
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name).resolve()
        self.control = bridge_control.BridgeControl(Adapter(), state=self.state)
        self.control.writer_id = MINE
        self.table = {}          # pid -> (ppid, command), what ps prints
        self.kills = []

    def relay(self, name, owner=MINE, relay=2001, root=2000, host=1100, raw=None):
        directory = self.state/'relays'/('relay-'+name)
        directory.mkdir(parents=True)
        (directory/'relay.json').write_text(raw if raw is not None else json.dumps(
            {'pid': relay, 'root_pid': root, 'app_server_pid': host, 'owner': owner}))

    def ps(self, argv, **options):
        self.assertEqual((argv[:3], options['env']), (['/bin/ps', '-o', 'pid=,ppid=,command='], {'LC_ALL': 'C'}))
        wanted = [int(item) for item in argv[argv.index('-p')+1].split(',')]
        return SimpleNamespace(returncode=0, stdout=''.join(
            '%5d %5d %s\n' % (pid, *self.table[pid]) for pid in wanted if pid in self.table))

    def stop(self):
        return self.control.stop_runtimes(run=self.ps, kill=lambda pid, number: self.kills.append((pid, number)))

    def test_only_the_cua_repl_whose_relay_names_this_bridge_is_signalled(self):
        self.table = {2000: (1100, CUA_REPL), 2001: (2000, RELAY), 3000: (1100, CUA_REPL), 3001: (3000, RELAY)}
        self.relay('mine')
        self.relay('other', owner='bridge-4243-1792345678', relay=3001, root=3000)
        self.relay('codex', owner=None, relay=3001, root=3000)
        self.assertEqual(self.stop(), 1)
        self.assertEqual(self.kills, [(2000, signal.SIGTERM)])

    def test_a_runtime_that_is_not_where_the_record_says_is_left_alone(self):
        self.relay('mine')
        for table in ({2000: (1100, CUA_REPL)},                                  # the relay is gone
                      {2000: (1, CUA_REPL), 2001: (2000, RELAY)},                 # cua-repl left the host
                      {2000: (1100, '/usr/bin/vim notes'), 2001: (2000, RELAY)},  # the pid runs another program
                      {2000: (1100, CUA_REPL), 2001: (1, RELAY)},                 # the relay is not under it
                      {}):
            self.table = table
            self.assertEqual(self.stop(), 0)
        self.assertEqual(self.kills, [])

    def test_records_that_cannot_be_read_or_name_no_usable_process_are_skipped(self):
        self.table = {2000: (1100, CUA_REPL), 2001: (2000, RELAY)}
        self.relay('broken', raw='{not json')
        self.relay('list', raw='[]')
        self.relay('bool', relay=True)
        self.relay('one', root=1)
        self.relay('text', host='1100')
        self.assertEqual(self.stop(), 0)
        self.control.writer_id = None          # a bridge that never got its name ends nothing
        self.relay('mine')
        self.assertEqual(self.stop(), 0)
        self.assertEqual(self.kills, [])

    def test_a_process_list_or_a_signal_that_fails_ends_nothing_and_raises_nothing(self):
        self.relay('mine')
        self.table = {2000: (1100, CUA_REPL), 2001: (2000, RELAY)}

        def refuses(pid, number):
            raise PermissionError(pid)
        self.assertEqual(self.control.stop_runtimes(run=self.ps, kill=refuses), 0)
        self.assertEqual(self.control.stop_runtimes(run=Mock(side_effect=OSError('no ps')), kill=refuses), 0)


class FinalizeTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_runtimes_are_ended_before_the_last_write_and_a_failure_there_changes_nothing(self):
        with tempfile.TemporaryDirectory(dir='/tmp', prefix='bc') as temp:
            control = bridge_control.BridgeControl(Adapter(), state=Path(temp).resolve()/'state')
            await control.start()
            control.stop_runtimes = Mock(side_effect=RuntimeError('boom'))
            await control.finalize()
            control.stop_runtimes.assert_called_once_with()
            self.assertFalse(control.directory.exists())
