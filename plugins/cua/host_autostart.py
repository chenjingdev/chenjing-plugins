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
WATCH_SECONDS = 30       # an app opened in the background is kept behind this long once its host is ready
WATCH_INTERVAL = 0.25    # how often the front app is looked at meanwhile
CLICK_SECONDS = 1        # a mouse press this recent means a person chose the app that came forward
_CORE_GRAPHICS = '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'
# CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState,
#                                        kCGEventLeftMouseDown or kCGEventRightMouseDown)
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


def start_in_background(work):
    """Run `work` in a thread of its own. A daemon: this process serves MCP for as long as the conversation lasts
    and must not wait for the watch when it ends."""
    threading.Thread(target=work, name='codex-front-watch', daemon=True).start()


def keep_behind(back, codex, until, sleep=time.sleep, clock=time.monotonic):
    """Until `until`, bring `back` to the front again whenever Codex comes forward by itself.

    `back` follows the front app while it is not Codex, so a person who moved on meanwhile gets that app back.
    Codex coming forward right after a mouse press was a person's choice: it stays and the watch is over.
    """
    while clock() < until:
        front = front_bundle()
        if front == codex:
            pressed = seconds_since_mouse_press()
            if pressed is not None and pressed <= CLICK_SECONDS:
                return
            try:
                subprocess.run(['/usr/bin/open', '-b', back],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            except (OSError, subprocess.TimeoutExpired):
                pass    # the next look tries again
        elif front:
            back = front
        sleep(WATCH_INTERVAL)


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
                start=start_in_background):
    """Return the ready registry, opening the closed app in the background first.

    Concurrent MCP sessions serialize on one lock, so the app is opened once.
    An app opened here is then kept behind for WATCH_SECONDS: whenever it activates itself, the previous frontmost
    app gets focus back. `start` runs that watch (a thread of its own by default); the return does not wait for it.
    """
    environment = os.environ if environment is None else environment
    try:
        return read_registry(state)
    except Exception:
        pass
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
            return read_registry(state)
        except Exception:
            pass
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
                sleep(0.2)
        if previous and previous != installation.bundle_id:
            until = clock()+WATCH_SECONDS
            start(lambda: keep_behind(previous, installation.bundle_id, until, sleep, clock))
        return registry
    finally:
        os.close(descriptor)
