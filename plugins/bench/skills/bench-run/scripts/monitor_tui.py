#!/usr/bin/env python3
"""대화형 TUI(agy 등) 감시 — 실행 중("esc to cancel")→유휴("? for shortcuts") 전이마다 화면 꼬리를 낸다.
사용: monitor_tui.py workspace:22 surface:30 <이름>
유휴가 곧 완료는 아니다(질문하고 기다릴 수도 있다). 꼬리를 읽고 판단한다. BENCH_TUI_RUNNING / BENCH_TUI_IDLE 로 문구를 바꿀 수 있다.
"""
import subprocess, time, sys, os
ws, surf, label = sys.argv[1], sys.argv[2], sys.argv[3]
RUNNING = os.environ.get("BENCH_TUI_RUNNING", "esc to cancel"); IDLE = os.environ.get("BENCH_TUI_IDLE", "? for shortcuts")
env = dict(os.environ, CMUX_QUIET="1"); start = time.time(); state = None; tick = 0
def screen():
    r = subprocess.run(["cmux","read-screen","--workspace",ws,"--surface",surf,"--lines","50"], capture_output=True, text=True, env=env, timeout=20)
    return [l for l in r.stdout.split("\n") if l.strip()] if r.returncode == 0 else None
while True:
    lines = screen()
    if lines is None: print(f"READ-ERROR {label}", flush=True); time.sleep(30); continue
    tail = "\n".join(lines[-14:])
    running = RUNNING in tail or "Calling MCP tool" in tail
    new = "idle" if (IDLE in tail and not running) else ("running" if running else state)
    if new == "idle" and state != "idle":
        print(f"IDLE {label} +{int((time.time()-start)//60)}m :: " + " | ".join(l.strip()[:150] for l in lines[-14:-4]), flush=True)
    state = new; tick += 1
    if tick % 20 == 0: print(f"heartbeat {label}: {state} +{int((time.time()-start)//60)}m", flush=True)
    time.sleep(15)
