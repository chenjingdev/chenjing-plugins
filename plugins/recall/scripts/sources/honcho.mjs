import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { localDate, projectDirName } from './memory-files.mjs';
import { inside } from './pact-records.mjs';
import { overlapOf } from './words.mjs';

export const name = '기억 서버';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8001';
const DEFAULT_ENV_FILE = path.join(os.homedir(), '.config', 'codex-honcho-sync', '.env');
const DEFAULT_REQUEST_MS = 2500;
const DEFAULT_BUDGET_MS = 60000;
const LIMIT = 20;
const MAX_USER_CHARS = 2000;
const SKIPPED_STARTS = ['<system-reminder>', '<command-message>', '<local-command', '<task-notification>', '<cross-session'];

// 묶음을 가르는 낱말, 위에서부터 먼저 걸린 묶음으로 간다. 한 글자 낱말은 한글 이웃이 없을 때만 맞춘다("오늘"·"늘어"에 "늘"이 걸리지 않게)
const KEYWORDS = {
  user: [
    ['rules', ['앞으로', '늘', '항상', '하지 마', '금지', '원칙']],
    ['failures', ['불편', '안 됨', '안 돼', '실패', '짜증', '문제', '깨짐', '막힘']],
    ['ideas', ['하면 좋겠', '아이디어', '다음에', '나중에', '추가하', '넣어']],
  ],
  assistant: [
    ['failures', ['막힌 곳', '실패', '의심']],
    ['ideas', ['다음 판 후보', '다음에 고칠', '후보']],
  ],
};

const hasWord = (text, word) => (word.length > 1 ? text.includes(word) : new RegExp(`(?<![가-힣])${word}(?![가-힣])`).test(text));
const bucketOf = (kind, text) => KEYWORDS[kind].find(([, words]) => words.some((w) => hasWord(text, w)))?.[0] ?? 'attempts';

function readEnvFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vars[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return vars;
}

function configOf(env) {
  const file = readEnvFile(env.HONCHO_ENV_FILE || DEFAULT_ENV_FILE);
  const pick = (key) => env[key] || file[key] || '';
  return {
    base: (pick('HONCHO_BASE_URL') || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    workspace: pick('HONCHO_WORKSPACE_ID') || 'memory',
    user: pick('HONCHO_USER_NAME') || 'user',
    token: pick('HONCHO_API_BEARER_TOKEN'),
  };
}

const positive = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);
const seconds = (ms) => `${ms / 1000}초`;

// 까닭에는 상태 코드와 주소만 싣는다: 토큰이나 주소 속 계정이 출력에 새지 않게
function reasonOf(e) {
  const hit = e.errors?.[0] ?? e;
  const code = e.code ?? hit.code;
  if (!code) return e.message;
  const host = hit.address ?? hit.hostname;
  const at = host ? ` ${host}${hit.port ? `:${hit.port}` : ''}` : '';
  return code === 'ECONNREFUSED' ? `연결 거부${at}` : `${code}${at}`;
}

// fetch는 9번 같은 막힌 포트를 요청 전에 거부해서 연결 거부 까닭을 못 읽으므로 node:http로 보낸다
function post(url, { headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https:') ? https : http;
    const req = transport.request(url, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, signal }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('close', () => reject(new Error('응답이 중간에 끊김')));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function search({ base, workspace, token }, body, { ms, label }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const { status, text } = await post(`${base}/v3/workspaces/${encodeURIComponent(workspace)}/search`, {
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    let list;
    try {
      list = JSON.parse(text);
    } catch {
      throw new Error('응답을 읽을 수 없음');
    }
    if (!Array.isArray(list)) throw new Error('응답이 메시지 목록이 아님');
    return list;
  } catch (e) {
    throw new Error(controller.signal.aborted ? `${label} 안에 응답 없음` : reasonOf(e));
  } finally {
    clearTimeout(timer);
  }
}

function keep(m, kind) {
  if (typeof m?.content !== 'string' || Number.isNaN(Date.parse(m.created_at))) return false;
  const head = m.content.trimStart();
  if (SKIPPED_STARTS.some((s) => head.startsWith(s))) return false;
  if (kind === 'user') return [...m.content].length <= MAX_USER_CHARS;
  return m.peer_id?.startsWith('assistant_') && m.metadata?.direct_user === false;
}

const tidy = (s) => s.replace(/[`*]/g, '').replace(/^[\s#-]+/, '').trim();
// AI 보고 첫 줄의 상태 머리말: "pact · build 6/8 — 내용", "pact · build 1/3: 내용", "pact · verify (2차)"
const STATUS_HEAD = /^pact\s*·\s*[^—:]{0,40}?(?:—|:\s|\.\s|$)/;
function gist(content) {
  const lines = content.trim().split(/\r?\n/).map(tidy);
  if (!lines[0]) return tidy(content.replace(/\s+/g, ' ')).split(/(?<=[.!?。])\s/)[0];
  return lines.map((l) => l.replace(STATUS_HEAD, '').trim()).find(Boolean) ?? lines[0];
}

function repoResolver(env, project) {
  const projectDir = path.resolve(project);
  const roots = (env.RECALL_ROOTS || path.join(os.homedir(), 'dev')).split(':').filter(Boolean);
  let folders;
  const known = () =>
    (folders ??= roots.flatMap((root) => {
      try {
        return readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => ({ dir: path.join(root, e.name), slug: projectDirName(path.join(root, e.name)) }));
      } catch {
        return [];
      }
    }));
  return (meta) => {
    const slug = /\.claude\/projects\/([^/]+)\//.exec(meta.transcript_path ?? '')?.[1];
    const folder = slug && known().filter((f) => slug === f.slug || slug.startsWith(`${f.slug}-`)).sort((a, b) => b.slug.length - a.slug.length)[0];
    if (folder) return { repo: path.basename(folder.dir), same_repo: inside(projectDir, folder.dir) };
    if (meta.cwd) return { repo: path.basename(meta.cwd), same_repo: inside(projectDir, meta.cwd) || inside(meta.cwd, projectDir) };
    return { repo: null, same_repo: false };
  };
}

export async function collect({ topicWords, project, env }) {
  if (!topicWords.length) return { items: [] };
  const config = configOf(env);
  const requestMs = positive(env.RECALL_REQUEST_MS, DEFAULT_REQUEST_MS);
  const budgetMs = positive(env.RECALL_BUDGET_MS, DEFAULT_BUDGET_MS);
  const limit = { ms: Math.min(requestMs, budgetMs), label: budgetMs < requestMs ? `전체 예산 ${seconds(budgetMs)}` : seconds(requestMs) };
  const topic = topicWords.join(' ');
  const asUser = { peer_id: config.user };
  const plans = [
    { kind: 'user', body: { query: topic, limit: LIMIT, filters: asUser } },
    { kind: 'user', body: { query: `${topic} 불편 안 됨 실패 짜증 문제`, limit: LIMIT, filters: asUser } },
    { kind: 'assistant', body: { query: `${topic} 막힌 곳 실패 다음 판 후보 남은 할 일 완료`, limit: LIMIT } },
  ];
  const settled = await Promise.allSettled(plans.map((p) => search(config, p.body, limit)));
  if (settled.every((r) => r.status === 'rejected')) throw settled[0].reason;

  // 사용자 말과 AI 보고를 따로 센다: 겹침이 큰 AI 보고가 같은 세션의 사용자 말을 밀어내지 않게
  const bySession = new Map();
  settled.forEach((r, i) => {
    if (r.status === 'rejected') return;
    const { kind } = plans[i];
    for (const m of r.value) {
      if (!keep(m, kind)) continue;
      const overlap = overlapOf(topicWords, m.content);
      const key = `${kind}\0${m.session_id ?? m.id}`;
      if (overlap && overlap > (bySession.get(key)?.overlap ?? 0)) bySession.set(key, { m, kind, overlap });
    }
  });

  const where = repoResolver(env, project);
  const items = [...bySession.values()].map(({ m, kind, overlap }) => ({
    bucket: bucketOf(kind, m.content),
    overlap,
    ...where(m.metadata ?? {}),
    date: localDate(new Date(m.created_at)),
    source: kind,
    text: gist(m.content),
    path: m.metadata?.transcript_path ?? m.metadata?.codex_rollout_path ?? null,
  }));
  return { items };
}
