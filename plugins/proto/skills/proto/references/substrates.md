# substrates — per-substrate candidate requirements, mock data, gallery assembly, builder brief

Everything here is the "how" behind SKILL.md. All three substrates converge to **one self-contained HTML per candidate**, so the gallery mechanism is identical; only the inside of a candidate differs. The four states (`bulk` first / `empty` / `error` / `loading`) and the self-shipped in-frame toggle are mandatory in every substrate.

---

## The four-state contract (applies to every substrate)

Each candidate ships its own control to switch states — a small toolbar or segmented control rendered inside the sandboxed iframe. `bulk` is the opening screen; the user should never land on an empty screen.

| state | what it must show |
|---|---|
| `bulk` | the flood stretch of the shared data, rendered as this interpretation sees it — dense, realistic, the default first screen |
| `empty` | the interpretation's genuine zero state (not a blanked-out bulk screen — the real "nothing yet" affordance) |
| `error` | the broken record surfaced as this interpretation would handle a bad/corrupt row |
| `loading` | this interpretation's in-flight state (skeleton / spinner-with-context / progressive fill), reached and left by the toggle |

The toggle must actually move between all four; the verification gate reads the source to confirm the markup and handlers exist.

Staged-mode detail rounds (SKILL Step 1.5) are the one exception: only the states the focused aspect actually touches are required — always including `bulk` — and the gate checks exactly that reduced set. The in-frame toggle requirement never relaxes.

---

## UI-shaped

Each candidate = a self-contained interactive HTML app.

- Divergence shows up as **different primary structure and primary action**: what the top-level navigation is, what the main button does, what the unit on screen is. Two UI candidates that share a layout and differ only in palette/copy are a skin collapse (gate fail).
- `bulk`: the main surface populated from the flood rows. `empty`: the app's real first-run/zero state. `error`: how this app renders the broken row (inline flag, quarantine, silent skip made visible). `loading`: skeleton or progressive population.
- Interactions must be real within the frame (clicks change state), but no persistence and no network.

## CLI-shaped

Each candidate = a self-contained HTML rendering a mock terminal transcript (command → output sequence), static or lightly interactive.

- Divergence shows up as **a different command surface and mental model**: subcommand shape, what one invocation does, whether it is one-shot or a REPL, what the output granularity is.
- `bulk`: a transcript over the flood rows (many results, pagination or `--limit` shown). `empty`: a command that returns nothing, and how that is signaled (exit code, empty-set message). `error`: a command hitting the broken record (stderr, non-zero exit, diagnostic). `loading`: an in-progress long command (progress line / streaming output), toggled.
- Render as a styled terminal; "light interaction" can be stepping through the transcript or a fake prompt that replays canned commands.

## pipeline / data-shaped

Each candidate = a self-contained HTML rendering an input→output correspondence table / diff.

- Divergence shows up as **a different transform contract**: what counts as a row, what the output columns are, what the diff is *of*, what gets aggregated vs. passed through.
- `bulk`: the full input→output table over the flood rows. `empty`: input present but output empty (all filtered) or input empty — and how the table communicates it. `error`: the broken input row and its output-side handling (rejected row, error column, partial output). `loading`: the transform mid-run (rows streaming in / progress), toggled.
- Show the correspondence explicitly (side-by-side or before/after diff), not just a result table.

---

## Probe sizing (staged mode)

A candidate must be judgeable in ~30 seconds (the 30초 판정 standard, SKILL Invariant 8), so size it like a probe, not a product:

- **Skeleton round (round 1):** one screen — the primary structure, the primary action, the four states. No secondary panels, no bonus features; anything not needed to judge the skeleton is scope creep.
- **Detail round (round ≥ 2):** the inherited base, visually unchanged outside the focused aspect, plus exactly the aspect's variation. A viewer flipping between A/B/C should see the SAME app except at the aspect. The builder edits the pre-copied output file in place — it does not regenerate the app.
- **Pace budget:** a probe judged in 30 seconds does not deserve a 15-minute QA pipeline. Two rules: ① **copy-then-edit** — the main session pre-copies the base to each candidate's output path (banner stripped) before spawning; the builder modifies that file with targeted Edits only and never re-emits it whole (re-emitting a ~70KB file is ~25k output tokens ≈ most of a 9-minute round; targeted edits are ~10× cheaper). ② self-verification capped at one render/syntax pass — no test harnesses, no headless-browser suites. Target wall-clock per staged round is a few minutes; if the honest ETA exceeds ~5 minutes, the round is over-scoped — narrow it.

---

## Canonical shared dataset

Author once, shared by all three builders verbatim. Requirements:

- **Real shape:** long realistic names, plausible values and distributions, believable timestamps. Never `foo`/`bar`/`item 1`.
- **Planted edges (mandatory):**
  - an **empty stretch** — a segment/period/category with no rows, so the empty state is reachable from real data;
  - at least one **broken record** — malformed, missing a required field, or internally contradictory, so the error state is provoked by data;
  - a **flood stretch** — a dense burst so `bulk` (the first screen) opens on real volume.
- Enough rows that pagination/aggregation choices actually matter (dozens, not three).
- The dataset is neutral to interpretation: it carries more fields than any one interpretation uses, and each candidate **projects** the subset its telos needs. The rows are identical across A/B/C.

Persist the dataset at `.proto/<run>/round-<n>/dataset.json` and paste it in full into every builder brief.

---

## Gallery assembly — srcdoc via JS string injection

`gallery.html` must itself be self-contained (it is presented with `SendUserFile(display: render)` in an isolated viewer, so it cannot fetch sibling files). Inline each candidate's full HTML as a JS string and assign it to `iframe.srcdoc` at runtime. Do **not** put raw HTML into a `srcdoc="…"` attribute — attribute escaping is fragile.

Robust recipe:

```html
<figure>
  <figcaption>A · <!-- one-line interpretation --></figcaption>
  <iframe id="frame-A" sandbox="allow-scripts" title="해석 A"></iframe>
</figure>
<!-- …B, C… -->
<script>
  // Each value is JSON.stringify(candidateHtml).replace(/</g, '\\u003c')
  // The `<` → `\u003c` escape guarantees no `</script>` inside the candidate
  // can terminate this block; JSON handles quotes/newlines/backslashes.
  const CANDIDATES = {
    A: "…escaped JS string of A.html…",
    B: "…escaped JS string of B.html…",
    C: "…escaped JS string of C.html…"
  };
  for (const k of ["A", "B", "C"]) {
    document.getElementById("frame-" + k).srcdoc = CANDIDATES[k];
  }
</script>
```

- `sandbox="allow-scripts"` (without `allow-same-origin`) puts each candidate in a unique opaque origin: its scripts run (needed for the state toggle) but cannot reach the parent gallery. This is what isolates global CSS/JS across candidates.
- Header text above the frames is the Korean instruction to exercise `empty`/`error` before judging (see SKILL Step 6).
- Frames should be tall enough to use without inner scroll where possible; a responsive grid (or stacked on narrow viewports) keeps all three comparable.

---

## Builder brief template

Fill every slot; spawn all three in one message. `<X>` = A | B | C.

```
You are building ONE prototype (candidate <X>) for an interpretation-divergence
gallery. Two sibling builders are building the other two interpretations in
parallel from the SAME data. Your job is to make YOUR interpretation unmistakably
different in STRUCTURE and INTERACTION — not in color or copy.

Substrate: <UI-shaped | CLI-shaped | pipeline/data-shaped>

Your interpretation (candidate <X>):
  <definition of this interpretation>
How it MUST differ from the other two:
  - vs <other 1>: <structural/interaction difference>
  - vs <other 2>: <structural/interaction difference>
The divergence axis for this round: <axis> — you are the "<this point>" point on it.

[Staged mode, round ≥ 2 only — inheritance base]
Base artifact (the previous round's survivor): <absolute path>
Read it FIRST and carry it forward WHOLE — same skeleton, same frozen
decisions. Change ONLY this round's focused aspect: <aspect>. Any difference
outside the aspect is a defect the verification gate rejects.

Shared canonical dataset (verbatim — project only the fields your telos needs;
do NOT invent extra rows, the rows are identical across all three candidates):
  <full dataset.json>

Requirements (all mandatory):
  - Single self-contained HTML file. ALL CSS and JS inline. ZERO external
    requests (no CDN, no fonts, no fetch/XHR, no images by URL). It must render
    with no network.
  - Four states, switchable by an in-frame toggle YOU build into this file
    (a small control that works inside a sandboxed iframe, sandbox="allow-scripts",
    with NO same-origin access to any parent):
      * bulk    — opening screen, the flood stretch of the shared data
      * empty   — the genuine zero state for this interpretation
      * error   — the broken record handled as this interpretation would
      * loading — this interpretation's in-flight state
    bulk is the default first screen. The toggle must move between all four.
  - Real shape: long realistic names, believable values. No foo/bar.
  - No persistence, no network, no build step.

Write the finished file to exactly:
  .proto/<run>/round-<n>/<X>.html

Return a 3-4 line summary: your interpretation in one line, the primary
structure, the primary action/transform, and confirmation that all four states
and the in-frame toggle are wired.
```
