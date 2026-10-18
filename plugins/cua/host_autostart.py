"""Open the original app as a host when it is closed; never quit a running app."""
import fcntl
import os
from pathlib import Path
import stat
import subprocess
import time

from runtime_paths import discover_installation, runtime_home

AUTOSTART_ENV = 'CODEX_HOST_CUA_AUTOSTART'
TIMEOUT_ENV = 'CODEX_HOST_CUA_AUTOSTART_TIMEOUT'


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
    _, _, value = info.partition('=')
    value = value.strip().strip('"')
    return value or None


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


def ensure_host(state, read_registry, environment=None, home=None, sleep=time.sleep, clock=time.monotonic):
    """Return the ready registry, opening the closed app in the background first.

    Concurrent MCP sessions serialize on one lock, so the app is opened once.
    The previous frontmost app gets focus back when Codex activates itself.
    """
    environment = os.environ if environment is None else environment
    try:
        return read_registry(state)
    except Exception:
        pass
    if environment.get(AUTOSTART_ENV, '1') == '0':
        raise AutostartFailure('Start Codex with the prepared host launcher before using this MCP plugin. No runtime was started.')
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
            settle = clock()+3
            while front_bundle() != installation.bundle_id and clock() < settle:
                sleep(0.1)
            if front_bundle() == installation.bundle_id:
                subprocess.run(['/usr/bin/open', '-b', previous],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        return registry
    finally:
        os.close(descriptor)
