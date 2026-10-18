"""A read-only fingerprint of the folders the tests must never touch, and the difference between two of them.

Names are not enough: an overwrite inside a file that already exists changes no name. Every entry is described by
its type, size, modification time in nanoseconds and inode, so a rewritten file, a new or removed entry and a
changed directory all show. This module only ever looks (lstat, scandir); it never follows a link and never writes.
"""
import os
from pathlib import Path
import stat

WATCHED = ('.local/share/codex-cua', '.local/bin/codex-cua', 'Library/Caches/codex-cua',
           'Library/Caches/codex-host-cua', 'Library/LaunchAgents')


def real_home():
    """The home of this user according to the account database, which no HOME variable can redirect."""
    import pwd
    return Path(pwd.getpwuid(os.getuid()).pw_dir)


def fingerprint(home, watched=WATCHED):
    seen = {}
    home = Path(home)
    for name in watched:
        pending = [home/name]
        while pending:
            path = pending.pop()
            key = str(path.relative_to(home))
            try:
                info = os.lstat(path)
            except OSError:
                seen[key] = None                      # absent, or not for us to look at
                continue
            seen[key] = (stat.S_IFMT(info.st_mode), info.st_size, info.st_mtime_ns, info.st_ino)
            if stat.S_ISDIR(info.st_mode):
                try:
                    with os.scandir(path) as entries:
                        pending.extend(Path(entry.path) for entry in entries)
                except OSError:
                    pass
    return seen


def changes(before, after):
    return sorted(key for key in set(before) | set(after) if before.get(key) != after.get(key))
