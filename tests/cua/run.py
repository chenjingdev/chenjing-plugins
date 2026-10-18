#!/usr/bin/env python3
"""Run the development regressions against the repository's plugin sources.

Code under test finds its support directories through the home directory. The runner therefore gives the whole run
a throw-away home. A test that forgets to inject its own root writes there instead of into the real one, and the
run fails if anything shows up there: a forgotten injection is loud, not silent. A child process that is given an
environment without HOME would find the real home through the account database, so the real support folders are
also fingerprinted before and after the run (read only, see guard.py) and the run fails on any difference.

Exit code: 0 when everything passed. 1 when a test failed or a test wrote into the throw-away home. 2 when the real
support folders changed while the run was going; the changed paths are listed with their new modification time in
local time. Using CUA, starting Codex or installing the plugin during the run does that, and then the run proves
nothing, so 2 wins over 1 (the test results are printed above it all the same). Run the tests again while CUA is
not in use; if 2 repeats with everything idle, a test writes there.

--tests and --real-home point the runner at a stand-in suite and a stand-in home. They exist for the runner's own
tests (test_guard.py) and are not needed otherwise.
"""
import argparse
import os
from pathlib import Path
import sys
import tempfile
import unittest

EXIT_FAILED = 1
EXIT_GUARD = 2
SHOWN = 30                       # changed paths that are printed; the rest is only counted
MOVED = ('The real support folders changed while the tests ran. The tests only read them, so most likely '
         'something else did: using CUA, starting Codex or installing the plugin during the run. Run the tests '
         'again while CUA is not in use; if it repeats with everything idle, a test writes there. New '
         'modification time, local time:')


def main(argv=None):
    sys.dont_write_bytecode = True
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description='Run the development regressions of the cua plugin.')
    parser.add_argument('--tests', type=Path, default=here, help='folder to discover test_*.py in (default: this one)')
    parser.add_argument('--real-home', type=Path,
                        help='home whose support folders the guard watches (default: the home of this account)')
    args = parser.parse_args(argv)
    plugin = here.parents[1] / 'plugins/cua'
    sys.path.insert(0, str(plugin))
    sys.path.insert(0, str(here))
    import guard
    real_home = args.real_home or guard.real_home()
    before = guard.fingerprint(real_home)
    with tempfile.TemporaryDirectory(prefix='cua-tests-home-') as home:
        os.environ['HOME'] = home
        suite = unittest.defaultTestLoader.discover(str(args.tests), pattern='test_*.py')
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        # The interpreter's own bytecode cache lives under the home on this Mac; it is not ours.
        strays = sorted(str(path.relative_to(home)) for path in Path(home).rglob('*')
                        if path.relative_to(home).parts[:3] != ('Library', 'Caches', 'com.apple.python')
                        and str(path.relative_to(home)) not in ('Library', 'Library/Caches'))
    problems = []
    if strays:
        problems.append('Tests wrote into the default home instead of an injected one:\n  ' + '\n  '.join(strays))
    moved = guard.describe(before, guard.fingerprint(real_home))
    if moved:
        more = ['... and %d more' % (len(moved) - SHOWN)] if len(moved) > SHOWN else []
        problems.append(MOVED + '\n  ' + '\n  '.join(moved[:SHOWN] + more))
    for problem in problems:
        print(problem, file=sys.stderr)
    if moved:
        return EXIT_GUARD
    return 0 if result.wasSuccessful() and not strays else EXIT_FAILED


if __name__ == '__main__':
    raise SystemExit(main())
