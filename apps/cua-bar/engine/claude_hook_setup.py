"""Install only CUA Bar's lifecycle hooks in one explicitly selected Claude settings directory.

This never discovers other profiles. The caller's explicit directory (or CLAUDE_CONFIG_DIR) wins over ~/.claude.
Only command handlers that name our stable launcher with an empty args list belong to us; other settings and hooks
are retained. Invalid or unsafe settings are reported without replacing them.
"""
import json
import os
from pathlib import Path
import stat
import shutil
import tempfile


HOOK_TIMEOUT = 10
MAX_SETTINGS_BYTES = 8 * 1024 * 1024
EVENTS = ('PreToolUse', 'Stop', 'SubagentStop', 'SessionEnd', 'StopFailure', 'UserPromptSubmit')
TOOL_MATCHER = '^mcp__cuabar__.*$'


class SettingsConflict(Exception):
    pass


def _directory(home, config_dir):
    value = config_dir if config_dir is not None else os.environ.get('CLAUDE_CONFIG_DIR')
    if value is None or value == '':
        return home / '.claude'
    value = os.fspath(value)
    if value == '~':
        return home
    if value.startswith('~/'):
        return home / value[2:]
    directory = Path(value)
    if not directory.is_absolute():
        raise SettingsConflict('invalid_config_dir')
    return directory


def _safe(info, directory=False):
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    return kind(info.st_mode) and info.st_uid == os.getuid() and not stat.S_IMODE(info.st_mode) & 0o022


def _read(path):
    """The settings and the identity/content used to detect a concurrent writer before replacement."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return {}, None, 0o600
    if not _safe(info):
        raise SettingsConflict('unsafe_settings')
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(descriptor, 'rb') as source:
        opened = os.fstat(source.fileno())
        if not _safe(opened) or (info.st_dev, info.st_ino) != (opened.st_dev, opened.st_ino):
            raise SettingsConflict('settings_changed')
        raw = source.read(MAX_SETTINGS_BYTES + 1)
    if len(raw) > MAX_SETTINGS_BYTES:
        raise SettingsConflict('settings_too_large')
    try:
        settings = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise SettingsConflict('invalid_json') from None
    if not isinstance(settings, dict):
        raise SettingsConflict('invalid_settings')
    return settings, (info.st_dev, info.st_ino, raw), stat.S_IMODE(info.st_mode)


def _own(handler, command):
    return (isinstance(handler, dict) and handler.get('type') == 'command'
            and handler.get('command') == command and handler.get('args') == [])


def _updated(settings, command, remove):
    hooks = settings.get('hooks', {})
    if not isinstance(hooks, dict):
        raise SettingsConflict('invalid_hooks')
    hooks = dict(hooks)
    removed_any = False
    for event in EVENTS:
        groups = hooks.get(event, [])
        if not isinstance(groups, list):
            raise SettingsConflict('invalid_hooks')
        kept = []
        removed = False
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get('hooks'), list):
                raise SettingsConflict('invalid_hooks')
            handlers = group['hooks']
            others = [handler for handler in handlers if not _own(handler, command)]
            removed = removed or len(others) != len(handlers)
            if len(others) == len(handlers):
                kept.append(group)
            elif others:
                kept.append({**group, 'hooks': others})
        if not remove:
            managed = {'hooks': [{'type': 'command', 'command': command, 'args': [], 'timeout': HOOK_TIMEOUT}]}
            if event == 'PreToolUse':
                managed['matcher'] = TOOL_MATCHER
            kept.append(managed)
        if kept:
            hooks[event] = kept
        elif removed:
            del hooks[event]
        removed_any = removed_any or removed
    updated = dict(settings)
    if hooks:
        updated['hooks'] = hooks
    elif removed_any:
        del updated['hooks']
    return updated


def _unchanged(path, original):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return original is None
    if original is None or not _safe(info) or (info.st_dev, info.st_ino) != original[:2]:
        return False
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(descriptor, 'rb') as source:
        opened = os.fstat(source.fileno())
        return (_safe(opened) and (opened.st_dev, opened.st_ino) == original[:2]
                and source.read(MAX_SETTINGS_BYTES + 1) == original[2])


def _write(path, settings, original, mode):
    descriptor, temporary = tempfile.mkstemp(prefix='.cuabar-hooks-', suffix='.tmp', dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as target:
            os.fchmod(target.fileno(), mode)
            json.dump(settings, target, ensure_ascii=False, indent=2)
            target.write('\n')
            target.flush()
            os.fsync(target.fileno())
        if not _unchanged(path, original):
            raise SettingsConflict('settings_changed')
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def configure_hooks(home=None, config_dir=None, remove=False):
    """A state dict: ready/removed, conflict for settings needing attention, or failed for an IO failure.

    The stable command stays the same across engine updates. Missing settings need no write on removal. A missing
    profile is created only on install, and unrelated profile directories are never read or changed.
    """
    result = {'state': 'failed', 'changed': False, 'settings_file': None}
    try:
        home = Path.home() if home is None else Path(home)
        if not home.is_absolute():
            raise SettingsConflict('invalid_home')
        directory = _directory(home, config_dir)
        path = directory / 'settings.json'
        result['settings_file'] = str(path)
        try:
            info = directory.lstat()
        except FileNotFoundError:
            if remove:
                return dict(result, state='removed')
            directory.mkdir(parents=True, mode=0o700)
            info = directory.lstat()
        if not _safe(info, directory=True):
            raise SettingsConflict('unsafe_config_dir')
        settings, original, mode = _read(path)
        result['hooks_disabled'] = settings.get('disableAllHooks') is True
        command = str(home / '.local/share/codex-cua/engine/current/claude-hook.sh')
        updated = _updated(settings, command, remove)
        if updated != settings:
            _write(path, updated, original, mode)
            result['changed'] = True
        return dict(result, state='removed' if remove else 'ready')
    except SettingsConflict as error:
        return dict(result, state='conflict', error=str(error))
    except (OSError, ValueError, TypeError, RecursionError):
        return dict(result, state='failed', error='settings_io_failed')


def inspect_hooks(home=None, config_dir=None):
    """Read-only readiness of the same managed entries configure_hooks installs."""
    try:
        home = Path.home() if home is None else Path(home)
        directory = _directory(home, config_dir)
        if not directory.exists():
            return 'missing'
        if not _safe(directory.lstat(), directory=True):
            return 'conflict'
        settings, _, _ = _read(directory/'settings.json')
        if settings.get('disableAllHooks') is True or settings.get('allowManagedHooksOnly') is True:
            return 'disabled'
        command = str(home/'.local/share/codex-cua/engine/current/claude-hook.sh')
        return 'ready' if _updated(settings, command, False) == settings else 'missing'
    except SettingsConflict:
        return 'conflict'
    except (OSError, ValueError, TypeError, RecursionError):
        return 'failed'


def claude_available(home=None, environment=None):
    home = Path.home() if home is None else Path(home)
    environment = os.environ if environment is None else environment
    return (shutil.which('claude', path=environment.get('PATH', '')) is not None
            or any(path.is_file() and os.access(path, os.X_OK) for path in
                   (home/'.local/bin/claude', home/'.claude/local/claude')))


def lifecycle_hooks_state(home=None, environment=None):
    environment = os.environ if environment is None else environment
    return (inspect_hooks(home, environment.get('CLAUDE_CONFIG_DIR', ''))
            if claude_available(home, environment) else 'not_installed')
