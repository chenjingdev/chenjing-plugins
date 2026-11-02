"""Send one bridge-authored request token to its verified relay's private cancellation endpoint.

The app-server has no per-MCP-call cancellation RPC. The relay can send the original MCP cancellation notification
to its own runtime, using a token that exists only in the pending call. This module never starts, stops or resets
anything, and a positive answer means only that notification was sent, not that an action was undone.
"""
import asyncio
import json
import os
from pathlib import Path
import re
import stat

from bridge_records import state_dir

TOKEN_META = 'cuabar/request-token'
OWNER = re.compile(r'^bridge-[0-9]{1,10}-[0-9]{1,12}$')
TOKEN = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
MAX_RECORD = 65536
MAX_REPLY = 1024


def private_directory(path):
    info = path.lstat()
    return stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not stat.S_IMODE(info.st_mode) & 0o077


def candidates(state, owner, host_pid):
    """Owned relay records of this bridge on this exact host, whose endpoint cannot name another directory."""
    if not state.is_absolute() or not private_directory(state) or not private_directory(state/'relays'):
        return []
    found = []
    for folder in sorted((state/'relays').glob('relay-*'))[:256]:
        descriptor = None
        try:
            if not private_directory(folder):
                continue
            descriptor = os.open(folder/'relay.json', os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
                                 | getattr(os, 'O_NONBLOCK', 0))
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077
                    or info.st_size > MAX_RECORD):
                continue
            record = json.loads(os.read(descriptor, MAX_RECORD+1).decode('utf-8'))
            if (not isinstance(record, dict) or record.get('schema_version') != 1 or record.get('kind') != 'relay'
                    or record.get('owner') != owner or record.get('cancel_by_request_token') is not True
                    or type(record.get('app_server_pid')) is not int or record['app_server_pid'] != host_pid
                    or type(record.get('pid')) is not int or record['pid'] <= 1
                    or type(record.get('started_at')) is not int or record['started_at'] <= 0):
                continue
            socket = folder/'control.sock'
            if record.get('control_path') != str(socket):
                continue
            info = socket.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
                continue
            found.append((socket, record['pid'], record['started_at']))
        except (OSError, ValueError, UnicodeError):
            continue
        finally:
            if descriptor is not None:
                os.close(descriptor)
    return found


async def cancel_request(owner, host_pid, request_token, state=None, timeout=1.0):
    """Return a fixed-state result, without disclosing a record, endpoint or token in an error."""
    unavailable = {'cancelled': False, 'reason': 'relay_unavailable'}
    if (not isinstance(owner, str) or not OWNER.fullmatch(owner)
            or type(host_pid) is not int or host_pid <= 1
            or not isinstance(request_token, str) or not TOKEN.fullmatch(request_token)):
        return unavailable
    state = state_dir() if state is None else Path(state)
    try:
        relays = candidates(state, owner, host_pid)
    except (OSError, ValueError):
        return unavailable
    deadline = asyncio.get_running_loop().time()+timeout
    while relays:
        retry = False
        for socket, pid, started_at in relays:
            writer = None
            try:
                remaining = deadline-asyncio.get_running_loop().time()
                if remaining <= 0:
                    break
                reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(str(socket), limit=MAX_REPLY), remaining)
                writer.write((json.dumps({'action': 'cancel', 'pid': pid, 'started_at': started_at, 'owner': owner,
                                          'request_token': request_token}, separators=(',', ':'))+'\n').encode())
                await asyncio.wait_for(writer.drain(), max(0.001, deadline-asyncio.get_running_loop().time()))
                raw = await asyncio.wait_for(reader.readuntil(b'\n'), max(0.001, deadline-asyncio.get_running_loop().time()))
                response = json.loads(raw)
                if isinstance(response, dict):
                    if response.get('cancelled') is True or response.get('reason') == 'already_cancelled':
                        return {'cancelled': True, 'reason': None}
                    retry = retry or response.get('reason') == 'not_found'
            except (OSError, ValueError, UnicodeError, RecursionError, asyncio.TimeoutError,
                    asyncio.IncompleteReadError, asyncio.LimitOverrunError):
                pass
            finally:
                if writer is not None:
                    writer.close()
                    try:
                        await writer.wait_closed()
                    except OSError:
                        pass
        remaining = deadline-asyncio.get_running_loop().time()
        if not retry or remaining <= 0:
            break
        # The app-server may not have delivered the original call to the relay yet. Only the idempotent cancel
        # request is repeated, under the same deadline and token; the original tool call is never sent twice.
        await asyncio.sleep(min(0.025, remaining))
    return {'cancelled': False, 'reason': 'not_found'} if relays else unavailable
