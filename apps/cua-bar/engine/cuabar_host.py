"""Who runs this engine for Claude Code: CUA Bar (the menu bar app) or the cuabar Claude Code plugin (0.9.0).

The app registers a user MCP named `cuabar` (tools `mcp__cuabar__…`) and manages hooks in the Claude settings. The
plugin brings its own MCP and hooks; Claude Code names its tools `mcp__plugin_cuabar_cuabar__…` and its server
`plugin:cuabar:cuabar`. The plugin's launcher sets CUABAR_HOST=plugin for the bridge it starts, and its hooks pass
`plugin`. Standard library only: the hooks import it.
"""
import os

HOST_ENV = 'CUABAR_HOST'
PLUGIN = 'plugin'
TOOL_PREFIXES = ('mcp__cuabar__', 'mcp__plugin_cuabar_cuabar__')
APP_SERVER = 'cuabar'
PLUGIN_SERVER = 'plugin:cuabar:cuabar'


def plugin(environment=None):
    environment = os.environ if environment is None else environment
    return environment.get(HOST_ENV) == PLUGIN


def tool_name(name):
    """The CUA tool's own name (`js`, `status` …) when `name` is one of cuabar's under either host, else None."""
    if not isinstance(name, str):
        return None
    for prefix in TOOL_PREFIXES:
        if name.startswith(prefix) and len(name) > len(prefix):
            return name[len(prefix):]
    return None


def reconnect_command(environment=None):
    return '/mcp reconnect ' + (PLUGIN_SERVER if plugin(environment) else APP_SERVER)
