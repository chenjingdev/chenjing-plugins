#!/usr/bin/env python3
"""Run the development regressions against the repository's plugin sources.

Code under test finds its support directories through the home directory. The runner therefore gives the whole run
a throw-away home. A test that forgets to inject its own root writes there instead of into the real one, and the
run fails if anything shows up there: a forgotten injection is loud, not silent. The real support folders are only
looked at (names, never changed) to catch code that bypasses the home directory altogether.
"""
import os
from pathlib import Path
import sys
import tempfile
import unittest

WATCHED = ('.local/share/codex-cua', 'Library/Caches/codex-cua')


def listing(home):
    """Names in the support folders the tests must never touch. Read only."""
    seen = {}
    for name in WATCHED:
        root = Path(home)/name
        try:
            seen[name] = sorted(entry.name for entry in os.scandir(root))
            relay = root/'relay'
            seen[name+'/relay'] = sorted(entry.name for entry in os.scandir(relay)) if relay.is_dir() else None
        except OSError:
            seen[name] = None
    return seen


def main():
    sys.dont_write_bytecode = True
    tests = Path(__file__).resolve().parent
    plugin = tests.parents[1] / 'plugins/cua'
    sys.path.insert(0, str(plugin))
    real_home = os.environ.get('HOME') or str(Path.home())
    before = listing(real_home)
    with tempfile.TemporaryDirectory(prefix='cua-tests-home-') as home:
        os.environ['HOME'] = home
        suite = unittest.defaultTestLoader.discover(str(tests), pattern='test_*.py')
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        # The interpreter's own bytecode cache lives under the home on this Mac; it is not ours.
        strays = sorted(str(path.relative_to(home)) for path in Path(home).rglob('*')
                        if 'Library/Caches/com.apple.python' not in str(path) and path.relative_to(home).parts[:3] != ('Library', 'Caches', 'com.apple.python')
                        and str(path.relative_to(home)) not in ('Library', 'Library/Caches'))
    problems = []
    if strays:
        problems.append('Tests wrote into the default home instead of an injected one:\n  ' + '\n  '.join(strays))
    if listing(real_home) != before:
        problems.append('The real support folders changed while the tests ran: ' + ', '.join(WATCHED))
    for problem in problems:
        print(problem, file=sys.stderr)
    return 0 if result.wasSuccessful() and not problems else 1


if __name__ == '__main__':
    raise SystemExit(main())
