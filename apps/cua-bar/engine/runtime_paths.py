"""Discover original, installed Codex assets without copying or modifying them."""
from dataclasses import dataclass
import os
from pathlib import Path
import plistlib

PUBLIC_PLUGIN_ID = 'cua@chenjing-plugins'
APP_ENV = 'CODEX_CUA_APP_PATH'


class InstallationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Installation:
    app_path: Path
    native_cli: Path
    cua_root: Path
    bundle_id: str
    executable: Path


def default_state(home=None):
    return (Path.home() if home is None else Path(home))/'Library/Caches/codex-host-cua'


def runtime_home(home=None):
    return (Path.home() if home is None else Path(home))/'.local/share/codex-cua'


def _app_installation(app):
    app = Path(app).expanduser()
    if not app.is_absolute():
        raise InstallationError('The app override must be an absolute path.')
    app = app.resolve(strict=True)
    try:
        with (app/'Contents/Info.plist').open('rb') as source:
            info = plistlib.load(source)
    except (OSError, ValueError, plistlib.InvalidFileException):
        raise InstallationError('The selected app has no valid bundle metadata.') from None
    if info.get('CFBundleIdentifier') != 'com.openai.codex':
        raise InstallationError('The selected app is not the original Codex Desktop bundle.')
    executable_name = info.get('CFBundleExecutable')
    if (not isinstance(executable_name, str) or not executable_name
            or Path(executable_name).name != executable_name):
        raise InstallationError('The selected app executable metadata is invalid.')
    resources = app/'Contents/Resources'
    candidates = [resources/'codex-cli/CodexCLI.app/Contents/MacOS/codex',
                  resources/'codex-cli/bin/codex']
    native = next((item.resolve() for item in candidates if item.is_file() and os.access(item, os.X_OK)), None)
    cua = resources/'cua_node'
    required = [cua/'bin/node', cua/'bin/node_repl',
                cua/'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs']
    executable = app/'Contents/MacOS'/executable_name
    if native is None or not executable.is_file() or not os.access(executable, os.X_OK):
        raise InstallationError('The original app or native CLI executable is missing.')
    if not all(item.is_file() for item in required) or not os.access(required[0], os.X_OK):
        raise InstallationError('The selected app does not contain the bundled CUA runtime.')
    return Installation(app, native, cua.resolve(), info['CFBundleIdentifier'], executable.resolve())


def discover_installation(environment=None, home=None, application_roots=None):
    environment = os.environ if environment is None else environment
    override = environment.get(APP_ENV)
    if override:
        try:
            return _app_installation(override)
        except OSError:
            raise InstallationError('The explicitly selected Codex app is unavailable.') from None
    home = Path.home() if home is None else Path(home)
    roots = [Path('/Applications'), home/'Applications'] if application_roots is None else [Path(x) for x in application_roots]
    for root in roots:
        for name in ('Codex.app', 'ChatGPT.app'):
            try:
                return _app_installation(root/name)
            except (InstallationError, OSError):
                continue
    raise InstallationError('Install Codex Desktop, or set CODEX_CUA_APP_PATH to its original app bundle.')


def installation_from_native_cli(native_cli):
    """Bind checks to the actual registered host, rather than another app build."""
    path = Path(native_cli).expanduser()
    if not path.is_absolute():
        raise InstallationError('The registered original CLI path is invalid.')
    try:
        path = path.resolve(strict=True)
        for ancestor in path.parents:
            if ancestor.suffix == '.app' and (ancestor/'Contents/Resources').is_dir():
                try:
                    installation = _app_installation(ancestor)
                except InstallationError:
                    continue
                resources = installation.app_path/'Contents/Resources/codex-cli'
                allowed = [resources/'CodexCLI.app/Contents/MacOS/codex', resources/'bin/codex']
                if any(candidate.is_file() and candidate.resolve() == path for candidate in allowed):
                    return Installation(installation.app_path, path, installation.cua_root,
                                        installation.bundle_id, installation.executable)
    except OSError:
        pass
    raise InstallationError('The registered host CLI cannot be verified as an installed original Codex CLI.')
