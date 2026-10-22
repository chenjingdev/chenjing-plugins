# baton

Claude Code 터미널 세션에 붙이는 mod 네 개를 묶은 플러그인. `/baton on`으로 고른 대화형 세션에서만 켜진다. 고르지 않은 세션에는 `/baton` 명령 하나만 보이고, 나머지 hook은 아무것도 하지 않는다. 외울 것은 `/baton` 하나다: 인자 없이 치면(`/baton 도움말`처럼 on·off가 아닌 말을 붙여도 같다) 상태와 쓸 수 있는 것을 화면별로 보여 준다. 다른 명령도 모두 `/baton`으로 시작해서, 켠 세션에서 입력창에 `/baton`까지 치면 넷이 목록에 함께 뜬다.

명령은 훅 모듈이 `$.command.register`로 등록한다. 이 방법은 플러그인 이름을 붙이지 않고(`/플러그인:이름`은 마크다운 명령·스킬에만 붙는다) 이름에 콜론을 받지 않아서, 플러그인 이름을 하이픈 머리말로 붙인다.

- 답 형식: 답을 첫 문단(물은 것에 대한 답), 화면에서 접히는 "설명:", 사용자 차례 줄로 나눠 쓰게 한다. 접힌 설명 위에는 `설명 목차: …` 줄이 붙고, 버튼이나 `/baton-e`로 펼친다. 규칙은 시스템 프롬프트가 아니라 대화 첫 입력에 맥락으로 한 번 붙는다(`/clear`나 압축 뒤에는 다시 붙는다). 그래서 `/baton on`은 다음 입력부터 적용되고, 규칙을 받은 대화에서 `/baton off`를 하면 다음 입력에 "이제 따르지 않는다"는 한 줄이 붙는다.
- 내 차례: 답에 남은 물을 것·볼 것을 모아 입력창 아래 줄 끝에 `↩ 내 차례 N`으로 보여 준다. 답할 때마다 판정 모델(`judge_model`)을 한 번 불러, 이번 턴으로 답했거나 해결된 항목은 닫고, 상황이 바뀐 항목(선택지가 줄었거나 전제가 바뀐 것)은 지금에 맞게 고쳐 쓰고, 새 질문은 더한다. "다르게 한 것:"(요청과 다르게 했거나 요청 밖에서 한 일)은 답할 것이 아니라서 모으지 않고, 접힌 설명 아래 본문에 남긴다(0.7.2까지는 내 차례에 올라 패널이 열렸다).
- 옆 패널: 전체 화면 모드(settings `tui: fullscreen`)의 옆 패널에 내 차례와 곁대화를 둔다. 내 차례 항목마다 [답하기]·[지우기]가 있고, 지운 직후에는 [되돌리기]가 뜬다. [답하기]를 누르면 그 질문 아래에 답 칸이 열리고 키보드도 그 칸으로 간다(입력창에 쓰던 글이 있으면 엔진이 키보드를 넘기지 않아서, 답 칸을 한 번 더 눌러 쓴다). 쓰고 Enter로 저장하면 링이 아직 답하지 않은 다음 항목으로 가고, [답 N개 본 대화로 보내기](s)로 모은 답을 한 번에 보낸다. 보낸 항목은 바로 닫혀 패널에서 빠진다. 0.7.2~0.7.3에서는 패널 입력칸에서 한글 조합이 깨져 답을 입력창에서 쓰게 했었다. 사용자가 패널에서 바로 쓰는 쪽을 골라 0.7.4에서 되살렸고, 쓰는 동안에는 입력칸 값을 다시 넣지 않고 곁대화 답이 와도 다시 그리지 않는다. 곁질문(q)은 입력창에 `/baton-side `를 붙여 입력창에서 쓴다. 곁대화는 도구 없이 답하고, 곁질문 자동 분리는 패널의 [자동 분리 켜기]로 켠다.
- 토론: sonnet 세션 두 개를 띄워 주제를 놓고 토론시키고, 토론 패널로 중계한다. `/baton-debate`만 치면 지금 대화를 이어받은 모델(`$.model.fork`, 본 대화 모델로 한 번 호출)이 주제·두 편 이름·배경을 골라 바로 시작한다. 결과는 패널의 [본 대화로 보내기]를 눌렀을 때만 본 대화에 들어간다.

## 설치

```
/plugin install baton --marketplace chenjingdev/chenjing-plugins
```

설치한 뒤 쓰려는 세션에서 `/baton on`을 한다. 고른 세션은 `--resume`으로 돌아와도 켜져 있다. `-p`, SDK, 데스크톱 앱 세션에서는 켜지지 않는다.

0.6.0까지는 이름이 `chenjing-mods`였다(명령 `/mods`·`/side`·`/e`·`/debate`). 그 이름으로 설치했다면 `claude plugin uninstall chenjing-mods@chenjing-plugins` 뒤 `claude plugin install baton@chenjing-plugins`로 바꾼다. 켜 둔 세션 목록과 지난 세션의 내 차례는 이름을 따라오지 않으니, 쓰려는 세션에서 `/baton on`을 다시 한다.

## 명령

| 명령 | 하는 일 |
|---|---|
| `/baton on`, `/baton off`, `/baton` | 이 세션에서 켜기, 끄기. 그 밖(인자 없이, `도움말` 등)은 상태와 쓸 수 있는 것 전부 |
| `/baton-e`, `/baton-e 2` | 마지막 답(2면 그 전 답)의 설명 펼치기·접기 |
| `/baton-side`, `/baton-side 질문` | 옆 패널 열기, 곁대화에 바로 묻기 |
| `/baton-debate`, `/baton-debate [라운드] 주제`, `/baton-debate stop` | 지금 대화에서 주제를 골라 토론, 주제를 직접 줘서 토론(라운드 기본·최대 10), 중지 |

나머지는 패널 버튼과 단축키로 한다: 내 차례의 [답하기](숫자)·[지우기]·[되돌리기](u)·[답 N개 본 대화로 보내기](s), 곁대화의 곁질문(q)·[본 대화로 보내기](m)·[자동 분리 켜기], 토론 탭의 [토론 중지]·[본 대화로 보내기](m). 입력창에서 패널로는 `ctrl+x tab`, 패널에서 입력창으로는 `Esc`. q를 누르면 입력창에 `/baton-side `가 붙고, Esc 없이 바로 이어 쓰면 된다. 예전 하위 명령(`/baton-side main`, `list`, `drop N`, `clear`, `undo`, `auto on|off`, `status`)도 그대로 받는다.

## 설정

`/config`에서 바꾸거나 settings.json의 `pluginConfigs["baton@chenjing-plugins"].options`에 적는다.

| 항목 | 기본값 | 뜻 |
|---|---|---|
| `judge_model` | `sonnet` | 내 차례를 뽑고 닫는 판정 모델 |
| `classify_model` | `haiku` | 곁질문인지 가르는 모델 |
| `side_auto` | `off` | 작업과 관계없어 보이는 질문을 곁대화로 자동으로 보낼지 |
| `debate_dir` | `~/.claude/baton/debates` | 토론 기록(.md)을 쓰는 폴더 |
| `debate_work_dir` | 비움 | 토론자 세션이 도는 폴더. 비우면 토론을 연 세션의 작업 폴더. 신뢰한 폴더여야 하고, 토론자는 그 폴더의 CLAUDE.md를 읽는다 |

## 답 형식 규칙을 시스템 프롬프트에 넣지 않는 이유

Team·Enterprise 조직 계정이나 managed settings가 있는 컴퓨터에서는 Claude Code에 들어 있는 `cc-plugin-sec-default`가 사용자가 설치한 플러그인의 `prompt.compose`·`prompt.section`·`prompt.context` hook을 건너뛴다(debug 로그의 `prompt.compose bypassed by cc-plugin-sec-default`). 0.7.0까지는 규칙을 `prompt.compose`로 넣어서 이런 계정에서는 모델에 닿지 않았다. 0.7.1부터는 `cc-plugin-sec-default`가 건너뛰지 않는 `prompt.submit`의 맥락으로 넣는다(2.1.296에서 확인). 입력마다 붙이면 약 760자씩 대화에 쌓여서, 대화마다 한 번만 붙인다.

## 개발

- 이 폴더를 그대로 읽게 하려면 이 폴더를 마켓플레이스로 더해 설치한다. `.claude-plugin/marketplace.json`이 그 용도다: `claude plugin marketplace add <이 폴더>`, `claude plugin install baton@baton`. 고친 뒤 `/reload-plugins`를 하면 새 버전 없이 들어간다.
- 엔진은 `hooks/register.tsx`가 바뀌어야 모듈을 다시 불러온다. 다른 파일만 고쳤으면 register.tsx 주석의 버전도 올린다. 설치본을 `claude plugin update`로 올린 뒤에도 열려 있던 세션은 `/reload-plugins`로 새 버전을 읽는다(2.1.296에서 디렉터리·git 마켓플레이스 둘 다 확인). CLI가 띄우는 "Restart to apply changes"는 늘 같은 문구다.
- 확인: `npx tsc -p .`, `claude plugin test .`, `claude plugin validate .`
- `.claude-plugin/types/`는 엔진이 만드는 파일이라 저장소에 넣지 않는다. 처음 받은 뒤에는 한 번 불러와야 tsc가 돈다.
