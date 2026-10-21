"""Install and verify the CUA relay without touching ~/.codex/config.toml.

The relay (relay/relay.mjs, started through relay/node-repl-relay) sits where cua-repl starts the original
node_repl. Three things in this module make that happen and keep it safe:

* a stable copy of the relay files in <data dir>/relay/, because Claude Code deletes old plugin versions
  while Codex is still running;
* the plan the Codex launcher follows at every primary start: read the effective bundled `cua_repl` definition
  from the native CLI, and only when it is exactly the bundled one, start the backend with one extra
  `-c mcp_servers.cua_repl=<table>` that differs from that definition in the environment alone;
* the identity check of the Claude bridge, which accepts a `cua_repl` server that is not the bundled plugin only
  when it is this relay;
* the relay definition a Claude bridge hands to its own thread. The desktop app writes `mcp_servers.cua_repl = null`
  into the host's configuration when it starts, which also takes away the launcher's `-c`, so a thread without
  configuration of its own would get the bundled runtime. The launcher keeps its verified table in the host record
  for that.

Everything here refuses rather than guesses: a refusal means Codex starts exactly as it would without the relay.
Reasons are fixed code words. No definition, environment value or path is ever put into a message.
"""
import json
import math
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import tempfile
import weakref

SERVER = 'cua_repl'
SERVER_KEY = 'mcp_servers.' + SERVER
RELAY_DIRECTORY = 'relay'
LAUNCHER = 'node-repl-relay'
SCRIPT = 'relay.mjs'
FILES = (SCRIPT, LAUNCHER)        # the launcher goes last: once it exists, the script next to it does too
END_MARKERS = {SCRIPT: b'// codex-cua relay end', LAUNCHER: b'# codex-cua relay end'}

ENV_RUNTIME_PATH = 'CUA_REPL_NODE_REPL_PATH'
ENV_NATIVE = 'CODEX_CUA_NATIVE_RUNTIME'
ENV_NODE = 'CODEX_CUA_RELAY_NODE'
ENV_STATE = 'CODEX_CUA_STATE_DIR'
ENV_OWNER = 'CODEX_CUA_OWNER'
RELAY_ENV = (ENV_NATIVE, ENV_NODE, ENV_STATE)
OWNER_NAME = re.compile(r'^bridge-[0-9]{1,10}-[0-9]{1,12}$')
SECRET_NAME = re.compile('TOKEN|SECRET|PASSWORD|KEY|AUTH', re.IGNORECASE)

READ_TIMEOUT = 3.0
MAX_DEFINITION_BYTES = 1 << 20
MAX_OVERRIDE_BYTES = 1 << 16
PLUGIN_NAME = 'unified-computer-use'
PLUGIN_MARKETPLACE = 'openai-bundled'

# What `mcp get cua_repl --json` may contain. Anything else is a field this code does not know how to reproduce.
DEFINITION_FIELDS = frozenset(('name', 'enabled', 'disabled_reason', 'transport', 'enabled_tools',
                               'disabled_tools', 'startup_timeout_sec', 'tool_timeout_sec'))
TRANSPORT_FIELDS = frozenset(('type', 'command', 'args', 'env', 'env_vars', 'cwd'))
# What the bundled plugin's .mcp.json entry may contain. `mcp get` hides omit_tools_from and tools.
PLUGIN_ENTRY_FIELDS = frozenset(('command', 'args', 'env', 'env_vars', 'enabled', 'enabled_tools', 'disabled_tools',
                                 'omit_tools_from', 'startup_timeout_sec', 'tool_timeout_sec', 'tools'))


class RelayRefused(Exception):
    """The relay is not used. The message is a fixed reason code, never a value."""


# ------------------------------------------------------------------ the stable copy

def relay_dir(data_dir):
    return Path(data_dir)/RELAY_DIRECTORY


def stable_launcher(data_dir):
    return relay_dir(data_dir)/LAUNCHER


def _owned_private(info):
    return stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not stat.S_IMODE(info.st_mode) & 0o077


def source_files(plugin_root):
    """The relay files of this plugin version, complete and unmodified-looking, or RelayRefused."""
    sources = {}
    for name in FILES:
        path = Path(plugin_root)/RELAY_DIRECTORY/name
        try:
            if not stat.S_ISREG(path.lstat().st_mode):
                raise RelayRefused('stable_copy')
            data = path.read_bytes()
        except OSError:
            raise RelayRefused('stable_copy') from None
        if not data.rstrip().endswith(END_MARKERS[name]):
            raise RelayRefused('stable_copy')          # a half-written update must never become the stable copy
        sources[name] = data
    return sources


def _identical(path, data, mode):
    try:
        info = path.lstat()
        return (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == mode
                and path.read_bytes() == data)
    except OSError:
        return False


def _replace(path, data, mode):
    """Write next to the target, then rename over it: a reader sees the old file or the new one, never half."""
    descriptor, temporary = tempfile.mkstemp(dir=str(path.parent), prefix='.relay-')
    try:
        with os.fdopen(descriptor, 'wb') as output:
            os.fchmod(output.fileno(), mode)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def refresh_relay_files(plugin_root, data_dir):
    """Make <data dir>/relay/ hold this plugin's relay files; return the stable launcher path.

    The data dir is the support directory of `codex-cua setup`; it has to exist already, private and owned.
    Files that are already identical are left alone.
    """
    sources = source_files(plugin_root)
    data_dir = Path(data_dir)
    try:
        if not _owned_private(data_dir.lstat()):
            raise RelayRefused('stable_copy')
        directory = relay_dir(data_dir)
        directory.mkdir(mode=0o700, exist_ok=True)
        if not _owned_private(directory.lstat()):
            raise RelayRefused('stable_copy')
        for name in FILES:
            mode = 0o700 if name == LAUNCHER else 0o600
            if not _identical(directory/name, sources[name], mode):
                _replace(directory/name, sources[name], mode)
    except OSError:
        raise RelayRefused('stable_copy') from None
    return directory/LAUNCHER


def remove_relay_files(data_dir):
    directory = relay_dir(data_dir)
    try:
        info = directory.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISDIR(info.st_mode):
        shutil.rmtree(directory)
    else:
        directory.unlink()


def relay_files_status(data_dir):
    """`ready`, `missing` or `invalid` for the relay files of the support directory."""
    directory = relay_dir(data_dir)
    try:
        info = directory.lstat()
    except FileNotFoundError:
        return 'missing'
    except OSError:
        return 'invalid'
    if not _owned_private(info):
        return 'invalid'
    for name in FILES:
        path = directory/name
        try:
            info = path.lstat()
        except FileNotFoundError:
            return 'missing'
        except OSError:
            return 'invalid'
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022:
            return 'invalid'
        if name == LAUNCHER and not stat.S_IMODE(info.st_mode) & stat.S_IXUSR:
            return 'invalid'
        try:
            if not path.read_bytes().rstrip().endswith(END_MARKERS[name]):
                return 'invalid'
        except OSError:
            return 'invalid'
    return 'ready'


def trusted_launcher(path):
    """A runnable regular file of this user that nobody else can write, in a directory nobody else can write."""
    path = Path(path)
    try:
        info = path.lstat()
        parent = path.parent.lstat()
    except OSError:
        return False
    return (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) & stat.S_IXUSR
            and not stat.S_IMODE(info.st_mode) & 0o022
            and stat.S_ISDIR(parent.st_mode) and parent.st_uid == os.getuid()
            and not stat.S_IMODE(parent.st_mode) & 0o022)


# ------------------------------------------------------------------ TOML for the -c override

def _toml_string(value):
    pieces = ['"']
    for character in value:
        code = ord(character)
        if 0xd800 <= code <= 0xdfff:
            raise ValueError('lone surrogate')
        if character == '"':
            pieces.append('\\"')
        elif character == '\\':
            pieces.append('\\\\')
        elif character in '\b\t\n\f\r':
            pieces.append({'\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r'}[character])
        elif code < 0x20 or code == 0x7f:
            pieces.append('\\u%04X' % code)
        elif code > 0x7e:
            pieces.append('\\u%04X' % code if code <= 0xffff else '\\U%08X' % code)
        else:
            pieces.append(character)
    pieces.append('"')
    return ''.join(pieces)


def toml_value(value):
    """TOML text for JSON-like data (pure ASCII, one line). Anything TOML cannot say raises ValueError."""
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError('not finite')
        return repr(value)
    if isinstance(value, str):
        return _toml_string(value)
    if isinstance(value, list):
        return '[' + ', '.join(toml_value(item) for item in value) + ']'
    if isinstance(value, dict):
        parts = []
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError('key')
            name = key if re.fullmatch('[A-Za-z0-9_-]+', key) else _toml_string(key)
            parts.append(name + ' = ' + toml_value(item))
        return '{' + ', '.join(parts) + '}'
    raise ValueError('type')


# ------------------------------------------------------------------ reading what Codex would start

CONFIG_OPTIONS = ('-c', '--config', '--enable', '--disable')          # take the next argument as their value
CONFIG_PREFIXES = ('--config=', '--enable=', '--disable=', '-c=')       # carry their value in the same argument


def _option_width(item):
    """How many arguments a configuration option takes (0: this is not one). The same rules as is_primary_launch."""
    if item in CONFIG_OPTIONS:
        return 2
    return 1 if item.startswith(CONFIG_PREFIXES) else 0


def config_flags(arguments):
    """The configuration options in `arguments`, in order: what shapes the effective config."""
    flags = []
    index = 0
    while index < len(arguments):
        width = _option_width(arguments[index])
        if width and index + width <= len(arguments):
            flags += arguments[index:index + width]
        index += width or 1
    return flags


def subcommand_index(arguments):
    """Where the subcommand is: the first argument that is not a root-level option (or its value)."""
    index = 0
    while index < len(arguments):
        width = _option_width(arguments[index])
        if not width:
            return index
        index += width
    raise RelayRefused('not_a_launch')


def read_definition(native, flags, environment, run=subprocess.run):
    """`<native> <flags> mcp get cua_repl --json`: the effective definition, as the native CLI sees it."""
    try:
        result = run([str(native), *flags, 'mcp', 'get', SERVER, '--json'], stdin=subprocess.DEVNULL,
                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=environment, timeout=READ_TIMEOUT)
        if result.returncode != 0 or len(result.stdout) > MAX_DEFINITION_BYTES:
            raise RelayRefused('definition_unreadable')
        value = json.loads(result.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        raise RelayRefused('definition_unreadable') from None
    if not isinstance(value, dict):
        raise RelayRefused('definition_unreadable')
    return value


def _same_path(left, right):
    return (isinstance(left, str) and os.path.isabs(left)
            and os.path.realpath(left) == os.path.realpath(str(right)))


def _strings(value):
    return isinstance(value, list) and all(isinstance(item, str) and item for item in value)


def _timeout(value):
    return value is None or (isinstance(value, (int, float)) and not isinstance(value, bool)
                             and math.isfinite(value) and value > 0)


def bundled_definition(value, cua_root):
    """Validate the effective definition; return it unchanged. It must be the bundled stdio server, nothing more."""
    if set(value) - DEFINITION_FIELDS:
        raise RelayRefused('unknown_field')
    transport = value.get('transport')
    if not isinstance(transport, dict) or transport.get('type') != 'stdio':
        raise RelayRefused('not_bundled')
    if set(transport) - TRANSPORT_FIELDS:
        raise RelayRefused('unknown_field')
    env = transport.get('env')
    if (value.get('name') != SERVER or value.get('enabled') is not True or value.get('disabled_reason') is not None
            or transport.get('cwd') is not None
            or not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items())
            or not isinstance(transport.get('args'), list) or len(transport['args']) != 1
            or not _strings(transport.get('env_vars', []))
            or not _timeout(value.get('startup_timeout_sec')) or not _timeout(value.get('tool_timeout_sec'))
            or any(value.get(key) is not None and not _strings(value.get(key)) for key in ('enabled_tools', 'disabled_tools'))):
        raise RelayRefused('not_bundled')
    cua_root = Path(cua_root)
    if (not _same_path(transport.get('command'), cua_root/'bin/node')
            or not _same_path(transport['args'][0], cua_root/'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')
            or not _same_path(env.get(ENV_RUNTIME_PATH), cua_root/'bin/node_repl')):
        raise RelayRefused('not_bundled')
    if any(SECRET_NAME.search(name) for name in env):
        raise RelayRefused('secret_env')
    if any(name in env for name in RELAY_ENV):
        raise RelayRefused('relay_env_present')
    return value


def _plain(value, depth=0):
    """JSON-like data TOML can say: strings, numbers, booleans, lists and tables of those."""
    if depth > 4:
        return False
    if isinstance(value, (str, bool, int)) or (isinstance(value, float) and math.isfinite(value)):
        return True
    if isinstance(value, list):
        return all(_plain(item, depth + 1) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and _plain(item, depth + 1) for key, item in value.items())
    return False


def _bundled_plugin_entry(installation, definition, environment, home):
    """The bundled plugin's own entry for the server, found where `mcp get` finds it.

    `mcp get` leaves out omit_tools_from and tools, which belong to the definition and shape what Codex's own
    threads see. They are taken from the plugin's .mcp.json, but only when that file is of the very plugin
    version this app bundles and agrees with everything `mcp get` shows. Anything else: refuse.
    """
    try:
        with (installation.app_path/'Contents/Info.plist').open('rb') as source:
            version = plistlib.load(source).get('CFBundleShortVersionString')
        if not isinstance(version, str) or not re.fullmatch(r'[0-9A-Za-z._+-]+', version) or version.startswith('.'):
            raise RelayRefused('plugin_entry')
        codex_home = environment.get('CODEX_HOME') or str((Path(home) if home else Path.home())/'.codex')
        env = definition['transport']['env']
        if (not os.path.isabs(codex_home)
                or (env.get('CODEX_HOME') is not None and os.path.realpath(env['CODEX_HOME']) != os.path.realpath(codex_home))
                or env.get('BROWSER_USE_CODEX_APP_VERSION', version) != version):
            raise RelayRefused('plugin_entry')
        directory = Path(codex_home)/'plugins/cache'/PLUGIN_MARKETPLACE/PLUGIN_NAME/version
        for name in ('.codex-plugin/plugin.json', '.mcp.json'):
            info = (directory/name).lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022:
                raise RelayRefused('plugin_entry')
        manifest = json.loads((directory/'.codex-plugin/plugin.json').read_text())
        loaded = json.loads((directory/'.mcp.json').read_text())
    except RelayRefused:
        raise
    except (OSError, ValueError, AttributeError, TypeError):
        raise RelayRefused('plugin_entry') from None
    servers = loaded.get('mcpServers', loaded.get('mcp_servers')) if isinstance(loaded, dict) else None
    entry = servers.get(SERVER) if isinstance(servers, dict) else None
    if (not isinstance(manifest, dict) or manifest.get('name') != PLUGIN_NAME or manifest.get('version') != version
            or not isinstance(entry, dict)):
        raise RelayRefused('plugin_entry')
    return entry


def _hidden_fields(definition, entry):
    """omit_tools_from and tools from the plugin entry, after checking the entry says what `mcp get` says."""
    if set(entry) - PLUGIN_ENTRY_FIELDS:
        raise RelayRefused('plugin_entry')
    transport = definition['transport']
    same = (entry.get('command') == transport['command'] and entry.get('args') == transport['args']
            and entry.get('env') == transport['env']
            and entry.get('env_vars', []) == transport.get('env_vars', [])
            and entry.get('enabled', True) is True
            and entry.get('enabled_tools') == definition.get('enabled_tools')
            and entry.get('disabled_tools') == definition.get('disabled_tools')
            and entry.get('startup_timeout_sec') == definition.get('startup_timeout_sec')
            and entry.get('tool_timeout_sec') == definition.get('tool_timeout_sec'))
    if not same:
        raise RelayRefused('plugin_entry')
    hidden = {}
    if 'omit_tools_from' in entry:
        if not _strings(entry['omit_tools_from']):
            raise RelayRefused('plugin_entry')
        hidden['omit_tools_from'] = list(entry['omit_tools_from'])
    if 'tools' in entry:
        tools = entry['tools']
        if not isinstance(tools, dict) or not _plain(tools):
            raise RelayRefused('plugin_entry')
        hidden['tools'] = tools
    return hidden


def build_override(definition, hidden, launcher, state_dir=None):
    """The `-c` value: every field of the definition, the environment changed to start the relay.

    Returns (override, environment, table): the argument `mcp_servers.cua_repl=<inline table>`, the new environment
    and the table itself.
    """
    transport = definition['transport']
    env = dict(transport['env'])
    env[ENV_RUNTIME_PATH] = str(launcher)
    env[ENV_NATIVE] = transport['env'][ENV_RUNTIME_PATH]
    env[ENV_NODE] = transport['command']
    if state_dir:
        env[ENV_STATE] = state_dir
    table = {'command': transport['command'], 'args': list(transport['args']), 'env': env}
    if transport.get('env_vars'):
        table['env_vars'] = list(transport['env_vars'])
    table['enabled'] = True
    for key in ('enabled_tools', 'disabled_tools'):
        if definition.get(key) is not None:
            table[key] = list(definition[key])
    if 'omit_tools_from' in hidden:
        table['omit_tools_from'] = hidden['omit_tools_from']
    for key in ('startup_timeout_sec', 'tool_timeout_sec'):
        if definition.get(key) is not None:
            table[key] = definition[key]
    if 'tools' in hidden:
        table['tools'] = hidden['tools']
    try:
        text = SERVER_KEY + '=' + toml_value(table)
    except ValueError:
        raise RelayRefused('unrepresentable') from None
    if len(text.encode('ascii')) > MAX_OVERRIDE_BYTES:
        raise RelayRefused('unrepresentable')
    return text, env, table


class RelayPlan:
    """What the launcher does for this start: the arguments of the backend and the proxy, and what was verified."""

    def __init__(self, arguments, override, launcher, native_runtime, node, script, state_dir, table=None):
        self.arguments = arguments
        self.override = override
        self.table = table              # the override as data: what a Claude bridge gives its own thread
        self.launcher = launcher
        self.native_runtime = native_runtime
        self.node = node
        self.script = script
        self.state_dir = state_dir

    def proxy_arguments(self):
        """For the desktop transport: the verified paths it needs to point the app's own threads at the relay."""
        arguments = ['--relay-launcher', str(self.launcher), '--relay-native-runtime', self.native_runtime,
                     '--relay-node', self.node, '--relay-script', self.script]
        if self.state_dir:
            arguments += ['--relay-state-dir', self.state_dir]
        return arguments


def _home(environment):
    value = environment.get('HOME')
    return Path(value) if value and os.path.isabs(value) else None


def _plan(native, arguments, environment, plugin_root, home, run):
    from runtime_paths import installation_from_native_cli, InstallationError, runtime_home
    home = home if home is not None else _home(environment)
    launcher = refresh_relay_files(plugin_root, runtime_home(home))
    if not trusted_launcher(launcher):
        raise RelayRefused('launcher_untrusted')
    try:
        installation = installation_from_native_cli(native)
    except (InstallationError, OSError):
        raise RelayRefused('not_original_cli') from None
    # The options are given to `mcp get` in the order of the real start: the root-level ones, then (below) our
    # override, then the subcommand's own.
    index = subcommand_index(arguments)
    root_flags, own_flags = config_flags(arguments[:index]), config_flags(arguments[index + 1:])
    definition = bundled_definition(read_definition(native, root_flags + own_flags, environment, run), installation.cua_root)
    hidden = _hidden_fields(definition, _bundled_plugin_entry(installation, definition, environment, home))
    state = environment.get(ENV_STATE)
    state = state if isinstance(state, str) and os.path.isabs(state) else None
    override, env, table = build_override(definition, hidden, launcher, state)
    # Ask the native CLI's own parser whether it reads the override back as intended, before the backend gets it.
    expected = json.loads(json.dumps(definition))
    expected['transport']['env'] = env
    if read_definition(native, root_flags + ['-c', override] + own_flags, environment, run) != expected:
        raise RelayRefused('override_rejected')
    return RelayPlan(list(arguments[:index]) + ['-c', override] + list(arguments[index:]), override, launcher,
                     definition['transport']['env'][ENV_RUNTIME_PATH], definition['transport']['command'],
                     definition['transport']['args'][0], state, table)


def plan_relay(native, arguments, environment, plugin_root, home=None, run=subprocess.run):
    """(plan, None) when the relay can be put in front of the bundled runtime for this start, else (None, reason).

    Never raises. The reason is a fixed code word.
    """
    try:
        return _plan(native, arguments, environment, plugin_root, home, run), None
    except RelayRefused as refusal:
        return None, str(refusal)
    except Exception:
        return None, 'unexpected'


# ------------------------------------------------------------------ the Claude bridge

def _registry(socket_path, launcher):
    """Does the host registry say the Codex launcher put this relay in front of the runtime of this very host?"""
    from runtime_paths import default_state
    state = Path(os.environ.get('CODEX_HOST_CUA_STATE_DIR') or default_state())
    parent = state.lstat()
    info = (state/'host.json').lstat()
    if (not state.is_absolute() or not _owned_private(parent) or not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077):
        return False
    data = json.loads((state/'host.json').read_text())
    return (isinstance(data, dict) and data.get('schema_version') == 1 and data.get('status') == 'ready'
            and data.get('relay') is True and data.get('relay_launcher') == str(launcher)
            and data.get('socket_path') == str(socket_path))


def _shown_server(result):
    config = result.get('config') if isinstance(result, dict) else None
    if not isinstance(config, dict):
        return None
    for key in ('mcp_servers', 'mcpServers'):
        servers = config.get(key)
        if isinstance(servers, dict) and servers.get(SERVER) is not None:
            return servers[SERVER]
    return None


def transport_is_relay(entry, cua_root, launcher):
    """Is the server definition `config/read` shows the relay in front of the bundled runtime?"""
    if not isinstance(entry, dict):
        return False
    transport = entry['transport'] if isinstance(entry.get('transport'), dict) else entry
    command, args, env = transport.get('command'), transport.get('args'), transport.get('env')
    if (not isinstance(command, str) or not isinstance(args, list) or not isinstance(env, dict)
            or not all(isinstance(item, str) for item in args)):
        return False
    cua_root = Path(cua_root)
    return (_same_path(command, cua_root/'bin/node')
            and len(args) == 1 and _same_path(args[0], cua_root/'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')
            and env.get(ENV_RUNTIME_PATH) == str(launcher)
            and _same_path(env.get(ENV_NATIVE), cua_root/'bin/node_repl')
            and env.get(ENV_NODE) == command)


_decided = weakref.WeakKeyDictionary()      # one decision per boot: `request` is a new function in every boot


def relay_thread_server(registry, cua_root, owner=None, home=None):
    """The `cua_repl` definition a Claude bridge gives its own thread so the relay runs in front of its runtime.

    Only the table the launcher verified and kept in a ready host record whose relay is the trusted launcher of this
    home, and only when it is exactly the relay in front of the bundled runtime. The bridge's name goes into the
    relay's environment and from there into its record; the runtime never sees it. None means the thread is started
    without it, as before.
    """
    try:
        if not isinstance(registry, dict) or registry.get('relay') is not True or cua_root is None:
            return None
        from runtime_paths import runtime_home
        launcher = stable_launcher(runtime_home(home))
        if registry.get('relay_launcher') != str(launcher) or not trusted_launcher(launcher):
            return None
        table = registry.get('relay_config')
        if not isinstance(table, dict) or not _plain(table) or not transport_is_relay(table, cua_root, launcher):
            return None
        server = json.loads(json.dumps(table))
        if isinstance(owner, str) and OWNER_NAME.match(owner):
            server['env'][ENV_OWNER] = owner
        return server
    except Exception:
        return None


async def accept_relay(adapter, request, selected, home=None):
    """True when the host's `cua_repl` is this plugin's relay, so the bridge may use it like the bundled plugin.

    `selected` is the server entry of mcpServerStatus/list. A server that reports a plugin is not the relay (a
    config-defined server, which the relay is, reports none). `config/read` is asked first. If it shows the server,
    the transport has to be exactly the relay's. If it does not show the server at all, the host registry has to
    say the launcher put the relay there. In both cases the launcher must be a file only this user can write.
    The answer is asked for once per boot: the caller asks again on every pass while the runtime starts.
    """
    if selected.get('pluginId') is not None:
        return False
    if request not in _decided:
        _decided[request] = await _decide(adapter, request, home)
    return _decided[request]


async def _decide(adapter, request, home):
    try:
        from runtime_paths import runtime_home
        if adapter.native_cua_root is None:
            return False
        launcher = stable_launcher(runtime_home(home))
        if not trusted_launcher(launcher):
            return False
        try:
            result = await request('config/read', {'includeLayers': False})
        except Exception:
            result = None
        shown = _shown_server(result)
        if shown is not None:
            return transport_is_relay(shown, adapter.native_cua_root, launcher)
        return _registry(adapter.rpc.socket_path, launcher)
    except Exception:
        return False
