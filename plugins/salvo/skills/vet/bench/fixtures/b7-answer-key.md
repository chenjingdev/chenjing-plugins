# B7 (notesearch 버그 사냥) 정답 키 — 동결 2026-07-07

픽스처: /Users/chenjing/dev/tmp-b7-notesearch (432 LOC, 7모듈, 노트 10개).
저자 스팟 체크 7/12 + worker 전수 재현 로그로 검증. Node v24.7.0.

| # | 분류 | 파일:라인 | 증상 | 재현 |
|---|---|---|---|---|
| 1 | 경로/서브디렉터리 | indexer.js:21(가드)+:38(상대 root) | 상대 root vs 절대 abs의 indexOf 가드가 서브디렉터리 재귀를 항상 차단 → 하위 노트 무음 미인덱싱 | `search quarterly-okrs` → 0건 (projects/roadmap.md에 존재) |
| 2 | off-by-one | search.js:43 | `slice(start, start+size-1)` → 페이지당 1개 부족 | `search notes` → 헤더 5건, 출력 4행 |
| 3 | 유니코드 | utils.js:13 (+search.js:20) | `/^[\x00-\x7F]+$/` 필터가 비ASCII 질의어 폐기 → 한글 검색 0건 | `search 회의` → 0건 (meeting-2025-01.md에 존재) |
| 4 | 오류 삼킴 | parser.js:48(catch→null)+indexer.js:47 | 깨진 frontmatter 노트를 경고 없이 인덱스 제외 | `search Draft` → 0건; index가 7파일 중 6개 보고, 경고 0 |
| 5 | 캐시 무효화 | cache.js:30 | 키가 basename만 — mtime 미반영, 수정 후에도 stale | node -e 캐시 set→파일수정→get → OLD 반환 |
| 6 | 설정 우선순위 | config.js:51 (:50 뒤에 적용) | Object.assign 순서로 config가 CLI 플래그 덮어씀 | `--page-size 20`도 `--page-size 1`도 4행 |
| 7 | 순회 중 변형 | utils.js:33 | forEach 안 splice → 인접 중복 생존 | `search "alpha beta gamma"` → Random Ideas 2회 출력 |
| 8 | 경계 | parser.js:56 | 빈 파일에서 lines[0] undefined → TypeError 크래시 | parseNote('') → TypeError |
| 9 | 정규식 이스케이프 | search.js:26 (utils.js:17 escapeRegExp 미사용) | 질의어 무이스케이프 RegExp: "(" 크래시, "." 오매칭 | `search "test("` → SyntaxError; `search "te.t"` → Todo 오매칭 |
| 10 | 비교자 | search.js:33 | sort가 boolean 반환 → 점수순 정렬 안 됨 | `search meeting` → score 4가 score 1 아래 |
| 11 | 모듈 간 불일치 | utils.js:24→indexer.js:33 vs search.js:6 | normalizeTag이 # 미제거(주석·README 약속 위반) → 인덱스 키 `#todo` vs 조회 키 `todo` → 태그 검색 항상 0건 | `search tag:todo` → 0건 |
| 12 | 직렬화 | cache.js:44 | JSON.stringify(Map) → 항상 "{}" — 파스 캐시 무음 사망 | index 후 .cache/notes.cache.json == {} |

채점: b7-protocol.md의 규칙 준용 (메커니즘 일치 기준, 부분 인정 없음,
합집합 순서 a→b→c 고정, 키 밖 발견은 저자 실측로 보너스/오탐 분류).
