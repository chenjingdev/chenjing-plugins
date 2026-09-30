// 검사용 Claude Code 기록 줄. 내용은 모두 지어낸 것이다.
let n = 0;
const ts = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + (++n) * 1000).toISOString();

export const user = (content, extra = {}) => ({ type: 'user', uuid: `u${n + 1}`, promptId: `p${n + 1}`, timestamp: ts(), message: { role: 'user', content }, ...extra });
export const toolResult = () => ({ type: 'user', uuid: `r${n + 1}`, timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '{"type":"assistant"} 결과 안의 글' }] } });
export const say = (text, stop = 'end_turn', extra = {}) => ({ type: 'assistant', uuid: `a${n + 1}`, timestamp: ts(), message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] }, ...extra });
export const tool = (name = 'Bash') => ({ type: 'assistant', uuid: `a${n + 1}`, timestamp: ts(), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${n}`, name, input: { command: 'ls' } }] } });
export const done = (durationMs = 4200) => ({ type: 'system', subtype: 'turn_duration', durationMs, timestamp: ts() });
export const title = (aiTitle) => ({ type: 'ai-title', aiTitle });
export const queued = (prompt, commandMode = 'prompt') => ({ type: 'attachment', uuid: `q${n + 1}`, timestamp: ts(), attachment: { type: 'queued_command', prompt, commandMode } });
export const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

// 긴 답(접힘 규칙이 적용되는 크기)
export const LONG_ANSWER = [
  '설정 이전을 마쳤습니다. 검사 12개가 모두 통과했고 배포는 하지 않았습니다.',
  '',
  '## 바꾼 것',
  '- 설정 파일 위치를 `config/app.yaml`로 옮겼습니다.',
  '- 옛 경로에서 읽던 코드 세 곳을 고쳤습니다.',
  '  - 시작 스크립트',
  '  - 백업 작업',
  '',
  '## 확인한 것',
  '| 검사 | 결과 |',
  '| --- | ---: |',
  '| 단위 | 12/12 |',
  '| 통합 | 3/3 |',
  '',
  '```bash',
  'npm test',
  '```',
  '',
  '**남은 일**',
  '문서의 예시 경로가 아직 옛 위치를 가리킵니다. ' + '예시가 여러 곳에 흩어져 있어 한 번에 고치려면 목록이 필요합니다. '.repeat(30),
  '',
  '1. 문서 예시만 고치기',
  '2. 문서와 샘플 설정까지 고치기',
  '',
  '어느 쪽으로 할까요?',
].join('\n');
