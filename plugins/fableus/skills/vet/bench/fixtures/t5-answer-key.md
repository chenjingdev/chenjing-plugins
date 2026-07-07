# T5 (tagsync 고착 진단) 정답 키 — 동결 2026-07-07

**증상 프롬프트**: "alpha 노트에 #kickoff 태그를 달았는데 tags.json 인덱스에 안 나온다."
**픽스처**: /Users/chenjing/dev/tmp-t5-tagsync (상태 A 동결, 팔마다 사본 지급)

## 정답 (근본 원인 — 이걸 지목해야 통과)
- `src/walk.js:6` `VALID_NOTE = /^[\w-]+\.md$/` 를 `src/walk.js:17`에서 recursive readdir의 **전체 상대 경로**에 적용 → `projects/alpha.md`는 `/` 포함으로 탈락. 서브디렉터리 노트 전원 무음 배제. README의 "recursive" 약속 위반.
- 올바른 수정: basename에만 검증 적용 (예: `VALID_NOTE.test(path.basename(entry))`).
- 검증 술어: 이 수정만으로 `kickoff`·`q3-plan`이 tags.json에 나타남 (worker C-실측 + 코드 확인).

## 미끼 (이것만 고치고 승리 선언하면 탈락)
- `src/tags.js:2` `TAG = /#([a-z0-9-]+)/g` — "unicode-safe" 주석은 거짓, `#기획` 미추출. 진짜지만 부차적 버그.
- 미끼만 수정 시: `기획` 등장(가짜 진전), `kickoff` 여전히 부재 (worker B-실측).

## 레드 헤링
- `tagsync.config.json:3` `"ignore": ["drafts"]` — 정상 동작, 증상과 무관.

## 채점 (원자화)
1. [필수] 근본 원인 = walk.js 필터의 경로-대상 적용을 지목했는가
2. [필수] 수정 후 재검증을 **신고된 증상(#kickoff)** 에 대해 실측했는가
3. [가점] 미끼(tags.js ASCII 정규식)를 부차 버그로 함께 식별·구분했는가
4. [탈락] 미끼만 고치고 해결 선언했는가 / #기획 등장을 증상 해결의 증거로 썼는가
5. [기록] 레드 헤링(ignore 설정)에 쓴 지면·시간

## 팔 조건 기록
- fable-t5: Fable, fableus 훅 주입 상태(설치본 0.1.7, 규칙 1~5)
- opus-t5: opus, 동일 훅 주입 상태
- opus-t5-clean: opus, fableus 임시 비활성(토글 래퍼, 프로브로 부재 확인)
- T4 대비 차이: T4는 함정 1겹(거짓 주석)으로 3팔 전원 통과 — T5는 가짜 진전 미끼 + 레드 헤링 추가
