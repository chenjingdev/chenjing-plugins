# 작업 3 보고 — spec.mjs html

커밋: 817d21a (worktree `/Users/chenjing/dev/chenjing-plugins/.pact/2026-11-01-기억으로-명세-채우기/wt`, push 안 함)

## 바꾼 파일
- plugins/pact/scripts/spec-html.mjs (새) — `renderSpecHtml(text, { title })`. parseSpec로 칸을 나누고, 줄은 splitTrailing·tagParts로 읽는다(새 태그 정규식 없음). 새로 읽는 것은 태그 콜론 뒤 출처(`SOURCE`)뿐.
- plugins/pact/scripts/spec.mjs — `html` 분기와 USAGE 한 줄. splitTrailing·tagParts·ITEM_HEAD·ITEM_SECTIONS에 `export`만 붙임(동작 변경 없음). spec-html은 `await import`로 불러 순환 import를 피함(approval.mjs와 같은 꼴).
- plugins/pact/scripts/paths.mjs — PACT_GITIGNORE에 `# 명세에서 다시 만드는 파일` + `*/spec.html`(`*/scratch/` 다음), `ensureIgnoreLine(root, line)`, 머리 주석 한 줄.
- plugins/pact/tests/spec-html.test.mjs (새) — 16개.

## 확인
- `node --test tests/spec-html.test.mjs tests/spec.test.mjs tests/paths.test.mjs` → 55개 통과, 실패 0
- `node --test tests/` → 542개 통과, 실패 0 (작업 전 526)
- 변이 확인: 다른 저장소 칩을 만드는 `other = true`를 `false`로 바꾸자 새 테스트 2개 실패 → 복원.
- 메인 트리의 run-dir에는 spec.html이 생기지 않았다(`ls $R/*.html` 없음). 명세는 scratch 복사본으로 돌림.
- 임시 프로젝트 `<scratch>/html-try/.pact/2026-11-01-기억으로-명세-채우기/spec.md`에 `spec.mjs html` → 종료 코드 0, 경로 한 줄 출력, 같은 폴더에 spec.html, `.pact/.gitignore`에 `*/spec.html`.

## 만든 HTML 처음 40줄 (이 명세에는 다른 저장소 줄이 없어 요약 상자 목록은 비어 있음. 다른 저장소 줄은 테스트가 덮음)
```html
<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>기억으로 명세 채우기 — 명세</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 720px; margin: 24px auto; padding: 0 16px; color: #222; background: #fff; }
  h1 { font-size: 22px; margin: 0; }
  h2 { font-size: 16px; margin: 24px 0 4px; }
  h3 { font-size: 14px; margin: 12px 0 2px; }
  .meta { color: #666; font-size: 13px; margin: 2px 0 16px; }
  .summary { border: 1px solid #ddd; background: #f7f7f7; border-radius: 6px; padding: 8px 14px 10px; }
  .summary p { margin: 4px 0; font-weight: 600; }
  .none { color: #888; }
  p { margin: 4px 0; }
  ul { margin: 2px 0; padding-left: 22px; }
  li { padding: 2px 0; }
  li.other { border-left: 3px solid #e8820c; padding-left: 8px; }
  ul.sub { font-size: 13px; color: #555; }
  code { background: #f1f1f1; border-radius: 3px; padding: 0 4px; font-size: 13px; }
  details { margin: 8px 0; }
  summary { cursor: pointer; color: #555; }
  .chip { display: inline-block; font-size: 12px; line-height: 1.5; padding: 0 7px; margin-left: 5px; border-radius: 10px; white-space: nowrap; }
  .user { background: #dbeafe; color: #1e40af; }
  .ai { background: #eee; color: #555; }
  .risk { background: #fde2e2; color: #b42318; }
  .rec { border: 1px solid #e8820c; color: #a15c00; }
  .repo { background: #e8820c; color: #fff; }
  .note { background: #f1f1f1; color: #666; font-size: 11px; }
</style></head><body>
<h1>기억으로 명세 채우기</h1>
<p class="meta">status: building · created: 2026-11-01</p>
<div class="summary">
<p>[사용자] 11개 · [AI 가정] 5개 · 기록에서 온 줄 1개(다른 저장소 0개) · 위험 0개</p>
</div>
<h2>목적</h2>
<p>기억 서버(Honcho)의 대화와 이 기계의 pact 기록이 쌓여 있는데 probe가 읽지 않아 같은 실패를 되풀이하고 아이디어를 다시 떠올린다. 기억 뒤지기는 따로 뗀 스킬이 하고, pact는 받은 문서 안에서 명세를 쓴다.</p>
<h2>범위</h2>
<p>새 플러그인 recall(스킬·스크립트·테스트)과 pact의 probe·spec-checker·verifier 연결, 명세 HTML 보기. 명세를 쓰는 프로젝트급 일에 적용한다.</p>
<h2>하지 않는 것</h2>
<ul><li>팀원 기억(team-memory)은 뒤지지 않는다 [사용자]. 가벼운 길(작은 변경)에서는 기록을 읽지 않고, 기억 서버의 대화·결론은 지우거나 고치지 않는다</li><li>다음 판 후보: 팀원 기억, 판이 끝날 때 기억에 따로 적기, 쓸데없는 예외 처리·주석을 지우는 코드 위생 스킬</li></ul>
<h2>기능</h2>
```

## 정한 것
- Ruling: 요약 상자 개수는 하위 구분 없이 "칩이 달린 목록 줄"(항목 줄 + 케이스 줄 + 하지 않는 것의 줄 끝 태그 줄)을 센다 — 지시가 "줄"로 적었고 케이스 줄의 `[사용자: 검수 1]`도 사용자가 정한 것이라서 — 틀리면 [사용자] n개가 F·R·A 항목 수와 달라 보인다
- Ruling: 태그 콜론 뒤가 날짜로 시작하지 않으면(`검수 1`, `검수 2 맡김`) 그 글 그대로 작은 회색 칩 하나로 보인다 — 지시가 "검수 n은 작은 회색 칩, 맡김도 그대로"라서 번호·맡김을 따로 쪼개지 않음 — 틀리면 `검수 1, 3` 같은 꼴도 한 칩에 통째로 나올 뿐 잃는 것은 없음
- Ruling: 날짜 앞에 `기록 `이 와도(`[AI 가정: 기록 10/11]`) 없어도(`[사용자: 10/18]`) 같은 날짜로 읽는다 — R2의 두 꼴이 이렇다 — 틀리면 AI 가정 줄의 기록 칩이 빠진다
- Ruling: `<details>`는 줄 맨 앞에서 시작할 때만 접힌 블록으로 읽는다(`openSize`는 줄 어디서든 읽음) — 글 속 `<details>` 낱말(백틱 안)이 블록으로 오인되지 않게 — 틀리면 줄 가운데 `<details>`로 연 블록이 접히지 않고 글로 보인다
- Ruling: `.pact/.gitignore`가 없으면 `ensureIgnoreLine`은 그 줄만 든 파일을 만든다 — `html`은 `specRunDir`가 먼저 파일을 쓰므로 실제로는 안 닿는 길이고 함수가 혼자서도 안전하게 — 틀리면 잃을 것 없음

## 걱정·위험
- 기존 명세의 `[사용자: 10/8 회의]`처럼 날짜 뒤에 출처 낱말을 붙인 꼴(spec.mjs 주석에 예가 있음)은 새 규칙대로 "다른 저장소 회의"로 보인다. 이 컴퓨터의 명세 중에는 그런 줄이 없었지만(.pact/*/spec.md 태그 전수 확인) 쓰는 쪽이 이 구분을 알아야 한다.
- 하지 않는 것 칸의 줄에서 태그가 문장 가운데 있으면(예: "…뒤지지 않는다 [사용자]. 가벼운 길…") 칩이 아니라 글로 남는다. spec.mjs의 lint·parse가 줄 끝 태그만 읽는 규칙과 같다.
- 요약 상자의 [사용자] 개수는 위 Ruling대로 줄 단위라서 lint 항목 수와 다를 수 있다.
- 칩은 글 뒤에 간격 없이 붙고(CSS margin) 복사하면 `…한다사용자`처럼 붙어 나온다.
- 화면으로 열어 본 확인은 하지 않았다(HTML 문자열 검사와 명령 실행만).
