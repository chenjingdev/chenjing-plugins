"""unlock-reset: when the computer-use service is restarted for a locked Mac, and everything it never touches (F8)."""
import fcntl
import json
import os
import plistlib
import signal
import types

import engine_status
import engine_unlock
from engine_support import ENGINE_PID, NOW, SESSION_A, UID, EngineCase, State

SERVICE_PID = 7000
BRIDGE = 'bridge-4242-%d' % (NOW-900)
RELAY = 'relay-3001-%d' % (NOW-2000)
LOCKED_AT = NOW-600


class UnlockCase(EngineCase):
    def setUp(self):
        super().setUp()
        self.start_world()
        self.machine.add(ENGINE_PID, 1, '/usr/bin/python3 setup.py unlock-reset', start=NOW-5)
        self.service = str(self.home/'.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService')
        self.machine.add(SERVICE_PID, 1000, self.service, start=NOW-3000)
        self.locked = True
        self.locked_at = LOCKED_AT       # None: the registry does not say when
        self.signed = {SERVICE_PID}

    def run_tool(self, argv, timeout=None, environment=None):
        """The fake Mac, plus the IO registry and codesign."""
        if argv[0] == '/usr/sbin/ioreg':
            self.machine.commands.append(list(argv))
            user = {'kCGSSessionUserIDKey': UID, 'kCGSSessionOnConsoleKey': True, 'kCGSSessionUserNameKey': 'someone'}
            if self.locked:
                user['CGSSessionScreenIsLocked'] = True
                if self.locked_at is not None:
                    user['CGSSessionScreenLockedTime'] = int(self.locked_at)
            other = {'kCGSSessionUserIDKey': UID+1, 'kCGSSessionOnConsoleKey': False, 'CGSSessionScreenIsLocked': True}
            root = {'IOConsoleLocked': False, 'IOConsoleUsers': [other, user]}
            return types.SimpleNamespace(returncode=0, stdout=plistlib.dumps(root).decode())
        if argv[0] == '/usr/bin/codesign':
            self.machine.commands.append(list(argv))
            return types.SimpleNamespace(returncode=0 if int(argv[-1]) in self.signed else 3, stdout='')
        return self.machine.run(argv, timeout=timeout, environment=environment)

    def reset(self):
        return engine_unlock.unlock_reset(self.context(run=self.run_tool))

    def failed(self, seconds_ago, ms=15000, writer=BRIDGE):
        return State.line(writer, seconds_ago, SESSION_A, ok=False, ms=ms, error='unlock_failed', cwd='/work/a')

    @staticmethod
    def restart(seconds_ago, ok=True):
        line = State.line('engine-%d-%d' % (ENGINE_PID, NOW-5000), seconds_ago, tool='unlock_reset', ok=ok, ms=800)
        if not ok:
            line['error'] = 'error'
        return line

    def lines(self):
        path = self.state.root/'activity.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def restarts_written(self):
        return [line for line in self.lines() if line['tool'] == 'unlock_reset']

    def terms(self):
        return [pid for pid, number in self.machine.signals if number == signal.SIGTERM]

    def assertUntouched(self, answer, reason, restarts=0):
        self.assertEqual(answer['reason'], reason)
        self.assertFalse(answer['ok'])
        self.assertEqual(answer['restarts'], restarts)
        self.assertEqual(self.machine.signals, [])
        self.assertIn(SERVICE_PID, self.machine.procs)


class WhenTests(UnlockCase):
    def test_a_mac_that_is_not_locked_is_left_alone(self):
        self.locked = False
        self.state.activity([self.failed(300), self.failed(200)])
        self.assertUntouched(self.reset(), 'not_locked')
        self.assertEqual(self.reset()['locked_at'], None)
        # Not even the process list was read.
        self.assertFalse(any(argv[0] in ('/bin/ps', '/usr/bin/codesign') for argv in self.machine.commands))

    def test_a_call_the_service_could_not_unlock_for_restarts_it(self):
        self.state.activity([self.failed(200)])
        answer = self.reset()
        self.assertEqual(answer, {'ok': True, 'reason': None, 'restarts': 1, 'limit': 5,
                                  'locked_at': '2026-10-18T11:50:00Z'})
        self.assertEqual(self.machine.signals, [(SERVICE_PID, signal.SIGTERM)])
        self.assertNotIn(SERVICE_PID, self.machine.procs)
        written = self.restarts_written()
        self.assertEqual(len(written), 1)
        self.assertEqual(written[0]['writer'], 'engine-%d-%d' % (ENGINE_PID, NOW-5))
        self.assertEqual((written[0]['ok'], written[0]['session_id']), (True, None))
        self.assertNotIn('error', written[0])

    def test_a_try_that_failed_and_a_refusal_without_one_alike(self):
        # The service refuses at once when it has no try left (its tries went to calls the log does not have); a try
        # that failed leaves it a second one, but a restart gives two again, and the next call is a new try either way.
        for ms in (200, 15000):
            self.machine.add(SERVICE_PID, 1000, self.service, start=NOW-3000)
            self.state.activity([self.failed(100, ms=ms)])
            self.assertTrue(self.reset()['ok'], ms)

    def test_failures_from_before_this_lock_do_not_count(self):
        self.state.activity([self.failed(900), self.failed(800)])
        self.assertUntouched(self.reset(), 'not_needed')

    def test_other_failures_do_not_count(self):
        self.state.activity([State.line(BRIDGE, 300, ok=False, ms=200, error='screen_locked'),
                             State.line(BRIDGE, 200, ok=False, ms=200, error='error'),
                             State.line(BRIDGE, 100, ok=False, ms=200, error='timeout')])
        self.assertUntouched(self.reset(), 'not_needed')

    def test_a_relay_s_lines_count_like_a_bridge_s(self):
        self.state.activity([self.failed(300, writer=RELAY), self.failed(200)])
        self.assertTrue(self.reset()['ok'])

    def test_after_a_restart_only_a_newer_failure_restarts_it_again(self):
        self.state.activity([self.failed(500), self.failed(450), self.restart(400)])
        self.assertUntouched(self.reset(), 'not_needed', restarts=1)
        self.state.activity([self.failed(500), self.failed(450), self.restart(400), self.failed(300)])
        answer = self.reset()
        self.assertEqual((answer['ok'], answer['restarts']), (True, 2))

    def test_at_most_five_restarts_in_one_lock(self):
        self.state.activity([self.restart(500), self.restart(450), self.restart(400), self.restart(350, ok=False),
                             self.restart(300), self.failed(200)])
        self.assertUntouched(self.reset(), 'limit', restarts=5)
        self.assertEqual(len(self.restarts_written()), 5, 'the limit writes no line')

    def test_the_restarts_of_an_earlier_lock_do_not_count(self):
        self.state.activity([self.restart(1000), self.restart(950), self.restart(900), self.restart(850),
                             self.restart(800), self.failed(200)])
        answer = self.reset()
        self.assertEqual((answer['ok'], answer['restarts']), (True, 1))

    def test_without_the_lock_s_start_the_lock_is_what_came_after_the_last_call_that_worked(self):
        self.locked_at = None
        worked = State.line(BRIDGE, 700, SESSION_A)
        ended = State.line(BRIDGE, 350, SESSION_A, tool='turn_ended')      # an AI's own end says nothing of the screen
        self.state.activity([self.failed(900), self.failed(800), worked, self.failed(400), ended, self.failed(300)])
        answer = self.reset()
        self.assertEqual((answer['ok'], answer['restarts'], answer['locked_at']), (True, 1, None))
        self.machine.add(SERVICE_PID+1, 1000, self.service, start=NOW)
        self.state.activity([self.failed(500), self.failed(400), State.line(BRIDGE, 300, SESSION_A)])
        self.assertEqual(self.reset()['reason'], 'not_needed')

    def test_the_lock_s_start_is_believed_in_either_count_of_seconds_and_only_when_it_is_recent(self):
        self.assertEqual(engine_unlock.lock_time(NOW-60, NOW), NOW-60)
        self.assertEqual(engine_unlock.lock_time(NOW-60-engine_unlock.CF_EPOCH, NOW), NOW-60)
        for value in (None, True, '1792320000', NOW-40*86400, NOW+3600, 0):
            self.assertIsNone(engine_unlock.lock_time(value, NOW), value)


class SafetyTests(UnlockCase):
    def setUp(self):
        super().setUp()
        self.state.activity([self.failed(300), self.failed(200)])

    def busy_bridge(self, busy=True):
        self.add_claude()
        self.add_bridge(4242)
        return self.state.bridge('a', 4242, NOW-900, busy=busy, session_id=SESSION_A)

    def test_a_running_call_is_waited_for(self):
        self.busy_bridge()
        self.machine.later(5, lambda: self.state.bridge('a', 4242, NOW-900, busy=False, session_id=SESSION_A))
        self.assertTrue(self.reset()['ok'])
        self.assertGreaterEqual(self.machine.now, NOW+5)

    def test_a_call_still_running_after_the_wait_keeps_the_service(self):
        self.busy_bridge()
        self.assertUntouched(self.reset(), 'call_in_flight')
        self.assertEqual(self.restarts_written(), [])

    def test_a_person_who_unlocked_meanwhile_keeps_the_service(self):
        self.busy_bridge()
        self.machine.later(2, lambda: setattr(self, 'locked', False))
        self.machine.later(5, lambda: self.state.bridge('a', 4242, NOW-900, busy=False, session_id=SESSION_A))
        self.assertUntouched(self.reset(), 'not_locked')

    def test_no_service_running_needs_nothing(self):
        # The next CUA call starts one, with its tries.
        self.machine.remove(SERVICE_PID)
        self.assertEqual(self.reset()['reason'], 'not_running')
        self.assertEqual(self.machine.signals, [])

    def test_only_this_user_s_service_of_a_codex_computer_use_app_is_looked_at(self):
        self.machine.remove(SERVICE_PID)
        self.machine.add(7001, 1, self.service, uid=UID+1)
        self.machine.add(7002, 1, '/tmp/SkyComputerUseService')
        self.machine.add(7003, 1, '/tmp/x'+self.service[len('/'):]+'-copy')
        self.machine.add(7004, 1, '/usr/bin/grep '+self.service)
        self.assertEqual(self.reset()['reason'], 'not_running')
        self.assertEqual(self.machine.signals, [])

    def test_a_service_that_is_not_signed_by_openai_is_never_signalled(self):
        self.signed = set()
        self.assertUntouched(self.reset(), 'not_ours')
        checked = [argv for argv in self.machine.commands if argv[0] == '/usr/bin/codesign']
        self.assertEqual(checked, [['/usr/bin/codesign', '--verify', '-R='+engine_unlock.SERVICE_REQUIREMENT,
                                    str(SERVICE_PID)]])
        self.assertIn('2DC432GLL2', engine_unlock.SERVICE_REQUIREMENT)
        self.assertIn('com.openai.sky.CUAService', engine_unlock.SERVICE_REQUIREMENT)

    def test_a_service_that_stays_is_never_killed(self):
        self.machine.ignore_term.add(SERVICE_PID)
        answer = self.reset()
        self.assertEqual((answer['ok'], answer['reason'], answer['restarts']), (False, 'still_running', 1))
        self.assertEqual(self.machine.signals, [(SERVICE_PID, signal.SIGTERM)])
        self.assertIn(SERVICE_PID, self.machine.procs)
        # It counts as one of the restarts of this lock.
        self.assertEqual([(line['ok'], line['error']) for line in self.restarts_written()], [(False, 'error')])

    def test_a_service_that_was_replaced_meanwhile_is_not_signalled(self):
        found = engine_unlock.services
        def replaced(ctx):
            procs = found(ctx)
            self.machine.remove(SERVICE_PID)
            self.machine.add(SERVICE_PID, 1000, self.service, start=NOW)
            return procs
        engine_unlock.services, original = replaced, engine_unlock.services
        self.addCleanup(setattr, engine_unlock, 'services', original)
        self.assertTrue(self.reset()['ok'])
        self.assertEqual(self.machine.signals, [])

    def test_one_run_at_a_time(self):
        guard = os.open(self.state.root/engine_unlock.LOCK_FILE, os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, guard)
        fcntl.flock(guard, fcntl.LOCK_EX)
        self.assertUntouched(self.reset(), 'busy')

    def test_without_a_private_state_folder_nothing_failed(self):
        os.chmod(self.state.root, 0o755)
        self.addCleanup(os.chmod, self.state.root, 0o700)
        self.assertUntouched(self.reset(), 'not_needed')


class LineTests(UnlockCase):
    """The restart's line in the 기록 tab: no connection's, no use of the screen."""

    def test_the_engine_s_line_is_nobody_s_call(self):
        self.state.activity([self.failed(300), self.restart(60)])
        status = engine_status.status(self.context(run=self.run_tool))
        engine_lines = [item for item in status['activity'] if item['tool'] == 'unlock_reset']
        self.assertEqual(len(engine_lines), 1)
        self.assertEqual((engine_lines[0]['agent'], engine_lines[0]['connection_id'], engine_lines[0]['ok']),
                         ('engine', None, True))
        self.assertEqual(status['screen']['last_call_at'], '2026-10-18T11:55:00Z', 'the failed call, not the restart')
