#!/usr/bin/python3
"""Prototype CLI override: original Desktop backend + Unix WebSocket stdio.

No JSON-RPC bodies are read or rewritten here. This script is unactivated;
Desktop must explicitly select it as CODEX_CLI_PATH on a later launch.
"""
import fcntl
import json
import math
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid

PRIMARY_PLUGIN_KEY = "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled="
NON_LAUNCH_COMMANDS = frozenset(("proxy", "daemon", "generate-ts", "generate-json-schema"))
FALLBACK_ENV = "CODEX_CUA_FALLBACK_NATIVE"


class BackendNotStarted(RuntimeError):
    """Raised only while no process of ours exists yet, so the original CLI can take over."""


def is_primary_launch(arguments):
    """Match this installed Desktop build, excluding auxiliary CLI commands."""
    index = 0
    while index < len(arguments):
        item = arguments[index]
        if item in ("-c", "--config", "--enable", "--disable"):
            index += 2
        elif item.startswith(("--config=", "--enable=", "--disable=")) or item.startswith("-c="):
            index += 1
        else:
            break
    if index >= len(arguments) or arguments[index] != "app-server":
        return False
    tail = arguments[index + 1:]
    if any(item in NON_LAUNCH_COMMANDS for item in tail):
        return False
    if any(item in ("--help", "-h", "--listen") or item.startswith("--listen=") for item in tail):
        return False
    return "--analytics-default-enabled" in tail and any(item.startswith(PRIMARY_PLUGIN_KEY) for item in arguments)


def _positive_timeout(environment, name, default):
    try:
        value = float(environment.get(name, default))
    except (TypeError, ValueError):
        raise RuntimeError("Invalid launcher timeout configuration.") from None
    if not math.isfinite(value) or not 0 < value <= 60:
        raise RuntimeError("Invalid launcher timeout configuration.")
    return value


def _private_directory(path):
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError("The explicit launcher state directory must be owned and private (0700).")


def _write_metadata(path, data):
    # Only our owned PIDs, native executable path, and endpoint lifecycle appear.
    descriptor, temporary = tempfile.mkstemp(prefix=".host-", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "w") as output:
            json.dump(data, output, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _require_private_parent(path):
    info = path.parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError("The endpoint parent must be owned and private (0700).")


def _secure_owned_socket(path):
    """Accept the native CLI's owned alias only to an owned private socket."""
    _require_private_parent(path)
    info = path.lstat()
    if info.st_uid != os.getuid() or not (stat.S_ISSOCK(info.st_mode) or stat.S_ISLNK(info.st_mode)):
        raise RuntimeError("The newly owned endpoint has an invalid type or owner.")
    target = path.resolve(strict=True) if stat.S_ISLNK(info.st_mode) else path
    _require_private_parent(target)
    target_info = target.lstat()
    if not stat.S_ISSOCK(target_info.st_mode) or target_info.st_uid != os.getuid():
        raise RuntimeError("The resolved endpoint must be an owned Unix socket.")
    os.chmod(target, 0o600)
    target_info = target.lstat()
    if not stat.S_ISSOCK(target_info.st_mode) or target_info.st_uid != os.getuid() or stat.S_IMODE(target_info.st_mode) != 0o600:
        raise RuntimeError("The resolved socket permissions could not be verified.")
    return target


def _wait_for_owned_socket(path, backend, stop, timeout):
    deadline = time.monotonic() + timeout
    while not stop.is_set():
        if backend.poll() is not None:
            raise RuntimeError("The original owned backend exited during startup.")
        try:
            _secure_owned_socket(path)
        except FileNotFoundError:
            pass
        else:
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("The owned backend startup deadline expired.")
        stop.wait(min(0.05, remaining))
    raise RuntimeError("Desktop shutdown interrupted owned backend startup.")


def _stop_owned(children, timeout):
    """Signal only exact Popen children, never groups or shared native services."""
    deadline = time.monotonic() + timeout
    clean = True
    for child in children:
        if child is not None and child.poll() is None:
            try:
                child.terminate()
            except ProcessLookupError:
                pass
            except PermissionError:
                clean = False
    remaining = max(0.0, deadline - time.monotonic())
    grace_end = time.monotonic() + remaining * 0.65
    for child in children:
        if child is None:
            continue
        try:
            child.wait(timeout=max(0.0, grace_end - time.monotonic()))
        except subprocess.TimeoutExpired:
            pass
    for child in children:
        if child is not None and child.poll() is None:
            try:
                child.kill()
            except ProcessLookupError:
                pass
            except PermissionError:
                clean = False
    for child in children:
        if child is None:
            continue
        try:
            child.wait(timeout=max(0.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            clean = False
    return clean and all(child is None or child.returncode is not None for child in children)


def _relay_plan(native, arguments, environment):
    """Decide whether the relay goes in front of the CUA runtime for this start: (plan, reason).

    Every problem, however unexpected, means no relay and the backend starts exactly as it would without one.
    """
    try:
        from relay_install import plan_relay
        return plan_relay(native, arguments, environment, Path(__file__).resolve().parent)
    except Exception:
        return None, "unavailable"


def _spawn_backend(native, arguments, endpoint, environment):
    return subprocess.Popen([str(native), *arguments, "--listen", "unix://" + str(endpoint)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=None,
        env=environment, cwd=os.getcwd(), close_fds=True)


def launch(native, arguments, environment, state_dir):
    """Own one original backend; raise BackendNotStarted if it cannot even be started."""
    progress = {"backend": False}
    try:
        return _launch(native, arguments, environment, state_dir, progress)
    except Exception:
        if progress["backend"]:
            raise
        # Nothing of ours is running, so no cleanup is owed beyond what _launch did.
        raise BackendNotStarted("The original backend was not started.") from None


def _launch(native, arguments, environment, state_dir, progress):
    """Own one original backend; framing bridge carries Desktop's untouched stdio."""
    startup_timeout = _positive_timeout(environment, "CODEX_HOST_CUA_STARTUP_TIMEOUT", 15)
    shutdown_timeout = _positive_timeout(environment, "CODEX_HOST_CUA_SHUTDOWN_TIMEOUT", 8)
    _private_directory(state_dir)
    lock_path = state_dir / "owner.lock"
    # O_NOFOLLOW: a symlink, even a dangling one, is never opened or created through.
    flags = os.O_RDWR | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0)
    lock = os.fdopen(os.open(lock_path, flags, 0o600), "a+")
    os.fchmod(lock.fileno(), 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        raise RuntimeError("Another primary launcher owns this explicit endpoint lease.") from None
    # The relay changes the backend's arguments only when the bundled definition was read and checked.
    relay, relay_reason = _relay_plan(native, arguments, environment)
    backend_arguments = relay.arguments if relay else list(arguments)
    instance_dir = state_dir / ("run-" + uuid.uuid4().hex[:12])
    instance_dir.mkdir(mode=0o700)
    endpoint = instance_dir / "rpc.sock"
    # The native CLI creates its own short socket and an owned alias when needed.
    metadata_path = state_dir / "host.json"
    record = {"schema_version": 1, "status": "starting", "owner_pid": os.getpid(),
              "backend_pid": None, "desktop_proxy_pid": None, "socket_path": str(endpoint),
              "native_cli": str(native), "mechanism": "original_app_server_unix_websocket",
              "operational_readiness": "not_checked",
              "relay": relay is not None, "relay_launcher": str(relay.launcher) if relay else None,
              "relay_reason": relay_reason}
    try:
        # Still before anything is started: a state directory that cannot be written
        # must not cost Codex its backend.
        _write_metadata(metadata_path, record)
    except OSError:
        instance_dir.rmdir()
        lock.close()
        raise
    stop = threading.Event()
    caught_signal = [None]
    previous = {}
    backend = desktop_proxy = None
    exit_status = 1
    def request_stop(signum, frame):
        if caught_signal[0] is None:
            caught_signal[0] = signum
        stop.set()
    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous[signum] = signal.signal(signum, request_stop)
        # All original argv, env, and cwd are preserved. Only listen is added, and, when the relay was verified,
        # the one -c override that backend_arguments carries.
        backend = _spawn_backend(native, backend_arguments, endpoint, environment)
        progress["backend"] = True
        record["backend_pid"] = backend.pid
        _write_metadata(metadata_path, record)
        try:
            _wait_for_owned_socket(endpoint, backend, stop, startup_timeout)
        except RuntimeError:
            # The relay is the one thing in this start that Codex never had before. A backend that leaves while
            # it starts, with the relay in its arguments, gets one more chance without it.
            if relay is None or backend.poll() is None or caught_signal[0] is not None:
                raise
            try:
                if endpoint.is_socket() or endpoint.is_symlink():
                    endpoint.unlink()
            except OSError:
                pass
            relay, relay_reason = None, "backend_rejected"
            record.update(relay=False, relay_launcher=None, relay_reason=relay_reason)
            backend = _spawn_backend(native, list(arguments), endpoint, environment)
            record["backend_pid"] = backend.pid
            _write_metadata(metadata_path, record)
            _wait_for_owned_socket(endpoint, backend, stop, startup_timeout)
        desktop_proxy = subprocess.Popen([sys.executable, str(Path(__file__).with_name("unix_ws_stdio.py")),
                                         "--socket", str(endpoint), *(relay.proxy_arguments() if relay else [])],
            stdin=None, stdout=None, stderr=None, env=environment, cwd=os.getcwd(), close_fds=True)
        record.update(status="ready", desktop_proxy_pid=desktop_proxy.pid)
        _write_metadata(metadata_path, record)
        while not stop.is_set():
            try:
                exit_status = desktop_proxy.wait(timeout=0.1)
                break
            except subprocess.TimeoutExpired:
                if backend.poll() is not None:
                    raise RuntimeError("The original owned backend exited while Desktop proxy was active.")
        if caught_signal[0] is not None:
            exit_status = 128 + caught_signal[0]
    finally:
        clean = _stop_owned((desktop_proxy, backend), shutdown_timeout)
        record.update(status="closed" if clean else "cleanup_unconfirmed",
                      backend_reaped=backend is None or backend.returncode is not None,
                      desktop_proxy_reaped=desktop_proxy is None or desktop_proxy.returncode is not None)
        _write_metadata(metadata_path, record)
        if clean:
            try:
                if endpoint.is_socket() or endpoint.is_symlink():
                    endpoint.unlink()
                instance_dir.rmdir()
            except OSError:
                pass
        for signum, handler in previous.items():
            signal.signal(signum, handler)
        lock.close()
        if not clean:
            exit_status = 1
    return exit_status if exit_status >= 0 else 128 - exit_status


def _checked_cli(native):
    if not native.is_file() or not os.access(native, os.X_OK) or native == Path(__file__).resolve():
        raise RuntimeError("The exact original native CLI path is missing, not executable, or recursive.")
    return native


def _original_cli(environment):
    configured_native = environment.get("CODEX_HOST_CUA_NATIVE_CLI")
    if configured_native:
        native = Path(configured_native).expanduser().resolve()
    else:
        from runtime_paths import discover_installation
        native = discover_installation(environment).native_cli
    return _checked_cli(native)


def _state_directory(value):
    try:
        path = Path(value).expanduser()
    except RuntimeError:
        raise BackendNotStarted("The explicit launcher state directory is invalid.") from None
    if not path.is_absolute():
        raise BackendNotStarted("The explicit launcher state directory must be absolute.")
    return path


def main(arguments=None, environment=None):
    arguments = list(sys.argv[1:] if arguments is None else arguments)
    environment = dict(os.environ if environment is None else environment)
    try:
        native = _original_cli(environment)
    except Exception:
        # Without a verified CLI nothing can be hosted. The launcher script recorded the
        # installed CLI when it was written, and Codex still starts that way, just without CUA.
        recorded = environment.get(FALLBACK_ENV, "")
        if not recorded or not os.path.isabs(recorded):
            raise
        native = _checked_cli(Path(recorded).resolve())
        os.execve(str(native), [str(native), *arguments], environment)
    state_value = environment.get("CODEX_HOST_CUA_STATE_DIR", "")
    if state_value and is_primary_launch(arguments):
        try:
            return launch(native, arguments, environment, _state_directory(state_value))
        except BackendNotStarted:
            # Nothing of ours is running, so the original CLI simply starts as it would without us.
            pass
    # Version/schema/auxiliary commands and every failure before the backend started
    # retain exact original execution: same argv, same environment.
    os.execve(str(native), [str(native), *arguments], environment)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError):
        # Do not print exception values, environment, argv, or RPC data.
        print("Desktop host launcher could not complete; inspect metadata and owned process state.", file=sys.stderr)
        raise SystemExit(1)
