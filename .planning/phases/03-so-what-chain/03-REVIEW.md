---
phase: 03-so-what-chain
reviewed: 2026-04-07T12:00:00Z
depth: standard
files_reviewed: 4
files_reviewed_list:
  - plugins/resume/.claude/agents/c-level.md
  - plugins/resume/scripts/episode-watcher.mjs
  - plugins/resume/scripts/test-episode-watcher.mjs
  - plugins/resume/skills/resume-panel/SKILL.md
findings:
  critical: 0
  warning: 3
  info: 2
  total: 5
status: issues_found
---

# Phase 03: Code Review Report

**Reviewed:** 2026-04-07T12:00:00Z
**Depth:** standard
**Files Reviewed:** 4
**Status:** issues_found

## Summary

Reviewed the So What chain implementation across the C-Level agent prompt, episode-watcher hook script, its test suite, and the SKILL.md orchestrator definition. The agent prompt (c-level.md) and SKILL.md are well-structured with clear rules for So What chain levels and orchestration.

The primary concerns are in `episode-watcher.mjs`: the flat-counter pattern for identifying "new" episodes is fragile and can misidentify episodes when the project list is reordered or episodes are inserted mid-list. There is also a potential race condition in the findings-inbox processing path, and a schema inconsistency in the So What trigger fallback.

## Warnings

### WR-01: Flat counter for "new episode" detection is order-dependent

**File:** `plugins/resume/scripts/episode-watcher.mjs:106-112, 217-222`
**Issue:** Both `detectMinimization` and the So What chain trigger use a flat `checked` counter across all projects to skip "already seen" episodes (`if (checked <= prevCount) continue`). This assumes episodes are only ever appended at the end, in the same project order. If a user adds a new project between existing projects, or if episodes within a project are reordered, the counter will skip wrong episodes or flag the wrong ones as "new." For example, if a new project with 2 episodes is inserted before an existing project, the counter will consider 2 episodes from the existing project as "new" and miss the actual new episodes entirely.

**Fix:** Instead of a flat counter, use episode identity (e.g., title or a generated ID) to track which episodes have been seen. Alternatively, track per-project episode counts in the snapshot:

```javascript
// In snapshot, store per-project counts:
// { project_episodes: { "프로젝트A": 3, "프로젝트B": 2 }, ... }

// Then in detection:
const prevProjectEpisodes = snapshot.project_episodes || {};
for (const project of source.projects || []) {
  const prevCount = prevProjectEpisodes[project.name] || 0;
  let idx = 0;
  for (const ep of project.episodes || []) {
    idx++;
    if (idx <= prevCount) continue; // skip already-seen in THIS project
    // ... check new episode
  }
}
```

### WR-02: Race condition in findings-inbox processing

**File:** `plugins/resume/scripts/episode-watcher.mjs:256-304`
**Issue:** The inbox processing uses `renameSync` to atomically move `findings-inbox.jsonl` to `findings-inbox.processing.jsonl`, then reads and deletes the processing file. If two hook invocations overlap (e.g., two rapid tool uses), the second invocation's `renameSync` will fail (caught by empty catch on line 258-260), but it could also encounter a state where `processingPath` exists from the first invocation. The second invocation would then read and process the same findings that the first invocation is also processing, potentially causing duplicate entries in `findings.json`. The `existsSync(processingPath)` check on line 263 does not prevent this because both invocations can reach it before either calls `unlinkSync`.

**Fix:** Use a lock file or add deduplication by checking finding IDs before appending to `findings.json`:

```javascript
// Deduplicate by ID before appending
const existingIds = new Set(existing.findings.map(f => f.id));
for (const f of newFindings) {
  if (existingIds.has(f.id)) continue; // skip duplicates
  f.delivered = false;
  // ... routing logic
  existing.findings.push(f);
}
```

### WR-03: So What trigger uses non-schema fallback field

**File:** `plugins/resume/scripts/episode-watcher.mjs:223`
**Issue:** The So What trigger reads `ep.star?.result || ep.result || ""` but the resume-source.json schema (defined in SKILL.md lines 516-521) only defines `result` inside the `star` object -- there is no top-level `ep.result` field. This fallback will always evaluate to `""` for schema-conforming data, making it dead code. More importantly, if an episode is saved with `ep.result` instead of `ep.star.result` due to a bug elsewhere, this fallback would silently mask the schema violation by still detecting it as valid data.

**Fix:** Remove the fallback and only use the canonical path. Add a comment explaining the expected schema:

```javascript
// Schema: episode.star.result is the canonical location
if (!hasQuantifiedImpact(ep.star?.result || "")) {
  messages.push(
    `[resume-panel:SO-WHAT] 에피소드 "${ep.title || "(제목 없음)"}" 임팩트 부족`
  );
  break;
}
```

## Info

### IN-01: Stale comment in test file

**File:** `plugins/resume/scripts/test-episode-watcher.mjs:697-698`
**Issue:** Comment says "The function doesn't exist yet in episode-watcher.mjs, so we define the expected logic here to validate the regex pattern. Task 2 will implement it in the actual file." However, `hasQuantifiedImpact` is already implemented at line 124 of episode-watcher.mjs. The comment is outdated and misleading.

**Fix:** Update the comment to reflect reality:

```javascript
// hasQuantifiedImpact unit tests
// Validates the regex pattern used in episode-watcher.mjs (line 124)
```

### IN-02: Multiple empty catch blocks silently swallow errors

**File:** `plugins/resume/scripts/episode-watcher.mjs:17-19, 63-65, 258-260, 303`
**Issue:** Four empty catch blocks exist in the file. While the stdin catch (line 17-19) and JSON parse catch (line 63-65) have legitimate reasons to silently exit or return null, the findings-related catches (lines 258-260, 303) could mask file system errors that indicate real problems (disk full, permissions, etc.).

**Fix:** Add minimal logging to the catch blocks that handle file operations, even if just to stderr (which won't interfere with the JSON stdout protocol):

```javascript
try { renameSync(inboxPath, processingPath); } catch (e) {
  // rename failure is expected if file was already consumed
  process.stderr.write(`[episode-watcher] inbox rename skipped: ${e.code}\n`);
}
```

---

_Reviewed: 2026-04-07T12:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
