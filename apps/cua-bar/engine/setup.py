#!/usr/bin/env python3
"""Private dependency bootstrap and stable user command; never auto-restart apps."""
import argparse
import asyncio
import contextlib
import fcntl
import json
import math
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time

sys.dont_write_bytecode = True
PLUGIN_ID = 'cua@chenjing-plugins'
MARKER = '# codex-cua authored command v1'
DEPENDENCY = 'websockets==12.0'
LOGIN_LABEL = 'com.chenjingdev.codex-cua.env'
# What the login agent runs. macOS lists the agent under Login Items by this name; with `/bin/sh -c`
# it said only `sh`.
LOGIN_SCRIPT = 'codex-cua-login-env'
FALLBACK_ENV = 'CODEX_CUA_FALLBACK_NATIVE'
ROOT_RESOLVED_FLAG = '--root-resolved'
# Commands of the menu bar app's engine (engine_cli.py): one JSON object on stdout.
ENGINE_COMMANDS = ('status', 'release', 'release-session', 'stop', 'restart-codex', 'diagnose')


def support_root(home=None):
    return (Path.home() if home is None else Path(home))/'.local/share/codex-cua'


def private_directory(path):
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) & 0o077):
        raise RuntimeError('The codex-cua support directory must be private and owned (0700).')


def private_json(path):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) & 0o077):
        raise RuntimeError('The codex-cua source binding must be private and owned (0600).')
    parent = path.parent.lstat()
    if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid()
            or stat.S_IMODE(parent.st_mode) & 0o077):
        raise RuntimeError('The codex-cua support directory must be private and owned (0700).')
    return json.loads(path.read_text())


def write_private(path, value):
    descriptor, name = tempfile.mkstemp(dir=str(path.parent), prefix='.codex-cua-')
    try:
        with os.fdopen(descriptor, 'w') as output:
            output.write(value)
        os.replace(name, path)
    finally:
        try:
            os.unlink(name)
        except FileNotFoundError:
            pass


def validated_plugin_root(path, version=None):
    """The real path of an engine folder (the manifest of `cua`, and the files every run needs), or RuntimeError."""
    path = Path(path).expanduser()
    if not path.is_absolute():
        raise RuntimeError('The engine path must be absolute.')
    path = path.resolve(strict=True)
    manifest_path = path/'.claude-plugin/plugin.json'
    manifest = json.loads(manifest_path.read_text())
    if (path.stat().st_uid != os.getuid() or manifest_path.stat().st_uid != os.getuid()
            or manifest.get('name') != 'cua'
            or not isinstance(manifest.get('version'), str)
            or (version is not None and manifest['version'] != version)
            or not all((path/name).is_file() for name in ('setup.py', 'runtime_paths.py', 'start-mcp.sh'))):
        raise RuntimeError('The engine source is invalid or unavailable.')
    return path


def resolve_plugin_root(home=None):
    """The engine folder `codex-cua setup` bound (source.json), and nothing else.

    Claude Code's plugin registry is not read: a cua plugin that is still installed does not matter here.
    """
    home = Path.home() if home is None else Path(home)
    binding = private_json(support_root(home)/'source.json')
    if (not isinstance(binding, dict) or binding.get('schema_version') != 1
            or binding.get('plugin_id') != PLUGIN_ID or not isinstance(binding.get('source_root'), str)):
        raise RuntimeError('The codex-cua source binding is invalid.')
    return validated_plugin_root(binding['source_root'])


def venv_ready(root):
    python = root/'venv/bin/python3'
    try:
        if not python.is_file():
            return False
        result = subprocess.run([str(python), '-I', '-c',
            'import sys,websockets;sys.exit(0 if sys.version_info >= (3,9) and websockets.__version__ == "12.0" else 1)'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


# The lock files this thread holds (by support folder): asking for one again would make it wait for itself.
_held_locks = threading.local()


@contextlib.contextmanager
def setup_lock(root):
    """Hold <support>/.setup.lock: one dependency bootstrap or engine install at a time.

    A thread that holds it passes through (an engine install runs the dependency bootstrap inside its own hold);
    any other thread or process waits for it, up to 320 seconds."""
    held = getattr(_held_locks, 'paths', None)
    if held is None:
        held = _held_locks.paths = set()
    key = str(root)
    if key in held:
        yield
        return
    flags = os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(root/'.setup.lock', flags, 0o600)
    lock_info = os.fstat(descriptor)
    if (not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != os.getuid()
            or stat.S_IMODE(lock_info.st_mode) & 0o077):
        os.close(descriptor)
        raise RuntimeError('The dependency setup lock must be private and owned.')
    with os.fdopen(descriptor, 'a+') as lock:
        deadline = time.monotonic()+320
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('Another setup did not finish before the deadline.') from None
                time.sleep(0.1)
        held.add(key)
        try:
            yield
        finally:
            held.discard(key)


def ensure_dependencies(home=None, repair=True):
    """The private interpreter, prepared if needed. With repair=False it only reports readiness."""
    if sys.version_info < (3, 9):
        raise RuntimeError('Python 3.9 or newer is required; no package manager was installed.')
    root = support_root(home)
    private_directory(root)
    if venv_ready(root):
        return root/'venv/bin/python3'
    if not repair:
        raise RuntimeError('The private Python runtime is not ready; run codex-cua setup.')
    with setup_lock(root):
        if venv_ready(root):
            return root/'venv/bin/python3'
        venv = root/'venv'
        if venv.exists() and (venv.is_symlink() or not venv.is_dir() or venv.stat().st_uid != os.getuid()):
            raise RuntimeError('The private Python runtime is not owned.')
        print('codex-cua: preparing private Python runtime', file=sys.stderr)
        if not (venv/'bin/python3').is_file():
            subprocess.run([sys.executable, '-m', 'venv', str(venv)], check=True,
                           stdout=sys.stderr, stderr=sys.stderr, timeout=120)
        pip = subprocess.run([str(venv/'bin/python3'), '-I', '-m', 'pip', '--version'],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        if pip.returncode != 0:
            # Repair only this owned environment after an interrupted bootstrap.
            subprocess.run([str(venv/'bin/python3'), '-I', '-m', 'ensurepip', '--upgrade'],
                           check=True, stdout=sys.stderr, stderr=sys.stderr, timeout=60)
        subprocess.run([str(venv/'bin/python3'), '-m', 'pip', '--isolated', 'install',
                        '--index-url', 'https://pypi.org/simple', '--disable-pip-version-check', DEPENDENCY],
                       check=True, stdout=sys.stderr, stderr=sys.stderr, timeout=180)
        if not venv_ready(root):
            raise RuntimeError('The private dependency verification failed.')
    return root/'venv/bin/python3'


def original_cli_path(home=None, environment=None):
    """The installed original CLI that the launcher may start instead of the plugin, or None."""
    try:
        from runtime_paths import discover_installation
        return str(discover_installation(environment, home).native_cli)
    except Exception:
        return None


def desktop_launcher(python, command, native=None):
    """Script that Codex Desktop runs as its CLI on every launch.

    Codex must start even when this plugin is broken or gone, so with a known original CLI
    the shell itself starts that CLI unless the interpreter and command copy are in place.
    A failed exec would end a non-interactive shell, hence the checks before it.
    """
    run = ('exec '+shlex.quote(str(python))+' '+shlex.quote(str(command))
           +' --control ensure --exec-wrapper -- "$@"\n')
    head = '#!/bin/sh\n'+MARKER+'\n'
    if native is None:
        return head+run
    return (head+FALLBACK_ENV+'='+shlex.quote(str(native))+'\nexport '+FALLBACK_ENV+'\n'
            +'if [ -x '+shlex.quote(str(python))+' ] && [ -f '+shlex.quote(str(command))+' ]; then\n'
            +'  '+run+'fi\n'
            +'exec "$'+FALLBACK_ENV+'" "$@"\n')


def install_command(plugin_root, home=None, environment=None):
    home = Path.home() if home is None else Path(home)
    root = support_root(home)
    plugin_root = validated_plugin_root(plugin_root)
    target = home/'.local/bin/codex-cua'
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() or target.is_symlink():
        info = target.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or MARKER not in target.read_text().splitlines()[:3]):
            raise RuntimeError('An unrelated codex-cua command already exists; it was preserved.')
    python = ensure_dependencies(home)
    write_private(root/'source.json', json.dumps({'schema_version': 1, 'plugin_id': PLUGIN_ID,
                                                 'source_root': str(plugin_root)})+'\n')
    write_private(root/'command.py', (plugin_root/'setup.py').read_text())
    command = '#!/bin/sh\n'+MARKER+'\nexec '+shlex.quote(str(python))+' '+shlex.quote(str(root/'command.py'))+' --control "$@"\n'
    # Atomic replace only after inspecting the previous authored command.
    write_private(target, command)
    target.chmod(0o700)
    # The app may select this launcher on every launch, so a broken plugin
    # install falls back to the original CLI instead of stopping Codex.
    launcher = desktop_launcher(python, root/'command.py', original_cli_path(home, environment))
    write_private(root/'start-desktop-cli.sh', launcher)
    (root/'start-desktop-cli.sh').chmod(0o700)
    install_relay(plugin_root, home)
    return target


def install_relay(plugin_root, home=None):
    """Copy the relay files to the support directory (the Codex launcher refreshes them at every start).

    The CUA connection works without the relay, so a failure here only shows up as `relay` in doctor.
    """
    try:
        from relay_install import refresh_relay_files
        refresh_relay_files(plugin_root, support_root(home))
        return True
    except Exception:
        return False


def relay_status(home=None):
    try:
        from relay_install import relay_files_status
        return relay_files_status(support_root(home))
    except Exception:
        return 'invalid'


def run_setup(plugin_root, home=None, environment=None):
    """The usual `setup` for the engine folder `plugin_root`: its command, the login environment and the relay files.

    Returns the command path, the login environment (ready, conflict or failed) and the relay files state."""
    target = install_command(plugin_root, home, environment)
    try:
        login = install_login_environment(home, environment)
    except Exception:
        login = 'failed'
    return target, login, relay_status(home)


def app_processes(executable):
    from host_autostart import app_processes as inventory
    return inventory(executable)


def login_agent_path(home=None):
    return (Path.home() if home is None else Path(home))/'Library/LaunchAgents'/(LOGIN_LABEL+'.plist')


def login_script_path(home=None):
    return support_root(home)/LOGIN_SCRIPT


def launchd_value(key):
    result = subprocess.run(['/bin/launchctl', 'getenv', key], stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, timeout=5)
    return result.stdout.strip()


def login_values(home=None, environment=None):
    from host_autostart import launch_environment
    return launch_environment(configured_state(environment, home), home=home)


def login_environment_status(home=None, environment=None):
    # A missing agent is reported without asking launchd.
    if not login_agent_path(home).is_file():
        return 'missing'
    values = login_values(home, environment)
    return 'ready' if all(launchd_value(key) == value for key, value in values.items()) else 'stale'


def install_login_environment(home=None, environment=None):
    """Let an ordinary Dock/Finder launch select the host launcher too."""
    values = login_values(home, environment)
    for key, value in values.items():
        current = launchd_value(key)
        if current and current != value:
            return 'conflict'
    path = login_agent_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    script = login_script_path(home)
    script.parent.mkdir(parents=True, exist_ok=True)
    write_private(script, '#!/bin/sh\n'+MARKER+'\n'+''.join(
        '/bin/launchctl setenv '+shlex.quote(key)+' '+shlex.quote(value)+'\n' for key, value in values.items()))
    script.chmod(0o700)
    write_private(path, plistlib.dumps({'Label': LOGIN_LABEL, 'ProgramArguments': [str(script)],
                                        'RunAtLoad': True}).decode())
    for key, value in values.items():
        subprocess.run(['/bin/launchctl', 'setenv', key, value], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    return 'ready'


def remove_login_environment(home=None, environment=None):
    path = login_agent_path(home)
    if path.is_file():
        if plistlib.loads(path.read_bytes()).get('Label') != LOGIN_LABEL:
            raise RuntimeError('An unrelated login agent was preserved.')
        path.unlink()
    script = login_script_path(home)
    try:
        if MARKER in script.read_text().splitlines()[:3]:
            script.unlink()
    except (OSError, UnicodeError):
        pass
    for key, value in login_values(home, environment).items():
        if launchd_value(key) == value:
            subprocess.run(['/bin/launchctl', 'unsetenv', key], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)


def configured_state(environment=None, home=None):
    environment = os.environ if environment is None else environment
    from runtime_paths import default_state
    return Path(environment.get('CODEX_HOST_CUA_STATE_DIR', str(default_state(home)))).expanduser()


def start_host(plugin_root, environment=None, home=None):
    environment = dict(os.environ if environment is None else environment)
    from runtime_paths import discover_installation
    from mcp_stdio import read_host_registry
    from host_autostart import launch_environment
    state = configured_state(environment, home)
    try:
        read_host_registry(state)
    except Exception:
        pass
    else:
        print('Codex host is already ready; the running app was preserved.')
        return 0
    installation = discover_installation(environment, home)
    if app_processes(installation.executable):
        print('Finish your Codex work, quit the app normally, then run codex-cua start. This command does not quit the app.', file=sys.stderr)
        return 1
    install_command(plugin_root, home, environment)
    try:
        install_login_environment(home, environment)
    except Exception:
        pass
    command = ['/usr/bin/open', '-a', str(installation.app_path)]
    for key, value in launch_environment(state, installation, home).items():
        command += ['--env', key+'='+value]
    return subprocess.run(command, env=environment, timeout=15).returncode


async def probe_host(registry, timeout):
    from host_mcp import HostMcp
    from runtime_paths import installation_from_native_cli, InstallationError
    observed = {'status': 'failed', 'tool_names': [], 'response_count': 0,
                'approval_required': False, 'operational_readiness': 'not_checked'}
    cua_root = None
    try:
        cua_root = installation_from_native_cli(registry.get('native_cli', '')).cua_root
    except (InstallationError, TypeError):
        pass
    def event(name):
        if name == 'unsupported_owned_thread_interaction':
            observed['approval_required'] = True
    replies = []
    adapter = HostMcp(None, Path(registry['socket_path']), native_cua_root=cua_root,
                      emit=replies.append, log=event, startup_timeout=max(0.1, timeout-3), cleanup_timeout=1)
    deadline = asyncio.get_running_loop().time()+timeout
    try:
        await asyncio.wait_for(adapter.boot(), max(0.1, timeout-3))
        observed['tool_names'] = sorted(adapter.tool_names)
        remaining = deadline-asyncio.get_running_loop().time()-3
        if remaining <= 0:
            raise asyncio.TimeoutError
        await asyncio.wait_for(adapter.handle({'jsonrpc': '2.0', 'id': 'doctor', 'method': 'tools/call',
            'params': {'name': 'js', 'arguments': {'code': 'await cua.getState();',
                                                'title': 'Read-only Codex CUA inventory check'}}}), remaining)
        reply = next((item for item in replies if item.get('id') == 'doctor'), {})
        result = reply.get('result')
        content = result.get('content') if isinstance(result, dict) else None
        observed['response_count'] = len(content) if isinstance(content, list) else 0
        observed['is_error'] = result.get('isError') is True if isinstance(result, dict) else True
        # Raw inventory, UI, exception bodies and identifiers remain local only.
        text_failure = False
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get('type') == 'text' and isinstance(item.get('text'), str):
                    import re
                    if re.search(r'(?im)^\s*(?:Error running code|(?:[A-Za-z.]*Error|Exception):)', item['text']):
                        text_failure = True
        observed['text_error_marker'] = text_failure
        observed['status'] = ('approval_required' if observed['approval_required'] else
                              'checked' if isinstance(result, dict) and not observed['is_error'] and not text_failure and observed['response_count'] else 'failed')
    except asyncio.TimeoutError:
        observed['status'] = 'timeout'
    except Exception:
        observed['status'] = 'approval_required' if observed['approval_required'] else 'failed'
    finally:
        replies.clear()
        try:
            remaining = max(0.1, deadline-asyncio.get_running_loop().time())
            observed['cleanup'] = await asyncio.wait_for(adapter.close(), remaining)
        except Exception:
            observed['cleanup'] = {'connection_close': 'unconfirmed', 'owned_thread_unsubscribe': 'unconfirmed'}
        if (observed['status'] == 'checked' and (observed['cleanup'].get('connection_close') != 'confirmed'
                or observed['cleanup'].get('owned_thread_unsubscribe') not in ('confirmed', 'already_unloaded'))):
            observed['status'] = 'cleanup_unconfirmed'
    return observed


def doctor(plugin_root, probe=False, timeout=15, home=None, environment=None):
    from runtime_paths import discover_installation, InstallationError
    from mcp_stdio import read_host_registry
    environment = os.environ if environment is None else environment
    report = {'schema_version': 1, 'plugin_id': PLUGIN_ID, 'status': 'unavailable',
              'installation': 'not_checked', 'dependencies': 'missing', 'host': 'unavailable',
              'login_environment': 'not_checked', 'relay': 'missing',
              'cua': 'not_checked', 'browser': 'not_checked', 'computer': 'not_checked',
              'operational_readiness': 'not_checked'}
    try:
        installation = discover_installation(environment, home)
        report['installation'] = 'verified_assets'
        with (installation.app_path/'Contents/Info.plist').open('rb') as source:
            import plistlib
            info = plistlib.load(source)
        report['app_version'] = info.get('CFBundleShortVersionString')
    except (InstallationError, OSError):
        pass
    try:
        report['login_environment'] = login_environment_status(home, environment)
    except Exception:
        report['login_environment'] = 'unknown'
    report['relay'] = relay_status(home)
    if venv_ready(support_root(home)):
        report['dependencies'] = 'ready'
        report['websockets_version'] = '12.0'
    try:
        registry = read_host_registry(configured_state(environment, home))
        report['host'] = 'registered_processes_alive'
        report['status'] = 'registered'
    except Exception:
        registry = None
    if probe:
        if registry is None:
            report['probe'] = {'status': 'host_unavailable'}
        elif report['dependencies'] != 'ready':
            report['probe'] = {'status': 'dependencies_missing'}
        else:
            report['probe'] = asyncio.run(probe_host(registry, timeout))
        report['status'] = report['probe']['status']
        if report['status'] == 'checked':
            report['cua'] = 'inventory_checked'
    report['next_action'] = ('none' if report['status'] == 'checked' else
                             'complete_original_approval' if report['status'] == 'approval_required' else
                             'run_setup' if report['dependencies'] != 'ready' else
                             'run_setup' if report['login_environment'] in ('missing', 'stale') else
                             'reopen_app_normally_or_reconnect_mcp' if registry is None else 'inspect_fresh_state')
    return report


def uninstall(home=None, environment=None):
    from mcp_stdio import read_host_registry
    home = Path.home() if home is None else Path(home)
    # Conservatively preserve all support files while any host owner is alive,
    # including a partial/stale registry with other valid owner PIDs.
    state = configured_state(environment, home)
    try:
        data = json.loads((state/'host.json').read_text())
        for key in ('owner_pid', 'backend_pid', 'desktop_proxy_pid'):
            pid = data.get(key) if isinstance(data, dict) else None
            if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    continue
                except PermissionError:
                    raise RuntimeError('Host ownership is uncertain; support files were preserved.') from None
                raise RuntimeError('A Codex host is running; quit normally before uninstalling its support runtime.')
    except FileNotFoundError:
        pass
    root = support_root(home)
    binding = private_json(root/'source.json')
    if binding.get('plugin_id') != PLUGIN_ID:
        raise RuntimeError('The support installation is not authored by this plugin.')
    remove_login_environment(home, environment)
    target = home/'.local/bin/codex-cua'
    if target.exists() or target.is_symlink():
        info = target.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or MARKER not in target.read_text().splitlines()[:3]:
            raise RuntimeError('An unrelated command was preserved.')
        target.unlink()
    try:
        from relay_install import remove_relay_files
        remove_relay_files(root)
    except Exception:
        pass
    shutil.rmtree(root)
    # App, original assets, live host state and Claude managed caches are untouched.
    return 0


def exec_native_fallback(arguments):
    native = os.environ.get(FALLBACK_ENV, '')
    if native and Path(native).is_absolute() and os.path.isfile(native) and os.access(native, os.X_OK):
        os.execve(native, [native, *arguments], dict(os.environ))


def split_forwarded(arguments):
    """Everything after the first `--` belongs to the original Codex CLI and is never inspected."""
    if '--' in arguments:
        separator = arguments.index('--')
        return arguments[:separator], arguments[separator+1:]
    return arguments, []


def readable_source(path):
    """Compile a script before exec'ing it, while a failure can still fall back to the original CLI."""
    return compile(path.read_bytes(), str(path), 'exec', dont_inherit=True)


def hand_over_to_registered_plugin(arguments):
    """Make the engine copy that setup bound decide what the stable command does.

    command.py is a copy of the setup.py that was current when `codex-cua setup` last ran, so
    after an update it is stale and does not know newer commands. Resolve the bound engine
    folder (source.json) and, unless this file already is its setup.py, run that setup.py with the same
    interpreter and arguments plus ROOT_RESOLVED_FLAG, which tells it the root is settled.
    Returns the bound root when there is nothing to hand over to.

    A setup.py older than 0.7.0 does not know the flag and would pass it on as an unrecognized
    argument, so the flag goes only to a setup.py that defines it. An older one never hands over
    again, and a newer one finds that it is the registered file, so nothing can loop.
    """
    root = resolve_plugin_root()
    target = root/'setup.py'
    if target.resolve() == Path(__file__).resolve():
        return root
    # This file has not run on this machine yet; a damaged update must fail here, not after exec.
    code = readable_source(target)
    handed = list(arguments)
    if 'ROOT_RESOLVED_FLAG' in code.co_names:
        handed.insert(handed.index('--control')+1, ROOT_RESOLVED_FLAG)
    os.execve(sys.executable, [sys.executable, str(target), *handed], dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))


def main(arguments=None):
    arguments = list(sys.argv[1:] if arguments is None else arguments)
    original = list(arguments)
    arguments, forwarded = split_forwarded(arguments)
    registered = None
    if '--control' in arguments and ROOT_RESOLVED_FLAG not in arguments:
        # Before argparse: a stale copy's parser would reject any command added since it was made.
        try:
            registered = hand_over_to_registered_plugin(original)
        except Exception:
            if '--exec-wrapper' in arguments:
                exec_native_fallback(forwarded)
            raise
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--control', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument(ROOT_RESOLVED_FLAG, action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('command', choices=('install', 'setup', 'install-engine', 'ensure', 'start', 'doctor',
                                            'uninstall', *ENGINE_COMMANDS))
    parser.add_argument('--exec-mcp', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--exec-wrapper', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--timeout', type=float, default=15)
    parser.add_argument('--connection')
    parser.add_argument('--ended', action='store_true')
    parser.add_argument('--session')
    parser.add_argument('--user', action='store_true')
    parser.add_argument('--group', choices=('all', 'claude', 'codex'))
    parser.add_argument('--force', action='store_true')
    args, remainder = parser.parse_known_args(arguments)
    remainder += forwarded
    if not math.isfinite(args.timeout) or not 0 < args.timeout <= 60:
        parser.error('--timeout must be finite, positive and at most 60 seconds')
    if args.command not in ENGINE_COMMANDS and (args.connection or args.ended or args.session or args.user
                                                or args.group or args.force):
        parser.error('unrecognized arguments')
    if sys.version_info < (3, 9) or sys.platform != 'darwin':
        raise RuntimeError('This plugin requires macOS and Python 3.9 or newer.')
    launching_codex = args.exec_wrapper and not args.exec_mcp
    try:
        plugin_root = registered or Path(__file__).resolve().parent
        sys.path.insert(0, str(plugin_root))
        if args.command == 'ensure':
            # Codex's own start never waits for a repair, takes the setup lock or runs pip:
            # not ready means the original CLI starts now. Setup and the MCP entry point repair.
            python = ensure_dependencies(repair=not launching_codex)
            if args.exec_mcp or args.exec_wrapper:
                script = plugin_root/('mcp_stdio.py' if args.exec_mcp else 'desktop_cli_wrapper.py')
                if launching_codex:
                    # Codex itself starts through these two: a missing or damaged file must not stop it.
                    for needed in (script, plugin_root/'unix_ws_stdio.py'):
                        readable_source(needed)
                environment = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
                # The original CLI gets exactly what followed `--`, never anything parsed here.
                os.execve(str(python), [str(python), str(script), *(forwarded if launching_codex else remainder)], environment)
            return 0
    except Exception:
        if launching_codex:
            exec_native_fallback(forwarded)
        raise
    if args.command in ('install', 'setup'):
        target, status, relay = run_setup(plugin_root)
        print('Installed authored command: '+str(target))
        print('Ordinary app launch as host: '+status)
        print('Relay files: '+relay)
        return 0
    if remainder:
        parser.error('unrecognized arguments')
    if args.command == 'install-engine':
        from engine_install import run_install_engine
        return run_install_engine(args, plugin_root, sys.modules[__name__])
    if args.command in ENGINE_COMMANDS:
        from engine_cli import run_command
        return run_command(args, plugin_root, sys.modules[__name__], parser.error)
    if args.command == 'start':
        return start_host(plugin_root)
    if args.command == 'uninstall':
        return uninstall()
    report = doctor(plugin_root, args.probe, args.timeout)
    if args.json:
        print(json.dumps(report, sort_keys=True))
    else:
        print('\n'.join(key+': '+str(value) for key, value in report.items()))
    return 0 if report['status'] in ('registered', 'checked') else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (Exception, KeyboardInterrupt):
        print('codex-cua could not complete. Check the app installation, private support permissions and original host status; no app was forcibly restarted.', file=sys.stderr)
        raise SystemExit(1)
