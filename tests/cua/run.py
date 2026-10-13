#!/usr/bin/env python3
"""Run the development regressions against the repository's plugin sources."""
from pathlib import Path
import sys
import unittest


def main():
    sys.dont_write_bytecode = True
    tests = Path(__file__).resolve().parent
    plugin = tests.parents[1] / 'plugins/cua'
    sys.path.insert(0, str(plugin))
    suite = unittest.defaultTestLoader.discover(str(tests), pattern='test_*.py')
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())
