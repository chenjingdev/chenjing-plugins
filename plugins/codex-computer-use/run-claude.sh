#!/bin/sh
set -eu
plugin_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
exec claude --plugin-dir "$plugin_dir" "$@"
