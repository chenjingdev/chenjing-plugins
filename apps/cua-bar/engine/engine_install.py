"""`install-engine`: the engine this command was started from becomes a private copy in
~/.local/share/codex-cua/engine/<version>/, and the usual setup runs from that copy.

A Claude conversation keeps running the engine files it was started from, and so does a Codex host. An update of the
app must not take those files away, so every version gets a folder of its own and a folder goes only when no process
runs from it any more. The copy is built in a temporary folder next to its place and renamed in, so a reader sees the
whole folder or none. A copy of the same version that is already whole is not touched: a conversation may be using it.

Success prints the result (one JSON object with --json). A failure prints one line to stderr and exits 1; what pip and
venv say while the dependencies are prepared is kept out of that line.
"""
import contextlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile

from engine_core import Context
from engine_inventory import command_state, snapshot

ENGINE_DIRECTORY = 'engine'
# What a folder may be named after: the shape engine_inventory accepts in `.../codex-cua/engine/<version>/mcp_stdio.py`.
VERSION = re.compile(r'^[0-9][0-9A-Za-z.+_-]{0,63}$')
# What Python and Finder leave around; never part of a copy.
SKIPPED = ('__pycache__', '.DS_Store')


def manifest_version(root):
    version = json.loads((root/'.claude-plugin/plugin.json').read_text()).get('version')
    if not isinstance(version, str) or not VERSION.match(version):
        raise RuntimeError('The engine version cannot name a folder.')
    return version


def listing(root):
    """What an engine folder holds: (relative path, is a folder, size, mode), every folder before what is in it."""
    found, pending = [], [Path()]
    while pending:
        relative = pending.pop()
        with os.scandir(root/relative) as scan:
            items = sorted(scan, key=lambda item: item.name)
        for item in items:
            if item.name in SKIPPED or item.name.endswith('.pyc'):
                continue
            info = item.stat(follow_symlinks=False)
            path = relative/item.name
            if stat.S_ISDIR(info.st_mode):
                found.append((path, True, 0, info.st_mode))
                pending.append(path)
            elif stat.S_ISREG(info.st_mode):
                found.append((path, False, info.st_size, info.st_mode))
            else:
                raise RuntimeError('The engine holds a link or a special file.')
    return found


def unpack(source, items, folder):
    for path, is_folder, _, mode in items:
        target = folder/path
        if is_folder:
            target.mkdir(mode=0o700)
        else:
            shutil.copyfile(source/path, target)
            target.chmod(0o700 if mode & stat.S_IXUSR else 0o600)


def whole(setup, folder, items, uid, version):
    """True when `folder` holds everything in `items` (files of the same size), private as a copy is made, and its
    manifest is the one of `version`. What else is in it does not matter."""
    try:
        info = os.lstat(folder)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) & 0o077:
            return False
        for path, is_folder, size, _ in items:
            info = os.lstat(folder/path)
            if info.st_uid != uid or stat.S_IMODE(info.st_mode) & 0o022:
                return False
            if is_folder != stat.S_ISDIR(info.st_mode) or (not is_folder and (
                    not stat.S_ISREG(info.st_mode) or info.st_size != size)):
                return False
        setup.validated_plugin_root(folder, version)
    except Exception:
        return False
    return True


def discard(path):
    """Remove a folder, or the link or file that stands in its place; never through a link. A failure is not one."""
    try:
        if os.path.islink(path) or not os.path.isdir(path):
            os.unlink(path)
        else:
            shutil.rmtree(path)
    except OSError:
        pass


def place(setup, engines, source, items, version, uid):
    """engines/<version> as a whole copy of `source`; one that already is whole stays as it is."""
    folder = engines/version
    if os.path.lexists(folder) and not folder.is_symlink() and (
            folder.resolve() == source or whole(setup, folder, items, uid, version)):
        return folder
    temporary = Path(tempfile.mkdtemp(prefix='.install-', dir=str(engines)))
    replaced = None
    try:
        unpack(source, items, temporary)
        if not whole(setup, temporary, items, uid, version):
            raise RuntimeError('The engine copy could not be checked.')
        if os.path.lexists(folder):
            # Not whole (damaged, or open to others): it goes aside first, so that the new one can take its name.
            replaced = engines/('.replaced-%d-%s' % (os.getpid(), os.urandom(4).hex()))
            os.rename(folder, replaced)
        try:
            os.rename(temporary, folder)
        except OSError:
            if replaced is not None:
                os.rename(replaced, folder)
                replaced = None
            elif whole(setup, folder, items, uid, version):
                return folder                      # another install-engine was quicker and left a whole copy
            raise
        if replaced is not None:
            discard(replaced)
        return folder
    finally:
        discard(temporary)                  # gone after the rename; what a failed copy left otherwise


def runs_from(commands, folders):
    """True when a command line holds one of the folders as a path (and not as the start of a longer name)."""
    pattern = re.compile('(?:%s)(?![0-9A-Za-z.+_-])' % '|'.join(re.escape(str(folder)) for folder in folders))
    return any(pattern.search(command) for command in commands)


def prune(ctx, engines, current):
    """Remove the copies other than `current` that no process runs from; returns their names.

    A process counts whoever it belongs to. Without a process list nothing is removed."""
    removed = []
    try:
        commands = [proc.command for proc in snapshot(ctx).values()]
        names = sorted(os.listdir(engines))
    except Exception:
        return removed
    real = engines.resolve()
    for name in names:
        if name == current or not VERSION.match(name):
            continue
        folder = engines/name
        try:
            info = os.lstat(folder)
        except OSError:
            continue
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != ctx.uid or runs_from(commands, (folder, real/name)):
            continue
        try:
            shutil.rmtree(folder)
        except OSError:
            continue
        removed.append(name)
    return removed


def install_engine(ctx, source_root):
    """Unpack, set up and prune. Returns the result the command prints."""
    setup = ctx.setup
    source = setup.validated_plugin_root(source_root)
    version = manifest_version(source)
    items = listing(source)
    support = setup.support_root(ctx.home)
    setup.private_directory(support)
    engines = support/ENGINE_DIRECTORY
    setup.private_directory(engines)
    folder = place(setup, engines, source, items, version, ctx.uid)
    setup.private_directory(folder)
    root = setup.validated_plugin_root(folder, version)
    _, login, relay = setup.run_setup(root, ctx.home, ctx.environment)
    state = {'command': command_state(ctx, support), 'login_environment': login, 'relay': relay}
    return {'version': version, 'root': str(root), 'removed': prune(ctx, engines, version), 'setup': state}


def reason(error):
    """Why it failed in a few words on one line: the fixed text of a refusal, else only what kind of failure."""
    if isinstance(error, RuntimeError):
        text = str(error)
    elif isinstance(error, OSError):
        text = '%s: %s' % (type(error).__name__, error.strerror or '')
    else:
        text = type(error).__name__
    return ' '.join(text.split()) or type(error).__name__


def run_install_engine(args, plugin_root, setup_module=None, context=None, stdout=None, stderr=None):
    out = stdout or sys.stdout
    try:
        ctx = context or Context(plugin_root, setup=setup_module)
        with tempfile.TemporaryFile('w+') as noise, contextlib.redirect_stderr(noise):
            result = install_engine(ctx, plugin_root)
    except Exception as error:
        print('codex-cua install-engine failed: ' + reason(error), file=stderr or sys.stderr)
        return 1
    if args.json:
        out.write(json.dumps(result)+'\n')
    else:
        lines = ['Installed engine %s: %s' % (result['version'], result['root'])]
        if result['removed']:
            lines.append('Removed older engines: ' + ', '.join(result['removed']))
        state = result['setup']
        lines += ['Authored command: ' + state['command'],
                  'Ordinary app launch as host: ' + state['login_environment'],
                  'Relay files: ' + state['relay']]
        out.write('\n'.join(lines)+'\n')
    out.flush()
    return 0
