"""Update warnings distinguish live stale MCP servers from transport connectivity, without a real client."""
from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import Mock, patch

import claude_lifecycle as lifecycle
import claude_reconnect as reconnect


OWNER = (4200, 1700000000)
INSTALLED = {'version': '0.8.17', 'revision': 'a'*64}


def payload(event='UserPromptSubmit', **changes):
    return {'hook_event_name': event, 'session_id': 'claude-one', 'prompt_id': 'prompt-one', **changes}


def compare(record, installed, command=None):
    current = record.get('version') == installed['version'] and record.get('runtime_revision') == installed['revision']
    return {'state': 'current' if current else 'reconnect_required', 'running_version': record.get('version'),
            'installed_version': installed['version'], 'reconnect_required': not current}


class ReconnectTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir='/tmp', prefix='crh')
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name).resolve()
        self.state.chmod(0o700)
        (self.state/'bridges').mkdir(mode=0o700)
        self.identities = {}
        self.read_command = Mock(return_value='PRIVATE_COMMAND_WITH_SECRET')

    def record(self, name='old', pid=5001, owner=OWNER, **changes):
        folder = self.state/'bridges'/('bridge-'+name)
        folder.mkdir(mode=0o700)
        record = {'owner_pid': owner[0], 'owner_started_at': owner[1], 'pid': pid, 'started_at': 1700000010,
                  'version': '0.8.16', 'runtime_revision': 'b'*64, **changes}
        path = folder/'bridge.json'
        path.write_text(json.dumps(record))
        path.chmod(0o600)
        self.identities[pid] = (os.getuid(), owner[0], record['started_at'])
        return path

    def notice(self, value=None, installed=INSTALLED, comparer=compare, identity=None):
        return reconnect.hook_output(self.state, OWNER, value or payload(), lifecycle.private_json,
            identity or self.identities.get, installed, comparer, self.read_command)

    def test_live_stale_server_warns_user_and_model_without_permission_or_block_decision(self):
        self.record()
        result = self.notice()
        self.assertIn('연결 0.8.16, 설치 0.8.17', result['systemMessage'])
        self.assertIn('/mcp', result['systemMessage'])
        self.assertIn('Connected', result['systemMessage'])
        self.assertEqual(result['hookSpecificOutput']['hookEventName'], 'UserPromptSubmit')
        self.assertIn('not report the connection as up to date', result['hookSpecificOutput']['additionalContext'])
        self.assertIn('cuabar status tool', result['hookSpecificOutput']['additionalContext'])
        self.assertIn('does not reconnect this MCP process', result['hookSpecificOutput']['additionalContext'])
        self.assertEqual(set(result), {'systemMessage', 'hookSpecificOutput'})
        self.assertEqual(set(result['hookSpecificOutput']), {'hookEventName', 'additionalContext'})
        self.read_command.assert_not_called()
        notices = list((self.state/'claude-reconnect-notices').rglob('*.json'))
        self.assertEqual(len(notices), 1)
        self.assertEqual(stat.S_IMODE(notices[0].stat().st_mode), 0o600)
        self.assertEqual(json.loads(notices[0].read_text()), {'schema_version': 1, 'notified': True})

    def test_current_runtime_or_missing_bridge_stays_silent_and_does_not_write(self):
        self.assertIsNone(self.notice())
        self.record(version=INSTALLED['version'], runtime_revision=INSTALLED['revision'])
        self.assertIsNone(self.notice())
        self.assertFalse((self.state/'claude-reconnect-notices').exists())

    def test_different_owner_reused_pid_foreign_user_dead_bridge_and_unsafe_record_are_ignored(self):
        self.record('other-owner', pid=5001, owner=(OWNER[0]+1, OWNER[1]))
        self.record('other-start', pid=5002, owner=(OWNER[0], OWNER[1]+1))
        self.record('reused-pid', pid=5003)
        self.identities[5003] = (os.getuid(), OWNER[0], 1700000099)
        self.record('foreign-user', pid=5004)
        self.identities[5004] = (os.getuid()+1, OWNER[0], 1700000010)
        self.record('dead', pid=5005)
        self.identities.pop(5005)
        path = self.record('unsafe', pid=5006)
        path.chmod(0o644)
        self.assertIsNone(self.notice())
        self.assertFalse((self.state/'claude-reconnect-notices').exists())

    def test_owner_and_start_are_rechecked_after_legacy_command_read(self):
        self.record(version=None)
        identity = Mock(side_effect=[(os.getuid(), OWNER[0], 1700000010), None])
        self.assertIsNone(self.notice(identity=identity))
        self.read_command.assert_called_once_with(5001)
        self.assertFalse((self.state/'claude-reconnect-notices').exists())

    def test_legacy_hint_goes_to_comparer_but_never_to_output_or_record(self):
        self.record(version=None)
        comparer = Mock(return_value={'state': 'unknown', 'running_version': None, 'reconnect_required': True})
        result = self.notice(comparer=comparer)
        self.assertIn('실행 버전을 확인할 수 없습니다', result['systemMessage'])
        self.assertNotIn('이전', result['systemMessage'])
        self.assertEqual(comparer.call_args.kwargs['command'], 'PRIVATE_COMMAND_WITH_SECRET')
        self.assertNotIn('PRIVATE', json.dumps(result))
        for path in (self.state/'claude-reconnect-notices').rglob('*.json'):
            self.assertNotIn('PRIVATE', path.read_text())

    def test_pre_lifecycle_legacy_bridge_with_no_owner_start_warns_using_verified_live_parent(self):
        path = self.record(version=None)
        record = json.loads(path.read_text())
        record.pop('owner_started_at')
        path.write_text(json.dumps(record))
        self.read_command.return_value = '/usr/bin/python3 /Users/example/.local/share/codex-cua/engine/0.8.15/mcp_stdio.py'
        from runtime_identity import runtime_status
        result = self.notice(comparer=runtime_status)
        self.assertIn('연결 0.8.15, 설치 0.8.17', result['systemMessage'])
        self.read_command.assert_called_once_with(5001)

    def test_legacy_record_must_not_predate_verified_claude_owner(self):
        path = self.record(version=None, started_at=OWNER[1]-1)
        record = json.loads(path.read_text())
        record.pop('owner_started_at')
        path.write_text(json.dumps(record))
        self.assertIsNone(self.notice())
        self.read_command.assert_not_called()

    def test_an_explicit_null_or_mismatched_owner_start_is_not_a_legacy_omission(self):
        for name, value in (('null', None), ('mismatch', OWNER[1]-1)):
            with self.subTest(name=name):
                self.record(name=name, pid=5001 if name == 'null' else 5002, owner_started_at=value)
        self.assertIsNone(self.notice())
        self.read_command.assert_not_called()

    def test_same_version_changed_code_also_warns_but_no_installed_identity_does_not(self):
        self.record(version=INSTALLED['version'])
        result = self.notice()
        self.assertIn('연결 0.8.17, 설치 0.8.17', result['systemMessage'])
        absent = Mock(return_value={'state': 'unknown', 'reconnect_required': False})
        self.assertIsNone(self.notice(payload(session_id='another-session'), installed={}, comparer=absent))

    def test_notice_once_across_prompt_and_tool_hooks_and_again_for_new_install_or_session(self):
        self.record()
        self.assertIsNotNone(self.notice())
        self.assertIsNone(self.notice(payload(prompt_id='prompt-two')))
        tool = payload('PreToolUse', tool_name='mcp__cuabar__js', tool_use_id='tool_one')
        self.assertIsNone(self.notice(tool))
        self.assertIsNotNone(self.notice(payload(session_id='another-session')))
        self.assertIsNotNone(self.notice(installed={**INSTALLED, 'revision': 'c'*64}))

    def test_parallel_hooks_emit_one_notice_and_keep_private_directories(self):
        self.record()
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.notice(), range(16)))
        self.assertEqual(sum(result is not None for result in results), 1)
        for path in (self.state/'claude-reconnect-notices').rglob('*'):
            if path.is_dir():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)

    def test_only_prompt_and_cuabar_tools_warn_and_input_does_not_leave_process(self):
        self.record()
        for value in (payload('Stop'), payload('StopFailure'), payload('SubagentStop'), payload('SessionEnd'),
                      payload('PreToolUse', tool_name='mcp__other__js'), payload(session_id='../bad'),
                      payload(session_id=False)):
            self.assertIsNone(self.notice(value))
        result = self.notice(payload('PreToolUse', tool_name='mcp__cuabar__js',
                                     tool_input={'code': 'PRIVATE_CODE'}, transcript_path='/PRIVATE_TRANSCRIPT'))
        self.assertEqual(result['hookSpecificOutput']['hookEventName'], 'PreToolUse')
        self.assertNotIn('PRIVATE', json.dumps(result))
        for name in ('status', 'repair'):
            self.assertIsNotNone(self.notice(payload('PreToolUse', tool_name='mcp__cuabar__'+name,
                                                     session_id='session-'+name)))

    def test_session_end_forgets_only_its_private_notice_and_preserves_other_session_and_owner(self):
        self.record()
        self.notice()
        self.notice(payload(session_id='another-session'))
        other = reconnect._scope(self.state, (OWNER[0]+1, OWNER[1]), 'claude-one')
        other.mkdir(parents=True, mode=0o700)
        other.parent.chmod(0o700)
        marker = other/'keep.json'
        marker.write_text('{}')
        marker.chmod(0o600)
        reconnect.forget_notices(self.state, OWNER, payload('SessionEnd'))
        self.assertFalse(reconnect._scope(self.state, OWNER, 'claude-one').exists())
        self.assertTrue(reconnect._scope(self.state, OWNER, 'another-session').is_dir())
        self.assertTrue(marker.is_file())
        self.assertIsNotNone(self.notice())

    def test_notice_storage_symlink_or_non_private_root_is_not_followed_or_repaired(self):
        self.record()
        target = self.state/'other'
        target.mkdir(mode=0o700)
        link = self.state/'claude-reconnect-notices'
        link.symlink_to(target, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            self.notice()
        self.assertEqual(list(target.iterdir()), [])
        link.unlink()
        self.state.chmod(0o755)
        with self.assertRaises(RuntimeError):
            self.notice()
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o755)

    def test_process_command_reads_only_target_process_and_handles_disappearance(self):
        with patch.object(reconnect.subprocess, 'run', return_value=Mock(stdout=' legacy command \n')) as run:
            self.assertEqual(reconnect.process_command(5001), 'legacy command')
        self.assertEqual(run.call_args.args[0], ['/bin/ps', '-p', '5001', '-o', 'command='])
        with patch.object(reconnect.subprocess, 'run', side_effect=OSError):
            self.assertIsNone(reconnect.process_command(5001))


class MainHookTests(unittest.TestCase):
    def run_hook(self, value, warning=None, failure=False):
        output = io.StringIO()
        fake_in = Mock(buffer=io.BytesIO(json.dumps(value).encode()))
        with patch.object(lifecycle.sys, 'stdin', fake_in), patch.object(lifecycle.sys, 'stdout', output), \
                patch.object(lifecycle, 'hook_owner', return_value=OWNER), \
                patch.object(lifecycle, 'state_dir', return_value=Path('/fixture-state')), \
                patch.object(lifecycle, 'bind_call') as bind, \
                patch.object(lifecycle, 'notify_bridges', return_value=[]) as notify, \
                patch.object(lifecycle, 'prune_bindings') as prune, \
                patch.object(reconnect, 'hook_output', side_effect=RuntimeError if failure else None,
                             return_value=warning) as notice, \
                patch.object(reconnect, 'forget_notices'):
            self.assertEqual(lifecycle.main(), 0)
        return output.getvalue(), bind, notify, prune, notice

    def test_notice_json_remains_valid_and_binding_still_runs(self):
        warning = {'systemMessage': '재연결 필요', 'hookSpecificOutput': {'hookEventName': 'PreToolUse'}}
        raw, bind, notify, _, _ = self.run_hook(payload('PreToolUse', tool_name='mcp__cuabar__js'), warning)
        self.assertEqual(json.loads(raw), warning)
        bind.assert_called_once()
        notify.assert_not_called()

    def test_broken_notice_never_prevents_binding_or_end_cleanup(self):
        _, bind, _, _, _ = self.run_hook(payload('PreToolUse', tool_name='mcp__cuabar__js'), failure=True)
        bind.assert_called_once()
        raw, _, notify, prune, _ = self.run_hook(payload('Stop'), failure=True)
        self.assertEqual(raw, '')
        notify.assert_called_once()
        prune.assert_called_once()


if __name__ == '__main__':
    unittest.main()
