---
name: proto
description: Use when the user runs /proto:proto <fuzzy one-liner>, or asks to see several genuinely different working prototypes of one under-specified idea and pick from real screens instead of writing more requirements. Interpretation-divergent parallel prototyping — build 3 real prototypes that diverge in interpretation (not skin), show them side by side in one gallery, and let the user adjudicate on the artifacts. Do NOT trigger for "make me one app/page" requests where a single implementation is wanted.
argument-hint: "<흐릿한 한 줄 아이디어>"
---

# proto — interpretation-divergent parallel prototyping

Text specs under-determine intent: reading the same sentence, a human and an AI picture different screens, and the verdict "technically correct but useless" only ever comes out on a real artifact. When generation cost is ~0, building N real things and choosing between them is cheaper than an interview. So `proto` takes one fuzzy one-liner and, without asking the user a single question first, builds **three working prototypes that diverge in how they *interpret* the idea** — not three skins of the same interpretation. It shows them side by side, the user makes a multiple-choice verdict on the artifacts, and the code is thrown away while the verdict is kept.

This skill produces evidence of intent (a surviving prototype + a verdict ledger). It does **not** produce the real build. The real build is written fresh, using the ledger and the survivor as inputs.

## Invariants (MUST — never relax these)

1. **Zero questions before the first build (제1계율).** From `/proto:proto <one-liner>` to the first gallery, ask the user nothing — no clarifying question, no scope check, no confirmation. Classify, diverge, author data, build. Questions happen only in the adjudication step (7), and only after real artifacts are on screen.
2. **N = 3.** Exactly three candidates per round. Not two, not four.
3. **Four states in every candidate:** `bulk` (the first screen — never empty), `empty`, `error`, `loading`. States switch via an **in-frame toggle the candidate ships itself** (a small control that works inside the sandboxed iframe), never via anything in the parent gallery.
4. **Anti-skin gate.** Before presenting, the three candidates' *structure and interaction* must actually differ. Two candidates that are the same layout with different colors/copy (skin collapse) fail the gate.
5. **Ledger carries no prose.** The ledger records verdict bits and direction vectors only. Never create a free-text "requirements" slot in it.
6. **Survivor banner.** The one surviving prototype is preserved with a Korean banner comment at the top of the file forbidding building on top of it.
7. **Interpretation-divergence, not style-divergence.** The user *adjudicates*, never generates. In any user-facing string, the word **"브레인스토밍" is banned** — this is interpretation divergence and multiple-choice judgment, not idea generation.

All other "how" (axis scoring detail, exact mock-data shapes, per-substrate state semantics, the builder brief) is execution-session discretion. See `references/substrates.md`.

---

## Step 0 — Input

Invocation: `/proto:proto <fuzzy one-liner>`. Take the one-liner as the seed. Do not ask anything back (Invariant 1). If the argument is empty, take the seed from the user's most recent request in the conversation; only if there is truly nothing to work from, ask once for the one-liner in plain text — that single case is the sole exception, and it is not a design question, just "what's the one line?".

## Step 1 — Substrate classification (main session, autonomous)

Classify the seed into one substrate. Do not ask the user.

- **UI-shaped** → each candidate = a self-contained interactive HTML app.
- **CLI-shaped** → each candidate = a self-contained HTML that renders a mock terminal transcript (command → output sequence; static or lightly interactive).
- **pipeline / data-shaped** → each candidate = a self-contained HTML rendering an input→output correspondence table / diff.

Every substrate converges to a single self-contained HTML per candidate, so the gallery mechanism (Step 6) is identical regardless. Per-substrate requirements and how the four states manifest are in `references/substrates.md`.

## Step 2 — Fix the divergence axis (main session, autonomous)

Pick the one axis on which interpretations of *this* seed genuinely split. Score each axis in the catalog by "does interpretation actually diverge here?" and take the single highest-leverage axis:

- **telos** — what is this tool *for*?
- **posture** — the user's stance: recording / exploring / automating / …
- **granularity** — the size of the unit being handled.
- **time** — the temporal frame: real-time / retrospective / planning.
- **agency** — who drives: the user or the system.

If no catalog axis is strong for this seed, **mint** a bespoke axis from the seed itself. Record the chosen axis; it becomes the ledger's per-round label. The three candidates are three points along this one axis.

## Step 3 — Author the canonical shared dataset (main session)

Author **one** set of mock data that all three candidates share. Plant the edges *in the data* so states are provoked, not faked:

- an **empty stretch** (provokes the empty state),
- a **broken record** (provokes the error state),
- a **flood stretch** (bulk — the first screen opens on the flood).

Data must have real shape: long names, realistic distributions, plausible values — never `foo`/`bar`. Each interpretation projects the fields it needs for its own telos from these shared rows; the rows are identical across candidates. Shape guidance per substrate is in `references/substrates.md`.

## Step 4 — Parallel generation (N = 3, one message)

Spawn **three builders in a single message** (parallel) via the Agent tool. Each builder brief MUST contain, in full:

- the **entire shared dataset** (verbatim, so all three project from identical rows),
- **this candidate's interpretation**, stated as a definition *and* explicitly how it differs from the other two,
- the **four-state requirement** with the self-shipped **in-frame toggle** (bulk first screen / empty / error / loading),
- the **self-contained requirement**: zero external requests, a single HTML file, all CSS/JS inline,
- the **exact absolute output path** to write to (`.proto/<run>/round-<n>/<A|B|C>.html`).

The builder brief template lives in `references/substrates.md` — use it.

**While building, do not show an empty spinner.** Show the user a Korean subtitle naming the three interpretations being built right now, plus an honest ETA in minutes. For example:

> 지금 3개 해석을 실물로 만드는 중입니다 (약 2~4분):
> A) …한 줄 해석…
> B) …한 줄 해석…
> C) …한 줄 해석…

## Step 5 — Verification gate (main session reads the sources)

Read all three HTML files from disk and confirm:

1. the four-state markup and the in-frame toggle **actually exist** in each,
2. required facets are not blank (no placeholder-only screens),
3. **the three candidates genuinely diverge in structure/interaction** — run the anti-skin check (Invariant 4).

If two candidates are the same structure with only a skin difference, **re-spawn that one builder once** with a reinforced brief (name the collapse, specify the structural difference required). If it still collapses after the re-spawn, **fall back to a different axis** and tell the user this happened, in Korean, in one line (e.g. "축 'X'에서 해석이 갈리지 않아 축 'Y'로 바꿨습니다"). Do not present a collapsed gallery.

## Step 6 — Present the gallery

Assemble a single `gallery.html` that embeds the three candidates as isolated frames:

```html
<iframe sandbox="allow-scripts" title="해석 A"></iframe>
```

- Isolate each candidate in `<iframe sandbox="allow-scripts">` so global CSS/JS cannot collide across candidates.
- **srcdoc injection is done via JS string injection, NOT HTML-attribute escaping.** Leave the `srcdoc` attribute empty in markup and assign the candidate HTML to `iframe.srcdoc` from a script, embedding each candidate as a JS/JSON string with `<` escaped to `\u003c`. Do not paste raw candidate HTML into a `srcdoc="…"` attribute. The exact recipe is in `references/substrates.md`.
- Above each frame, an interpretation label: **A / B / C + the one-line interpretation**.
- Gallery header (Korean), instructing the user to exercise the states before judging, e.g.:

  > 판정 전에 각 후보의 empty / error 토글을 한 번씩 눌러보세요. 이 셋은 스타일이 아니라 해석이 다릅니다.

Present `gallery.html` with `SendUserFile(display: render)`.

## Step 7 — Adjudication (AskUserQuestion, only right after presenting artifacts)

Call `AskUserQuestion` — never before real artifacts are on screen.

- **Q1 (always):** "어느 해석이 의도에 가장 가깝나요?" → options `A / B / C / 전부 아님`. Each option's description is a **real-artifact identity anchor** (e.g. "상단 탭=타임라인, 주 버튼=+1 기록"), never a persuasion pitch for that option.
- **Derived question, only when "전부 아님" is chosen:** "가장 어긋난 지점은?" → `다루는 대상 / 핵심 동작 / 목적 자체 / 빠진 기능`. Feed the answer into an axis adjustment and run a **steered re-divergence** as the next round.
- **In later rounds (round ≥ 2), add a second question:** `이 해석으로 확정 / 한 번 더 세부를 갈라보기`.
- Free text is always available via "Other" but never required.

## Step 8 — Accumulate the ledger

Append to `.proto/<YYYYMMDD-HHmmss>-<slug>/ledger.md` (slug = timestamp prefix + sanitized seed; Korean seeds are allowed). One block per round, **verdict bits and direction only — no prose requirements slot (Invariant 5)**. Each block MUST carry the real-artifact anchor (which gallery file, which candidate). Format:

```
## Round <n> — <axis>
- gallery: .proto/<run>/round-<n>/gallery.html
- A · <one-line interpretation> · anchor: round-<n>/A.html
- B · <one-line interpretation> · anchor: round-<n>/B.html
- C · <one-line interpretation> · anchor: round-<n>/C.html
- verdict: <A|B|C|전부 아님>   [round ≥ 2: + 확정 | 한 번 더]
- mismatch: <다루는 대상|핵심 동작|목적 자체|빠진 기능|—>
- next: <direction vector for the next round, or — if terminating>
```

## Step 9 — Termination and hand-off

Rounds are capped at **3**. Propose termination once the verdict is stable (a 확정 selection) and no new discovery is surfacing. On termination:

1. Preserve the surviving prototype's HTML as `.proto/<run>/survivor.html`, inserting this Korean banner comment at the very top of the file:

   > 이 파일은 의도의 증거입니다. 본 빌드는 이 코드 위에 짓지 말고 처음부터 새로 지으세요 — ledger.md의 판정과 이 실물을 입력으로만 쓰세요.

2. Delete the other candidates and the gallery file(s); keep only `ledger.md` and `survivor.html`.
3. In the final message, give the user the **ledger path and the survivor path**, and state that when moving to the real build, these two files are the inputs — not code to extend.
