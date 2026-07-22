---
name: proto
description: A five-minute structure-divergence sprint. Use when the user runs /proto:proto <fuzzy one-liner>, or brings a fuzzy under-specified idea and wants to see it take shape before any real build starts. One checklist page pins the must-have features (inferred candidates plus the assistant's suggested additions), then two or three low-fidelity wireframes arrange that same feature set in genuinely different structures, shown side by side for one multiple-choice verdict. Do NOT use for "make me this app/page" requests where the implementation is already specified, and never as a long-running product-discovery campaign.
argument-hint: "<흐릿한 한 줄 아이디어>"
---

# proto — 구조 갈림 스프린트

One fuzzy line comes in. One checklist page settles which features the thing must have; about five minutes later the user is looking at two or three low-fidelity sketches that arrange those same features in different structures, and answers one multiple-choice question. Only the chosen sketch and a few verdict lines are kept — a record of intent that the real build takes as input and starts fresh from. Everything else, including the sketch code, is deleted.

The split between the interview and the sketches is deliberate. What the tool must do — the feature list — can be settled in words in a few seconds, and guessing it instead produces sketches that differ in functionality. Those cannot be compared: the honest answer to "어느 게 낫나요?" becomes "둘 다 필요한데요", and no single choice is possible. What cannot be settled in words is structure — which feature is on the first screen, how the user moves between features, which action is one click away. That judgment only comes from a person looking at concrete artifacts. So the interview fixes what the tool does, and the sketches differ only in how it is arranged. The checklist also carries the assistant's own suggestions — features neither the input nor the user named would otherwise never surface, and a suggestion the user can check is safe where a silently added feature would make the verdict ambiguous.

The five-minute budget is a hard constraint, not an optimization target. Every part is sized to stay inside it: the interview is one checklist page returned in one paste, not a questionnaire; you draw the sketches yourself, because at this size briefing a subagent and waiting for it takes longer than drawing; the data is a handful of realistic labels written inline, with no dataset files; checking is one reread by eye, with no verification step; and there is no round 3 — an idea still unresolved after two rounds needs a real spec pass, so say that and stop. If a step's honest ETA breaks the budget, make the sketches smaller instead of taking more time.

## The run

**Input.** The argument is the input line. If empty, take the user's most recent request; if there is truly nothing to work from, ask for the one line in plain text.

**Scope.** Infer three or four candidate features from the input — if it names a real project, read one or two files (README, product notes) so the candidates are accurate; don't read more than that. Then add two or three features you would suggest yourself: adjacent things the input implies but nobody named. Write both groups into `.proto/<YYYYMMDD-HHmmss>-<slug>/scope.html` — this creates the run directory the sketches will use — as a self-contained checklist page (recipe below): inferred candidates checked by default, suggestions unchecked and marked `(제안)` with a one-line reason each, a free-text row for additions, and a result line at the bottom that live-updates to `스코프: <체크된 항목, 쉼표로>` with a 복사 button. Present it with `SendUserFile(display: render)` and open it as a browser tab in the same step, and say in one line: 체크한 뒤 복사 버튼을 눌러 결과 줄을 채팅에 붙여넣어 달라. A local page cannot send data back on its own, so the pasted line is the return channel and the authoritative **scope**: every sketch contains all of it, and unchecked features appear in none. The page replaces a multiple-choice question because the choice tool caps options at four, and candidates plus suggestions regularly need more room than that. It is still the whole interview — one interruption — and a feature idea that occurs to you after this point goes into `verdict.md` as a suggestion line, never silently into a sketch. Anything the user volunteers beyond the checkboxes (including a hand-edited paste, or a plain-words reply instead of a paste) is the user's scope decision — record it immediately, never defer it.

**Axis.** With the features fixed, pick the one structural dimension on which arrangements of this scope actually differ: which feature is on the first screen and how the others are reached, the navigation type (mode switch / one split screen / a fixed sequence), which action is the primary one-click action, how much is visible at once (everything on one screen / one thing at a time) — or define a different dimension from the input itself if one fits better. Each sketch is one point on that one dimension: the same feature set, described by a different sentence about its structure. If the dimension honestly yields only two arrangements, draw two — a third added only to reach three makes the choice harder, not clearer. The sketches never differ in functionality (that makes them incomparable) and never only in visual styling (that leaves nothing to judge). (The user chooses between options and is never asked to generate ideas — so the word "브레인스토밍" never appears in anything user-facing.)

**Draw.** Announce what's coming in one line with an honest ETA —

> 같은 기능, 세 구조로 그리는 중 (~2분) — A) …한 줄… B) …한 줄… C) …한 줄…

— then write the files yourself to `.proto/<YYYYMMDD-HHmmss>-<slug>/{A,B,C}.html` (or just A, B). Each sketch is:

- one self-contained HTML file — all CSS/JS inline, zero external requests, because it must render inside a sandboxed iframe with no network;
- wireframe fidelity — gray boxes, labels, clickable spots, monochrome, roughly ≤200 lines, no live logic (timers, simulation, computed state). The verdict is about layout and flow; anything richer takes longer and distracts from that question;
- populated with real nouns — a handful of plausible names and values, never `foo`/`bar`, because unnamed boxes cannot be judged. Reuse the project vocabulary you read during the scope step. Real personal data stays in local files — never publish it to an external service;
- complete — every must-have from the scope appears, wired, in every sketch. A sketch missing one cannot be compared with the others; fix it before presenting;
- honest — everything drawn responds to interaction. An inert tab or an unopenable menu makes the user judge something that doesn't exist; out-of-scope UI is omitted entirely.

**Glance.** Reread the files once and ask three questions: does every sketch contain the full scope? do they actually differ in structure and primary action, or are two of them the same layout with different styling? is anything drawn but not wired? Fix the weak file directly by editing it — you drew it, the fix takes seconds.

**Gallery.** Assemble `gallery.html` (recipe below): isolated frames, each labeled `A/B/C · 구조 한 줄`, with a header that states in one plain Korean sentence that the sketches share the same features and how their structures differ. Present it with `SendUserFile(display: render)` and open the sketch files as browser tabs in the same step (`open A.html B.html C.html`; Linux `xdg-open`; no GUI browser → send the files individually). The standard is a 30-second verdict: the user should see the difference and be able to choose within half a minute of the gallery opening. If they can't, the sketches contained too much — that is a drawing defect, not the user's fault.

**Verdict.** With the artifacts on screen, ask one question via `AskUserQuestion`: "어느 구조가 의도에 가장 가깝나요?" → `A / B (/ C) / 전부 아님`. Each option's description is a factual one-line summary of that sketch's structure — "첫 화면=런 기록 테이블, 주 버튼=판정 저장" — never persuasion. A pick (or a mixed answer via free text, like "골격은 A인데 주 동작은 C" — take the named base as survivor and keep the quote) goes straight to hand-off. `전부 아님` gets one follow-up — "가장 어긋난 지점은?" → `첫 화면 기능 / 이동 방식 / 주 동작 / 스코프 자체` — and that answer determines round 2. `스코프 자체` means the interview was wrong: re-present the scope page once, corrected by what you just learned, and build round 2 on the new scope.

**Round 2 — only if the verdict asks for it.** Same run directory, overwrite the files. The new round narrows: take the thing the mismatch answer pointed at and offer different versions of that, at the same or lower fidelity. Never respond to a rejection with a bigger or denser concept — the user rejected what was already shown, and adding more moves further from what they asked for. Round 2's verdict ends the sprint whatever it is. A second `전부 아님` means the idea doesn't resolve in a five-minute comparison: write both rounds into `verdict.md`, say so plainly, and recommend a real spec pass. There is no round 3.

**Hand-off.** Write `.proto/<run>/verdict.md` — a few lines with the user's words kept verbatim, no derived-requirements essay:

```
# proto — <입력 한 줄>
- scope: <필수 기능 목록, 쉼표로>
- axis: <갈림축>
- A: <구조 한 줄> / B: <구조 한 줄> / C: <구조 한 줄>
- verdict: <A|B|C|전부 아님> — "<사용자 판정 원문>"
- direction: <본 빌드를 위한 방향 한 줄>
```

(Round 2 appends a second block.) Save the chosen sketch as `survivor.html` with this banner comment at the top, then delete the losing sketches, the gallery, and the scope page:

> 이 파일은 판정 기록의 근거입니다. 본 빌드는 이 코드 위에 짓지 말고 처음부터 새로 지으세요 — verdict.md의 판정과 이 파일을 입력으로만 쓰세요.

The final message is two paths — `verdict.md`, `survivor.html` — and one sentence: the real build starts fresh from these two files; the sketch code is never extended.

## Scope page recipe

`scope.html` is one self-contained file, wireframe-plain like everything else. The working parts:

```html
<label><input type="checkbox" class="feat" value="라이브 런 관제" checked> 라이브 런 관제 — 한 줄 설명</label>
<!-- …inferred candidates checked; suggestions unchecked, labeled (제안) with a one-line reason… -->
<label>+ 직접 추가: <input type="text" id="extra" placeholder="쉼표로 여러 개"></label>
<textarea id="result" readonly></textarea> <button id="copy">복사</button>
<p>복사한 줄을 채팅에 붙여넣어 주세요.</p>
<script>
  const update = () => {
    const feats = [...document.querySelectorAll('.feat:checked')].map(c => c.value);
    const extra = document.getElementById('extra').value.split(',').map(s => s.trim()).filter(Boolean);
    document.getElementById('result').value = '스코프: ' + feats.concat(extra).join(', ');
  };
  document.querySelectorAll('.feat, #extra').forEach(el => el.oninput = update); update();
  document.getElementById('copy').onclick = () => {
    const t = document.getElementById('result'); t.select();
    (navigator.clipboard ? navigator.clipboard.writeText(t.value) : Promise.reject())
      .catch(() => document.execCommand('copy'));
  };
</script>
```

The copy button needs the fallback because the inline viewer may block the clipboard API; the selected textarea lets the user copy by hand in the worst case, which is why the result is a visible textarea and not a hidden string.

## Gallery recipe

`gallery.html` must itself be self-contained (it renders in an isolated viewer that cannot fetch sibling files), so inline each sketch as a JS string and assign it to `iframe.srcdoc` at runtime — never paste raw HTML into a `srcdoc="…"` attribute, where escaping is fragile:

```html
<figure><figcaption>A · 구조 한 줄</figcaption>
  <iframe id="frame-A" sandbox="allow-scripts" title="구조 A"></iframe></figure>
<!-- …B, C… -->
<script>
  // each value = JSON.stringify(sketchHtml).replace(/</g, '\\u003c')
  const SKETCHES = { A: "…", B: "…", C: "…" };
  for (const k of Object.keys(SKETCHES))
    document.getElementById("frame-" + k).srcdoc = SKETCHES[k];
</script>
```

`sandbox="allow-scripts"` without `allow-same-origin` gives each sketch an opaque origin: its clickable spots work, and nothing — CSS, JS, globals — leaks between frames or into the gallery.

## Input shapes

The input's shape changes what a "sketch" is, nothing else: UI ideas → screen wireframes; CLI ideas → mock terminal transcripts (command → output); pipeline/data ideas → input→output correspondence tables. All are still single self-contained HTML files, so the gallery and the verdict work identically.
