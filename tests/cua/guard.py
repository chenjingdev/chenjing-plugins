"""A read-only fingerprint of the folders the tests must never touch, and the difference between two of them.

Names are not enough: an overwrite inside a file that already exists changes no name. Every entry is described by
its type, size, modification time in nanoseconds and inode, so a rewritten file, a new or removed entry and a
changed directory all show. This module only ever looks (lstat, scandir); it never follows a link and never writes.
"""
from collections import namedtuple
from datetime import datetime
import os
from pathlib import Path
import stat

WATCHED = ('.local/share/codex-cua', '.local/bin/codex-cua', 'Library/Caches/codex-cua',
           'Library/Caches/codex-host-cua')
# Shared folders, of which only the entries with our own prefix count: other tools change their own entries all the
# time (the login agents of this plugin are com.chenjingdev.codex-cua.*).
PREFIXED = (('Library/LaunchAgents', 'com.chenjingdev.'),)

Entry = namedtuple('Entry', 'kind size mtime_ns inode')


def real_home():
    """The home of this user according to the account database, which no HOME variable can redirect."""
    import pwd
    return Path(pwd.getpwuid(os.getuid()).pw_dir)


def fingerprint(home, watched=WATCHED, prefixed=PREFIXED):
    seen = {}
    home = Path(home)
    starts = [home/name for name in watched]
    for name, prefix in prefixed:
        try:
            with os.scandir(home/name) as entries:
                starts += [home/name/entry.name for entry in entries if entry.name.startswith(prefix)]
        except OSError:
            pass
    for start in starts:
        pending = [start]
        while pending:
            path = pending.pop()
            key = str(path.relative_to(home))
            try:
                info = os.lstat(path)
            except OSError:
                seen[key] = None                      # absent, or not for us to look at
                continue
            seen[key] = Entry(stat.S_IFMT(info.st_mode), info.st_size, info.st_mtime_ns, info.st_ino)
            if stat.S_ISDIR(info.st_mode):
                try:
                    with os.scandir(path) as entries:
                        pending.extend(Path(entry.path) for entry in entries)
                except OSError:
                    pass
    return seen


def changes(before, after):
    return sorted(key for key in set(before) | set(after) if before.get(key) != after.get(key))


def local_time(mtime_ns):
    """A modification time in the local time zone, to the second and with its offset: 2026-10-19 00:12:34 +0900."""
    return datetime.fromtimestamp(mtime_ns // 1_000_000_000).astimezone().strftime('%Y-%m-%d %H:%M:%S %z')


def describe(before, after):
    """One line per changed path: what happened to it and, for what is still there, its new modification time."""
    lines = []
    for key in changes(before, after):
        now = after.get(key)
        if now is None:
            lines.append('%s  removed' % key)
        else:
            lines.append('%s  %s, modified %s' % (key, 'new' if before.get(key) is None else 'changed',
                                                  local_time(now.mtime_ns)))
    return lines
