#!/bin/sh
# Standard-library-only hook: never bootstraps dependencies or starts Codex.
engine_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 0
exec /usr/bin/python3 -B "$engine_dir/claude_lifecycle.py" "$@"
