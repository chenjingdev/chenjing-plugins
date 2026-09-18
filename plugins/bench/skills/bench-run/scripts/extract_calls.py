#!/usr/bin/env python3
"""하네스 트랜스크립트에서 앱(MCP 서버) 도구 호출 순서를 뽑는다.

사용:
  extract_calls.py --harness claude|codex|grok|agy --app aria --match "새벽 항구 (sol-xhigh)" [--out calls.jsonl] [--bench-home ~/.bench] [--json]

--match 는 그 런을 식별하는 문자열(프롬프트에 박은 런 태그가 들어간 곡 제목). 같은 문자열을 가진 세션이 여럿이면
앱 도구 호출이 가장 많은 세션을 고른다(재실행 전 죽은 시도 대신 완주한 것).
앱 도구 이름 집합은 ~/.bench/apps/<app>.json 의 tools 캐시에서 읽는다(없으면 모든 이름을 앱 도구로 본다).
출력 jsonl 한 줄: {"i","t","tool","items","args","error"} — items 는 aria 라면 그 호출로 들어간 노트 수(add_notes/set_song).
--json 이면 요약 지표를 stdout 에 JSON 으로 낸다. 하네스별 파일 형식은 references/harnesses.md 참고.
"""
import argparse, json, glob, os, re, datetime
ap = argparse.ArgumentParser()
ap.add_argument("--harness", required=True, choices=["claude","codex","grok","agy"])
ap.add_argument("--app", default="aria"); ap.add_argument("--match", required=True)
ap.add_argument("--out"); ap.add_argument("--bench-home", default=os.path.expanduser("~/.bench")); ap.add_argument("--json", action="store_true")
A = ap.parse_args(); BH = A.bench_home
try: TOOLS = set(json.load(open(f"{BH}/apps/{A.app}.json"))["tools"][A.app])
except Exception: TOOLS = None
is_app = (lambda n: n in TOOLS) if TOOLS else (lambda n: True)

def song_notes(sg):
    if isinstance(sg, str):
        try: sg = json.loads(sg)
        except Exception: return 0
    return sum(len(t.get("notes", [])) for t in sg.get("tracks", []) if isinstance(t, dict)) if isinstance(sg, dict) else 0
def items_in(args):  # aria: 이 호출로 들어간 노트 수. 다른 앱은 여기에 규칙을 추가한다.
    if not isinstance(args, dict): return 0
    if isinstance(args.get("notes"), list): return len(args["notes"])
    for k in ("song_json", "song"):
        if k in args: return song_notes(args[k])
    return 0
def brief(args):
    if not isinstance(args, dict): return ""
    keep = {}
    for k, v in args.items():
        if k == "notes": keep[k] = f"[{len(v)} notes]"
        elif k in ("song", "song_json"): keep[k] = f"{{song JSON, {song_notes(v)} notes}}"
        elif isinstance(v, (str, int, float, bool)) or v is None: keep[k] = v if not isinstance(v, str) or len(v) < 60 else v[:57] + "…"
        else: keep[k] = json.dumps(v, ensure_ascii=False)[:60]
    return json.dumps(keep, ensure_ascii=False)
def iso(ts): return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat().replace("+00:00", "Z") if isinstance(ts, (int, float)) else ts

def scan_claude(m):
    for f in glob.glob(f"{BH}/_claude/projects/*/*.jsonl"):
        txt = open(f, encoding="utf-8", errors="ignore").read()
        if m not in txt: continue
        calls = []
        for line in txt.splitlines():
            try: d = json.loads(line)
            except Exception: continue
            c = (d.get("message") or {}).get("content")
            if isinstance(c, list):
                for b in c:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        name = str(b.get("name")); base = name.split("__")[-1] if name.startswith("mcp__") else f"[{name}]"
                        calls.append(dict(t=d.get("timestamp"), tool=base if is_app(base) else f"[{name}]", args=b.get("input") or {}, error=False))
        yield calls, f
def scan_codex(m):
    for f in glob.glob(f"{BH}/{A.app}/codex/sessions/*/*/*/*.jsonl"):
        txt = open(f, encoding="utf-8", errors="ignore").read()
        if m not in txt: continue
        calls = []
        for line in txt.splitlines():
            try: d = json.loads(line)
            except Exception: continue
            it = ((d.get("payload") or {}).get("item") or {})
            if it.get("type") == "McpToolCall":
                tool = it.get("tool"); calls.append(dict(t=d.get("timestamp"), tool=tool if is_app(tool) else f"[{tool}]", args=it.get("arguments") or {}, error=bool((it.get("result") or {}).get("isError"))))
        yield calls, f
def scan_grok(m):
    for d_ in glob.glob(f"{BH}/{A.app}/grok/sessions/*/*/"):
        ch = os.path.join(d_, "chat_history.jsonl")
        if not os.path.exists(ch) or m not in open(ch, encoding="utf-8", errors="ignore").read(): continue
        calls = []
        for line in open(os.path.join(d_, "updates.jsonl"), encoding="utf-8", errors="ignore"):
            try: u = json.loads(line)
            except Exception: continue
            upd = (u.get("params") or {}).get("update") or {}
            if upd.get("sessionUpdate") != "tool_call": continue
            ri = upd.get("rawInput") or {}
            if upd.get("title") == "use_tool":
                name = str(ri.get("tool_name", "")).split("__")[-1]
                calls.append(dict(t=iso(u.get("timestamp")), tool=name if is_app(name) else f"[{ri.get('tool_name')}]", args=ri.get("tool_input") or {}, error=False))
            else: calls.append(dict(t=iso(u.get("timestamp")), tool=f"[{upd.get('title')}]", args=ri, error=False))
        yield calls, d_
def scan_agy(m):
    for f in glob.glob(f"{BH}/{A.app}/agy/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl"):
        txt = open(f, encoding="utf-8", errors="ignore").read()
        if m not in txt: continue
        calls = []
        def unq(v):
            if isinstance(v, str):
                try: return json.loads(v)
                except Exception: return v
            return v
        for line in txt.splitlines():
            try: d = json.loads(line)
            except Exception: continue
            for tc in d.get("tool_calls") or []:
                name = str(tc.get("name", "")); parsed = {k: unq(v) for k, v in (tc.get("args") or {}).items()}
                if name == "call_mcp_tool":
                    tool = str(parsed.get("ToolName", "")); inner = unq(parsed.get("Arguments", {}))
                    calls.append(dict(t=d.get("created_at"), tool=tool if is_app(tool) else f"[{tool}]", args=inner if isinstance(inner, dict) else {}, error=False)); continue
                calls.append(dict(t=d.get("created_at"), tool=f"[{name}]", args=parsed, error=False))
        yield calls, f

scan = dict(claude=scan_claude, codex=scan_codex, grok=scan_grok, agy=scan_agy)[A.harness]
best = None
for calls, src in scan(A.match):
    n_app = sum(1 for c in calls if not c["tool"].startswith("["))
    has_export = any(c["tool"] == "export" for c in calls)
    key = (n_app, has_export, len(calls))
    if best is None or key > best[0]: best = (key, calls, src)
if not best: raise SystemExit(f"'{A.match}' 를 가진 {A.harness} 트랜스크립트가 없습니다")
_, calls, src = best
if A.out:
    with open(A.out, "w") as fh:
        for i, c in enumerate(calls, 1): fh.write(json.dumps(dict(i=i, t=c["t"], tool=c["tool"], items=items_in(c["args"]), error=c["error"], args=brief(c["args"])), ensure_ascii=False) + "\n")
# 요약 지표
app_calls = [c for c in calls if not c["tool"].startswith("[")]
def parse_t(a):
    try: return datetime.datetime.fromisoformat(str(a).replace("Z", "+00:00"))
    except Exception: return None
ts = [parse_t(c["t"]) for c in calls]; ts = [t for t in ts if t]
active = round(sum((b - a).total_seconds() for a, b in zip(ts, ts[1:]) if 0 <= (b - a).total_seconds() <= 1200) / 60, 1) if ts else None
from collections import Counter
cnt = Counter(c["tool"] for c in app_calls)
item_calls = [(c["tool"], items_in(c["args"])) for c in app_calls if items_in(c["args"])]
summary = dict(source=src.replace(os.path.expanduser("~"), "~"), app_calls=len(app_calls), harness_calls=len(calls) - len(app_calls), counts=dict(cnt.most_common()),
    first_item_call_index=next((i for i, c in enumerate(app_calls, 1) if items_in(c["args"])), None),
    add_notes_calls=sum(1 for t, _ in item_calls if t == "add_notes"), add_notes_avg=(round(sum(n for t, n in item_calls if t == "add_notes") / max(1, sum(1 for t, _ in item_calls if t == "add_notes")))) if any(t == "add_notes" for t, _ in item_calls) else None,
    set_song_calls=sum(1 for t, _ in item_calls if t == "set_song"), set_song_max_items=max((n for t, n in item_calls if t == "set_song"), default=0),
    biggest_single_call_items=max((n for _, n in item_calls), default=0),
    direct_http_api_calls=sum(1 for c in calls if c["tool"].startswith("[") and "api/rpc" in json.dumps(c["args"], ensure_ascii=False)),
    elapsed_min=round((ts[-1] - ts[0]).total_seconds() / 60, 1) if len(ts) > 1 else None, active_min=active, first_ten=[c["tool"] for c in app_calls[:10]])
print(json.dumps(summary, ensure_ascii=False, indent=None if A.json else 1))
