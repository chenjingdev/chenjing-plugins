# spec schema (L6)

## 무엇인가

`spec.md`는 **L6 codespeak-level plain-text spec**의 backbone이다. L4 시나리오 카드와 L5 장면들이 모두 모인 한 시나리오를, AI가 그대로 코드로 변환할 수 있는 정밀도의 자연어 명세로 압축한다. codespeak.dev 스타일 — 코드가 아니되 코드 변환이 결정적인 plain-text. 사용자 프로젝트에서는 `docs/spec/chapters/<chapter>/scenarios/<scenario>/spec.md`로 작성된다. 이 파일이 승인되면 superpowers의 `writing-plans` skill로 인계되어 구현 단계로 넘어간다.

## 필드 정의 — 4섹션

각 섹션은 자연어로 작성되지만, 모호한 형용사·감정형·일반론을 허용하지 않는다. *"사용자가 만족한다"*가 아니라 *"목록 최상단에 항목이 1초 안에 보인다"*.

### 1. State model
- **역할:** 이 시나리오가 다루는 상태들과 전이 조건. 유한 상태 기계 또는 상태 변수 목록을 자연어로.
- **작성 가이드:** *상태 이름*과 *그 상태에서 가능한 행동*, *다음 상태로의 전이 조건*을 적는다. 형식 자유 — 표·목록·문장 어느 쪽이든. 단, 모든 상태가 *어떻게 진입하고 어떻게 떠나는지* 빠짐없이.
- **좋은 예:** *"UI에는 두 상태가 있다. `idle` (입력창 비어 있고 포커스 없음, 목록 표시), `composing` (입력창에 텍스트 있음 또는 포커스 있음). `idle → composing` 전이는 입력창 탭 또는 첫 키 입력. `composing → idle` 전이는 Enter (저장과 동시에) 또는 외부 영역 탭."*
- **나쁜 예:** *"앱이 입력 상태와 대기 상태를 갖는다."* (전이 조건 누락)

### 2. Event flow
- **역할:** 사용자/시스템 이벤트의 발생 순서. 이벤트 타입과 그에 대한 시스템의 반응.
- **작성 가이드:** *이벤트 → 핸들러 → 결과* 형식. 각 이벤트가 어떤 상태에서만 유효한지·실패 시 동작은 어떤지·side effect는 무엇인지. 시간 순서가 중요하면 번호 매김.
- **좋은 예:** *"이벤트 `tap_input`: `idle` 상태에서만 유효. 효과: UI 상태를 `composing`으로 전이, 키보드 표시. 이벤트 `key_press`: `composing` 상태에서 유효. 효과: 임시 텍스트 갱신. 이벤트 `submit` (Enter 또는 ↵): `composing` 상태에서 임시 텍스트가 비어 있지 않을 때만 유효. 효과: todo 객체 생성·저장 → 목록 prepend → 입력창 clear → UI 상태 `idle`로 전이 (포커스는 유지)."*
- **나쁜 예:** *"사용자가 입력하면 todo가 추가된다."* (이벤트 분해 없음)

### 3. Data model
- **역할:** 저장되는 entity와 그 관계. 필드 이름·타입·제약.
- **작성 가이드:** entity별로 *필드 목록 + 타입 + 제약*. 관계는 *어떤 entity가 어떤 entity를 참조*하는지 자연어로. 영속성 여부(저장 vs 휘발) 명시.
- **좋은 예:** *"entity `Todo` (영속): id (string, uuid), text (string, 1-200자, trim 후 비어있지 않음), created_at (timestamp), status (enum: open | done, default open). 관계: 사용자별로 격리됨 — 모든 Todo는 단일 user 컨텍스트에 속한다 (이 시나리오 범위에서는 단일 사용자 가정)."*
- **나쁜 예:** *"todo는 텍스트와 시간을 갖는다."* (타입·제약·관계 없음)

### 4. Acceptance criteria
- **역할:** 이 시나리오가 *통과*했음을 증명하는 관찰 가능 기준 N개.
- **작성 가이드:** *Given / When / Then* 또는 *체크리스트* 형식. 각 기준은 외부에서 관찰 가능해야 한다(자동화 테스트로 옮길 수 있는 정밀도). N은 보통 3-7개.
- **좋은 예:**
  1. Given UI 상태가 `idle`이고 입력창이 비어 있을 때, When 사용자가 입력창을 탭하면, Then UI 상태는 `composing`으로 전이되고 키보드가 표시된다.
  2. Given UI 상태가 `composing`이고 입력창에 *"내일 견적서 보내기"*가 있을 때, When 사용자가 Enter를 누르면, Then `Todo` 객체 1개가 저장소에 생성되고, 목록 최상단에 해당 텍스트의 항목이 1초 안에 표시된다.
  3. Acceptance 2의 시점에 입력창은 비워지고 포커스가 유지된다 (연속 입력 가능).
  4. Given UI 상태가 `composing`이고 입력창이 공백만 또는 빈 문자열일 때, When 사용자가 Enter를 누르면, Then `Todo` 객체는 생성되지 않고 UI는 `composing` 상태로 머무른다.
- **나쁜 예:** *"todo 추가가 잘 동작해야 한다."* (관찰 불가)

## 출력 markdown 템플릿

`docs/spec/chapters/<chapter>/scenarios/<scenario>/spec.md`에 다음 구조.

```markdown
# Spec: <시나리오 한 줄 제목>

> chapter: <chapter id>
> scenario: <scenario id>
> depth: L6
> status: draft | approved | implemented
> methodology_l6: <사용한 방법론>

## State model
<자연어 — 상태와 전이 조건>

## Event flow
<자연어 — 이벤트·핸들러·결과>

## Data model
<자연어 — entity·필드·관계>

## Acceptance criteria
1. Given ___, When ___, Then ___.
2. ...
3. ...
```

## 가상 todo 앱 "DayLine" 예시 (간단한 todo 추가 시나리오 1세트)

```markdown
# Spec: 한 줄로 할 일 추가하기

> chapter: 02-first-capture
> scenario: 01-quick-add
> depth: L6
> status: approved
> methodology_l6: pragmatism

## State model

UI에는 두 상태가 있다.

- `idle`: 입력창이 비어 있고 포커스 없음. 목록은 시간 역순으로 표시됨.
- `composing`: 입력창에 텍스트가 있거나 포커스가 있음.

전이:
- `idle → composing`: 사용자가 입력창을 탭하거나 첫 키를 누른 시점.
- `composing → idle`: 사용자가 Enter를 누른 시점(저장과 동시에) 또는 외부 영역을 탭한 시점(텍스트가 비어 있을 때만; 텍스트가 있으면 그대로 `composing` 유지).

## Event flow

1. **이벤트 `tap_input`** — `idle` 상태에서만 유효.
   - 효과: UI 상태를 `composing`으로 전이. 키보드 표시. 입력창 placeholder 숨김.
2. **이벤트 `key_press(char)`** — `composing` 상태에서 유효.
   - 효과: 임시 텍스트 버퍼에 문자 추가. 화면 갱신.
3. **이벤트 `submit`** (Enter 또는 모바일 ↵) — `composing` 상태에서 임시 텍스트를 trim한 결과가 1자 이상일 때만 유효.
   - 효과 (순서대로):
     1. `Todo` 객체를 `{id: uuid, text: trimmed, created_at: now, status: open}`으로 생성.
     2. 영속 저장소에 commit.
     3. 목록 캐시를 무효화하고 새 객체를 최상단으로 prepend.
     4. 입력창의 임시 텍스트 버퍼를 비움.
     5. UI 상태를 `idle`로 전이하되 입력창 포커스는 유지.
     6. 가벼운 햅틱 1회 (모바일).
   - 임시 텍스트가 trim 후 빈 문자열이면 이벤트는 *no-op* — UI 상태와 데이터 모두 변하지 않음.
4. **이벤트 `tap_outside`** — `composing` 상태에서 유효.
   - 효과: 임시 텍스트가 비어 있으면 `idle`로 전이, 키보드 닫힘. 비어 있지 않으면 그대로 `composing` 유지(저장 의도 보호).

## Data model

`Todo` (영속, key-value 저장소 또는 SQLite 테이블 어느 쪽이든):
- `id`: string, UUID v4, 생성 시 자동 부여.
- `text`: string, trim 적용 후 1자 이상 200자 이하.
- `created_at`: ISO 8601 timestamp, 생성 시점의 클라이언트 시간.
- `status`: enum `open | done`, 생성 시 default `open`.

관계: 모든 `Todo`는 현재 단일 사용자 컨텍스트에 속한다 (이 시나리오 범위에서는 멀티유저·동기화 미고려). 다중 기기 동기화는 별도 시나리오의 spec.

휘발 상태 (저장 안 함):
- 임시 텍스트 버퍼 (입력창의 현재 텍스트).
- UI 상태 (`idle | composing`).

## Acceptance criteria

1. Given UI 상태가 `idle`이고 입력창이 비어 있을 때, When 사용자가 입력창을 탭하면, Then UI 상태는 `composing`으로 전이되고 키보드가 화면에 표시된다.
2. Given UI 상태가 `composing`이고 임시 텍스트가 *"내일 견적서 보내기"* (16자)일 때, When 사용자가 Enter를 누르면, Then `Todo` 객체 1개가 영속 저장소에 생성되고 그 객체의 text는 *"내일 견적서 보내기"*이며 목록 최상단에 1초 안에 표시된다.
3. Acceptance 2의 시점에 입력창은 비워지고 입력창 포커스는 유지된다(다음 키 입력으로 새 todo를 바로 시작 가능).
4. Given UI 상태가 `composing`이고 임시 텍스트가 공백만 또는 빈 문자열일 때, When 사용자가 Enter를 누르면, Then `Todo` 객체는 생성되지 않고 UI 상태는 `composing` 그대로이며 저장소에는 변화가 없다.
5. Given UI 상태가 `composing`이고 임시 텍스트가 비어 있을 때, When 사용자가 입력창 외부 영역을 탭하면, Then UI 상태는 `idle`로 전이되고 키보드가 닫힌다.
6. Given UI 상태가 `composing`이고 임시 텍스트가 1자 이상일 때, When 사용자가 입력창 외부 영역을 탭하면, Then UI 상태는 `composing`을 유지하고 임시 텍스트는 보존된다.
7. Given 임시 텍스트가 200자를 초과해 입력될 때, When 추가 키 입력이 발생하면, Then 입력창은 200자에서 입력을 거부한다(저장 시도 시 trim 검증과 별개로 입력 단계에서 컷).
```

## AI 행동 룰 (이 schema를 인터뷰 backbone으로 쓸 때)

L6 spec을 채울 때 너는 4섹션을 *State model → Event flow → Data model → Acceptance criteria* 순서로 작성한다. 한 섹션당 한 메시지 한 질문 룰. **이 단계에서는 사용자가 답을 모를 가능성이 가장 높다 — 너는 L4 시나리오 카드와 L5 장면들을 *재료*로 삼아 초안을 *제안*하고 사용자에게 *"이렇게 잡으면 어떻습니까? 빠진 게 있나요?"*로 검증을 받는다 (이전 LOD와 진행 방향이 다름에 주의).** **manifest의 `methodology_l6` (default Pragmatism)에 따라 모든 모호한 표현에 *"이게 참이라면 어떤 차이가 코드로 보일까요?"*를 던진다. 사용자가 *"빠르게"*, *"부드럽게"* 같은 형용사를 쓰면 *"몇 ms 안인가요?"*, *"어떤 애니메이션 곡선인가요?"*로 한 단계 내린다.** **Acceptance criteria는 Given/When/Then 형식으로 강제하고, 각 기준이 자동화 테스트로 변환 가능한지 자체 검증한다 — 변환 어려우면 사용자와 함께 한 단계 더 정밀화.** 4섹션이 채워지면 사용자에게 전체 요약 → 명시 승인 → `spec.md` 작성 → manifest의 시나리오 항목 `depth: L6`, `status: approved`, `methodology_l6: <선택된 방법론>` 갱신. 사용자가 *"이 시나리오 spec으로 구현해줘"*라고 명시하면 그때 superpowers의 `writing-plans` skill로 인계하고 manifest의 `implementation_log`에 기록한다.
