"""The block in the login shell's startup file that has Codex start through the host launcher.

At its start, before its global state and the app-server, Codex on macOS waits up to five seconds for the environment
of the user's login shell: it runs the shell with `-ilc` (CODEX_SHELL=1 added to the environment it hands on) and merges
whatever the shell's `env` prints into its own. The app-server it starts next is $CODEX_CLI_PATH when that is set. When
macOS reopens Codex at login, Codex is up before launchd runs the login agent of setup (19 seconds before it after the
restart of 2026-10-30), so only the shell can hand the launcher over in time.

The block exports the login agent's two values, and only in a shell that Codex starts (CODEX_SHELL, or Codex's bundle id
in __CFBundleIdentifier, which Codex's own children inherit) while the launcher is there. In a terminal its condition is
false and it does nothing; once the engine is gone it does nothing either.

zsh reads $ZDOTDIR/.zshenv (~/.zshenv without ZDOTDIR) before anything else, in every shell. bash as a login shell reads
the first of ~/.bash_profile, ~/.bash_login and ~/.profile that is there. Any other login shell gets no block: the login
agent alone serves it.

Only the block is ever written, from its first marker line to its last: what is outside stays byte for byte, and a file
that already holds the same block is not written at all. A file is replaced as a whole (a new file beside it, renamed
over it) with the mode it had. A link stays where it is, and the file it points to is the one that changes.
"""
import os
from pathlib import Path
import pwd
import stat
import tempfile

from runtime_paths import CODEX_BUNDLE_ID

START = b'# >>> codex-cua (CUA Bar) >>>'
END = b'# <<< codex-cua (CUA Bar) <<<'
NOTE = b'# CUA Bar: Codex reads this when it starts, so it attaches even when macOS reopens Codex at login.'
BASH_FILES = ('.bash_profile', '.bash_login', '.profile')
NEW_FILE_MODE = 0o644


def login_shell():
    """The login shell of this user in the account database ('' when it names none)."""
    try:
        return pwd.getpwuid(os.getuid()).pw_shell or ''
    except KeyError:
        return ''


def zsh_folder(home, environment):
    """Where zsh finds .zshenv: $ZDOTDIR when it is an absolute path, else the home folder."""
    folder = environment.get('ZDOTDIR') or ''
    return Path(folder) if os.path.isabs(folder) else Path(home)


def startup_file(home, environment):
    """The file the login shell reads first when Codex starts it, or None for a shell that gets no block."""
    name = os.path.basename(login_shell())
    if name == 'zsh':
        return zsh_folder(home, environment)/'.zshenv'
    if name == 'bash':
        for file in BASH_FILES:
            if os.path.exists(Path(home)/file):      # a link that points nowhere is not there for bash either
                return Path(home)/file
        return Path(home)/BASH_FILES[0]
    return None


def candidate_files(home, environment):
    """Every file a setup may have put the block in, whatever the login shell is now."""
    files = [zsh_folder(home, environment)/'.zshenv', Path(home)/'.zshenv'] + [Path(home)/name for name in BASH_FILES]
    return list(dict.fromkeys(files))


def quoted(value):
    """`value` in single quotes, the same for sh, bash and zsh."""
    return b"'" + os.fsencode(value).replace(b"'", b"'\"'\"'") + b"'"


def block(values):
    """The block for the login agent's values, CODEX_CLI_PATH (the launcher it looks for) first."""
    lines = [START, NOTE,
             b'if [ -n "${CODEX_SHELL-}" ] || [ "${__CFBundleIdentifier-}" = ' + CODEX_BUNDLE_ID.encode() + b' ]; then',
             b'  if [ -x ' + quoted(values['CODEX_CLI_PATH']) + b' ]; then']
    lines += [b'    export ' + key.encode() + b'=' + quoted(value) for key, value in values.items()]
    lines += [b'  fi', b'fi', END]
    return b'\n'.join(lines)+b'\n'


def lines_of(data):
    """The lines of `data`, each with its newline (the last one may have none): joined they are `data` again."""
    lines = data.split(b'\n')
    last = lines.pop()
    return [line+b'\n' for line in lines]+([last] if last else [])


def blocks_in(lines):
    """(first, last) line numbers of every block: a start line, then an end line, and no other start line between them.
    A start line without its end is text like any other, and so is an end line without its start."""
    found, opened = [], None
    for number, line in enumerate(lines):
        marker = line.strip()
        if marker == START:
            opened = number
        elif marker == END and opened is not None:
            found.append((opened, number))
            opened = None
    return found


def _rebuilt(lines, blocks, instead=None):
    """`lines` with every block taken out, and `instead` where the first one was."""
    kept, start = [], 0
    for number, (first, last) in enumerate(blocks):
        kept += lines[start:first]
        if number == 0 and instead is not None:
            kept.append(instead)
        start = last+1
    return b''.join(kept+lines[start:])


def with_block(data, text):
    """`data` with `text` as its one block: where the first block was, else at the end on a line of its own."""
    lines = lines_of(data)
    blocks = blocks_in(lines)
    if blocks:
        return _rebuilt(lines, blocks, text)
    return data+(b'\n' if data and not data.endswith(b'\n') else b'')+text


def without_block(data):
    lines = lines_of(data)
    return _rebuilt(lines, blocks_in(lines))


def _read(path):
    """What the file (that a link points to) holds; b'' when there is none. Anything but a plain file is an OSError."""
    try:
        info = os.stat(path)
    except FileNotFoundError:
        return b''
    if not stat.S_ISREG(info.st_mode):
        raise IsADirectoryError(path)
    with open(path, 'rb') as source:
        return source.read()


def _writable(path):
    """Whether the file (that a link points to) can be replaced as a whole: a plain file of this user that this user may
    write, or none yet, in a folder this user may write to."""
    target = os.path.realpath(path)
    try:
        info = os.stat(target)
    except FileNotFoundError:
        info = None
    except OSError:
        return False
    if info is not None and (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                             or not os.access(target, os.W_OK)):
        return False
    folder = os.path.dirname(target)
    return os.path.isdir(folder) and os.access(folder, os.W_OK | os.X_OK)


def _replace(target, data):
    """`data` as a new file beside `target`, with the mode `target` has (0644 for a new one), renamed over it."""
    try:
        mode = stat.S_IMODE(os.stat(target).st_mode)
    except FileNotFoundError:
        mode = NEW_FILE_MODE
    descriptor, name = tempfile.mkstemp(dir=os.path.dirname(target), prefix='.codex-cua-')
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(data)
            os.fchmod(output.fileno(), mode)
        os.replace(name, target)
    finally:
        try:
            os.unlink(name)
        except FileNotFoundError:
            pass


def block_state(path, values):
    """ready (the file holds the block once, as it is now), missing (no block), outdated (another block, or more than
    one) or unwritable (not ready, and the file cannot be read or replaced). Nothing is written."""
    try:
        data = _read(path)
    except OSError:
        return 'unwritable'
    if with_block(data, block(values)) == data:
        return 'ready'
    if not _writable(path):
        return 'unwritable'
    return 'outdated' if blocks_in(lines_of(data)) else 'missing'


def install_block(path, values):
    """Put the block into the file `path` (the one a link points to). ready, or unwritable when it cannot be."""
    target = os.path.realpath(path)
    try:
        data = _read(target)
        updated = with_block(data, block(values))
        if updated != data:
            if not _writable(target):
                return 'unwritable'
            _replace(target, updated)
    except OSError:
        return 'unwritable'
    return 'ready'


def remove_block(path):
    """Take every block out of the file `path` (the one a link points to); a file left with nothing but blanks goes.
    A file without a block is not touched. True when something was taken out; an OSError when it could not be."""
    target = os.path.realpath(path)
    data = _read(target)
    rest = without_block(data)
    if rest == data:
        return False
    if not _writable(target):
        raise PermissionError(target)
    if rest.strip():
        _replace(target, rest)
    else:
        os.unlink(target)
    return True
