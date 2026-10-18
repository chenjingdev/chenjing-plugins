#!/usr/bin/env python3
"""Run the development regressions against the repository's plugin sources.

Code under test finds its support directories through the home directory. The runner therefore gives the whole run
a throw-away home. A test that forgets to inject its own root writes there instead of into the real one, and the
run fails if anything shows up there: a forgotten injection is loud, not silent. A child process that is given an
environment without HOME would find the real home through the account database, so the real support folders are
also fingerprinted before and after the run (read only, see guard.py) and the run fails on any difference.
"""
import os
from pathlib import Path
import sys
import tempfile
import unittest


def main():
    sys.dont_write_bytecode = True
    tests = Path(__file__).resolve().parent
    plugin = tests.parents[1] / 'plugins/cua'
    sys.path.insert(0, str(plugin))
    sys.path.insert(0, str(tests))
    import guard
    real_home = guard.real_home()
    before = guard.fingerprint(real_home)
    with tempfile.TemporaryDirectory(prefix='cua-tests-home-') as home:
        os.environ['HOME'] = home
        suite = unittest.defaultTestLoader.discover(str(tests), pattern='test_*.py')
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        # The interpreter's own bytecode cache lives under the home on this Mac; it is not ours.
        strays = sorted(str(path.relative_to(home)) for path in Path(home).rglob('*')
                        if path.relative_to(home).parts[:3] != ('Library', 'Caches', 'com.apple.python')
                        and str(path.relative_to(home)) not in ('Library', 'Library/Caches'))
    problems = []
    if strays:
        problems.append('Tests wrote into the default home instead of an injected one:\n  ' + '\n  '.join(strays))
    moved = guard.changes(before, guard.fingerprint(real_home))
    if moved:
        problems.append('The real support folders changed while the tests ran:\n  ' + '\n  '.join(moved[:30]))
    for problem in problems:
        print(problem, file=sys.stderr)
    return 0 if result.wasSuccessful() and not problems else 1


if __name__ == '__main__':
    raise SystemExit(main())
