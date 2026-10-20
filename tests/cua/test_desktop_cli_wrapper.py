"""Launcher tests use an isolated fake CLI, never Codex, CUA, or a GUI."""
import calendar
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

PLUGIN_ROOT = Path(__file__).resolve().parents[2] / 'plugins/cua'
spec = importlib.util.spec_from_file_location("host_wrapper", PLUGIN_ROOT / "desktop_cli_wrapper.py")
wrapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wrapper)
PRIMARY = ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled", "-c",
           "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true", "-c",
           "plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=true"]

FAKE = r'''#!/usr/bin/env python3
import hashlib,json,os,pathlib,signal,socket,sys,threading,time
args=sys.argv[1:]
log=pathlib.Path(os.environ['FIXTURE_EVENT_FILE'])
def record(role):
    with log.open('a') as output:
        output.write(json.dumps({'role':role,'pid':os.getpid(),'argv':args,'cwd':os.getcwd(),
            'fixture_hash':hashlib.sha256(os.environ.get('FIXTURE_ENV','').encode()).hexdigest()})+'\n')
if 'mcp' in args and 'get' in args:
    # The launcher reads the effective CUA definition before it starts the backend. That is no launch.
    sys.path.insert(0,os.environ.get('FIXTURE_TESTS_DIR',''))
    definition=os.environ.get('FIXTURE_MCP_DEFINITION');mode=os.environ.get('FIXTURE_MCP_MODE','ok')
    if not definition or mode=='exit':sys.exit(1)
    if mode=='hang':time.sleep(30)
    import fake_native_cli
    with (log.parent/'mcp-get.jsonl').open('a') as output:
        output.write(json.dumps({'argv':args,'fixture_hash':hashlib.sha256(os.environ.get('FIXTURE_ENV','').encode()).hexdigest()})+'\n')
    print(json.dumps(fake_native_cli.mcp_get(args[:args.index('mcp')],json.load(open(definition)),ignore_override=mode=='ignore_override')))
    sys.exit(0)
if 'app-server' in args and 'proxy' in args:
    record('proxy')
    connection=socket.socket(socket.AF_UNIX);connection.connect(args[args.index('--sock')+1])
    stream=connection.makefile('rb')
    for raw in sys.stdin.buffer:
        connection.sendall(raw)
        response=stream.readline()
        if not response:break
        sys.stdout.buffer.write(response);sys.stdout.buffer.flush()
    stream.close();connection.close()
elif '--listen' in args:
    record('backend')
    if os.environ.get('FIXTURE_REJECT_OVERRIDE') and any(item.startswith('mcp_servers.cua_repl=') for item in args):sys.exit(1)
    if os.environ.get('FIXTURE_REJECT_LISTEN'):sys.exit(1)
    mode=os.environ.get('FIXTURE_MODE','normal')
    if mode=='hang':time.sleep(60)
    if mode=='stubborn':signal.signal(signal.SIGTERM,signal.SIG_IGN)
    if mode=='witness':
        def told_to_stop(signum,frame):
            # What the host registry says at the moment the launcher tells this backend to stop.
            seen=json.loads(pathlib.Path(os.environ['FIXTURE_HOST_FILE']).read_text())
            with log.open('a') as output:
                output.write(json.dumps({'role':'told-to-stop','pid':os.getpid(),'host':seen})+'\n')
            os._exit(0)
        signal.signal(signal.SIGTERM,told_to_stop)
    endpoint=args[args.index('--listen')+1].removeprefix('unix://') if hasattr(str,'removeprefix') else args[args.index('--listen')+1][7:]
    server=socket.socket(socket.AF_UNIX)
    if mode=='symlink':
        parent=log.parent/'native-short';parent.mkdir(mode=0o700)
        target=parent/'actual.sock';server.bind(str(target));pathlib.Path(endpoint).symlink_to(target)
    else:
        server.bind(endpoint)
    server.listen()
    def client(connection):
        with connection:
            stream=connection.makefile('rb')
            for raw in stream:
                request=json.loads(raw)
                if 'id' not in request:continue
                result={'id':request['id'],'result':{'backend_pid':os.getpid(),'method':request.get('method')}}
                connection.sendall((json.dumps(result)+'\n').encode())
    while True:
        connection,_=server.accept();threading.Thread(target=client,args=(connection,),daemon=True).start()
else:
    record('passthrough')
    print(json.dumps({'argv':args,'fixture_hash':hashlib.sha256(os.environ.get('FIXTURE_ENV','').encode()).hexdigest()}))
'''

FAKE_STDIO = r'''import hashlib,json,os,pathlib,socket,sys
args=sys.argv[1:]
with pathlib.Path(os.environ['FIXTURE_EVENT_FILE']).open('a') as output:
    output.write(json.dumps({'role':'proxy','pid':os.getpid(),'argv':args,'cwd':os.getcwd(),
        'fixture_hash':hashlib.sha256(os.environ.get('FIXTURE_ENV','').encode()).hexdigest()})+'\n')
connection=socket.socket(socket.AF_UNIX);connection.connect(args[args.index('--socket')+1])
stream=connection.makefile('rb')
for raw in sys.stdin.buffer:
    connection.sendall(raw)
    response=stream.readline()
    if not response:break
    sys.stdout.buffer.write(response);sys.stdout.buffer.flush()
stream.close();connection.close()
'''


class MatchTests(unittest.TestCase):
    def test_only_current_primary_desktop_launch_matches(self):
        self.assertTrue(wrapper.is_primary_launch(PRIMARY))
        for arguments in (["--version"], ["exec", "app-server"], ["app-server"],
                          PRIMARY + ["--listen", "unix:///fixture.sock"], PRIMARY + ["--help"],
                          ["app-server", "proxy", "--sock", "/fixture.sock"],
                          ["app-server", "generate-json-schema", "--out", "/fixture"],
                          ["app-server", "--analytics-default-enabled", "-c", "default_permissions=fixture"]):
            with self.subTest(arguments=arguments):
                self.assertFalse(wrapper.is_primary_launch(arguments))


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/tmp", prefix="hcu-")
        self.root = Path(self.temporary.name).resolve()
        self.native = self.root / "native.py"
        self.native.write_text(FAKE)
        self.native.chmod(0o700)
        self.launcher = self.root / "desktop_cli_wrapper.py"
        self.launcher.write_text((PLUGIN_ROOT/'desktop_cli_wrapper.py').read_text())
        self.proxy = self.root / "unix_ws_stdio.py"
        self.proxy.write_text(FAKE_STDIO)
        self.log = self.root / "events.jsonl"
        self.state = self.root / "state"
        self.environment = dict(os.environ)
        self.environment.update({"HOME":str(self.root/"home"),"CODEX_HOST_CUA_NATIVE_CLI":str(self.native),
            "CODEX_HOST_CUA_STATE_DIR":str(self.state), "CODEX_HOST_CUA_STARTUP_TIMEOUT":"2",
            "CODEX_HOST_CUA_SHUTDOWN_TIMEOUT":"0.4", "FIXTURE_EVENT_FILE":str(self.log),
            "FIXTURE_ENV":"fixture-environment-value"})
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
                try:child.wait(timeout=3)
                except subprocess.TimeoutExpired:child.kill();child.wait()
            for stream in (child.stdin,child.stdout,child.stderr):
                if stream is not None and not stream.closed:stream.close()
        # This cleanup targets only fake child PIDs recorded in our test folder.
        for event in self.events():
            try:os.kill(event['pid'],signal.SIGKILL)
            except ProcessLookupError:pass
        self.temporary.cleanup()

    def events(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def start(self, arguments=PRIMARY, environment=None):
        child = subprocess.Popen([sys.executable,str(self.launcher),*arguments],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            env=self.environment if environment is None else environment,cwd=str(self.root))
        self.children.append(child)
        return child

    def ready(self):
        deadline=time.monotonic()+3
        while time.monotonic()<deadline:
            try:
                result=json.loads((self.state/'host.json').read_text())
                if result.get('status')=='ready':return result
            except (OSError,ValueError):pass
            time.sleep(0.01)
        self.fail('Fake launcher did not become ready')

    def assert_reaped(self, pid):
        with self.assertRaises(ProcessLookupError):os.kill(pid,0)

    def test_exact_backend_argv_environment_cwd_and_desktop_stdio_preserved(self):
        child=self.start();metadata=self.ready()
        request={'id':'desktop-fixture','method':'initialize','params':{'clientInfo':{'name':'fixture'}}}
        child.stdin.write((json.dumps(request)+'\n').encode());child.stdin.flush()
        result=json.loads(child.stdout.readline())
        self.assertEqual(result['id'],'desktop-fixture')
        self.assertEqual(result['result']['backend_pid'],metadata['backend_pid'])
        child.stdin.close();child.wait(timeout=3)
        self.assertEqual(child.returncode,0,child.stderr.read().decode())
        events=self.events();backend=next(event for event in events if event['role']=='backend')
        proxy=next(event for event in events if event['role']=='proxy')
        self.assertEqual(backend['argv'],PRIMARY+['--listen','unix://'+metadata['socket_path']])
        self.assertEqual(proxy['argv'],['--socket',metadata['socket_path']])
        for event in (backend,proxy):
            self.assertEqual(event['cwd'],str(self.root))
            self.assertEqual(event['fixture_hash'],hashlib.sha256(self.environment['FIXTURE_ENV'].encode()).hexdigest())
            self.assert_reaped(event['pid'])
        final=json.loads((self.state/'host.json').read_text())
        self.assertEqual(final['status'],'closed')
        self.assertTrue(final['backend_reaped'])
        self.assertTrue(final['desktop_proxy_reaped'])
        self.assertEqual(final['operational_readiness'],'not_checked')

    def test_another_stdio_transport_reaches_same_owned_backend_with_independent_initialize(self):
        desktop=self.start();metadata=self.ready()
        other=subprocess.Popen([sys.executable,str(self.proxy),'--socket',metadata['socket_path']],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=self.environment,cwd=str(self.root))
        self.children.append(other)
        for client,ident in ((desktop,'desktop'),(other,'other')):
            client.stdin.write((json.dumps({'id':ident,'method':'initialize'})+'\n').encode());client.stdin.flush()
            result=json.loads(client.stdout.readline())
            self.assertEqual(result['id'],ident)
            self.assertEqual(result['result']['backend_pid'],metadata['backend_pid'])
        other.stdin.close();other.wait(timeout=3)
        self.assertIsNone(desktop.poll())
        desktop.stdin.close();desktop.wait(timeout=3)
        self.assert_reaped(metadata['backend_pid'])

    def test_private_endpoint_and_lease_permissions(self):
        child=self.start();metadata=self.ready();endpoint=Path(metadata['socket_path'])
        for path,mode in ((self.state,0o700),(endpoint.parent,0o700),(endpoint,0o600),(self.state/'host.json',0o600)):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode),mode)
            self.assertEqual(path.stat().st_uid,os.getuid())
        child.stdin.close();child.wait(timeout=3)
        self.assertFalse(endpoint.exists())

    def test_native_owned_socket_alias_is_accepted_and_lease_path_retained(self):
        environment=dict(self.environment);environment['FIXTURE_MODE']='symlink'
        child=self.start(environment=environment);metadata=self.ready();endpoint=Path(metadata['socket_path'])
        self.assertTrue(endpoint.is_symlink())
        self.assertEqual(metadata['socket_path'],str(endpoint))
        self.assertEqual(endpoint.resolve(strict=True).parent,self.root/'native-short')
        self.assertEqual(stat.S_IMODE(endpoint.resolve(strict=True).stat().st_mode),0o600)
        child.stdin.write(b'{"id":"alias-fixture","method":"initialize"}\n');child.stdin.flush()
        self.assertEqual(json.loads(child.stdout.readline())['id'],'alias-fixture')
        child.stdin.close();child.wait(timeout=3)
        self.assertEqual(child.returncode,0)
        self.assert_reaped(metadata['backend_pid'])

    def test_socket_alias_rejects_public_target_parent_without_chmod(self):
        leased=self.root/'leased';leased.mkdir(mode=0o700)
        public=self.root/'public';public.mkdir(mode=0o755)
        target=public/'actual.sock';connection=socket.socket(socket.AF_UNIX)
        try:
            connection.bind(str(target));target.chmod(0o666)
            alias=leased/'rpc.sock';alias.symlink_to(target)
            with self.assertRaises(RuntimeError):wrapper._secure_owned_socket(alias)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode),0o666)
        finally:connection.close()

    def test_socket_alias_rejects_foreign_target_owner_without_chmod(self):
        leased=self.root/'leased';leased.mkdir(mode=0o700)
        private=self.root/'private';private.mkdir(mode=0o700)
        target=private/'actual.sock';connection=socket.socket(socket.AF_UNIX)
        try:
            connection.bind(str(target));target.chmod(0o666)
            alias=leased/'rpc.sock';alias.symlink_to(target)
            original_lstat=Path.lstat
            def foreign_owner(path):
                info=original_lstat(path)
                return types.SimpleNamespace(st_mode=info.st_mode,st_uid=os.getuid()+1) if path==target else info
            with patch.object(Path,'lstat',foreign_owner),self.assertRaises(RuntimeError):
                wrapper._secure_owned_socket(alias)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode),0o666)
        finally:connection.close()

    def test_socket_alias_rejects_public_leased_parent(self):
        leased=self.root/'leased';leased.mkdir(mode=0o755)
        private=self.root/'private';private.mkdir(mode=0o700)
        target=private/'actual.sock';connection=socket.socket(socket.AF_UNIX)
        try:
            connection.bind(str(target));alias=leased/'rpc.sock';alias.symlink_to(target)
            with self.assertRaises(RuntimeError):wrapper._secure_owned_socket(alias)
        finally:connection.close()

    def test_socket_alias_rejects_foreign_alias_owner_without_chmod(self):
        leased=self.root/'leased';leased.mkdir(mode=0o700)
        private=self.root/'private';private.mkdir(mode=0o700)
        target=private/'actual.sock';connection=socket.socket(socket.AF_UNIX)
        try:
            connection.bind(str(target));target.chmod(0o666)
            alias=leased/'rpc.sock';alias.symlink_to(target)
            original_lstat=Path.lstat
            def foreign_owner(path):
                info=original_lstat(path)
                return types.SimpleNamespace(st_mode=info.st_mode,st_uid=os.getuid()+1) if path==alias else info
            with patch.object(Path,'lstat',foreign_owner),self.assertRaises(RuntimeError):
                wrapper._secure_owned_socket(alias)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode),0o666)
        finally:connection.close()

    def test_auxiliary_and_nonlaunch_commands_do_not_replace_primary_lease(self):
        desktop=self.start();metadata=self.ready()
        for arguments in (['--version'],['app-server','generate-ts','--out','/fixture'],
                          ['app-server','--analytics-default-enabled','-c','default_permissions=fixture']):
            helper=self.start(arguments);stdout,stderr=helper.communicate(timeout=3)
            self.assertEqual(helper.returncode,0,stderr.decode())
            self.assertEqual(json.loads(stdout)['argv'],arguments)
            self.assertEqual(json.loads((self.state/'host.json').read_text())['backend_pid'],metadata['backend_pid'])
        desktop.stdin.close();desktop.wait(timeout=3)

    def test_unconfigured_override_is_exact_pass_through(self):
        environment=dict(self.environment);environment.pop('CODEX_HOST_CUA_STATE_DIR')
        child=self.start(environment=environment);stdout,stderr=child.communicate(timeout=3)
        self.assertEqual(child.returncode,0,stderr.decode())
        self.assertEqual(json.loads(stdout)['argv'],PRIMARY)
        self.assertFalse(self.state.exists())

    def test_existing_primary_lease_is_not_replaced_and_the_duplicate_runs_the_original_cli(self):
        desktop=self.start();metadata=self.ready()
        duplicate=self.start();stdout,stderr=duplicate.communicate(timeout=3)
        self.assertEqual(duplicate.returncode,0,stderr.decode())
        reported=json.loads(stdout)
        self.assertEqual(reported['argv'],PRIMARY)
        self.assertEqual(reported['fixture_hash'],hashlib.sha256(self.environment['FIXTURE_ENV'].encode()).hexdigest())
        self.assertEqual(stderr,b'')
        self.assertEqual(json.loads((self.state/'host.json').read_text())['backend_pid'],metadata['backend_pid'])
        self.assertEqual([event['role'] for event in self.events()].count('backend'),1)
        desktop.stdin.close();desktop.wait(timeout=3)

    def test_startup_timeout_reaps_only_owned_fake_backend(self):
        environment=dict(self.environment);environment.update(FIXTURE_MODE='hang',CODEX_HOST_CUA_STARTUP_TIMEOUT='0.15')
        child=self.start(environment=environment);started=time.monotonic();stdout,stderr=child.communicate(timeout=3)
        self.assertLess(time.monotonic()-started,1.0)
        self.assertEqual(child.returncode,1)
        self.assertEqual(stdout,b'')
        self.assertNotIn(b'fixture-environment-value',stderr)
        # The backend had started, so this stays a failure; the original CLI is not run a second time.
        self.assertNotIn('passthrough',[event['role'] for event in self.events()])
        final=json.loads((self.state/'host.json').read_text())
        self.assertIsInstance(final['backend_pid'],int)
        self.assert_reaped(final['backend_pid'])
        self.assertTrue(final['backend_reaped'])

    def test_sigterm_and_stubborn_backend_cleanup_are_bounded(self):
        environment=dict(self.environment);environment['FIXTURE_MODE']='stubborn'
        child=self.start(environment=environment);metadata=self.ready();started=time.monotonic()
        child.send_signal(signal.SIGTERM);child.wait(timeout=3)
        self.assertLess(time.monotonic()-started,1.0)
        self.assertEqual(child.returncode,143)
        self.assert_reaped(metadata['backend_pid']);self.assert_reaped(metadata['desktop_proxy_pid'])

    def test_the_launcher_says_it_is_stopping_and_since_when_before_it_stops_the_backend(self):
        environment=dict(self.environment,FIXTURE_MODE='witness',FIXTURE_HOST_FILE=str(self.state/'host.json'))
        child=self.start(environment=environment);ready=self.ready();asked=time.time()
        child.stdin.close();child.wait(timeout=3)
        self.assertEqual(child.returncode,0,child.stderr.read().decode())
        [told]=[event for event in self.events() if event['role']=='told-to-stop']
        seen=told['host']
        self.assertEqual(seen['status'],'stopping')
        named=calendar.timegm(time.strptime(seen['stopping_at'],'%Y-%m-%dT%H:%M:%SZ'))
        self.assertTrue(asked-1<=named<=time.time()+1,(asked,named))
        for key in ('owner_pid','backend_pid','desktop_proxy_pid','socket_path','relay','relay_config'):
            self.assertEqual(seen[key],ready[key],key)
        self.assertEqual(json.loads((self.state/'host.json').read_text())['status'],'closed')

    def test_a_stopping_record_that_cannot_be_written_does_not_keep_the_backend_alive(self):
        real=wrapper._write_metadata;calls=[]
        def stopping_and_second_write_fail(path,data):
            calls.append(dict(data))
            if len(calls)==2 or data['status']=='stopping':raise OSError('PRIVATE_DISK_ERROR')
            return real(path,data)
        with patch.object(wrapper,'_write_metadata',side_effect=stopping_and_second_write_fail), \
             patch.object(wrapper.os,'execve',side_effect=AssertionError('The backend had started')):
            with self.assertRaises(OSError):
                wrapper.main(list(PRIMARY),dict(self.environment))
        self.assertEqual([call['status'] for call in calls],['starting','starting','stopping','closed'])
        self.assert_reaped(calls[1]['backend_pid'])
        self.assertEqual(json.loads((self.state/'host.json').read_text())['status'],'closed')

    def test_public_or_relative_state_paths_run_the_original_cli_without_backend_spawn(self):
        self.state.mkdir(mode=0o755)
        child=self.start();stdout,stderr=child.communicate(timeout=3)
        self.assertEqual(child.returncode,0,stderr.decode());self.assertEqual(stderr,b'')
        self.assertEqual(json.loads(stdout)['argv'],PRIMARY)
        self.assertEqual([event['role'] for event in self.events()],['passthrough'])
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode),0o755)
        self.assertFalse((self.state/'host.json').exists())
        environment=dict(self.environment);environment['CODEX_HOST_CUA_STATE_DIR']='relative-state'
        child=self.start(environment=environment);stdout,stderr=child.communicate(timeout=3)
        self.assertEqual(child.returncode,0,stderr.decode());self.assertEqual(json.loads(stdout)['argv'],PRIMARY)
        self.assertEqual([event['role'] for event in self.events()],['passthrough']*2)

    def run_main(self, environment, arguments=PRIMARY):
        """Run main() in this process with exec replaced, and return what would have been exec'd."""
        with patch.object(wrapper.os,'execve',side_effect=SystemExit(0)) as execute:
            with self.assertRaises(SystemExit):
                wrapper.main(list(arguments),environment)
        return execute

    def test_failures_before_the_backend_exec_the_original_cli_with_unchanged_argv_and_environment(self):
        holders=[]
        def public_state(environment):
            self.state.mkdir(mode=0o755)
        def relative_state(environment):
            environment['CODEX_HOST_CUA_STATE_DIR']='relative-state'
        def invalid_timeout(environment):
            environment['CODEX_HOST_CUA_STARTUP_TIMEOUT']='soon'
        def lease_held_elsewhere(environment):
            self.state.mkdir(mode=0o700)
            holder=open(self.state/'owner.lock','a+');holders.append(holder)
            fcntl.flock(holder,fcntl.LOCK_EX)
        def lease_is_symlink(environment):
            self.state.mkdir(mode=0o700)
            (self.root/'elsewhere').write_text('')
            (self.state/'owner.lock').symlink_to(self.root/'elsewhere')
        def lease_is_dangling_symlink(environment):
            self.state.mkdir(mode=0o700)
            (self.state/'owner.lock').symlink_to(self.root/'nowhere')
        def state_parent_is_a_file(environment):
            (self.root/'blocker').write_text('x')
            environment['CODEX_HOST_CUA_STATE_DIR']=str(self.root/'blocker/state')
        cases={'public state directory':public_state,'relative state directory':relative_state,
               'invalid timeout':invalid_timeout,'lease held by another launcher':lease_held_elsewhere,
               'lease file is a symlink':lease_is_symlink,'lease file is a dangling symlink':lease_is_dangling_symlink,
               'state directory cannot be created':state_parent_is_a_file}
        for name,prepare in cases.items():
            with self.subTest(name):
                shutil.rmtree(self.state,ignore_errors=True)
                for leftover in ('blocker','nowhere','elsewhere'):(self.root/leftover).unlink(missing_ok=True)
                environment=dict(self.environment);prepare(environment)
                before=dict(environment)
                execute=self.run_main(environment)
                self.assertEqual(execute.call_count,1)
                self.assertEqual(execute.call_args.args,(str(self.native),[str(self.native),*PRIMARY],before))
                self.assertEqual(environment,before)
                self.assertFalse((self.root/'nowhere').exists(),'The lease must not be created through a symlink')
                for holder in holders:holder.close()
                holders.clear()

    def test_backend_that_cannot_be_spawned_is_not_started_so_the_original_cli_runs(self):
        environment=dict(self.environment)
        with patch.object(wrapper.subprocess,'Popen',side_effect=OSError('PRIVATE_SPAWN_ERROR')) as spawn:
            execute=self.run_main(environment)
        self.assertEqual(spawn.call_count,1)
        self.assertEqual(execute.call_args.args,(str(self.native),[str(self.native),*PRIMARY],environment))
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode),0o700)
        self.assertEqual(list(self.state.glob('run-*')),[])

    def test_metadata_that_cannot_be_written_before_the_backend_starts_runs_the_original_cli(self):
        environment=dict(self.environment)
        with patch.object(wrapper.subprocess,'Popen',side_effect=AssertionError('No backend may start')), \
             patch.object(wrapper,'_write_metadata',side_effect=OSError('PRIVATE_DISK_ERROR')) as write:
            execute=self.run_main(environment)
        self.assertEqual(write.call_count,1)
        self.assertEqual(write.call_args.args[1]['backend_pid'],None)
        self.assertEqual(execute.call_args.args,(str(self.native),[str(self.native),*PRIMARY],environment))
        self.assertEqual(list(self.state.glob('run-*')),[])

    def test_metadata_failure_after_the_backend_started_keeps_failing_and_reaps_it(self):
        real=wrapper._write_metadata;calls=[]
        def second_write_fails(path,data):
            calls.append(dict(data))
            if len(calls)==2:raise OSError('PRIVATE_DISK_ERROR')
            return real(path,data)
        with patch.object(wrapper,'_write_metadata',side_effect=second_write_fails), \
             patch.object(wrapper.os,'execve',side_effect=AssertionError('The backend had started')):
            with self.assertRaises(OSError):
                wrapper.main(list(PRIMARY),dict(self.environment))
        self.assertIsNone(calls[0]['backend_pid']);self.assertIsInstance(calls[1]['backend_pid'],int)
        self.assert_reaped(calls[1]['backend_pid'])

    def test_unverifiable_cli_uses_the_one_recorded_by_the_launcher_script(self):
        environment=dict(self.environment,CODEX_HOST_CUA_NATIVE_CLI=str(self.root/'missing'),
                         CODEX_CUA_FALLBACK_NATIVE=str(self.native))
        execute=self.run_main(environment)
        self.assertEqual(execute.call_args.args,(str(self.native),[str(self.native),*PRIMARY],environment))
        self.assertFalse(self.state.exists())
        for recorded in ('',str(self.root/'missing'),'relative/codex',str(self.launcher)):
            environment['CODEX_CUA_FALLBACK_NATIVE']=recorded
            with patch.object(wrapper.os,'execve',side_effect=AssertionError('Nothing may be exec\'d')), \
                 self.assertRaises(RuntimeError):
                wrapper.main(list(PRIMARY),environment)


if __name__=='__main__':unittest.main(verbosity=2)
