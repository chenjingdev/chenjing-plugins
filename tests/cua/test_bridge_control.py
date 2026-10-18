import asyncio,json,os,stat,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock,patch
from bridge_control import BridgeControl
class Tests(unittest.IsolatedAsyncioTestCase):
 async def test_scoped_control_is_private_and_rejects_wrong_process(self):
  with tempfile.TemporaryDirectory() as directory:
   a=SimpleNamespace(stopping=False,active_tool_calls=0,release_turn=AsyncMock(return_value={'released':True,'scopeCount':1}))
   c=BridgeControl(a,Path(directory)/'state');await c.start()
   try:
    record=json.loads((c.directory/'relay.json').read_text());self.assertEqual(record['rootPid'],os.getpid())
    self.assertEqual((c.directory/'control.sock').stat().st_mode&0o077,0)
    self.assertEqual((c.directory/'relay.json').stat().st_mode&0o077,0)
    r,w=await asyncio.open_unix_connection(str(c.directory/'control.sock'))
    w.write((json.dumps({'action':'release','rootPid':os.getpid()+1,'relayPid':os.getpid()})+'\n').encode());await w.drain()
    self.assertEqual(await r.readline(),b'');w.close();await w.wait_closed();a.release_turn.assert_not_called()
    r,w=await asyncio.open_unix_connection(str(c.directory/'control.sock'))
    w.write((json.dumps({'action':'release','rootPid':os.getpid(),'relayPid':os.getpid()})+'\n').encode());await w.drain()
    self.assertTrue(json.loads(await r.readline())['released']);self.assertTrue(a.stopping)
    a.release_turn.assert_awaited_once();w.close();await w.wait_closed()
   finally:await c.close()
 async def test_default_location_is_the_private_codex_cua_bridges_directory(self):
  # A short path: the control socket lives inside it and Unix socket paths are limited to 104 bytes.
  with tempfile.TemporaryDirectory(dir='/tmp',prefix='bc-') as directory:
   home=Path(directory).resolve()
   with patch.object(Path,'home',return_value=home):
    c=BridgeControl(SimpleNamespace(stopping=False,active_tool_calls=0))
    self.assertEqual(c.root,home/'Library/Caches/codex-cua/bridges')
    await c.start()
   try:
    self.assertTrue(c.directory.name.startswith('bridge-'));self.assertEqual(c.directory.parent,c.root)
    for private in (home/'Library/Caches/codex-cua',c.root,c.directory):
     self.assertEqual(stat.S_IMODE(private.stat().st_mode),0o700,str(private))
   finally:await c.close()
   self.assertEqual(list(c.root.iterdir()),[])
 async def test_a_public_control_directory_is_refused(self):
  with tempfile.TemporaryDirectory() as directory:
   state=Path(directory)/'state';state.mkdir(mode=0o755)
   c=BridgeControl(SimpleNamespace(stopping=False,active_tool_calls=0),state)
   with self.assertRaises(RuntimeError):await c.start()
   self.assertEqual(list(state.iterdir()),[])
if __name__=='__main__':unittest.main()
