#!/usr/bin/env python3
"""aria 벤치 런 수집·패키징. 사용: aria_collect.py <runs-spec.json> <출력 디렉터리> [--screenshots] [--move]
스펙 형식은 references/aria.md. 살아 있는 인스턴스에서 곡 JSON·편집 이력을 받고, 결과물(MP3)과 화면을 모으고,
extract_calls.py 로 도구 호출 순서·지표를 뽑아 runs.json / process/summary.md / README.md 를 만든다.
"""
import json, glob, os, re, sys, subprocess, shutil, datetime
HERE = os.path.dirname(os.path.abspath(__file__)); H = os.path.expanduser("~")
spec = json.load(open(sys.argv[1])); OUT = os.path.abspath(sys.argv[2]); SHOTS = "--screenshots" in sys.argv; MOVE = "--move" in sys.argv
APP = spec.get("app", "aria"); BH = os.path.expanduser(spec.get("bench_home", "~/.bench"))
for sub in ("audio", "screenshots", "songs", "process", "prompts"): os.makedirs(f"{OUT}/{sub}", exist_ok=True)
def alive(pid):
    try: os.kill(pid, 0); return True
    except Exception: return False
def rpc(inst, tool, args=None):
    r = subprocess.run(["curl","-s","-m","30","-H",f"Authorization: Bearer {inst['bridgeToken']}","-H","Content-Type: application/json","-X","POST",f"{inst['baseUrl']}/api/rpc","-d",json.dumps({"tool":tool,"args":args or {}})],capture_output=True,text=True)
    j = json.loads(r.stdout); 
    if not j.get("ok"): raise RuntimeError(j.get("error"))
    return j["result"]
# 살아 있는 인스턴스 → 제목
inst_by_title = {}
for f in glob.glob(f"{BH}/{APP}/data-*/sessions/*/runtime.json"):
    d = json.load(open(f))
    if not alive(d["pid"]): continue
    try:
        res = rpc(d, "get_song"); head, _, body = res.partition("\n\n"); song = json.loads(body[body.index("{"):])
    except Exception: continue
    d["_song"] = song; d["_dir"] = os.path.dirname(f); inst_by_title[song.get("title")] = d
def dur(p):
    o = subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",p],capture_output=True,text=True).stdout.strip()
    return round(float(o)) if o else None
def find_mp3(tag, slug=None):
    cands = []
    for d_ in spec.get("mp3_dirs", ["~/Music/aria", f"~/.bench/{APP}/work"]):
        for p in glob.glob(os.path.join(os.path.expanduser(d_), "*.mp3")):
            b = os.path.basename(p)
            if tag in b or tag.replace("-", "") in b.replace("-", "") or (slug and slug in b): cands.append(p)
    return max(cands, key=os.path.getmtime) if cands else None
runs_out, rows = [], []
for r in spec["runs"]:
    m = spec["models"][r["model"]]; rt = spec["rounds"][r["round"]]; title = f"{rt} ({r['tag']})"; slug = f"{r['round']}_{m['slug']}_{r['effort']}"
    inst = inst_by_title.get(title)
    if not inst: print(f"!! 살아 있는 인스턴스 없음: {title}", file=sys.stderr); continue
    song = inst["_song"]; json.dump(song, open(f"{OUT}/songs/{slug}.json","w"), ensure_ascii=False)
    hist = rpc(inst, "edit_history"); hist_ops = [x.strip() for x in hist.split("최근 편집(마지막이 가장 최신):")[-1].split("→")] if "최근 편집" in hist else []
    bars = max((int(n["bar"]) for t in song["tracks"] for n in t.get("notes", [])), default=0); notes = sum(len(t.get("notes", [])) for t in song["tracks"])
    mp3_src = find_mp3(r["tag"], slug); mp3 = None
    if mp3_src:
        mp3 = f"{OUT}/audio/{slug}.mp3"; (shutil.move if MOVE else shutil.copy2)(mp3_src, mp3)
    png = None
    if SHOTS:
        png = f"{OUT}/screenshots/{slug}.png"
        subprocess.run([f"{HERE}/aria_screenshot.sh", inst["baseUrl"], png, "2600" if len(song["tracks"]) > 24 else "1900"], capture_output=True)
        if not os.path.exists(png): png = None
    calls_file = f"{OUT}/process/{slug}.calls.jsonl"
    ex = subprocess.run([sys.executable, f"{HERE}/extract_calls.py", "--harness", m["harness"], "--app", APP, "--match", title, "--out", calls_file, "--json", "--bench-home", BH], capture_output=True, text=True)
    met = json.loads(ex.stdout) if ex.returncode == 0 and ex.stdout.strip() else {"error": ex.stderr.strip()[:200]}
    # 작곡 방식 판정
    ss_max, an_calls, big = met.get("set_song_max_items", 0), met.get("add_notes_calls", 0), met.get("biggest_single_call_items", 0)
    if notes and ss_max >= 0.8 * notes: style = "whole-song batch (set_song)"
    elif an_calls >= 8 and (big / notes if notes else 0) <= 0.35: style = "incremental (add_notes per track/section)"
    elif any("곡 통째 교체" in o for o in hist_ops) and an_calls <= 2: style = "whole-song batch (set_song" + ("; mostly via direct HTTP calls from scripts" if met.get("direct_http_api_calls") else "; payload not visible in transcript") + ")"
    elif any("구간 복제" in o for o in hist_ops): style = "mixed (set_song skeleton + copy_bars tiling)"
    else: style = "mixed"
    met.update(build_style=style, biggest_call_share=round(big / notes, 2) if notes else None)
    run = dict(slug=slug, round=r["round"], round_title=rt, display_name=f"{rt} - {m['display']} {r['effort']}", harness=m.get("harness_display", m["harness"]), model_id=m["model_id"], model_display=m["display"], effort=r["effort"], run_tag=r["tag"],
               title=title, bpm=song.get("bpm"), time_sig=song.get("timeSig"), bars=bars, tracks=len(song["tracks"]), track_names=[t.get("name") for t in song["tracks"]], notes=notes,
               mp3=f"audio/{slug}.mp3" if mp3 else None, mp3_seconds=dur(mp3) if mp3 else None, mp3_original=(mp3_src or "").replace(H, "~") or None, screenshot=f"screenshots/{slug}.png" if png else None,
               song_json=f"songs/{slug}.json", calls_file=f"process/{slug}.calls.jsonl", gui_url=inst["baseUrl"], data_dir=inst["_dir"].replace(H, "~"), conditions=r.get("conditions", ""), aria_edit_history_tail=hist_ops, metrics=met)
    runs_out.append(run)
    rows.append((rt, m["display"], r["effort"], bars, len(song["tracks"]), notes, run["mp3_seconds"], met.get("app_calls"), met.get("harness_calls"), style, met.get("first_item_call_index"), met.get("add_notes_calls"), met.get("add_notes_avg"), met.get("set_song_calls"), met.get("biggest_call_share"), met.get("counts", {}).get("play", 0), met.get("active_min")))
    print(f"{slug:36s} bars {bars:3d} tracks {len(song['tracks']):2d} notes {notes:5d} mp3 {run['mp3_seconds']} calls {met.get('app_calls')} {style}")
json.dump(dict(generated=datetime.datetime.now().isoformat(timespec="seconds"), app=APP, runs=runs_out), open(f"{OUT}/runs.json","w"), ensure_ascii=False, indent=1)
with open(f"{OUT}/process/summary.md","w") as fh:
    fh.write("| 라운드 | 모델 | effort | 마디 | 트랙 | 노트 | MP3(s) | 앱 도구 호출 | 하네스 도구 호출 | 작곡 방식 | 첫 노트 입력 순번 | add_notes 횟수 | add_notes 평균 | set_song 횟수 | 최대 단일 호출 비율 | play | 실제 작업 시간(분) |\n|" + "---|" * 17 + "\n")
    for row in rows: fh.write("| " + " | ".join(str(x) for x in row) + " |\n")
# 프롬프트, aria 타이밍 수식
pd = os.path.expanduser(f"~/.bench/{APP}/prompts")
if os.path.isdir(pd):
    for p in glob.glob(f"{pd}/*"): shutil.copy2(p, f"{OUT}/prompts/")
repo = os.path.expanduser(spec.get("aria_repo", "~/dev/aria")); sj = f"{repo}/src/song.js"
if os.path.exists(sj):
    src = open(sj, encoding="utf-8").read().split("\n")
    def block(start_pat, end_pat):
        s_ = next(i for i, l in enumerate(src) if re.match(start_pat, l)); e_ = next(i for i in range(s_ + 1, len(src)) if re.match(end_pat, src[i]))
        return src[s_:e_]
    consts = [l for l in src[:40] if l.startswith("const NOTE_RE") or l.startswith("const SEMIS")]
    parts = ["// aria src/song.js 에서 옮긴 타이밍·피치 함수. noteToMidi('C4')===60. tempoSegments(song) → beatToSec/secToBeat.", *consts,
             *block(r"export function noteToMidi", r"export function midiToFreq"), *block(r"export function beatsPerBar", r"^export function (?!beatsPerBar)"),
             *block(r"export function tempoSegments", r"export function notePlaybackEndBeat"), *block(r"export function bpmAtBeat", r"export function hasTempoChanges")]
    open(f"{OUT}/songs/aria-timing.js", "w").write("\n".join(parts) + "\n")
    if subprocess.run(["node", "--check", f"{OUT}/songs/aria-timing.js"], capture_output=True).returncode != 0: print("!! aria-timing.js 문법 확인 실패 — 수동으로 손봐야 한다", file=sys.stderr)
open(f"{OUT}/README.md","w").write(f"""# {APP} 벤치 패키지 — {datetime.date.today()}

- `runs.json` — 런별 메타데이터·과정 지표·예외 조건. 모든 표와 글의 근거.
- `audio/`, `screenshots/`, `songs/` — 결과물·화면·곡 JSON(slug `<round>_<model>_<effort>`).
- `process/*.calls.jsonl` — 도구 호출 순서. `process/summary.md` — 요약표.
- `prompts/` — 프롬프트 원문과 실행 조건. `songs/aria-timing.js` — 재생 위치 계산용 aria 원본 수식.
""")
print("package:", OUT)
