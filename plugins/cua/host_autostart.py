"""Open the original app as a host when it is closed; never quit a running app."""
import ctypes
import fcntl
import os
from pathlib import Path
import re
import stat
import subprocess
import threading
import time

from runtime_paths import discover_installation, runtime_home

TIMEOUT_ENV = 'CODEX_HOST_CUA_AUTOSTART_TIMEOUT'
WATCH_SECONDS = 30       # how long an app opened in the background is kept behind once its host is ready
FIRST_CALL_WATCH = 15    # and again from the first tool call after that, however late the call comes
MAX_SENT_BACK = 3        # how often it is sent back per opening, all watches together
WATCH_INTERVAL = 0.25    # how often the front app is looked at meanwhile
CLICK_SECONDS = 1        # a mouse press this recent means a person chose the app that came forward
SETTLE_SECONDS = 1       # Codex still in front this long after it was sent back has come forward again
_CORE_GRAPHICS = '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'
# CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState,
#                                        kCGEventLeftMouseDown or kCGEventRightMouseDown)
# Only the mouse: a modifier key is also down while a person types the first prompt, when Codex tends to come forward.
_HID_SYSTEM_STATE = 1
_MOUSE_PRESSES = (1, 3)
# `lsappinfo info -only bundleid` prints `"CFBundleIdentifier"="…"` on older macOS and several lines with
# `bundleID="…"` on macOS 27.
_BUNDLE_ID = re.compile(r'(?:"CFBundleIdentifier"|\bbundleID)\s*=\s*"([^"\s]+)"')


class AutostartFailure(RuntimeError):
    pass


def launch_environment(state, installation=None, home=None):
    """Variables that make the app select the host launcher instead of its CLI."""
    values = {'CODEX_CLI_PATH': str(runtime_home(home)/'start-desktop-cli.sh'),
              'CODEX_HOST_CUA_STATE_DIR': str(state)}
    if installation is not None:
        values['CODEX_HOST_CUA_NATIVE_CLI'] = str(installation.native_cli)
    return values


def app_processes(executable):
    result = subprocess.run(['/bin/ps', '-axo', 'pid=,comm='], check=True,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5)
    matches = []
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and parts[0].isdigit() and parts[1] == str(executable):
            matches.append(int(parts[0]))
    return matches


def front_bundle():
    try:
        front = subprocess.run(['/usr/bin/lsappinfo', 'front'], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True, timeout=3).stdout.strip()
        if not front:
            return None
        info = subprocess.run(['/usr/bin/lsappinfo', 'info', '-only', 'bundleid', front],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=3).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    match = _BUNDLE_ID.search(info)
    return match.group(1) if match else None


def seconds_since_mouse_press():
    """Seconds since the left or the right mouse button was last pressed, or None when macOS will not say."""
    try:
        reader = ctypes.CDLL(_CORE_GRAPHICS).CGEventSourceSecondsSinceLastEventType
        reader.restype = ctypes.c_double
        reader.argtypes = [ctypes.c_int32, ctypes.c_uint32]
        return min(reader(_HID_SYSTEM_STATE, event) for event in _MOUSE_PRESSES)
    except (OSError, AttributeError):
        return None


def app_running(bundle):
    """Whether an app with this bundle id is running. When lsappinfo cannot say, it counts as running."""
    try:
        found = subprocess.run(['/usr/bin/lsappinfo', 'find', 'bundleid='+bundle], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True, timeout=3).stdout
    except (OSError, subprocess.TimeoutExpired):
        return True
    return bool(found.strip())


def start_in_background(work):
    """Run `work` in a thread of its own. A daemon: this process serves MCP for as long as the conversation lasts
    and must not wait for a watch when it ends."""
    threading.Thread(target=work, name='codex-front-watch', daemon=True).start()


class Watch:
    """Keeps a Codex that this process opened in the background behind, one watch at a time.

    The first-call watch also covers a Codex that replaced that one before the first call (a reconnect found its host
    ready): it is as freshly started, and a person using it has it in front, where nothing is watched.

    Whenever Codex comes to the front by itself, the app that was in front before is brought back, at most
    MAX_SENT_BACK times per opening however many watches there are. A watch ends at its deadline, or at once when a
    person picked Codex (a mouse press just before it came forward).
    """
    def __init__(self):
        self.lock = threading.Lock()
        self.codex = None              # bundle id of the Codex this process opened; None before it did
        self.first_call_due = False    # no tool call has asked for a watch since that opening
        self.sent_back = 0             # how often Codex was sent back since that opening
        self.until = None              # when the running watch ends; None while none runs

    def opened(self, codex):
        with self.lock:
            self.codex, self.first_call_due, self.sent_back = codex, True, 0

    def first_call(self, start=None, sleep=time.sleep, clock=time.monotonic):
        """The first tool call after the opening, however late: watch again, from the app in front at that moment.

        Whether this was the first call is the answer. The front app is read here, before the call goes out: read
        later, a Codex that comes forward within milliseconds would look like one that was in front already. If it
        is Codex, a person may be using it and nothing is watched. The watch itself has a thread of its own.
        """
        with self.lock:
            due, self.first_call_due = self.first_call_due, False
            codex = self.codex
        if not due:
            return False
        until = clock()+FIRST_CALL_WATCH
        back = front_bundle()
        (start or start_in_background)(lambda: self.watch(codex, back, until, sleep, clock))
        return True

    def give_back(self):
        """The call that was the first one never got to Codex: the next call is the first."""
        with self.lock:
            self.first_call_due = self.codex is not None

    def watch(self, codex, back, until, sleep=time.sleep, clock=time.monotonic):
        """Watch in this thread until `until`, bringing `back` forward when Codex comes forward by itself.

        Nothing is watched without an app to bring back. While a watch runs, this only gives it more time.
        """
        if not back or back == codex:
            return
        with self.lock:
            if self.until is not None:
                self.until = max(self.until, until)
                return
            if self.sent_back >= MAX_SENT_BACK:
                return
            self.until = until
        self.keep_behind(codex, back, sleep, clock)

    def going(self, clock):
        with self.lock:
            if clock() < self.until and self.sent_back < MAX_SENT_BACK:
                return True
            self.until = None      # decided under the lock, so that more time asked for meanwhile is not lost
            return False

    def end(self):
        with self.lock:
            self.until = None

    def keep_behind(self, codex, back, sleep, clock):
        """`back` follows the front app while it is not Codex, so a person who moved on gets that app back."""
        forward = False            # Codex was in front at the last look
        sent_at = None             # when it was last sent back
        try:
            while self.going(clock):
                front = front_bundle()
                if front == codex:
                    # It has just come forward, or it came again before the next look and stays in front.
                    if not forward or (sent_at is not None and clock()-sent_at >= SETTLE_SECONDS):
                        forward = True
                        pressed = seconds_since_mouse_press()
                        if pressed is not None and pressed <= CLICK_SECONDS:
                            self.end()     # a person chose it: it stays
                            return
                        back = self.send_back(back)
                        sent_at = clock() if back else None
                elif front:
                    forward = False
                    back = front
                sleep(WATCH_INTERVAL)
        except BaseException:
            self.end()             # a watch that broke off must not make the next one think it still runs
            raise

    def send_back(self, back):
        """Bring `back` forward again. None once it has quit: the next app to come forward takes its place."""
        if back is None or not app_running(back):
            return None
        with self.lock:
            self.sent_back += 1
        try:
            subprocess.run(['/usr/bin/open', '-b', back],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            pass    # counted all the same, and not tried again for this coming forward
        return back


WATCH = Watch()


def watch_first_call(start=None, sleep=time.sleep, clock=time.monotonic):
    """For the MCP server, before a tool call goes out: the first one after this process opened Codex asks for a
    watch. It reads the front app, which takes a moment, and says whether this call was the first."""
    return WATCH.first_call(start, sleep, clock)


def give_back_first_call():
    """For the MCP server: the call that was the first one failed, so the chance is the next call's."""
    WATCH.give_back()


def _timeout(environment):
    try:
        value = float(environment.get(TIMEOUT_ENV, 25))
    except (TypeError, ValueError):
        return 25.0
    return value if 0 < value <= 120 else 25.0


def _lock(state):
    state.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = state.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise AutostartFailure('The Codex host state directory must be private and owned (0700).')
    flags = os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0)
    return os.open(state/'autostart.lock', flags, 0o600)


def ensure_host(state, read_registry, environment=None, home=None, sleep=time.sleep, clock=time.monotonic,
                start=None, log=None):
    """Return the ready registry, opening the closed app in the background first.

    Concurrent MCP sessions serialize on one lock, so the app is opened once.
    An app opened here is then kept behind (see Watch): for WATCH_SECONDS from the moment its host is ready, and
    again at the first tool call. `start` runs a watch, in a thread of its own by default; the return does not wait,
    and a watch that cannot start is only logged (`log` gets an event name).
    """
    environment = os.environ if environment is None else environment
    watcher = WATCH
    try:
        registry = read_registry(state)
    except Exception:
        pass
    else:
        return registry
    timeout = _timeout(environment)
    descriptor = _lock(state)
    try:
        deadline = clock()+timeout
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if clock() >= deadline:
                    raise AutostartFailure('Another session is still opening Codex; reconnect this MCP shortly.') from None
                sleep(0.1)
        try:
            registry = read_registry(state)
        except Exception:
            pass
        else:
            return registry
        installation = discover_installation(environment, home)
        if app_processes(installation.executable):
            raise AutostartFailure('Codex is open without the host listener. Quit Codex normally (Cmd+Q), '
                                   'reopen it, then reconnect this MCP. No app was quit.')
        previous = front_bundle()
        command = ['/usr/bin/open', '-g', '-j', '-a', str(installation.app_path)]
        for key, value in launch_environment(state, installation, home).items():
            command += ['--env', key+'='+value]
        if subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15).returncode != 0:
            raise AutostartFailure('Codex could not be opened in the background.')
        registry = None
        chosen = False    # a person pressed the mouse just before Codex came forward or while it was in front
        while registry is None:
            try:
                registry = read_registry(state)
            except Exception:
                if clock() >= deadline:
                    # A login, permission or update window may be waiting unseen.
                    subprocess.run(['/usr/bin/open', '-b', installation.bundle_id],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
                    raise AutostartFailure('Codex opened but its host did not become ready in time. '
                                           'Check the Codex window for a login or permission prompt, '
                                           'then reconnect this MCP.') from None
                # A person may move on while the host starts: that app is the one to bring back. Or the person
                # chooses Codex, with a mouse press just before it comes forward or while it is in front: it stays
                # until another app comes forward. Nothing is brought back before the host is ready.
                front = front_bundle()
                if front == installation.bundle_id:
                    if not chosen:
                        pressed = seconds_since_mouse_press()
                        chosen = pressed is not None and pressed <= CLICK_SECONDS
                elif front:
                    chosen = False
                    previous = front
                sleep(0.2)
        watcher.opened(installation.bundle_id)
        if previous and previous != installation.bundle_id and not chosen:
            until = clock()+WATCH_SECONDS
            codex = installation.bundle_id
            try:
                (start or start_in_background)(lambda: watcher.watch(codex, previous, until, sleep, clock))
            except RuntimeError:
                # A watch is a nicety: a thread that cannot start must not fail the connection. Only that is caught,
                # so an error inside a watch run in place (the tests do) still shows.
                if log is not None:
                    log('open_watch_unavailable')
        return registry
    finally:
        os.close(descriptor)
