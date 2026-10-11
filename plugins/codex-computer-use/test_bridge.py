"""Compatibility test entry point for the previous local installation command."""
import unittest


def load_tests(loader, tests, pattern):
    # Discovery already finds the three modules; avoid running them twice.
    if pattern is not None:
        return tests
    return loader.loadTestsFromNames(['test_host_mcp', 'test_desktop_cli_wrapper', 'test_registry'])


if __name__ == '__main__':
    unittest.main()
