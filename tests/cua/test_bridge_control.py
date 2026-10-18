"""The record owner and control endpoint on their own, against a stand-in adapter: where they live and what they refuse.

How they behave with a real connection, scopes and releases is in test_bridge_lifecycle.py.
"""
import asyncio
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

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
