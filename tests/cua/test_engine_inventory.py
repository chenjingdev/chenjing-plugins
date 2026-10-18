"""The inventory: process list parsing, what each process is, the host registry, the app and the setup state."""
from pathlib import Path
import plistlib
import types
import unittest
from unittest.mock import patch

import engine_inventory as inventory
import setup
from engine_support import APP_VERSION, ENGINE_PID, NOW, UID, EngineCase, lstart


class ParsingTests(EngineCase):
    def test_parses_pid_ppid_uid_start_memory_and_the_whole_command(self):
        text = ('    1     0     0 Ss   %s   19792 /sbin/launchd\n'
                '12345   600   501 S+   %s  73400 /Users/me/My Apps/tool --flag "two words"\n'
                % (lstart(NOW-5000), lstart(NOW-65)))
        procs = inventory.parse_ps(text)
        self.assertEqual(procs[12345], inventory.Proc(12345, 600, 501, NOW-65, 73400, '/Users/me/My Apps/tool --flag "two words"'))
        self.assertEqual(procs[1].start, NOW-5000)

    def test_a_day_of_the_month_below_ten_is_padded_with_a_space(self):
        line = '  77   1   501 Ss   Thu Oct  8 09:05:03 2026    1000 /bin/x\n'
        proc = inventory.parse_ps(line)[77]
        self.assertEqual(proc.start, int(__import__('time').mktime((2026, 10, 8, 9, 5, 3, 0, 0, -1))))

    def test_zombies_and_lines_in_another_language_are_skipped(self):
        text = ('  10   1   501 Z    %s       0 <defunct>\n'
                '  11   1   501 Ss   2026년 10월 18일 12:00:00     500 /bin/korean\n'
                '  12   1   501 Ss   %s     500 /bin/fine\n' % (lstart(NOW), lstart(NOW)))
        self.assertEqual(sorted(inventory.parse_ps(text)), [12])

    def test_the_snapshot_is_one_ps_call_in_the_c_locale_and_empty_output_is_an_error(self):
        self.machine.add(5, 1, '/bin/x')
        ctx = self.context()
        self.assertEqual(sorted(inventory.snapshot(ctx)), [5])
        self.assertEqual(self.machine.commands, [['/bin/ps', '-axww', '-o', inventory.PS_FIELDS]])
        ctx.run = lambda argv, timeout=None, environment=None: types.SimpleNamespace(returncode=1, stdout='')
        with self.assertRaises(RuntimeError):
            inventory.snapshot(ctx)

    def test_identity_is_pid_and_start_time_within_a_second(self):
        proc = inventory.Proc(7, 1, UID, 1000, 1, 'x')
        self.assertTrue(inventory.same_process(proc, UID, 7, 1000))
        self.assertTrue(inventory.same_process(proc, UID, 7, 1001))
        self.assertFalse(inventory.same_process(proc, UID, 7, 1002))
        self.assertFalse(inventory.same_process(proc, UID, 8, 1000))
        self.assertFalse(inventory.same_process(proc, UID+1, 7, 1000))
        self.assertFalse(inventory.same_process(None, UID, 7, 1000))


class ClassificationTests(EngineCase):
    def test_cua_runtime_roots(self):
        self.assertTrue(inventory.is_cua_repl(self.commands.cua_repl))
        self.assertFalse(inventory.is_cua_repl(self.commands.node_repl))
        self.assertFalse(inventory.is_cua_repl('grep /@oai/cua-repl/bin/cua-repl.mjs'))
        self.assertFalse(inventory.is_cua_repl('/usr/bin/python3 /x/@oai/cua-repl/bin/cua-repl.mjs'))
        self.assertFalse(inventory.is_cua_repl(self.commands.relay))

    def test_claude_bridges_of_this_and_older_plugins(self):
        root = Path('/work/plugins/cua')
        for command in (self.commands.bridge, self.commands.old_bridge,
                        '/usr/bin/python3 /Users/me/.claude/plugins/cache/chenjing-plugins/codex-computer-use/0.4.1/mcp_stdio.py',
                        '/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/Resources/'
                        'Python.app/Contents/MacOS/Python /Users/me/x y/plugins/cua/mcp_stdio.py',
                        '/venv/bin/python3 /work/plugins/cua/mcp_stdio.py'):
            self.assertTrue(inventory.is_bridge(command, root), command)
        for command in ('/usr/bin/python3 /Users/me/other/mcp_stdio.py',
                        'node /Users/me/.claude/plugins/cache/chenjing-plugins/cua/0.7.0/mcp_stdio.py',
                        '/usr/bin/python3 /Users/me/.local/share/codex-cua/command.py --control status',
                        '/bin/sh -c "python3 /x/cua/0.7.0/mcp_stdio.py"',
                        '/usr/bin/python3 /Users/me/.claude/plugins/cache/chenjing-plugins/cua/0.7.0/mcp_stdio.py.bak'):
            self.assertFalse(inventory.is_bridge(command, root), command)
        # A development checkout is recognised by this plugin's own folder, whatever it is called.
        self.assertTrue(inventory.is_bridge('/usr/bin/python3 /dev/checkout/mcp_stdio.py', Path('/dev/checkout')))
        self.assertFalse(inventory.is_bridge('/usr/bin/python3 /dev/checkout/mcp_stdio.pyc', Path('/dev/checkout')))

    def test_cmux_cua_is_told_apart_from_programs_that_only_mention_it(self):
        self.assertEqual(inventory.cmux_mode(self.commands.cmux_serve), 'serve')
        self.assertEqual(inventory.cmux_mode(self.commands.cmux_mcp), 'mcp')
        self.assertIsNone(inventory.cmux_mode(self.commands.claude))
        self.assertIsNone(inventory.cmux_mode(
            '/Users/me/.local/bin/claude --mcp-config={"mcpServers":{"cmux-cua":{"command":"/x/MacOS/cmux-cua","args":["mcp"]}}}'))
        self.assertIsNone(inventory.cmux_mode('/usr/bin/tail -f /var/log/cmux-cua.log'))

    def test_app_servers_and_chrome_main_processes(self):
        self.assertTrue(inventory.is_app_server(self.commands.app_server))
        self.assertTrue(inventory.is_app_server(str(self.native)+' app-server --listen stdio://'))
        self.assertFalse(inventory.is_app_server(self.commands.app_main))
        self.assertFalse(inventory.is_app_server('/usr/bin/vim app-server.md'))
        self.assertTrue(inventory.is_chrome_main(self.commands.chrome))
        self.assertTrue(inventory.is_chrome_main('/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'))
        for command in (self.commands.chrome+' --headless=new --disable-gpu',
                        self.commands.chrome+' --user-data-dir=/tmp/profile',
                        '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/'
                        'Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer'):
            self.assertFalse(inventory.is_chrome_main(command), command)


class HostRegistryTests(EngineCase):
    def setUp(self):
        super().setUp()
        self.machine.add(5, 1, '/bin/x')

    def host(self):
        procs = inventory.snapshot(self.context())
        return inventory.read_host(self.context(), procs)

    def alive(self, *pids):
        for pid in pids:
            self.machine.add(pid, 1, '/bin/host-part')

    def test_no_registry_is_missing(self):
        self.machine.add(5, 1, '/bin/x')
        self.assertEqual(self.host(), inventory.Host('missing', None, None, False, None))

    def test_ready_needs_the_registry_to_say_ready_and_all_three_processes_to_be_alive(self):
        self.alive(1000, 1100, 1200)
        self.write_host()
        host = self.host()
        self.assertEqual((host.state, host.since, host.relay, host.relay_reason), ('ready', NOW-300, False, None))
        self.assertEqual(host.registry['backend_pid'], 1100)
        self.machine.remove(1200)
        self.assertEqual(self.host().state, 'closed')

    def test_starting_depends_on_the_wrapper_being_alive(self):
        self.alive(1000)
        self.write_host(status='starting', backend=None, proxy=None)
        self.assertEqual(self.host().state, 'starting')
        self.machine.remove(1000)
        self.assertEqual(self.host().state, 'closed')

    def test_closed_and_unconfirmed_registries_are_closed_even_when_pids_are_alive(self):
        self.alive(1000, 1100, 1200)
        for status in ('closed', 'cleanup_unconfirmed'):
            self.write_host(status=status)
            self.assertEqual(self.host().state, 'closed')

    def test_unreadable_or_foreign_registries_are_unknown(self):
        self.alive(1000, 1100, 1200)
        path = self.host_dir/'host.json'
        self.write_host()
        path.chmod(0o644)
        self.assertEqual(self.host().state, 'unknown')
        path.chmod(0o600)
        path.write_text('{not json')
        self.assertEqual(self.host().state, 'unknown')
        for changes in ({'mechanism': 'standalone'}, {'schema_version': 2}, {'status': 'weird'},
                        {'owner_pid': True}, {'backend_pid': 'x'}, {'socket_path': 'relative.sock'}):
            self.write_host(**changes)
            self.assertEqual(self.host().state, 'unknown', changes)
        self.write_host()
        self.host_dir.chmod(0o755)
        self.assertEqual(self.host().state, 'unknown')
        self.host_dir.chmod(0o700)

    def test_a_state_directory_given_as_a_relative_path_is_not_read(self):
        self.alive(1000, 1100, 1200)
        self.write_host()
        ctx = self.context(environment={'CODEX_HOST_CUA_STATE_DIR': 'relative/host'})
        self.assertEqual(inventory.read_host(ctx, inventory.snapshot(ctx)).state, 'unknown')

    def test_processes_of_another_user_do_not_count(self):
        self.alive(1000, 1100)
        self.machine.add(1200, 1, '/bin/host-part', uid=UID+1)
        self.write_host()
        self.assertEqual(self.host().state, 'closed')

    def test_relay_flag_and_reason_code_are_read_and_a_code_only_counts_when_the_relay_is_off(self):
        self.alive(1000, 1100, 1200)
        self.write_host(relay=True, relay_reason='unknown_field')
        host = self.host()
        self.assertEqual((host.relay, host.relay_reason), (True, None))
        self.write_host(relay=False, relay_reason='unknown_field')
        host = self.host()
        self.assertEqual((host.relay, host.relay_reason), (False, 'unknown_field'))
        self.write_host(relay=False, relay_reason='/Users/me/secret path')
        self.assertIsNone(self.host().relay_reason)
        self.write_host(relay='yes')
        self.assertFalse(self.host().relay)


class AppTests(EngineCase):
    def test_installation_version_and_main_processes(self):
        self.machine.add(1000, 1, self.commands.app_main)
        self.machine.add(1001, 1000, str(self.app/'Contents/Frameworks/Helper.app/Contents/MacOS/Helper')+' --type=gpu')
        self.machine.add(1002, 1, self.commands.app_main, uid=UID+1)
        self.machine.add(1003, 1, self.commands.app_main+' -psn_0_1234')
        self.machine.add(1004, 1, self.commands.app_main+'-other')
        ctx = self.context()
        inv = inventory.collect(ctx)
        self.assertEqual(inv.installation.app_path, self.app)
        self.assertEqual(inv.app_version, APP_VERSION)
        self.assertEqual(inv.app_pids, [1000, 1003])

    def test_no_app_means_no_installation_and_no_pids(self):
        self.machine.add(1000, 1, '/bin/x')
        ctx = self.context(application_roots=[self.home/'Nowhere'])
        inv = inventory.collect(ctx)
        self.assertIsNone(inv.installation)
        self.assertIsNone(inv.app_version)
        self.assertEqual(inv.app_pids, [])

    def test_only_the_given_application_folders_are_looked_at(self):
        import runtime_paths
        seen, real = [], runtime_paths._app_installation

        def spy(app):
            seen.append(str(app))
            return real(app)
        with patch.object(runtime_paths, '_app_installation', spy):
            self.assertIsNotNone(inventory.find_installation(self.context()))
        self.assertTrue(seen)
        self.assertTrue(all(item.startswith(str(self.home)) for item in seen), seen)


class SetupChecksTests(EngineCase):
    """The real setup checks, on a temporary HOME; the two functions that start programs are replaced."""

    def setUp(self):
        super().setUp()
        self.support = setup.support_root(self.home)
        self.support.mkdir(parents=True, mode=0o700)
        self.launchd = {}
        self.venv = True
        for patcher in (patch.object(setup, 'venv_ready', side_effect=lambda root: self.venv),
                        patch.object(setup, 'launchd_value', side_effect=lambda key: self.launchd.get(key, ''))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def checks(self):
        return inventory.setup_checks(self.context())

    def install_files(self, launcher=True, command=True, python=True):
        if command:
            (self.support/'command.py').write_text('x')
            target = self.home/'.local/bin/codex-cua'
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('#!/bin/sh\n'+setup.MARKER+'\nexec x\n')
        if python:
            (self.support/'venv/bin').mkdir(parents=True, exist_ok=True)
            (self.support/'venv/bin/python3').write_text('x')
        if launcher:
            path = self.support/'start-desktop-cli.sh'
            path.write_text('#!/bin/sh\n'+setup.MARKER+'\nexec x\n')
            path.chmod(0o700)

    def test_nothing_installed(self):
        self.venv = False
        self.assertEqual(self.checks(), {'command': 'missing', 'dependencies': 'missing', 'login_environment': 'missing',
                                         'wrapper': 'missing', 'relay_files': 'missing'})

    def test_everything_installed(self):
        self.install_files()
        for name, marker in inventory.RELAY_FILES:
            self.relay_file(name, marker)
        agent = setup.login_agent_path(self.home)
        agent.parent.mkdir(parents=True)
        agent.write_bytes(plistlib.dumps({'Label': setup.LOGIN_LABEL}))
        self.launchd.update(setup.login_values(self.home, self.context().environment))
        self.assertEqual(self.checks(), {'command': 'ready', 'dependencies': 'ready', 'login_environment': 'ready',
                                         'wrapper': 'ready', 'relay_files': 'ready'})

    def relay_file(self, name, marker, mode=None):
        directory = self.support/'relay'
        directory.mkdir(exist_ok=True, mode=0o700)
        path = directory/name
        path.write_bytes(b'content\n'+marker+b'\n')
        path.chmod(mode if mode is not None else (0o700 if name == 'node-repl-relay' else 0o600))
        return path

    def test_command_needs_the_authored_marker_and_the_copy_of_command_py(self):
        self.install_files()
        self.assertEqual(self.checks()['command'], 'ready')
        (self.support/'command.py').unlink()
        self.assertEqual(self.checks()['command'], 'missing')
        (self.support/'command.py').write_text('x')
        (self.home/'.local/bin/codex-cua').write_text('#!/bin/sh\nexec something-else\n')
        self.assertEqual(self.checks()['command'], 'missing')

    def test_login_environment_states(self):
        agent = setup.login_agent_path(self.home)
        self.assertEqual(self.checks()['login_environment'], 'missing')
        self.launchd['CODEX_CLI_PATH'] = '/somebody/else'
        self.assertEqual(self.checks()['login_environment'], 'conflict')
        self.launchd.clear()
        agent.parent.mkdir(parents=True)
        agent.write_bytes(plistlib.dumps({'Label': setup.LOGIN_LABEL}))
        self.assertEqual(self.checks()['login_environment'], 'stale')
        self.launchd.update(setup.login_values(self.home, self.context().environment))
        self.assertEqual(self.checks()['login_environment'], 'ready')
        agent.write_bytes(plistlib.dumps({'Label': 'unrelated'}))
        self.assertEqual(self.checks()['login_environment'], 'conflict')
        agent.write_text('not a plist')
        self.assertEqual(self.checks()['login_environment'], 'unknown')
        with patch.object(setup, 'launchd_value', side_effect=OSError):
            agent.unlink()
            self.assertEqual(self.checks()['login_environment'], 'unknown')

    def test_wrapper_states(self):
        self.assertEqual(self.checks()['wrapper'], 'missing')
        self.install_files()
        self.assertEqual(self.checks()['wrapper'], 'ready')
        launcher = self.support/'start-desktop-cli.sh'
        launcher.chmod(0o600)
        self.assertEqual(self.checks()['wrapper'], 'broken')
        launcher.chmod(0o722)
        self.assertEqual(self.checks()['wrapper'], 'broken')
        launcher.chmod(0o700)
        launcher.write_text('#!/bin/sh\nexec x\n')
        self.assertEqual(self.checks()['wrapper'], 'broken')
        launcher.write_text('#!/bin/sh\n'+setup.MARKER+'\nexec x\n')
        (self.support/'venv/bin/python3').unlink()
        self.assertEqual(self.checks()['wrapper'], 'broken')
        (self.support/'venv/bin/python3').write_text('x')
        (self.support/'command.py').unlink()
        self.assertEqual(self.checks()['wrapper'], 'broken')

    def test_wrapper_is_broken_when_the_plugin_scripts_it_starts_are_damaged(self):
        self.install_files()
        plugin = self.root/'plugin'
        plugin.mkdir()
        (plugin/'desktop_cli_wrapper.py').write_text('x = 1\n')
        (plugin/'unix_ws_stdio.py').write_text('x = 1\n')
        ctx = self.context(plugin_root=plugin)
        self.assertEqual(inventory.wrapper_state(ctx, self.support), 'ready')
        (plugin/'unix_ws_stdio.py').write_text('def broken(:\n')
        self.assertEqual(inventory.wrapper_state(ctx, self.support), 'broken')
        (plugin/'unix_ws_stdio.py').unlink()
        self.assertEqual(inventory.wrapper_state(ctx, self.support), 'broken')

    def test_relay_files_states(self):
        self.assertEqual(inventory.relay_files_state(self.support, UID), 'missing')
        self.relay_file('relay.mjs', b'// codex-cua relay end')
        self.assertEqual(inventory.relay_files_state(self.support, UID), 'missing')
        launcher = self.relay_file('node-repl-relay', b'# codex-cua relay end')
        self.assertEqual(inventory.relay_files_state(self.support, UID), 'ready')
        launcher.chmod(0o600)
        self.assertEqual(inventory.relay_files_state(self.support, UID), 'invalid')       # not executable
        launcher.chmod(0o770)
        self.assertEqual(inventory.relay_files_state(self.support, UID), 'invalid')       # others can write it
        launcher.chmod(0o700)
        launcher.write_bytes(b'#!/bin/sh\nhalf written')
        self.assertEqual(inventory.relay_files_state(self.support, UID), 'invalid')       # no end marker
        self.relay_file('node-repl-relay', b'# codex-cua relay end')
        (self.support/'relay').chmod(0o755)
        self.assertEqual(inventory.relay_files_state(self.support, UID), 'invalid')       # directory not private
        (self.support/'relay').chmod(0o700)
        (self.support/'relay/relay.mjs').unlink()
        (self.support/'relay/relay.mjs').symlink_to(self.support/'relay/node-repl-relay')
        self.assertEqual(inventory.relay_files_state(self.support, UID), 'invalid')       # a link is not a file

    def test_the_relay_state_comes_from_setup_once_setup_knows_it(self):
        with patch.object(setup, 'relay_status', create=True, return_value='ready') as called:
            self.assertEqual(self.checks()['relay_files'], 'ready')
        called.assert_called_once_with(self.home)
        with patch.object(setup, 'relay_status', create=True, side_effect=OSError):
            self.assertEqual(self.checks()['relay_files'], 'invalid')

    def test_a_failing_check_only_marks_its_own_entry(self):
        with patch.object(setup, 'venv_ready', side_effect=OSError):
            self.assertEqual(self.checks()['dependencies'], 'missing')


class WorkingFolderTests(EngineCase):
    def test_one_lsof_call_for_the_pids_asked_about(self):
        self.machine.cwds.update({11: '/work/a', 12: '/work/b b'})
        ctx = self.context()
        self.assertEqual(inventory.working_folders(ctx, [12, 11, 13, 11]), {11: '/work/a', 12: '/work/b b'})
        self.assertEqual(self.machine.commands, [['/usr/sbin/lsof', '-a', '-d', 'cwd', '-Fpn', '-p', '11,12,13']])

    def test_no_pids_no_call_and_a_failing_lsof_gives_nothing(self):
        ctx = self.context()
        self.assertEqual(inventory.working_folders(ctx, []), {})
        self.assertEqual(self.machine.commands, [])
        ctx.run = lambda *args, **kwargs: (_ for _ in ()).throw(OSError)
        self.assertEqual(inventory.working_folders(ctx, [1]), {})
        self.machine.cwds[1] = 'relative'
        ctx.run = self.machine.run
        self.assertEqual(inventory.working_folders(ctx, [1]), {})


class InventoryTests(EngineCase):
    def test_subtree_memory_and_protected_processes(self):
        c = self.commands
        self.machine.add(1000, 1, c.app_main)
        self.machine.add(1100, 1000, c.app_server)
        self.machine.add(2000, 1100, c.cua_repl, rss_kb=100)
        self.machine.add(2001, 2000, c.node_repl, rss_kb=200)
        self.machine.add(2002, 2001, '/bin/kernel', rss_kb=300)
        self.machine.add(2100, 1100, c.node_repl, rss_kb=900)          # the user's own node_repl, not a CUA runtime
        self.machine.add(3000, 1, c.cmux_serve)
        self.machine.add(3001, 4000, c.cmux_mcp)
        self.machine.add(4000, 1, c.claude)
        self.machine.add(5000, 1, c.chrome, start=NOW-100)
        self.machine.add(5001, 1, c.chrome+' --headless=new', start=NOW-50)
        self.machine.add(ENGINE_PID, 6000, '/usr/bin/python3 setup.py status')
        self.machine.add(6000, 1, '/bin/zsh')
        inv = inventory.collect(self.context())
        self.assertEqual(inv.cua_repl, [2000])
        self.assertEqual(sorted(inv.subtree(2000)), [2000, 2001, 2002])
        self.assertEqual(inv.rss_bytes(inv.subtree(2000)), 600*1024)
        self.assertEqual(inv.app_servers, [1100])
        self.assertEqual((inv.cmux_daemons, inv.cmux_clients), ([3000], [4000]))
        self.assertEqual(inv.chrome_started, NOW-100)
        protected = inv.protected_pids(owners=[7000])
        self.assertTrue({1000, 1100, 3000, 3001, 4000, 5000, 7000, ENGINE_PID, 6000} <= protected)
        self.assertFalse({2000, 2001, 2002} & protected)

    def test_other_users_processes_are_not_considered(self):
        self.machine.add(2000, 1, self.commands.cua_repl, uid=UID+1)
        self.machine.add(2001, 1, self.commands.bridge, uid=UID+1)
        self.machine.add(2002, 1, self.commands.cmux_serve, uid=UID+1)
        inv = inventory.collect(self.context())
        self.assertEqual((inv.cua_repl, inv.bridges, inv.cmux_daemons), ([], [], []))


if __name__ == '__main__':
    unittest.main()
