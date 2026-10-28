"""The record helpers: where the state is, what a private directory is, process identity and the activity log."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import stat
from types import SimpleNamespace
import tempfile
import threading
import time
import unittest

import bridge_records as records


class RecordsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def test_state_directory_follows_the_variable_only_when_it_is_absolute(self):
        home = self.root/'home'
        default = home/'Library/Caches/codex-cua'
        self.assertEqual(records.state_dir({}, home), default)
        self.assertEqual(records.state_dir({'CODEX_CUA_STATE_DIR': ''}, home), default)
        self.assertEqual(records.state_dir({'CODEX_CUA_STATE_DIR': 'relative'}, home), default)
        self.assertEqual(records.state_dir({'CODEX_CUA_STATE_DIR': '/some/where'}, home), Path('/some/where'))

    def test_a_refused_browser_is_written_down_as_the_codex_version_and_the_time_only(self):
        state = self.root/'state'
        self.assertTrue(records.remember_browser_blocked(state, '26.1023.50603', '2026-10-28T09:48:00Z'))
        path = state/records.BROWSER_BLOCKED_FILE
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o700)
        self.assertEqual(json.loads(path.read_text()),
                         {'schema_version': 1, 'app_version': '26.1023.50603', 'at': '2026-10-28T09:48:00Z'})
        self.assertEqual(records.read_browser_blocked(state), {'app_version': '26.1023.50603', 'at': '2026-10-28T09:48:00Z'})
        # Without a version nothing could tell later whether the same Codex runs: nothing is written.
        for version in (None, '', '../x', 'a b', 7):
            self.assertFalse(records.remember_browser_blocked(state, version))
        self.assertEqual(records.read_browser_blocked(state)['app_version'], '26.1023.50603')
        # The time is now when none is given.
        records.remember_browser_blocked(state, '26.1030.1')
        self.assertRegex(records.read_browser_blocked(state)['at'], r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')

    def test_a_note_that_is_missing_foreign_or_damaged_says_nothing(self):
        state = records.private_directory(self.root/'state')
        path = state/records.BROWSER_BLOCKED_FILE
        self.assertIsNone(records.read_browser_blocked(state))
        for text in ('not json', '[]', '{"schema_version": 2, "app_version": "1"}', '{"schema_version": 1}',
                     '{"schema_version": 1, "app_version": "a/b"}'):
            path.write_text(text)
            self.assertIsNone(records.read_browser_blocked(state), text)
        path.write_text('{"schema_version": 1, "app_version": "1.2"}')
        self.assertEqual(records.read_browser_blocked(state), {'app_version': '1.2', 'at': None})
        path.chmod(0o666)
        self.assertIsNone(records.read_browser_blocked(state), 'others may write it')
        path.chmod(0o600)
        self.assertIsNone(records.read_browser_blocked(state, uid=os.getuid()+1), 'another user\'s')
        path.unlink()
        path.symlink_to(self.root/'elsewhere.json')
        (self.root/'elsewhere.json').write_text('{"schema_version": 1, "app_version": "1.2"}')
        self.assertIsNone(records.read_browser_blocked(state), 'a link is not followed')

    def test_a_private_directory_is_made_with_0700_and_an_existing_one_must_already_be_private(self):
        path = records.private_directory(self.root/'a/b/state')
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        records.private_directory(path)
        loose = self.root/'loose'
        loose.mkdir(mode=0o755)
        loose.chmod(0o755)
        with self.assertRaises(RuntimeError):
            records.private_directory(loose)
        self.assertEqual(stat.S_IMODE(loose.stat().st_mode), 0o755)
        for mode in (0o770, 0o707, 0o750, 0o705):
            loose.chmod(mode)
            with self.assertRaises(RuntimeError):
                records.private_directory(loose)
        link = self.root/'link'
        link.symlink_to(path)
        with self.assertRaises(RuntimeError):
            records.private_directory(link)
        plain = self.root/'plain'
        plain.write_text('x')
        with self.assertRaises(OSError):
            records.private_directory(plain)

    def test_process_start_is_read_from_ps_in_the_c_locale_as_epoch_seconds(self):
        calls = []
        def run(command, **kwargs):
            calls.append((command, kwargs))
            return SimpleNamespace(stdout='Sun Oct  4 22:08:11 2026\n')
        started = records.process_started_at(4242, run)
        self.assertEqual(started, int(datetime.datetime(2026, 10, 4, 22, 8, 11).timestamp()))
        [(command, kwargs)] = calls
        self.assertEqual(command, ['/bin/ps', '-p', '4242', '-o', 'lstart='])
        self.assertEqual(kwargs['env']['LC_ALL'], 'C')

    def test_the_real_process_start_is_a_plausible_time_and_stable(self):
        started = records.process_started_at(os.getpid())
        self.assertLessEqual(started, time.time())
        self.assertGreater(started, time.time()-10*365*86400)
        self.assertEqual(records.process_started_at(os.getpid()), started)

    def test_an_atomic_write_is_private_leaves_no_temporary_file_and_keeps_the_old_file_on_failure(self):
        path = self.root/'record.json'
        records.write_json_atomic(path, {'a': 1})
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        records.write_json_atomic(path, {'a': 2})
        self.assertEqual(json.loads(path.read_text()), {'a': 2})
        with self.assertRaises(TypeError):
            records.write_json_atomic(path, {'a': object()})
        self.assertEqual(json.loads(path.read_text()), {'a': 2})
        self.assertEqual([entry.name for entry in self.root.iterdir()], ['record.json'])

    def test_activity_lines_are_appended_to_a_private_file(self):
        for number in range(3):
            records.append_activity(self.root, {'n': number})
        path = self.root/'activity.jsonl'
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual([json.loads(line)['n'] for line in path.read_text().splitlines()], [0, 1, 2])

    def test_the_error_text_is_kept_only_when_a_private_settings_file_says_so(self):
        self.assertFalse(records.keeps_error_text(self.root))
        path = self.root/records.SETTINGS_FILE
        for content, mode, kept in (('{"schema_version": 1, "error_text": true}', 0o600, True),
                                    ('{"schema_version": 1, "error_text": false}', 0o600, False),
                                    ('{"error_text": "yes"}', 0o600, False), ('{broken', 0o600, False), ('[true]', 0o600, False),
                                    ('{"error_text": true}', 0o644, False)):
            path.write_text(content)
            path.chmod(mode)
            self.assertEqual(records.keeps_error_text(self.root), kept, (content, oct(mode)))
        path.chmod(0o600)
        path.rename(self.root/'real.json')
        path.symlink_to(self.root/'real.json')
        self.assertFalse(records.keeps_error_text(self.root), 'a link is not followed')

    def test_the_error_text_is_one_line_and_clipped(self):
        self.assertIsNone(records.error_text([]))
        self.assertIsNone(records.error_text(['', '  \n', None, 7]))
        self.assertEqual(records.error_text(['TypeError: x\n    at <anonymous>:1:1', ' second\ttext ']),
                         'TypeError: x at <anonymous>:1:1 second text')
        clipped = records.error_text(['가'*(records.ERROR_TEXT_LIMIT+10)])
        self.assertEqual(len(clipped), records.ERROR_TEXT_LIMIT)
        self.assertTrue(clipped.endswith('…'))
        self.assertEqual(records.error_text(['a'*records.ERROR_TEXT_LIMIT]), 'a'*records.ERROR_TEXT_LIMIT)

    def test_a_symlink_in_place_of_the_activity_file_is_never_followed(self):
        target = self.root/'elsewhere'
        target.write_text('')
        (self.root/'activity.jsonl').symlink_to(target)
        with self.assertRaises(OSError):
            records.append_activity(self.root, {'n': 1})
        self.assertEqual(target.read_text(), '')

    def test_a_file_past_its_limit_keeps_only_the_newest_lines(self):
        for number in range(30):
            records.append_activity(self.root, {'n': number, 'pad': 'x'*40}, max_bytes=1000, keep=5)
        lines = (self.root/'activity.jsonl').read_text().splitlines()
        self.assertLessEqual(len(lines), 5+int(1000/60)+1)
        self.assertEqual(json.loads(lines[-1])['n'], 29)
        for number in range(30, 60):
            records.append_activity(self.root, {'n': number, 'pad': 'x'*40}, max_bytes=1000, keep=5)
        numbers = [json.loads(line)['n'] for line in (self.root/'activity.jsonl').read_text().splitlines()]
        self.assertEqual(numbers, sorted(numbers))
        self.assertEqual(numbers[-1], 59)
        self.assertEqual(stat.S_IMODE((self.root/'activity.jsonl').stat().st_mode), 0o600)
        self.assertEqual(sorted(entry.name for entry in self.root.iterdir()), ['activity.jsonl', 'activity.lock'])

    def test_compaction_keeps_exactly_the_newest_two_hundred_lines_by_default(self):
        path = self.root/'activity.jsonl'
        path.write_text(''.join(json.dumps({'n': number})+'\n' for number in range(1000)))
        records.compact_activity(self.root)
        numbers = [json.loads(line)['n'] for line in path.read_text().splitlines()]
        self.assertEqual(numbers, list(range(800, 1000)))
        self.assertEqual((records.ACTIVITY_MAX_BYTES, records.ACTIVITY_KEEP_LINES), (256*1024, 200))

    def test_a_line_still_being_written_is_not_kept_by_compaction(self):
        path = self.root/'activity.jsonl'
        path.write_text('{"n":1}\n{"n":2}\n{"n":')
        records.compact_activity(self.root, keep=5)
        self.assertEqual(path.read_text(), '{"n":1}\n{"n":2}\n')

    def append_without_waiting(self, number):
        """A writer with a busy lock must go on at once; a regression to waiting would otherwise hang the whole run."""
        worker = threading.Thread(target=records.append_activity, args=(self.root, {'n': number}),
                                  kwargs={'max_bytes': 10, 'keep': 5}, daemon=True)
        worker.start()
        worker.join(5)
        self.assertFalse(worker.is_alive(), 'The writer waited for a busy lock')

    def test_a_busy_lock_means_the_writer_only_appends(self):
        path = self.root/'activity.jsonl'
        path.write_text(''.join(json.dumps({'n': number})+'\n' for number in range(50)))
        holder = os.open(self.root/'activity.lock', os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, holder)
        fcntl.flock(holder, fcntl.LOCK_EX)
        self.append_without_waiting(50)
        self.assertEqual(len(path.read_text().splitlines()), 51)
        fcntl.flock(holder, fcntl.LOCK_UN)
        records.append_activity(self.root, {'n': 51}, max_bytes=10, keep=5)
        self.assertEqual([json.loads(line)['n'] for line in path.read_text().splitlines()], [47, 48, 49, 50, 51])

    @unittest.skipUnless(hasattr(os, 'O_EXLOCK'), 'O_EXLOCK is macOS and BSD only')
    def test_the_relays_lock_and_this_writers_lock_exclude_each_other(self):
        # The relay trims the same file under open(O_EXLOCK | O_NONBLOCK) on activity.lock. Only flock sees that lock.
        path = self.root/'activity.jsonl'
        path.write_text(''.join(json.dumps({'n': number})+'\n' for number in range(50)))
        relay = os.open(self.root/'activity.lock', os.O_RDWR | os.O_CREAT | os.O_EXLOCK | os.O_NONBLOCK, 0o600)
        try:
            self.append_without_waiting(50)
            self.assertEqual(len(path.read_text().splitlines()), 51)
        finally:
            os.close(relay)
        records.append_activity(self.root, {'n': 51}, max_bytes=10, keep=5)
        self.assertEqual([json.loads(line)['n'] for line in path.read_text().splitlines()], [47, 48, 49, 50, 51])
        # And the other way round: while this writer trims, the relay's open fails instead of waiting.
        holder = os.open(self.root/'activity.lock', os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, holder)
        fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with self.assertRaises(BlockingIOError):
            os.open(self.root/'activity.lock', os.O_RDWR | os.O_EXLOCK | os.O_NONBLOCK)


if __name__ == '__main__':
    unittest.main()
