# Codex CUA 개발용 테스트

저장소 루트에서 전체 회귀 시험을 실행한다.

```sh
python3 tests/codex-computer-use/run.py
```

Runner는 `plugins/codex-computer-use`를 Python 모듈 검색 경로에 추가한 뒤 이 폴더의 `test_*.py`를 발견해 실행한다. 시험용 추가 의존성은 없으며 Python 표준 라이브러리의 `unittest`를 사용한다.

기존 68개 행동 검증을 보존한다. MCP catalog·이미지·오류·승인 전달, 전용 thread 종료, 다른 client 유지, launcher의 인자·환경·stdio 보존, registry와 원본 앱 탐색, 설치 캐시 업데이트, 의존성 준비의 동시 실행과 부분 설치 복구를 확인한다. 릴리스 버전은 플러그인 manifest에서 읽어 실행 정보와 비교한다. 설치 캐시 업데이트를 흉내 내는 `0.4.0`과 `0.4.1`은 시험 데이터다.

시험은 임시 폴더, fake CLI, mock 호스트를 사용한다. 실제 Codex·CUA·브라우저·GUI·계정이나 credential을 호출하지 않는다. 소켓과 subprocess를 사용하는 시험도 격리된 fake 대상만 생성하고 정리한다. 시험 파일과 fixture 코드는 고객 설치용 플러그인 폴더에 포함하지 않는다.

이 테스트 코드는 플러그인과 같은 [MIT 라이선스](../../plugins/codex-computer-use/LICENSE)를 따른다.
