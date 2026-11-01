// Claude 메모리 파일 출처: ~/.claude/projects/<프로젝트 폴더 이름>/memory/*.md 중 type이 feedback·user면 지키라는 규칙,
// project면 예전 시도로 낸다. 메모리는 이 프로젝트의 것이라 늘 같은 저장소로 친다. 항목 꼴은 recall.mjs 머리말에 있다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = '메모리 파일';

const BUCKETS = { feedback: 'rules', user: 'rules', project: 'attempts' };

// Claude Code는 프로젝트 경로에서 영숫자가 아닌 글자를 모두 -로 바꿔 폴더 이름을 만든다(/만 바꾸면 점·한글이 든 경로를 놓친다)
export const projectDirName = (project) => path.resolve(project).replace(/[^A-Za-z0-9]/g, '-');

// frontmatter에서 name·description·type·modified를 읽는다. type·modified는 metadata 아래에 들여쓰여 있어 들여쓰기를 가리지 않고 첫 줄을 쓴다.
function parseMemory(text) {
  const fm = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fm, body: text };
  for (const line of m[1].split(/\r?\n/)) {
    const k = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (k && !(k[1] in fm)) fm[k[1]] = k[2].trim().replace(/^"(.*)"$/, (_, s) => s.replace(/\\"/g, '"'));
  }
  return { fm, body: text.slice(m[0].length) };
}

const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export async function collect({ topicWords, project, env }) {
  const base = env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
  const dir = path.join(base, projectDirName(project), 'memory');
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return { items: [] };
  }
  const words = [...new Set(topicWords.map((w) => w.toLowerCase()))];
  const items = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const { fm, body } = parseMemory(readFileSync(full, 'utf8'));
    const bucket = BUCKETS[fm.type];
    if (!bucket) continue;
    const haystack = [fm.name, fm.description, body].join('\n').toLowerCase();
    const overlap = words.filter((w) => haystack.includes(w)).length;
    if (!overlap) continue;
    const modified = new Date(fm.modified);
    items.push({
      bucket,
      overlap,
      same_repo: true,
      date: localDate(Number.isNaN(modified.getTime()) ? statSync(full).mtime : modified),
      source: 'memory',
      repo: null,
      text: fm.description || fm.name,
      path: full,
    });
  }
  return { items };
}
