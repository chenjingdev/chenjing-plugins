"""What `codex mcp get cua_repl --json` prints, the way the native CLI prints it: the effective server definition
in its own shape, without the fields it leaves out (omit_tools_from, tools). A `-c mcp_servers.cua_repl=<table>`
among the options replaces the definition, as it does in the real CLI."""
import copy

from toml_subset import parse_override


def shown(table):
    return {'name': 'cua_repl', 'enabled': table.get('enabled', True), 'disabled_reason': None,
            'transport': {'type': 'stdio', 'command': table['command'], 'args': table.get('args', []),
                          'env': table.get('env'), 'env_vars': table.get('env_vars', []), 'cwd': None},
            'enabled_tools': table.get('enabled_tools'), 'disabled_tools': table.get('disabled_tools'),
            'startup_timeout_sec': table.get('startup_timeout_sec'), 'tool_timeout_sec': table.get('tool_timeout_sec')}


def mcp_get(flags, definition, ignore_override=False, alter_env=None):
    result = copy.deepcopy(definition)
    for position, item in enumerate(flags):
        if item == '-c' and flags[position+1].startswith('mcp_servers.cua_repl=') and not ignore_override:
            result = shown(parse_override(flags[position+1])[1])
            if alter_env:
                result['transport']['env'] = alter_env(result['transport']['env'])
    return result
