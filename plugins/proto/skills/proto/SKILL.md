---
name: proto
description: A five-minute interpretation-divergence sprint. Use when the user runs /proto:proto <fuzzy one-liner>, or brings a fuzzy under-specified idea and wants to see genuinely different takes on it side by side and just pick one before any real build starts. Sketch three low-fidelity wireframes that each interpret the idea differently, show them in one gallery, take one multiple-choice verdict, hand off the chosen sketch. Do NOT use for "make me this app/page" requests where the implementation is already specified, and never as a long-running product-discovery campaign.
argument-hint: "<흐릿한 한 줄 아이디어>"
---

# proto — 해석 갈림 스프린트

One fuzzy line comes in. About five minutes later the user is looking at three low-fidelity sketches that read that line three different ways, and answers one multiple-choice question. What survives is the chosen sketch and a few verdict lines — evidence of intent that a real build takes as input and starts fresh from. Nothing else survives, including the code.

This works because the verdict that matters — "맞긴 한데 이게 아님" — only ever comes out of a person looking at an artifact, never out of more text. So everything serves one goal: get judgeable artifacts in front of the user fast, and make the three differ in *interpretation* — what the idea is for, what unit it handles, who drives — never in styling.

Speed is the identity, not an optimization. Every part is sized to keep the gallery minutes away: you draw the sketches yourself (at this size, briefing and awaiting a subagent costs more than drawing), the data is a handful of realistic labels written inline (no dataset files), checking is one reread by eye (no verification pipeline), and there is no round 3 (a seed still unresolved after two rounds needs an interview or a spec pass — say so and stop). If any step's honest ETA breaks the budget, shrink the sketches, never the pace.

## The run

**Seed.** The argument is the seed. If empty, take the user's most recent request; if there is truly nothing to work from, ask for the one line in plain text — the only question that ever precedes the gallery. From here until the gallery is on screen, ask nothing else: the premise is artifacts before words, and with the gallery minutes away a clarifying question costs more than it could save. After the gallery, questions are normal tools, and anything the user volunteers is recorded on the spot — never deferred on procedural grounds.

**Axis.** Pick the one axis on which interpretations of *this* seed genuinely split: what the tool is for, the user's posture (recording / exploring / automating), the unit being handled, the time frame, who drives — or mint a better axis from the seed itself. The three sketches are three points on that one axis. That is what makes them interpretations rather than skins: each needs a different *sentence* to describe, not a different adjective. (The user adjudicates, never generates — so the word "브레인스토밍" never appears in anything user-facing.)

**Draw.** Announce what's coming in one line with an honest ETA —

> 세 갈래로 그리는 중 (~2분) — A) …한 줄… B) …한 줄… C) …한 줄…

— then write the three files yourself to `.proto/<YYYYMMDD-HHmmss>-<slug>/{A,B,C}.html`. Each sketch is:

- one self-contained HTML file — all CSS/JS inline, zero external requests, because it must render inside a sandboxed iframe with no network;
- wireframe fidelity — gray boxes, labels, hotspots, monochrome, roughly ≤200 lines, no live logic (timers, simulation, computed state). The verdict is about shape and flow; anything richer slows the sprint and pollutes the question;
- populated with real nouns — a handful of plausible names and values, never `foo`/`bar`, because unnamed boxes are unjudgeable. If the seed names a real project, glance at a file or two for its vocabulary; don't dig. Real personal data stays in local files — never publish it to an external service;
- honest — everything drawn is wired. An inert tab or an unopenable menu is a fake surface that skews the verdict toward things that don't exist; out-of-scope UI is omitted entirely.

**Glance.** Reread the three files once and ask two questions: do they actually split in structure and primary action, or did two collapse into skins of each other? Is anything drawn but not wired? Fix the weak file directly by editing it — you drew it, the fix takes seconds.

**Gallery.** Assemble `gallery.html` (recipe below): three isolated frames, each labeled `A/B/C · 한 줄 해석`, with a header that states in one plain Korean sentence exactly where the three diverge. Present it with `SendUserFile(display: render)` and open the three sketch files as browser tabs in the same step (`open A.html B.html C.html`; Linux `xdg-open`; no GUI browser → send the files individually). The standard is a 30-second verdict: the user should see the split and be able to choose within half a minute of the gallery opening. If they can't, the sketches were over-scoped — that defect is yours, not theirs.

**Verdict.** With the artifacts on screen, ask one question via `AskUserQuestion`: "어느 해석이 의도에 가장 가깝나요?" → `A / B / C / 전부 아님`. Each option's description is an identity anchor in plain words — "상단 탭=타임라인, 주 버튼=+1 기록" — never a pitch. A pick (or a hybrid via free text, like "UI는 A인데 단위는 C" — take the named base as survivor and keep the quote) goes straight to hand-off. `전부 아님` gets one follow-up — "가장 어긋난 지점은?" → `다루는 대상 / 핵심 동작 / 목적 자체 / 빠진 기능` — and that answer steers round 2.

**Round 2 — only if the verdict asks for it.** Same run directory, overwrite A/B/C. The new round narrows: take the thing the mismatch answer pointed at and split *that*, at the same or lower fidelity. Rejection is never answered with a bigger or denser concept — that road leads away from the user, not toward them. Round 2's verdict ends the sprint whatever it is. A second `전부 아님` means the seed doesn't resolve in a five-minute split: write both rounds into `verdict.md`, say so plainly, and recommend an interview or spec pass. There is no round 3.

**Hand-off.** Write `.proto/<run>/verdict.md` — a few lines with the user's words kept verbatim, no derived-requirements essay:

```
# proto — <seed>
- axis: <갈림축>
- A: <한 줄> / B: <한 줄> / C: <한 줄>
- verdict: <A|B|C|전부 아님> — "<사용자 판정 원문>"
- direction: <본 빌드를 위한 방향 한 줄>
```

(Round 2 appends a second block.) Save the chosen sketch as `survivor.html` with this banner comment at the top, then delete the losing sketches and the gallery:

> 이 파일은 의도의 증거입니다. 본 빌드는 이 코드 위에 짓지 말고 처음부터 새로 지으세요 — verdict.md의 판정과 이 실물을 입력으로만 쓰세요.

The final message is two paths — `verdict.md`, `survivor.html` — and one sentence: the real build starts fresh from these two files; the sketch code is never extended.

## Gallery recipe

`gallery.html` must itself be self-contained (it renders in an isolated viewer that cannot fetch sibling files), so inline each sketch as a JS string and assign it to `iframe.srcdoc` at runtime — never paste raw HTML into a `srcdoc="…"` attribute, where escaping is fragile:

```html
<figure><figcaption>A · 한 줄 해석</figcaption>
  <iframe id="frame-A" sandbox="allow-scripts" title="해석 A"></iframe></figure>
<!-- …B, C… -->
<script>
  // each value = JSON.stringify(sketchHtml).replace(/</g, '\\u003c')
  const SKETCHES = { A: "…", B: "…", C: "…" };
  for (const k of ["A","B","C"])
    document.getElementById("frame-" + k).srcdoc = SKETCHES[k];
</script>
```

`sandbox="allow-scripts"` without `allow-same-origin` gives each sketch an opaque origin: its hotspots work, and nothing — CSS, JS, globals — leaks between frames or into the gallery.

## Substrate note

The seed's shape changes what a "sketch" is, nothing else: UI-shaped seeds → screen wireframes; CLI-shaped → mock terminal transcripts (command → output); pipeline/data-shaped → input→output correspondence tables. All three are still single self-contained HTML files, so the gallery and the verdict work identically.
