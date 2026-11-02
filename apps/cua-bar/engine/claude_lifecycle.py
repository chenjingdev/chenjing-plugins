"""Claude event hooks and per-agent CUA scope ownership; no transcript or tool input is stored.

PreToolUse binds the CLI's tool-use id to its session/agent/prompt. The bridge consumes that binding from the
same private state directory. End hooks ask only bridges owned by this exact live Claude process to end matching
bound scopes. They never start Codex, choose native session ids, change permissions, or release unrelated work.
"""
import asyncio
from collections import Counter
import contextvars
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import time
import uuid

from bridge_records import private_directory, process_started_at, state_dir, write_json_atomic

IDENT = re.compile(r'^[A-Za-z0-9_.:-]{1,200}$')
END_EVENTS = frozenset(('Stop', 'StopFailure', 'SubagentStop', 'SessionEnd', 'UserPromptSubmit'))
MAX_INPUT = 1024 * 1024
END_SECONDS = 5.0


def identity(pid):
    """A live process's uid, parent and start; no argv or environment is read."""
    try:
        output = subprocess.check_output(['/bin/ps', '-p', str(pid), '-o', 'uid=,ppid='], text=True, timeout=2)
        uid, parent = map(int, output.split())
        return uid, parent, process_started_at(pid)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def hook_owner(environment=None):
    """CLAUDE_PID is accepted only when it is a same-user ancestor of this hook process."""
    environment = os.environ if environment is None else environment
    value = environment.get('CLAUDE_PID', '')
    if not value.isdigit() or int(value) <= 1:
        return None
    expected, current, seen = int(value), os.getppid(), set()
    while current > 1 and current not in seen and len(seen) < 32:
        seen.add(current)
        info = identity(current)
        if info is None or info[0] != os.getuid():
            return None
        if current == expected:
            return current, info[2]
        current = info[1]
    return None


def source(payload):
    session = payload.get('claude_session_id', payload.get('session_id'))
    agent, prompt = payload.get('agent_id'), payload.get('prompt_id')
    agent = '' if agent is None else agent
    prompt = '' if prompt is None else prompt
    if (not isinstance(session, str) or not IDENT.fullmatch(session)
            or any(not isinstance(value, str) or (value and not IDENT.fullmatch(value)) for value in (agent, prompt))):
        return None
    return {'claude_session_id': session, 'agent_id': agent, 'prompt_id': prompt}


def source_key(value):
    return tuple(value[name] for name in ('claude_session_id', 'agent_id', 'prompt_id'))


def private_json(path):
    try:
        info = path.lstat()
        parent = path.parent.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077
                or info.st_size > 65536 or not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid()
                or parent.st_mode & 0o077):
            return None
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else None
    except (OSError, ValueError, RecursionError):
        return None


def binding_path(state, owner, tool_id):
    key = json.dumps([owner[0], owner[1], tool_id], separators=(',', ':')).encode()
    return Path(state)/'claude-hook-calls'/('%d-%d' % owner)/(hashlib.sha256(key).hexdigest()+'.json')


def bind_call(state, owner, payload):
    bound, tool_id = source(payload), payload.get('tool_use_id')
    name = payload.get('tool_name', '')
    if (bound is None or not isinstance(tool_id, str) or not IDENT.fullmatch(tool_id)
            or name not in ('mcp__cuabar__js', 'mcp__cuabar__js_reset', 'mcp__cuabar__turn_ended')):
        return False
    private_directory(Path(state))
    private_directory(Path(state)/'claude-hook-calls')
    private_directory(binding_path(state, owner, tool_id).parent)
    write_json_atomic(binding_path(state, owner, tool_id), {'schema_version': 1, 'owner_pid': owner[0],
        'owner_started_at': owner[1], 'tool_use_id': tool_id, 'at': time.time(), **bound})
    return True


def read_binding(state, owner, tool_id):
    if not isinstance(tool_id, str) or not IDENT.fullmatch(tool_id):
        return None
    value = private_json(binding_path(state, owner, tool_id))
    if (not value or value.get('schema_version') != 1 or value.get('owner_pid') != owner[0]
            or value.get('owner_started_at') != owner[1] or value.get('tool_use_id') != tool_id):
        return None
    return source(value)


def prune_bindings(state, owner, payload):
    bound, event = source(payload), payload.get('hook_event_name')
    if bound is None or event not in END_EVENTS or (event == 'SubagentStop' and not bound['agent_id']):
        return
    folder = Path(state)/'claude-hook-calls'/('%d-%d' % owner)
    for path in folder.glob('*.json'):
        value = private_json(path)
        original = source(value) if value else None
        if (not original or value.get('owner_pid') != owner[0] or value.get('owner_started_at') != owner[1]
                or original['claude_session_id'] != bound['claude_session_id']):
            continue
        if event != 'SessionEnd':
            if original['agent_id'] != bound['agent_id']:
                continue
            if event == 'SubagentStop':
                path.unlink()
                continue
            if event == 'UserPromptSubmit':
                if bound['prompt_id'] and original['prompt_id'] == bound['prompt_id']:
                    continue
            elif bound['prompt_id'] and original['prompt_id'] != bound['prompt_id']:
                continue
        path.unlink()
    try:
        folder.rmdir()
    except OSError:
        pass


def notify_bridges(state, owner, payload):
    """Only private, live records belonging to this exact Claude process may receive an end event."""
    bound, event = source(payload), payload.get('hook_event_name')
    if bound is None or event not in END_EVENTS:
        return []
    results = []
    for path in (Path(state)/'bridges').glob('bridge-*/bridge.json'):
        record = private_json(path)
        if (not record or record.get('owner_pid') != owner[0] or record.get('owner_started_at') != owner[1]):
            continue
        pid, started = record.get('pid'), record.get('started_at')
        if type(pid) is not int or type(started) is not int or identity(pid) != (os.getuid(), owner[0], started):
            continue
        control = path.parent/'control.sock'
        try:
            info = control.lstat()
            if (record.get('control_path') != str(control) or not stat.S_ISSOCK(info.st_mode)
                    or info.st_uid != os.getuid() or info.st_mode & 0o077):
                continue
            request = {'action': 'claude_event', 'pid': pid, 'started_at': started, 'event': event, **bound}
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(6)
                client.connect(str(control))
                client.sendall((json.dumps(request)+'\n').encode())
                data = bytearray()
                while b'\n' not in data and len(data) < 4096:
                    chunk = client.recv(4096-len(data))
                    if not chunk:
                        break
                    data.extend(chunk)
                reply = json.loads(data)
                if isinstance(reply, dict):
                    results.append(reply)
        except (OSError, ValueError):
            results.append({'released': False, 'reason': 'unconfirmed'})
    return results


class ScopeRouter:
    """Keep native turns separate for Claude parent/subagents and their prompts on a shared MCP connection."""
    def __init__(self, adapter):
        self.adapter = adapter
        self.context = contextvars.ContextVar('cuabar_claude_source', default=None)
        self.current = {}
        self.sources = {}
        self.inflight = Counter()

    def enter(self, message):
        if not isinstance(message, dict):
            return self.context.set(None)
        params = message.get('params', {}) if isinstance(message, dict) else {}
        meta = params.get('_meta', {}) if isinstance(params, dict) else {}
        owner = getattr(self.adapter, 'claude_owner', None)
        state = getattr(self.adapter, 'control_state', None)
        bound = None
        if (message.get('method') == 'tools/call' and isinstance(meta, dict) and owner and state):
            bound = read_binding(state, owner, meta.get('claudecode/toolUseId'))
        return self.context.set(bound)

    def scope(self):
        bound = self.context.get()
        if bound is None or self.adapter.thread_id is None:
            return None
        key = source_key(bound)
        scope = self.current.get(key)
        if scope is None or scope['session_id'] != self.adapter.thread_id:
            scope = {'session_id': self.adapter.thread_id, 'turn_id': str(uuid.uuid4())}
            self.current[key] = scope
            self.sources[(scope['session_id'], scope['turn_id'])] = dict(bound)
        return dict(scope)

    def retired(self, scope, confirmed):
        for key, current in list(self.current.items()):
            if current == scope:
                self.current.pop(key)
        if confirmed:
            self.sources.pop((scope['session_id'], scope['turn_id']), None)

    def snapshot(self):
        return [{**bound, 'session_id': key[0], 'turn_id': key[1]} for key, bound in self.sources.items()
                if key in self.adapter.scopes]

    def selected(self, event, bound):
        targets = []
        for key, original in self.sources.items():
            if key not in self.adapter.scopes or original['claude_session_id'] != bound['claude_session_id']:
                continue
            if event == 'SessionEnd':
                targets.append(key)
                continue
            if event == 'SubagentStop':
                if not bound['agent_id'] or original['agent_id'] != bound['agent_id']:
                    continue
                targets.append(key)
                continue
            elif original['agent_id'] != bound['agent_id']:
                continue
            if event == 'UserPromptSubmit':
                if bound['prompt_id'] and original['prompt_id'] == bound['prompt_id']:
                    continue
            elif bound['prompt_id'] and original['prompt_id'] != bound['prompt_id']:
                continue
            targets.append(key)
        return targets

    async def end(self, request):
        event, bound = request.get('event'), source(request)
        if event not in END_EVENTS or bound is None:
            return {'released': False, 'reason': 'invalid_event', 'scope_count': 0}
        targets = self.selected(event, bound)
        deadline = time.monotonic()+END_SECONDS
        while any(self.inflight[key] for key in targets):
            if time.monotonic() >= deadline:
                return {'released': False, 'reason': 'request_in_flight', 'scope_count': 0}
            await asyncio.sleep(.05)
        count = 0
        for key in targets:
            acquired = False
            try:
                await asyncio.wait_for(self.adapter.turn_lock.acquire(), max(.001, deadline-time.monotonic()))
                acquired = True
                if key not in self.adapter.scopes:
                    continue
                if self.inflight[key]:
                    return {'released': False, 'reason': 'request_in_flight', 'scope_count': count}
                if not self.adapter.connected or key[0] != self.adapter.thread_id:
                    return {'released': False, 'reason': 'host_unavailable', 'scope_count': count}
                scope = {'session_id': key[0], 'turn_id': key[1]}
                try:
                    remaining = max(.001, deadline-time.monotonic())
                    confirmed, _ = await asyncio.wait_for(self.adapter.end_scope(scope, remaining), remaining)
                except Exception:
                    confirmed = False
                if not confirmed:
                    self.adapter.cleanup_unconfirmed = True
                    self.adapter.changed()
                    return {'released': False, 'reason': 'cleanup_not_confirmed', 'scope_count': count}
                count += 1
            except asyncio.TimeoutError:
                return {'released': False, 'reason': 'cleanup_not_confirmed', 'scope_count': count}
            finally:
                if acquired:
                    self.adapter.turn_lock.release()
        return {'released': True, 'reason': None, 'scope_count': count}


def main():
    # Hook errors never block a user's message or approve an action. Only fixed diagnostics leave this process.
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT+1)
        if len(raw) > MAX_INPUT:
            return 0
        payload = json.loads(raw)
        owner = hook_owner()
        if not isinstance(payload, dict) or owner is None:
            return 0
        state = state_dir()
        if payload.get('hook_event_name') == 'PreToolUse':
            bind_call(state, owner, payload)
        else:
            results = notify_bridges(state, owner, payload)
            if any(result.get('released') is False for result in results):
                print('cuabar: CUA cleanup was not confirmed.', file=sys.stderr)
            prune_bindings(state, owner, payload)
    except Exception:
        print('cuabar: lifecycle hook unavailable.', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
