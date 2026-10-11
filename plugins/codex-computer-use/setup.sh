#!/bin/sh
set -eu
plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bootstrap_python=/usr/bin/python3
if ! "$bootstrap_python" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
  bootstrap_python=$(command -v python3 || true)
  if [ -z "$bootstrap_python" ] || ! "$bootstrap_python" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
    printf '%s\n' 'codex-cua requires Python 3.9 or newer. No package manager was installed.' >&2
    exit 1
  fi
fi
export PYTHONDONTWRITEBYTECODE=1
exec "$bootstrap_python" "$plugin_root/setup.py" "$@"
