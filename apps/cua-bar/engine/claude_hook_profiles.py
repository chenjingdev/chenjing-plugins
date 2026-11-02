"""Remember only profiles explicitly configured by CUA Bar, so removing the shared launcher leaves no owned hooks.

The private ledger is prepared before hook settings change. Failed, unchanged configuration restores the previous
ledger. Uninstall preflights every recorded profile and preserves the shared support runtime on any conflict. No
profile discovery, transcript reading, Claude process or Codex call happens here.
"""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import stat
import tempfile

from claude_hook_setup import SettingsConflict, _directory, configure_hooks, inspect_hooks

LEDGER_NAME = 'claude-hook-profiles.json'
LOCK_NAME = '.claude-hook-profiles.lock'
MAX_BYTES = 65536
MAX_PROFILES = 128


class ProfileConflict(Exception):
    pass


def _home(home):
    home = Path.home() if home is None else Path(home)
    if not home.is_absolute() or '\0' in str(home):
        raise ProfileConflict('invalid_home')
    return home


def _safe(info, directory=False):
    return ((stat.S_ISDIR if directory else stat.S_ISREG)(info.st_mode)
            and info.st_uid == os.getuid() and not stat.S_IMODE(info.st_mode) & 0o077)


def _selected(home, environment):
    try:
        directory = _directory(home, environment.get('CLAUDE_CONFIG_DIR', ''))
        selected = str(Path(os.path.abspath(directory)))
        if '\0' in selected:
            raise ValueError('invalid path')
        return selected
    except (SettingsConflict, TypeError, ValueError):
        raise ProfileConflict('invalid_config_dir') from None


@contextmanager
def _locked(root, create=True):
    try:
        info = root.lstat()
    except FileNotFoundError:
        if not create:
            yield False
            return
        root.mkdir(parents=True, mode=0o700)
        info = root.lstat()
    if not _safe(info, directory=True):
        raise ProfileConflict('unsafe_support_directory')
    lock = root/LOCK_NAME
    descriptor = os.open(lock, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        if not _safe(os.fstat(descriptor)):
            raise ProfileConflict('unsafe_profile_lock')
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ProfileConflict('profile_setup_busy') from None
        yield True
    finally:
        os.close(descriptor)


def _read(path):
    """Profiles plus an identity/content token for refusing concurrent replacements."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return [], None
    if not _safe(info) or info.st_size > MAX_BYTES:
        raise ProfileConflict('unsafe_profile_ledger')
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(descriptor, 'rb') as source:
        opened = os.fstat(source.fileno())
        if not _safe(opened) or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise ProfileConflict('profile_ledger_changed')
        raw = source.read(MAX_BYTES+1)
    if len(raw) > MAX_BYTES:
        raise ProfileConflict('unsafe_profile_ledger')
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise ProfileConflict('invalid_profile_ledger') from None
    profiles = data.get('profiles') if isinstance(data, dict) else None
    if (not isinstance(data, dict) or type(data.get('schema_version')) is not int
            or data['schema_version'] != 1 or not isinstance(profiles, list) or len(profiles) > MAX_PROFILES):
        raise ProfileConflict('invalid_profile_ledger')
    if any(not isinstance(value, str) or not value or '\0' in value or not Path(value).is_absolute()
           or os.path.abspath(value) != value for value in profiles):
        raise ProfileConflict('invalid_profile_ledger')
    if len(set(profiles)) != len(profiles):
        raise ProfileConflict('invalid_profile_ledger')
    return profiles, (opened.st_dev, opened.st_ino, raw)


def _same(path, expected):
    _, actual = _read(path)
    return actual == expected


def _replace(path, raw, expected):
    descriptor, temporary = tempfile.mkstemp(prefix='.claude-hook-profiles-', suffix='.tmp', dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'wb') as target:
            target.write(raw)
            target.flush()
            os.fsync(target.fileno())
        if not _same(path, expected):
            raise ProfileConflict('profile_ledger_changed')
        os.replace(temporary, path)
        return _read(path)[1]
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _save(path, profiles, expected):
    if len(profiles) > MAX_PROFILES:
        raise ProfileConflict('too_many_hook_profiles')
    raw = (json.dumps({'schema_version': 1, 'profiles': profiles}, ensure_ascii=False, indent=2)+'\n').encode('utf-8')
    if len(raw) > MAX_BYTES:
        raise ProfileConflict('profile_ledger_too_large')
    return _replace(path, raw, expected)


def _restore(path, original, prepared):
    if original is not None:
        _replace(path, original[2], prepared)
    elif _same(path, prepared):
        path.unlink()
    else:
        raise ProfileConflict('profile_ledger_changed')


def configure_profile(home=None, environment=None):
    """Configure the selected profile, recording it before hooks can refer to the shared support launcher."""
    answer = {'state': 'failed', 'changed': False}
    try:
        home = _home(home)
        environment = os.environ if environment is None else environment
        selected = _selected(home, environment)
        root = home/'.local/share/codex-cua'
        path = root/LEDGER_NAME
        answer.update(profile=selected, ledger_file=str(path))
        with _locked(root):
            profiles, original = _read(path)
            added = selected not in profiles
            prepared = _save(path, [*profiles, selected], original) if added else original
            try:
                configured = configure_hooks(home, selected)
            except Exception:
                # The outcome is uncertain: retain the prepared ledger so uninstall still checks this profile.
                return dict(answer, error='profile_configuration_unconfirmed')
            if configured.get('state') != 'ready':
                if added and configured.get('changed') is False:
                    _restore(path, original, prepared)
                return {**answer, **configured}
            return {**answer, **configured, 'changed': added or configured.get('changed', False)}
    except ProfileConflict as error:
        return dict(answer, state='conflict', error=str(error))
    except (OSError, ValueError, TypeError, RecursionError):
        return dict(answer, error='profile_settings_io_failed')


def remove_profiles(home=None, environment=None):
    """Remove only our hooks from explicitly recorded profiles and the current profile; any failure preserves support.

    Preflighting all settings avoids partially removing hooks when another profile is already known to be invalid.
    A later write failure may leave an earlier profile restored; the intact ledger allows a safe retry.
    """
    answer = {'state': 'failed', 'changed': False}
    try:
        home = _home(home)
        environment = os.environ if environment is None else environment
        selected = _selected(home, environment)
        root = home/'.local/share/codex-cua'
        path = root/LEDGER_NAME
        with _locked(root, create=False) as present:
            profiles, original = _read(path) if present else ([], None)
            targets = list(dict.fromkeys([*profiles, selected]))
            for directory in targets:
                state = inspect_hooks(home, directory)
                if state in ('conflict', 'failed'):
                    return dict(answer, state=state, error='profile_settings_unreadable')
            for directory in targets:
                restored = configure_hooks(home, directory, remove=True)
                answer['changed'] = answer['changed'] or restored.get('changed', False)
                if restored.get('state') != 'removed':
                    return dict(answer, state=restored.get('state', 'failed'), error='profile_removal_unconfirmed')
            if present and original is not None and profiles:
                _save(path, [], original)
            return dict(answer, state='removed')
    except ProfileConflict as error:
        return dict(answer, state='conflict', error=str(error))
    except (OSError, ValueError, TypeError, RecursionError):
        return dict(answer, error='profile_settings_io_failed')
