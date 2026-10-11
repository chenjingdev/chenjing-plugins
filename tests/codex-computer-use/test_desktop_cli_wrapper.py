"""Launcher tests use an isolated fake CLI, never Codex, CUA, or a GUI."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
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

PLUGIN_ROOT = Path(__file__).resolve().parents[2] / 'plugins/codex-computer-use'
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
    mode=os.environ.get('FIXTURE_MODE','normal')
    if mode=='hang':time.sleep(60)
    if mode=='stubborn':signal.signal(signal.SIGTERM,signal.SIG_IGN)
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
        self.environment.update({"CODEX_HOST_CUA_NATIVE_CLI":str(self.native),
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

    def test_existing_primary_lease_is_not_replaced(self):
        desktop=self.start();metadata=self.ready()
        duplicate=self.start();stdout,stderr=duplicate.communicate(timeout=3)
        self.assertEqual(duplicate.returncode,1)
        self.assertEqual(stdout,b'')
        self.assertNotIn(b'fixture-environment-value',stderr)
        self.assertEqual(json.loads((self.state/'host.json').read_text())['backend_pid'],metadata['backend_pid'])
        desktop.stdin.close();desktop.wait(timeout=3)

    def test_startup_timeout_reaps_only_owned_fake_backend(self):
        environment=dict(self.environment);environment.update(FIXTURE_MODE='hang',CODEX_HOST_CUA_STARTUP_TIMEOUT='0.15')
        child=self.start(environment=environment);started=time.monotonic();stdout,stderr=child.communicate(timeout=3)
        self.assertLess(time.monotonic()-started,1.0)
        self.assertEqual(child.returncode,1)
        self.assertEqual(stdout,b'')
        self.assertNotIn(b'fixture-environment-value',stderr)
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

    def test_public_or_relative_state_paths_are_rejected_without_backend_spawn(self):
        self.state.mkdir(mode=0o755)
        child=self.start();stdout,stderr=child.communicate(timeout=3)
        self.assertEqual(child.returncode,1);self.assertFalse(self.events())
        environment=dict(self.environment);environment['CODEX_HOST_CUA_STATE_DIR']='relative-state'
        child=self.start(environment=environment);child.communicate(timeout=3)
        self.assertEqual(child.returncode,1);self.assertFalse(self.events())


if __name__=='__main__':unittest.main(verbosity=2)
