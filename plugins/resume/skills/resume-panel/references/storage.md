# Storage — Schema, Timing, and Methods

Read this file when initializing `resume-source.json`, saving an episode, or updating a STAR field (contradiction restoration, So What chain synthesis).

## resume-source.json Schema

```json
{
  "meta": {
    "target_company": "",
    "target_position": "",
    "jd_summary": "",
    "created_at": "",
    "updated_at": ""
  },
  "profile": {
    "name": "",
    "age": 0,
    "years_of_experience": 0,
    "companies": []
  },
  "companies": [
    {
      "name": "",
      "research": {
        "mau": "",
        "tech_stack": [],
        "team_size": "",
        "notes": ""
      },
      "projects": [
        {
          "name": "",
          "period": "",
          "role": "",
          "tech_stack": [],
          "episodes": [
            {
              "type": "성과|문제해결|리더십|협업|학습|기타",
              "title": "",
              "situation": "",
              "task": "",
              "action": "",
              "result": ""
            }
          ]
        }
      ]
    }
  ],
  "gap_analysis": {
    "met": [],
    "gaps": [
      {
        "requirement": "",
        "verdict": "",
        "market_standard": "",
        "suggestion": ""
      }
    ]
  }
}
```

## Save Timing

| Timing | Content |
|------|------|
| End of Round 0 | Initial `resume-source.json` (skeleton: meta + profile + companies) |
| On episode capture | Append to the owning company/project |
| End of Round 2 | Add `gap_analysis` |
| End of Round 3 | Final save + generate `resume-draft.md` |

## Save Method

Use the Bash tool with a `cat` heredoc (instead of the Write tool, for token efficiency):

```bash
cat <<'EOF' > ./resume-source.json
{ ... 전체 JSON ... }
EOF
```

## Initial State Directory Setup

Right after `resume-source.json` is first created (end of Round 0), initialize `.resume-panel/`:

```bash
mkdir -p .resume-panel
cat <<'EOF' > .resume-panel/meta.json
{
  "last_profiler_call": null,
  "last_profiler_episode_count": 0,
  "current_company": null,
  "total_profiler_calls": 0,
  "gap_probes_this_session": 0,
  "perspective_shifts_this_session": 0,
  "perspective_shifted_episodes": [],
  "contradictions_presented_this_session": 0
}
EOF
```

`snapshot.json` is auto-created on first run by the episode-watcher hook, so manual initialization is not needed.

## resume-draft.md Structure (End of Round 3)

```markdown
# {이름} — {타겟 포지션}

## 프로필
{경력 요약 — MAU, 기술스택, 핵심 강점}

## 경력

### {회사} ({기간})
**{프로젝트}** | {역할}
- {에피소드 기반 성과 bullet}
- {에피소드 기반 성과 bullet}

## ⚠️ 갭 분석 (타겟: {회사} {포지션})

### 충족
- {요구사항}: ✓

### 부족 — 이 레벨에 기대되는 경험
- {요구사항}: {시장 기준선}

### 추천 액션
- {구체적 제안}
```
