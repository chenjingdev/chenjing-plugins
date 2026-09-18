#!/usr/bin/env python3
"""비대화형 벤치 런 완료 감시 — Monitor 도구로 돌린다.
사용: monitor_runs.py 11:fable-medium 15:fable-xhigh …   (workspace 번호:이름)
화면 마지막 줄이 셸 프롬프트로 돌아오면 DONE, 5분마다 heartbeat. 프롬프트 정규식은 BENCH_PROMPT_RE 로 바꿀 수 있다.
"""
import subprocess, time, sys, re, os
PROMPT = re.compile(os.environ.get("BENCH_PROMPT_RE", r"MacStudio dev % *$"))
NAMES = dict((int(a.split(":")[0]), a.split(":", 1)[1]) for a in sys.argv[1:])
if not NAMES: sys.exit("사용: monitor_runs.py <ws번호>:<이름> …")
env = dict(os.environ, CMUX_QUIET="1"); START = time.time()
def elapsed(): return f"+{int((time.time()-START)//60)}m"
def screen(w):
    r = subprocess.run(["cmux","read-screen","--workspace",f"workspace:{w}","--lines","40"], capture_output=True, text=True, env=env, timeout=20)
    if r.returncode != 0: return None, (r.stderr or r.stdout).strip()[:200]
    return [l for l in r.stdout.split("\n") if l.strip()], None
pending = list(NAMES); tick = 0; errs = 0
while pending:
    for w in list(pending):
        try: lines, err = screen(w)
        except Exception as e: lines, err = None, str(e)
        if lines is None:
            errs += 1
            if errs in (1, 10, 100): print(f"READ-ERROR workspace:{w}: {err}", flush=True)
            continue
        if lines and PROMPT.search(lines[-1]):
            pending.remove(w)
            print(f"DONE {NAMES[w]} (workspace:{w}) {elapsed()} :: " + " | ".join(l[:160] for l in lines[-4:-1]), flush=True)
    if not pending: print(f"ALL DONE {elapsed()}", flush=True); break
    tick += 1
    if tick % 20 == 0: print(f"still running ({len(pending)}): {' '.join(NAMES[w] for w in pending)} | {elapsed()}", flush=True)
    time.sleep(15)
