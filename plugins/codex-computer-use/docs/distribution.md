# 배포와 호환성

`codex-computer-use@chenjing-plugins`는 macOS용 Claude Code 플러그인입니다. 첫 공개 버전은 0.4.0입니다. 원본 CUA·Codex 바이너리와 시스템 프롬프트는 배포하지 않습니다. Python 의존성은 설치 시 전용 환경으로 받습니다.

## 0.4.0 변경

- 사용자 이름에 묶인 경로를 제거하고 Codex 설치 위치·실제 호스트의 CUA 경로를 탐색합니다.
- 전용 Python 환경, `codex-cua` 실행 명령, 설치·시작·진단·제거를 제공합니다.
- 종료 도구 `turn_ended`의 안내 schema를 실제 빈 인자 호출과 맞춥니다. 브리지가 자신의 대화와 턴 식별자를 채웁니다.
- 공개 마켓 등록, MIT 라이선스, 설정·사용 스킬과 복구 문서를 제공합니다.

## 실행 경계

MCP는 실행 중인 원본 Codex 서버에 연결합니다. 호스트가 없을 때 별도 CUA나 모델 세션을 몰래 실행하지 않습니다. 연결마다 전용 ephemeral thread를 생성하고, 연결 해제 시 그 대화만 정리합니다.

원본 도구의 설명·schema·결과는 전달되며 `turn_ended`의 빈 인자 인터페이스가 유일한 도구 계약 변환입니다. Claude의 기존 session/turn/권한 값을 원본 대화 식별자로 사용하지 않습니다. 앱 실행 경로에는 private Unix listener와 통신 중계기가 추가됩니다.

원본 엔진을 호출한다는 사실은 Codex와 Claude의 판단·전체 프롬프트·동시 작업·모든 GUI 결과가 같다는 보증이 아닙니다. 표준 form 승인만 중계하고 확장 승인, MCP cancellation, Claude 매 턴 Stop hook은 지원하지 않습니다. 현재 설정의 Portwarden relay는 설치된 원본 경로와 소유권을 확인한 경우에만 허용합니다.

## 검증

자동 시험은 fixture로 catalog·결과 전달, 대화별 scope, 승인 전달, 소켓과 registry 검사, 실행 인자 보존, 자식 프로세스 정리, 설치 위치와 의존성 설정을 검사합니다.

실제 연결 검사는 준비된 호스트에 새 연결을 만들고 catalog와 읽기 전용 호출을 확인합니다. 자동 시험 통과나 getState 성공만으로 모든 앱에서의 클릭·드래그·동시 입력을 검증했다고 주장하지 않습니다.

초기 실제 호스트 검증 환경은 Apple Silicon Mac의 Codex Desktop 26.1007.21159와 내장 CLI 0.162.0-alpha.17.2입니다. 다른 버전은 원본 catalog와 내부 인터페이스의 호환성에 따라 달라질 수 있습니다.
