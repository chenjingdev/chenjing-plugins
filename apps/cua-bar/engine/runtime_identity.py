"""Compare the code a bridge loaded with the engine currently installed on disk.

The running identity is captured once, before the MCP starts serving. Reading the
manifest again later would mislabel an old process after an in-place repair.
No code from the installed engine is imported or executed by these observations.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat

VERSION = re.compile(r'^[0-9][0-9A-Za-z.+_-]{0,63}$')
REVISION = re.compile(r'^[a-f0-9]{64}$')
LEGACY = re.compile(r'/codex-cua/engine/([0-9][0-9A-Za-z.+_-]{0,63})/mcp_stdio\.py(?=\s|$)')
UNKNOWN = {'version': None, 'revision': None}
MAX_BYTES = 16 * 1024 * 1024


def _owned(path, directory=False):
    info = path.lstat()
    return (info.st_uid == os.getuid() and not stat.S_IMODE(info.st_mode) & 0o022
            and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)))


def engine_identity(root):
    """Bounded content digest of owned runtime files, or unknown if they cannot be verified."""
    try:
        root = Path(root)
        if not _owned(root, directory=True):
            return dict(UNKNOWN)
        manifest = root / '.claude-plugin/plugin.json'
        if (not _owned(manifest.parent, directory=True) or not _owned(manifest)
                or manifest.stat().st_size > 65536):
            return dict(UNKNOWN)
        version = json.loads(manifest.read_bytes()).get('version')
        if not isinstance(version, str) or not VERSION.fullmatch(version):
            return dict(UNKNOWN)
        files = [manifest]
        pending, visited = [root], 0
        while pending:
            folder = pending.pop()
            visited += 1
            if visited > 256:
                return dict(UNKNOWN)
            for item in folder.iterdir():
                if item.name.startswith('.') or item.name == '__pycache__':
                    continue
                if item.is_dir():
                    if not _owned(item, directory=True):
                        return dict(UNKNOWN)
                    pending.append(item)
                elif item.suffix in ('.py', '.sh', '.mjs'):
                    if not _owned(item):
                        return dict(UNKNOWN)
                    files.append(item)
                if len(files) + len(pending) > 512:
                    return dict(UNKNOWN)
        if not all(root / name in files for name in ('host_mcp.py', 'mcp_stdio.py')):
            return dict(UNKNOWN)
        digest, total = hashlib.sha256(), 0
        for file in sorted(files):
            size = file.stat().st_size
            total += size
            if size > 2 * 1024 * 1024 or total > MAX_BYTES:
                return dict(UNKNOWN)
            content = file.read_bytes()
            if len(content) != size:
                return dict(UNKNOWN)
            digest.update(str(file.relative_to(root)).encode('utf-8') + b'\0')
            digest.update(hashlib.sha256(content).digest())
        return {'version': version, 'revision': digest.hexdigest()}
    except (OSError, ValueError, AttributeError, RecursionError):
        return dict(UNKNOWN)


def installed_root(home=None):
    """Only the private engine/current target installed by CUABar, never an arbitrary source path."""
    home = Path.home() if home is None else Path(home)
    engines = home / '.local/share/codex-cua/engine'
    try:
        if not _owned(engines, directory=True):
            return None
        target = (engines / 'current').resolve(strict=True)
        if (target.parent != engines.resolve(strict=True) or not VERSION.fullmatch(target.name)
                or not _owned(target, directory=True)):
            return None
        return target
    except (OSError, RuntimeError):
        return None


def installed_identity(home=None):
    root = installed_root(home)
    return engine_identity(root) if root is not None else dict(UNKNOWN)


def runtime_status(record, installed, command=None):
    """Old records can identify their version by their versioned executable path.

    Without a content identity the version cannot be fully verified; a reconnect
    is recommended once. A missing installation cannot establish an update.
    """
    version = record.get('version')
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        found = LEGACY.search(command) if isinstance(command, str) else None
        version = found.group(1) if found else None
    wanted = installed.get('version')
    if not isinstance(wanted, str) or not VERSION.fullmatch(wanted):
        wanted = None
    revision, expected = record.get('runtime_revision'), installed.get('revision')
    known = all(isinstance(value, str) and REVISION.fullmatch(value) for value in (revision, expected))
    if wanted is None:
        state, reconnect = 'unknown', False
    elif version is not None and (version != wanted or (known and revision != expected)):
        state, reconnect = 'reconnect_required', True
    elif version == wanted and known:
        state, reconnect = 'current', False
    else:
        state, reconnect = 'unknown', True
    return {'state': state, 'running_version': version, 'installed_version': wanted,
            'reconnect_required': reconnect}


RUNNING_IDENTITY = engine_identity(Path(__file__).resolve().parent)
