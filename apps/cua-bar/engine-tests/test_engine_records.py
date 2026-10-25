"""Reading and cleaning bridge and relay records, the activity log and the control sockets."""
import json
import os
import stat
import time
import unittest

import engine_records as records
from engine_core import iso
from engine_support import NOW, SESSION_A, SESSION_B, SESSION_C, UID, EngineCase, State, at


class LoadingTests(EngineCase):
    def load(self):
        return records.load_records(self.state.root, UID)

    def test_reads_bridge_and_relay_records_and_ignores_unknown_keys(self):
        self.state.bridge('a1', 4242, NOW-900, session_id=SESSION_A, future_key={'x': 1},
                          scopes=[State.scope(SESSION_A)], cleanup='open')
        self.state.relay('b2', 5151, NOW-800, scopes=[State.scope(SESSION_B, subagent=True)])
        found = {record.kind: record for record in self.load()}
        bridge, relay = found['bridge'], found['relay']
        self.assertEqual((bridge.pid, bridge.started_at, bridge.writer, bridge.connection_id),
                         (4242, NOW-900, 'bridge-4242-%d' % (NOW-900), 'claude-4242-%d' % (NOW-900)))
        self.assertEqual((relay.writer, relay.connection_id, relay.agent),
                         ('relay-5151-%d' % (NOW-800), 'codex-5151-%d' % (NOW-800), 'codex'))
        self.assertEqual(bridge.sessions(), {SESSION_A})
        self.assertEqual(bridge.current_session, SESSION_A)
        self.assertEqual(relay.open_sessions, [SESSION_B])
        self.assertFalse(bridge.live)

    def test_records_that_cannot_be_trusted_are_ignored(self):
        self.state.bridge('wrongschema', 4242, NOW-900, schema_version=2)
        self.state.bridge('wrongkind', 4243, NOW-900, kind='relay')
        self.state.bridge('badpid', True, NOW-900)
        self.state.bridge('pid1', 1, NOW-900)
        self.state.bridge('badstart', 4244, 5)
        self.state.bridge('milliseconds', 4245, (NOW-900)*1000)
        self.state.bridge('good', 4246, NOW-900)
        publicfile = self.state.bridge('public', 4247, NOW-900)
        (publicfile/'bridge.json').chmod(0o644)
        brokenjson = self.state.bridge('broken', 4248, NOW-900)
        (brokenjson/'bridge.json').write_text('{nope')
        huge = self.state.bridge('huge', 4249, NOW-900)
        (huge/'bridge.json').write_text(json.dumps({'padding': 'x'*(records.MAX_RECORD_BYTES+1)}))
        linked = self.state.bridge('linked', 4250, NOW-900)
        (linked/'bridge.json').rename(linked/'real.json')
        (linked/'bridge.json').symlink_to(linked/'real.json')
        publicdirectory = self.state.bridge('publicdir', 4251, NOW-900)
        publicdirectory.chmod(0o755)
        strange = self.state.root/'bridges/not-a-record'
        strange.mkdir(mode=0o700)
        (self.state.root/'bridges/bridge-file').write_text('x')
        self.assertEqual([record.pid for record in self.load()], [4246])

    def test_a_state_directory_that_is_not_private_has_no_records(self):
        self.state.bridge('a1', 4242, NOW-900)
        self.state.root.chmod(0o755)
        self.assertEqual(self.load(), [])
        self.state.root.chmod(0o700)
        self.assertEqual(len(self.load()), 1)
        self.assertEqual(records.load_records(self.root/'missing', UID), [])
        (self.state.root/'bridges').chmod(0o755)
        self.assertEqual(self.load(), [])
        (self.state.root/'bridges').chmod(0o700)

    def test_scopes_with_unusable_session_ids_are_dropped_and_times_are_parsed(self):
        self.state.bridge('a1', 4242, NOW-900, scopes=[
            State.scope(SESSION_A, first=at(600), last=at(300)), {'session_id': '../etc/passwd'}, {'turn_id': 'x'}, 'text',
            State.scope(SESSION_A, turn='turn-2', first=at(200), last=at(100)), State.scope(SESSION_B, last=at(50))],
            session_id=SESSION_C)
        [record] = self.load()
        self.assertEqual(record.open_sessions, [SESSION_A, SESSION_B])
        self.assertEqual(record.sessions(), {SESSION_A, SESSION_B, SESSION_C})
        self.assertEqual(record.last_scope_time(SESSION_A), at(100))
        self.assertEqual(record.last_scope_time(SESSION_B), at(50))

    def test_last_scope_time_falls_back_to_the_first_time_and_then_the_record_time(self):
        self.state.bridge('a1', 4242, NOW-900, scopes=[{'session_id': SESSION_A, 'first_at': iso(at(70))},
                                                       {'session_id': SESSION_B}], updated_at=iso(at(20)))
        [record] = self.load()
        self.assertEqual(record.last_scope_time(SESSION_A), at(70))
        self.assertEqual(record.last_scope_time(SESSION_B), at(20))
        record.data.pop('updated_at')
        self.assertIsNone(record.last_scope_time(SESSION_B))

    def test_text_number_time_and_path_accessors_are_defensive(self):
        self.state.relay('b2', 5151, NOW-800, cwd='relative', app_server_pid=0, last_call_at='yesterday', busy='yes')
        [record] = self.load()
        self.assertIsNone(record.path('cwd'))
        self.assertIsNone(record.number('app_server_pid'))
        self.assertIsNone(record.time('last_call_at'))
        self.assertEqual(record.number('pid'), 5151)


class LiveSessionTests(EngineCase):
    def load(self):
        return {record.kind: record for record in records.load_records(self.state.root, UID)}

    def test_a_bridge_serves_its_current_session_and_a_relay_all_of_its_open_scopes(self):
        self.state.bridge('a1', 4242, NOW-900, session_id=SESSION_B, scopes=[State.scope(SESSION_A), State.scope(SESSION_B)])
        self.state.relay('b2', 5151, NOW-800, scopes=[State.scope(SESSION_A), State.scope(SESSION_C)])
        found = self.load()
        self.assertEqual(found['bridge'].live_sessions(), {SESSION_B})
        self.assertEqual(found['bridge'].sessions(), {SESSION_A, SESSION_B})        # everything it lists, for attribution
        self.assertEqual(found['relay'].live_sessions(), {SESSION_A, SESSION_C})

    def test_a_bridge_that_never_connected_serves_nothing(self):
        self.state.bridge('a1', 4242, NOW-900, session_id=None, scopes=[State.scope(SESSION_A)])
        self.assertEqual(self.load()['bridge'].live_sessions(), set())


class ReleaseTimeoutTests(EngineCase):
    def test_at_least_thirteen_seconds_and_five_more_for_every_open_scope(self):
        for count in (0, 1, 2, 3, 4, 10):
            self.state.bridge('t%d' % count, 4000+count, NOW-900,
                              scopes=[State.scope(SESSION_A, turn='turn-%d' % number) for number in range(count)])
        by_count = {len(record.scopes): record for record in records.load_records(self.state.root, UID)}
        self.assertEqual([records.release_timeout(by_count[count]) for count in (0, 1, 2, 3, 4, 10)],
                         [13.0, 13.0, 13.0, 18.0, 23.0, 53.0])


class ReleasedMemoryTests(EngineCase):
    WRITER = 'bridge-4242-%d' % (NOW-900)
    OTHER = 'relay-5151-%d' % (NOW-800)

    def remember(self, writer, session, stamp=NOW):
        return records.remember_released(self.state.root, UID, writer, session, iso(stamp))

    def test_released_pairs_are_kept_in_a_private_file_with_identifiers_and_times_only(self):
        self.assertEqual(records.read_released(self.state.root, UID), set())
        self.assertTrue(self.remember(self.WRITER, SESSION_A))
        self.assertTrue(self.remember(self.WRITER, SESSION_B, NOW+1))
        self.assertTrue(self.remember(self.WRITER, SESSION_A, NOW+2))               # the same pair again is one pair
        self.assertEqual(records.read_released(self.state.root, UID), {(self.WRITER, SESSION_A), (self.WRITER, SESSION_B)})
        path = self.state.root/records.RELEASED_FILE
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        data = json.loads(path.read_text())
        self.assertEqual(data['schema_version'], 1)
        self.assertEqual([sorted(item) for item in data['released']], [['released_at', 'session_id', 'writer']]*2)
        self.assertEqual({item['released_at'] for item in data['released']}, {iso(NOW+1), iso(NOW+2)})
        self.assertEqual([item.name for item in self.state.root.iterdir() if item.name.startswith('.')], [])

    def test_the_pairs_of_records_that_are_gone_are_forgotten_and_nothing_else(self):
        self.remember(self.WRITER, SESSION_A)
        self.remember(self.OTHER, SESSION_B)
        self.assertFalse(records.forget_released(self.state.root, UID, {self.WRITER, self.OTHER}))
        self.assertTrue(records.forget_released(self.state.root, UID, {self.WRITER}))
        self.assertEqual(records.read_released(self.state.root, UID), {(self.WRITER, SESSION_A)})
        self.assertFalse(records.forget_released(self.state.root, UID, {self.WRITER}))
        self.assertFalse(records.forget_released(self.root/'missing', UID, set()))

    def test_a_damaged_foreign_or_unsafe_file_is_an_empty_memory(self):
        path = self.state.root/records.RELEASED_FILE
        good = {'writer': self.WRITER, 'session_id': SESSION_A, 'released_at': iso(NOW)}
        for content in ('{broken', '[]', json.dumps({'schema_version': 2, 'released': [good]}),
                        json.dumps({'schema_version': 1, 'released': 'x'}),
                        json.dumps({'schema_version': 1, 'released': ['text', {'writer': 'evil', 'session_id': SESSION_A},
                                                                     {'writer': self.WRITER, 'session_id': '../x'}]})):
            path.write_text(content)
            os.chmod(path, 0o600)
            self.assertEqual(records.read_released(self.state.root, UID), set(), content)
        path.write_text(json.dumps({'schema_version': 1, 'released': [good]}))
        os.chmod(path, 0o644)
        self.assertEqual(records.read_released(self.state.root, UID), set())          # others could have written it
        os.chmod(path, 0o600)
        self.assertEqual(records.read_released(self.state.root, UID), {(self.WRITER, SESSION_A)})
        path.rename(self.state.root/'real.json')
        path.symlink_to(self.state.root/'real.json')
        self.assertEqual(records.read_released(self.state.root, UID), set())          # a link is not followed

    def test_a_state_directory_that_cannot_be_trusted_is_neither_read_nor_written(self):
        self.remember(self.WRITER, SESSION_A)
        self.state.root.chmod(0o755)
        self.assertEqual(records.read_released(self.state.root, UID), set())
        self.assertFalse(self.remember(self.OTHER, SESSION_B))
        self.state.root.chmod(0o700)
        self.assertEqual(records.read_released(self.state.root, UID), {(self.WRITER, SESSION_A)})


class SettingsTests(EngineCase):
    def read(self):
        return records.read_settings(self.state.root, UID)

    def test_error_text_is_off_until_the_person_turns_it_on(self):
        self.assertEqual(self.read(), {'error_text': False})
        self.assertEqual(records.write_settings(self.state.root, UID, True), {'ok': True, 'reason': None, 'error_text': True})
        self.assertEqual(self.read(), {'error_text': True})
        path = self.state.root/records.SETTINGS_FILE
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(json.loads(path.read_text()), {'schema_version': 1, 'error_text': True})
        self.assertEqual(records.write_settings(self.state.root, UID, False), {'ok': True, 'reason': None, 'error_text': False})
        self.assertEqual(self.read(), {'error_text': False})
        self.assertEqual([item.name for item in self.state.root.iterdir() if item.name.startswith('.')], [])

    def test_a_damaged_foreign_or_unsafe_file_reads_as_off(self):
        for content in ('{broken', '[]', 'true', json.dumps({'error_text': 'yes'}), json.dumps({'error_text': 1}),
                        '{"error_text": true, "x": "%s"}' % ('y'*records.SETTINGS_MAX_BYTES)):
            self.state.settings(content)
            self.assertEqual(self.read(), {'error_text': False}, content[:40])
        self.state.settings({'error_text': True}, mode=0o644)
        self.assertEqual(self.read(), {'error_text': False})           # others could have written it
        self.state.settings({'error_text': True})
        self.assertEqual(self.read(), {'error_text': True})
        path = self.state.root/records.SETTINGS_FILE
        path.rename(self.state.root/'real.json')
        path.symlink_to(self.state.root/'real.json')
        self.assertEqual(self.read(), {'error_text': False})           # a link is not followed

    def test_a_state_directory_that_cannot_be_trusted_is_not_written_and_a_missing_one_is_made(self):
        self.state.root.chmod(0o755)
        self.assertEqual(records.write_settings(self.state.root, UID, True), {'ok': False, 'reason': 'unwritable'})
        self.assertFalse((self.state.root/records.SETTINGS_FILE).exists())
        self.state.root.chmod(0o700)
        fresh = self.root/'fresh-state'
        self.assertTrue(records.write_settings(fresh, UID, True)['ok'])
        self.assertEqual(stat.S_IMODE(os.stat(fresh).st_mode), 0o700)
        self.assertEqual(records.read_settings(fresh, UID), {'error_text': True})


class ControlTests(EngineCase):
    def record(self, kind='bridge', pid=4242, started=NOW-900):
        directory = getattr(self.state, kind)('c1', pid, started)
        [record] = [item for item in records.load_records(self.state.root, UID) if item.kind == kind]
        return directory, record

    def test_one_json_line_out_one_back_with_the_identity_exactly_as_recorded(self):
        directory, record = self.record()
        server = self.serve(directory, 4242, NOW-900, lambda request: {'released': True, 'reason': None, 'scope_count': 2})
        self.assertEqual(records.control_request(record, 'release', UID),
                         {'released': True, 'reason': None, 'scope_count': 2})
        self.assertEqual(server.requests, [{'action': 'release', 'pid': 4242, 'started_at': NOW-900}])

    def test_a_writer_that_does_not_recognise_the_identity_closes_without_an_answer(self):
        directory, record = self.record()
        self.serve(directory, 4242, NOW-901, lambda request: {'released': True})
        with self.assertRaises(records.ControlError) as caught:
            records.control_request(record, 'release', UID)
        self.assertEqual(caught.exception.kind, 'no_answer')

    def test_a_slow_writer_times_out_a_stale_socket_is_unreachable_and_no_socket_is_missing(self):
        directory, record = self.record()
        with self.assertRaises(records.ControlError) as caught:
            records.control_request(record, 'release', UID)
        self.assertEqual(caught.exception.kind, 'missing')
        server = self.serve(directory, 4242, NOW-900, lambda request: time.sleep(1.5) or {'released': True})
        with self.assertRaises(records.ControlError) as caught:
            records.control_request(record, 'release', UID, timeout=0.3)
        self.assertEqual(caught.exception.kind, 'timeout')
        server.close()
        with self.assertRaises(records.ControlError) as caught:      # the socket file stays after the writer died
            records.control_request(record, 'release', UID)
        self.assertEqual(caught.exception.kind, 'unreachable')

    def test_replies_that_are_not_a_json_object_are_invalid(self):
        directory, record = self.record()
        server = self.serve(directory, 4242, NOW-900, lambda request: ['not', 'an', 'object'])
        with self.assertRaises(records.ControlError) as caught:
            records.control_request(record, 'status', UID)
        self.assertEqual(caught.exception.kind, 'invalid')

    def test_a_socket_that_is_not_private_or_not_a_socket_is_not_used(self):
        directory, record = self.record()
        server = self.serve(directory, 4242, NOW-900, lambda request: {'released': True})
        self.assertEqual(records.control_socket(record, UID), directory/'control.sock')
        os.chmod(directory/'control.sock', 0o666)
        self.assertIsNone(records.control_socket(record, UID))
        server.close()
        (directory/'control.sock').unlink()
        (directory/'control.sock').write_text('not a socket')
        os.chmod(directory/'control.sock', 0o600)
        self.assertIsNone(records.control_socket(record, UID))

    def test_the_socket_of_the_record_directory_is_used_whatever_control_path_says(self):
        directory, record = self.record('relay', pid=5151)
        other = self.state.relay('other', 5152, NOW-900)
        self.serve(other, 5152, NOW-900, lambda request: {'released': True, 'scope_count': 9})
        record.data['control_path'] = str(other/'control.sock')
        with self.assertRaises(records.ControlError) as caught:
            records.control_request(record, 'release', UID)
        self.assertEqual(caught.exception.kind, 'missing')


class CleanupTests(EngineCase):
    def load(self, kind='bridge'):
        return [record for record in records.load_records(self.state.root, UID) if record.kind == kind]

    def test_removing_a_session_keeps_the_other_scopes_and_every_other_field(self):
        directory = self.state.bridge('a1', 4242, NOW-900, cleanup='not_confirmed', future='keep', scopes=[
            State.scope(SESSION_A), State.scope(SESSION_B), State.scope(SESSION_A, turn='turn-2'), 'odd entry'],
            updated_at='2026-10-18T11:59:00Z')
        [record] = self.load()
        self.assertTrue(records.remove_sessions(self.state.root, UID, record, {SESSION_A}))
        data = json.loads((directory/'bridge.json').read_text())
        self.assertEqual([item['session_id'] for item in data['scopes'] if isinstance(item, dict)], [SESSION_B])
        self.assertEqual((data['future'], data['updated_at'], data['cleanup'], data['pid']),
                         ('keep', '2026-10-18T11:59:00Z', 'not_confirmed', 4242))
        self.assertEqual(oct(os.stat(directory/'bridge.json').st_mode & 0o777), '0o600')
        self.assertEqual(sorted(item.name for item in directory.iterdir()), ['bridge.json'])
        self.assertFalse(records.remove_sessions(self.state.root, UID, record, {SESSION_A}))

    def test_the_record_goes_with_its_last_scope_including_its_socket_and_temporary_files(self):
        directory = self.state.relay('b2', 5151, NOW-800, scopes=[State.scope(SESSION_A)])
        (directory/'control.sock').write_text('left over')
        (directory/'relay.json.5151.tmp').write_text('{}')
        (directory/'.tmp-ab12cd').write_text('{}')
        [record] = self.load('relay')
        self.assertTrue(records.remove_sessions(self.state.root, UID, record, {SESSION_A}))
        self.assertFalse(directory.exists())

    def test_a_directory_with_unknown_files_stays_and_names_outside_the_pattern_are_never_deleted(self):
        directory = self.state.relay('b2', 5151, NOW-800, scopes=[State.scope(SESSION_A)])
        (directory/'mystery.txt').write_text('x')
        [record] = self.load('relay')
        records.remove_sessions(self.state.root, UID, record, {SESSION_A})
        self.assertEqual(sorted(item.name for item in directory.iterdir()), ['mystery.txt'])
        foreign = self.state.root/'relays/precious'
        foreign.mkdir(mode=0o700)
        record.directory = foreign
        self.assertFalse(records.delete_record_directory(record, UID))
        self.assertTrue(foreign.exists())

    def test_prune_deletes_only_what_has_nothing_open_and_is_old_enough(self):
        empty = self.state.bridge('empty', 4242, NOW-900)
        open_scope = self.state.bridge('open', 4243, NOW-900, scopes=[State.scope(SESSION_A)])
        fresh = self.state.bridge('fresh', 4244, NOW-900, age=5)
        by_pid = {record.pid: record for record in self.load()}
        self.assertTrue(records.prune(self.state.root, UID, by_pid[4242], now=NOW, min_age=60))
        self.assertFalse(records.prune(self.state.root, UID, by_pid[4243], now=NOW, min_age=60))
        self.assertFalse(records.prune(self.state.root, UID, by_pid[4244], now=NOW, min_age=60))
        self.assertTrue(records.prune(self.state.root, UID, by_pid[4243], droppable={SESSION_A}, now=NOW, min_age=60))
        self.assertEqual([empty.exists(), open_scope.exists(), fresh.exists()], [False, False, True])

    def test_prune_looks_at_the_record_as_it_is_now(self):
        directory = self.state.bridge('a1', 4242, NOW-900)
        [record] = self.load()
        data = json.loads((directory/'bridge.json').read_text())
        data['scopes'] = [State.scope(SESSION_A)]
        (directory/'bridge.json').write_text(json.dumps(data))
        self.assertFalse(records.prune(self.state.root, UID, record))
        self.assertTrue(directory.exists())


class ActivityTests(EngineCase):
    def read(self):
        return records.read_activity(self.state.root, UID)

    def test_valid_lines_are_read_in_order_and_everything_else_is_skipped(self):
        good = State.line('bridge-4242-%d' % (NOW-900), 30, SESSION_A, ms=1234)
        self.state.activity([
            good, 'not json\n', '[1, 2]\n', State.line('relay-5151-%d' % (NOW-800), 20, None, tool='turn_ended', ok=False),
            {**good, 'writer': 'someone-else'}, {**good, 'tool': 'js; rm -rf'}, {**good, 'ok': 'yes'},
            {**good, 'ms': -5}, {**good, 'at': 'noon'}, {**good, 'session_id': 'a b'}, {**good, 'ms': True},
            {**good, 'extra': 'ignored'}])
        lines = self.read()
        self.assertEqual([(item['writer'].split('-')[0], item['tool'], item['ok'], item['ms'], item['session_id'])
                          for item in lines],
                         [('bridge', 'js', True, 1234, SESSION_A), ('relay', 'turn_ended', False, 1000, None),
                          ('bridge', 'js', True, 1234, SESSION_A)])
        self.assertEqual(lines[0]['at'], at(30))

    def test_a_line_carries_the_bridge_its_runtime_serves_only_when_that_is_a_bridges_name(self):
        bridge, relay = 'bridge-4242-%d' % (NOW-900), 'relay-5151-%d' % (NOW-800)
        self.state.activity([
            State.line(relay, 60, SESSION_A, owner=bridge),
            State.line(relay, 50, SESSION_A),                                          # an older relay's, or Codex's
            State.line(relay, 40, SESSION_A, owner='relay-4242-%d' % (NOW-900)),       # a relay is nobody's owner
            State.line(relay, 30, SESSION_A, owner='bridge-4242-x'),
            State.line(relay, 20, SESSION_A, owner='bridge-%s-1' % ('9'*11)),
            State.line(relay, 10, SESSION_A, owner=bridge+'; rm'),
            State.line(relay, 5, SESSION_A, owner=4242)])
        lines = self.read()
        # A value that does not fit costs the line nothing but that value: the line itself is still a call.
        self.assertEqual(len(lines), 7)
        self.assertEqual([item['owner'] for item in lines], [bridge, None, None, None, None, None, None])

    def test_a_failed_call_s_line_says_why_only_in_a_known_word(self):
        writer = 'bridge-4242-%d' % (NOW-900)
        self.state.activity([
            State.line(writer, 60, ok=False, error='timeout'), State.line(writer, 50, ok=False, error='screen_locked'),
            State.line(writer, 40, ok=False, error='error'), State.line(writer, 30, ok=False),     # an older writer's
            State.line(writer, 20, ok=False, error='The Mac is locked'), State.line(writer, 10, ok=False, error=7),
            State.line(writer, 5, ok=True, error='timeout')])
        lines = self.read()
        # A value that does not fit costs the line nothing but that value, and a call that worked has no reason.
        self.assertEqual([(item['ok'], item['error']) for item in lines], [
            (False, 'timeout'), (False, 'screen_locked'), (False, 'error'), (False, None), (False, None), (False, None),
            (True, None)])

    def test_a_failed_call_s_line_keeps_its_error_text_only_as_a_text(self):
        writer = 'bridge-4242-%d' % (NOW-900)
        self.state.activity([
            State.line(writer, 60, ok=False, error='error', error_text='TypeError: x is not a function'),
            State.line(writer, 50, ok=False, error='error'), State.line(writer, 40, ok=False, error_text='   '),
            State.line(writer, 30, ok=False, error_text=7), State.line(writer, 20, ok=True, error_text='kept by mistake'),
            State.line(writer, 10, ok=False, error_text='x'*(records.ERROR_TEXT_LIMIT+50))])
        lines = self.read()
        self.assertEqual([item['error_text'] for item in lines[:5]], ['TypeError: x is not a function', None, None, None, None])
        self.assertEqual(lines[5]['error_text'], 'x'*records.ERROR_TEXT_LIMIT, 'never longer than a writer keeps it')

    def test_only_the_tail_of_a_big_file_is_read_and_a_cut_first_line_is_skipped(self):
        old = records.ACTIVITY_TAIL_BYTES
        records.ACTIVITY_TAIL_BYTES = 600
        self.addCleanup(setattr, records, 'ACTIVITY_TAIL_BYTES', old)
        writer = 'bridge-4242-%d' % (NOW-900)
        self.state.activity([State.line(writer, 1000-index, SESSION_A, ms=index) for index in range(20)])
        lines = self.read()
        self.assertTrue(0 < len(lines) < 20)
        self.assertEqual(lines[-1]['ms'], 19)
        self.assertEqual([item['ms'] for item in lines], list(range(20-len(lines), 20)))

    def test_missing_unsafe_or_foreign_files_give_nothing(self):
        self.assertEqual(self.read(), [])
        self.state.activity([State.line('bridge-4242-%d' % (NOW-900), 30)])
        path = self.state.root/'activity.jsonl'
        path.chmod(0o644)
        self.assertEqual(self.read(), [])
        path.chmod(0o600)
        path.rename(self.state.root/'real.jsonl')
        path.symlink_to(self.state.root/'real.jsonl')
        self.assertEqual(self.read(), [])


if __name__ == '__main__':
    unittest.main()
