#!/usr/bin/env node
// 실제 프로필 세 곳에서 MCP 서버 정의를 찾아 정규화된 JSON 으로 출력한다.
//   node find-mcp.mjs            전부
//   node find-mcp.mjs myapp      이름에 'myapp' 이 들어간 것만 (대소문자 무시)
// 출처: ~/.claude.json (mcpServers) · ~/.codex/config.toml ([mcp_servers.*]) · ~/.gemini/config/mcp_config.json
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const H = os.homedir();
const q = (process.argv[2] ?? "").toLowerCase();
const out = [];
const push = (source, name, def) => { if (!q || name.toLowerCase().includes(q)) out.push({ source, name, ...def }); };

// Claude Code — 사용자 범위 MCP 는 ~/.claude.json 에 있다 (settings.json 이 아님)
try {
  const d = JSON.parse(fs.readFileSync(path.join(H, ".claude.json"), "utf8"));
  for (const [n, s] of Object.entries(d.mcpServers ?? {})) push("claude", n, { type: s.type ?? (s.url ? "http" : "stdio"), command: s.command, args: s.args ?? [], env: s.env ?? {}, cwd: s.cwd, url: s.url });
} catch (e) { console.error(`claude 프로필 읽기 실패: ${e.message}`); }

// Codex — 최소 TOML 파서: [mcp_servers.X] / [mcp_servers.X.env] 섹션의 문자열·배열·불·숫자만
try {
  const toml = fs.readFileSync(path.join(H, ".codex", "config.toml"), "utf8");
  const servers = {};
  let cur = null, skipMultiline = false;
  const val = (v) => {
    v = v.trim();
    if (v.startsWith("[")) return [...v.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
    if (v.startsWith('"')) return JSON.parse(v);
    if (v === "true" || v === "false") return v === "true";
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  };
  for (const raw of toml.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (skipMultiline) { if (line.includes('"""') || line.includes("'''")) skipMultiline = false; continue; }
    if (!line || line.startsWith("#")) continue;
    const sec = /^\[mcp_servers\.([A-Za-z0-9_-]+)(\.env|\.tools\.[^\]]+|\.http_headers)?\]$/.exec(line);
    if (sec) { cur = sec[2] === ".env" ? { n: sec[1], env: true } : sec[2] ? null : { n: sec[1], env: false }; servers[sec[1]] ??= { env: {} }; continue; }
    if (/^\[/.test(line)) { cur = null; continue; }
    if (!cur) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line); if (!kv) continue;
    const rhs = kv[2].trim();
    if (/^("""|''')/.test(rhs) && !/("""|''').*("""|''')$/.test(rhs)) { skipMultiline = true; continue; }   // 여러 줄 문자열은 건너뛴다
    let v; try { v = val(rhs); } catch { v = rhs; }
    if (cur.env) servers[cur.n].env[kv[1]] = v; else servers[cur.n][kv[1]] = v;
  }
  for (const [n, s] of Object.entries(servers)) push("codex", n, { type: s.url ? "http" : "stdio", command: s.command, args: s.args ?? [], env: s.env, cwd: s.cwd, url: s.url, enabled: s.enabled ?? true, startup_timeout_sec: s.startup_timeout_sec });
} catch (e) { console.error(`codex 프로필 읽기 실패: ${e.message}`); }

// agy (Antigravity CLI) — 전역 MCP 설정
try {
  const d = JSON.parse(fs.readFileSync(path.join(H, ".gemini", "config", "mcp_config.json"), "utf8"));
  for (const [n, s] of Object.entries(d.mcpServers ?? d)) push("agy", n, { type: s.url || s.httpUrl ? "http" : "stdio", command: s.command, args: s.args ?? [], env: s.env ?? {}, cwd: s.cwd, url: s.url ?? s.httpUrl });
} catch (e) { console.error(`agy 프로필 읽기 실패: ${e.message}`); }

if (!out.length) { console.error(q ? `'${q}' 에 해당하는 MCP 서버가 세 프로필 어디에도 없습니다` : "MCP 서버 정의를 찾지 못했습니다"); process.exit(1); }
console.log(JSON.stringify(out, null, 2));
