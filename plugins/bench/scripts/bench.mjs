#!/usr/bin/env node
// bench — 사용자 설정(다른 MCP·스킬·플러그인·훅·지침 파일)과 완전히 분리된 "순정" 하네스 프로필에서
// 앱(MCP 서버 묶음)을 실행하는 최소 러너. 벤치·테스트 런이 Honcho 같은 기억 훅에 들어가지 않는 부수효과도 있다.
//
//   bench init <app> [--refresh-tools]    프로필 생성·갱신 (멱등). MCP 서버를 한 번 띄워 도구 목록을 받아 앱 JSON 에 캐시
//   bench run <app> <harness> [--skill] [--effort E] [--model M] [--dry-run] [-- 프롬프트…]
//   bench status [app]                    버전·프로필·등록 상태
//   bench apps                            등록된 앱 이름
//
// 하네스: claude | codex | agy   (effort 값은 하네스마다 다르다: claude low…max, codex low…xhigh, agy low|medium|high)
// 앱 등록(apps/<app>.json 작성)은 사람이 손으로 하지 않고 bench-profile 스킬이 담당한다 — 스키마는 skills/bench-profile/references/runner.md.
// 이 파일은 chenjing-plugins 의 bench 플러그인에 번들되며, 셸의 `bench` 함수가 설치된 플러그인 경로에서 이 파일을 찾아 실행한다.
//
// 경로
//   BENCH_HOME      기본 ~/.bench            프로필 + 앱 정의(apps/) — 사용자 데이터라 플러그인 밖에 둔다
//   BENCH_APPS_DIR  기본 $BENCH_HOME/apps    앱 정의 위치를 따로 두고 싶을 때
//     apps/<app>.json          앱 정의 (bench-profile 스킬이 작성)
//     _claude/                 Claude Code 공유 프로필(CLAUDE_CONFIG_DIR). 로그인이 프로필별이라 앱 간 공유해 1회만 /login
//     <app>/claude-mcp.json    Claude 에 --mcp-config 로 주는 앱별 MCP 정의
//     <app>/codex-raw|skill/   CODEX_HOME 이자 HOME (HOME 도 바꿔야 ~/.agents/skills 가 안 보인다)
//     <app>/agy-raw|skill/     HOME 오버라이드용 홈 (.gemini 에 인증 파일만 링크)
//     <app>/work/raw|skill/    빈 작업 디렉터리 / Claude 스킬용 .claude/skills 링크

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const REAL_HOME = os.homedir();
const BENCH_HOME = process.env.BENCH_HOME || path.join(REAL_HOME, ".bench");
const APPS_DIR = process.env.BENCH_APPS_DIR || path.join(BENCH_HOME, "apps");
const AGY_BIN = process.env.AGY_BIN || path.join(REAL_HOME, ".local", "bin", "agy");

// ---------- 공용 ----------
const mkdir = (d) => fs.mkdirSync(d, { recursive: true });
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const writeJson = (f, v) => { mkdir(path.dirname(f)); fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n"); };
const must = (p, why) => { if (!exists(p)) throw new Error(`${why}: ${p} 가 없습니다`); };
function link(target, at) {
  try { fs.rmSync(at, { recursive: true, force: true }); } catch {}
  mkdir(path.dirname(at));
  fs.symlinkSync(target, at);
}
function appFile(app) { return path.join(APPS_DIR, `${app}.json`); }
function loadApp(app) {
  must(appFile(app), `앱 정의(bench-profile 스킬로 등록)`);
  const a = JSON.parse(fs.readFileSync(appFile(app), "utf8"));
  if (!a.mcp || !Object.keys(a.mcp).length) throw new Error(`${app}: mcp 항목이 비어 있습니다`);
  for (const [n, s] of Object.entries(a.mcp)) if (!s.command) throw new Error(`${app}.mcp.${n}: stdio 서버(command)만 지원합니다`);
  a.skills = (a.skills ?? []).map((s) => s.replace(/^~(?=\/|$)/, REAL_HOME));
  for (const s of a.skills) must(path.join(s, "SKILL.md"), "스킬 디렉터리");
  return a;
}
function listApps() {
  if (!exists(APPS_DIR)) return [];
  return fs.readdirSync(APPS_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
}
const dirs = (app) => ({
  app: path.join(BENCH_HOME, app),
  claude: path.join(BENCH_HOME, "_claude"),
  claudeMcp: path.join(BENCH_HOME, app, "claude-mcp.json"),
  codex: (skill) => path.join(BENCH_HOME, app, skill ? "codex-skill" : "codex-raw"),
  agy: (skill) => path.join(BENCH_HOME, app, skill ? "agy-skill" : "agy-raw"),
  work: (skill) => path.join(BENCH_HOME, app, "work", skill ? "skill" : "raw"),
});
// MCP 서버 프로세스는 실제 HOME 을 봐야 한다(HOME 오버라이드 하네스 아래에서 ~/.<app> 데이터·엔진을 잃지 않게).
const serverEnv = (s) => ({ HOME: REAL_HOME, ...(s.env ?? {}) });

// ---------- MCP tools/list (Codex 는 MCP 도구를 도구별로 승인해야 해서 이름 목록이 필요) ----------
function listTools(server, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...serverEnv(server) }, stdio: ["pipe", "pipe", "ignore"] });
    let buf = "", done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); child.kill(); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error("tools/list 응답 시간 초과")), timeoutMs);
    const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    child.on("error", (e) => finish(e));
    child.on("exit", () => finish(new Error("MCP 서버가 응답 전에 종료됐습니다")));
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { send({ jsonrpc: "2.0", method: "notifications/initialized" }); send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }); }
        if (msg.id === 2) finish(null, (msg.result?.tools ?? []).map((t) => t.name));
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "0.1" } } });
  });
}

// ---------- init ----------
function initClaude(app, a) {
  const D = dirs(app);
  mkdir(D.claude);
  writeJson(D.claudeMcp, { mcpServers: Object.fromEntries(Object.entries(a.mcp).map(([n, s]) => [n, { type: "stdio", command: s.command, args: s.args ?? [], env: serverEnv(s) }])) });
  mkdir(D.work(false));
  const skillsDir = path.join(D.work(true), ".claude", "skills");
  fs.rmSync(skillsDir, { recursive: true, force: true }); mkdir(skillsDir);
  for (const s of a.skills) link(s, path.join(skillsDir, path.basename(s)));
}
function initCodex(app, a, withSkill) {
  const home = dirs(app).codex(withSkill);
  mkdir(home);
  must(path.join(REAL_HOME, ".codex", "auth.json"), "Codex 인증 파일");
  link(path.join(REAL_HOME, ".codex", "auth.json"), path.join(home, "auth.json"));
  const q = (v) => JSON.stringify(v);
  let toml = `# bench 프로필 (${app}) — bench.mjs 가 생성. 실제 ~/.codex/config.toml 과 무관.\n[features]\napps = false\n`;
  for (const [n, s] of Object.entries(a.mcp)) {
    toml += `\n[mcp_servers.${n}]\ncommand = ${q(s.command)}\nargs = [${(s.args ?? []).map(q).join(", ")}]\n`;
    toml += `\n[mcp_servers.${n}.env]\n${Object.entries(serverEnv(s)).map(([k, v]) => `${k} = ${q(String(v))}`).join("\n")}\n`;
    // approval_policy=never 에서 MCP 도구는 즉시 취소되므로 도구별 approve 선언 (서버 단위 키는 무시됨)
    for (const t of a.tools?.[n] ?? []) toml += `[mcp_servers.${n}.tools.${t}]\napproval_mode = "approve"\n`;
  }
  fs.writeFileSync(path.join(home, "config.toml"), toml);
  const skillsDir = path.join(home, "skills");
  fs.rmSync(skillsDir, { recursive: true, force: true }); mkdir(skillsDir);
  if (withSkill) for (const s of a.skills) link(s, path.join(skillsDir, path.basename(s)));
}
function initAgy(app, a, withSkill) {
  const home = dirs(app).agy(withSkill);
  const g = path.join(REAL_HOME, ".gemini"), bg = path.join(home, ".gemini");
  mkdir(path.join(bg, "config")); mkdir(path.join(bg, "antigravity-cli"));
  // 인증·설치 식별자만 공유. antigravity-cli/ 전체를 링크하면 그 안의 mcp/ 캐시에서 플러그인이 딸려온다.
  for (const f of ["oauth_creds.json", "google_accounts.json", "installation_id"]) { must(path.join(g, f), "agy 인증 파일"); link(path.join(g, f), path.join(bg, f)); }
  must(path.join(g, "antigravity-cli", "antigravity-oauth-token"), "agy OAuth 토큰");
  link(path.join(g, "antigravity-cli", "antigravity-oauth-token"), path.join(bg, "antigravity-cli", "antigravity-oauth-token"));
  let settings = {}; try { settings = JSON.parse(fs.readFileSync(path.join(g, "settings.json"), "utf8")); } catch {}
  delete settings.mcpServers; delete settings.hooks;
  writeJson(path.join(bg, "settings.json"), settings);
  writeJson(path.join(bg, "config", "mcp_config.json"), { mcpServers: Object.fromEntries(Object.entries(a.mcp).map(([n, s]) => [n, { command: s.command, args: s.args ?? [], env: serverEnv(s) }])) });
  const skillsDir = path.join(bg, "config", "skills");
  fs.rmSync(skillsDir, { recursive: true, force: true });
  if (withSkill) { mkdir(skillsDir); for (const s of a.skills) link(s, path.join(skillsDir, path.basename(s))); }
}

async function init(app, opts) {
  const a = loadApp(app);
  a.tools ??= {};
  for (const [n, s] of Object.entries(a.mcp)) {
    if (a.tools[n]?.length && !opts.refreshTools) continue;
    process.stderr.write(`[bench] ${n} 도구 목록 조회 중…`);
    a.tools[n] = await listTools(s);
    process.stderr.write(` ${a.tools[n].length}개\n`);
  }
  writeJson(appFile(app), a);   // 도구 목록 캐시
  initClaude(app, a);
  initCodex(app, a, false); initCodex(app, a, true);
  initAgy(app, a, false); initAgy(app, a, true);
  console.log(`프로필 준비 완료: ${dirs(app).app}`);
  if (!exists(path.join(dirs(app).claude, ".claude.json"))) console.log(`Claude Code 는 공유 벤치 프로필에 첫 1회 로그인이 필요합니다:  bench run ${app} claude  → /login`);
}

// ---------- status ----------
function version(cmd, args, env) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env } });
  return (r.stdout || r.stderr || "").trim().split("\n")[0] || `(실행 실패: ${r.error?.message ?? r.status})`;
}
function status(only) {
  console.log(`BENCH_HOME=${BENCH_HOME}  BENCH_APPS_DIR=${APPS_DIR}`);
  console.log(`claude ${version("claude", ["--version"])} · codex ${version("codex", ["--version"])} · agy ${version(AGY_BIN, ["--version"])}`);
  console.log(`Claude 공유 프로필: ${exists(path.join(BENCH_HOME, "_claude", ".claude.json")) ? "로그인 이력 있음(미확정 — 첫 실행 때 확인)" : "미로그인 — bench run <app> claude → /login"}`);
  for (const app of listApps().filter((x) => !only || x === only)) {
    let a; try { a = loadApp(app); } catch (e) { console.log(`\n${app}: 정의 오류 — ${e.message}`); continue; }
    const D = dirs(app);
    const commit = a.repo ? version("git", ["-C", a.repo.replace(/^~/, REAL_HOME), "rev-parse", "--short", "HEAD"]) : "";
    console.log(`\n${app}${commit ? `  (repo ${commit})` : ""}`);
    console.log(`  MCP: ${Object.entries(a.mcp).map(([n]) => `${n}(${a.tools?.[n]?.length ?? "?"}개 도구)`).join(", ")}`);
    console.log(`  스킬: 기본 OFF · --skill 로 ON → ${a.skills.length ? a.skills.map((s) => path.basename(s)).join(", ") : "등록된 스킬 없음(--skill 도 raw 와 같음)"}`);
    const ok = exists(D.claudeMcp) && exists(path.join(D.codex(false), "config.toml")) && exists(path.join(D.agy(false), ".gemini", "config", "mcp_config.json"));
    console.log(`  프로필: ${ok ? "준비됨" : "미생성 — bench init " + app}  ${D.app}`);
  }
}

// ---------- run ----------
function parseRun(argv) {
  const o = { app: argv[0], harness: argv[1], skill: false, effort: null, model: null, prompt: null, dryRun: false };
  const rest = argv.slice(2), words = [];
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i];
    if (x === "--skill") o.skill = true;
    else if (x === "--dry-run") o.dryRun = true;
    else if (x === "--effort") o.effort = rest[++i];
    else if (x === "--model") o.model = rest[++i];
    else if (x === "--") { words.push(...rest.slice(i + 1)); break; }
    else words.push(x);
  }
  if (words.length) o.prompt = words.join(" ");
  return o;
}
function run(o) {
  if (!o.app || !o.harness) throw new Error("사용법: bench run <app> <claude|codex|agy> [--skill] [--effort E] [--model M] [--dry-run] [-- 프롬프트…]");
  loadApp(o.app);
  const D = dirs(o.app);
  if (!exists(D.claudeMcp)) throw new Error(`프로필이 없습니다: bench init ${o.app}`);
  let cmd, args = [], env = {}, cwd = D.work(false);
  if (o.harness === "claude") {
    cmd = "claude"; env.CLAUDE_CONFIG_DIR = D.claude; cwd = D.work(o.skill);
    args.push("--strict-mcp-config", "--mcp-config", D.claudeMcp, "--permission-mode", "bypassPermissions");
    // raw 에 --disable-slash-commands 를 붙이면 /mcp 같은 내장 명령까지 사라진다. 사용자 스킬은 이 프로필에 없어
    // 어차피 보이지 않고(확인됨), 남는 것은 Claude Code 내장 스킬뿐 — Codex 의 imagegen 처럼 "순정"에 속한다.
    if (o.effort) args.push("--effort", o.effort);
    if (o.model) args.push("--model", o.model);
    if (o.prompt) args.push("-p", o.prompt);
  } else if (o.harness === "codex") {
    cmd = "codex"; env.CODEX_HOME = D.codex(o.skill); env.HOME = env.CODEX_HOME;
    if (o.prompt) args.push("exec", "--skip-git-repo-check"); else args.push("-a", "never");
    if (o.model) args.push("-m", o.model);
    if (o.effort) args.push("-c", `model_reasoning_effort="${o.effort}"`);
    if (o.prompt) args.push(o.prompt);
  } else if (o.harness === "agy") {
    cmd = AGY_BIN; env.HOME = D.agy(o.skill);
    args.push("--dangerously-skip-permissions");
    if (o.effort) args.push("--effort", o.effort);
    if (o.model) args.push("--model", o.model);
    if (o.prompt) args.push("-p", o.prompt, "--output-format", "text");
  } else throw new Error(`알 수 없는 하네스: ${o.harness} (claude | codex | agy)`);
  mkdir(cwd);
  console.error(`[bench] ${o.app} · ${o.harness} skill=${o.skill ? "ON" : "OFF"} effort=${o.effort ?? "기본"} model=${o.model ?? "기본"} cwd=${cwd}`);
  if (o.dryRun) {
    console.log(Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ") + " " + [cmd, ...args].map((x) => (/[\s"]/.test(x) ? JSON.stringify(x) : x)).join(" "));
    return;
  }
  // 비대화형이면 stdin 을 닫는다 — codex exec 는 TTY 가 아니면 stdin 을 기다리다 멈춘다.
  const r = spawnSync(cmd, args, { stdio: [o.prompt ? "ignore" : "inherit", "inherit", "inherit"], cwd, env: { ...process.env, ...env } });
  if (r.error) throw r.error;
  process.exit(r.status ?? 1);
}

// ---------- main ----------
const [sub, ...rest] = process.argv.slice(2);
try {
  if (sub === "init") { if (!rest[0]) throw new Error("사용법: bench init <app> [--refresh-tools]"); await init(rest[0], { refreshTools: rest.includes("--refresh-tools") }); }
  else if (sub === "status") status(rest[0]);
  else if (sub === "apps") console.log(listApps().join("\n"));
  else if (sub === "run") run(parseRun(rest));
  else { console.log("사용법: bench init <app> | status [app] | apps | run <app> <claude|codex|agy> [--skill] [--effort E] [--model M] [--dry-run] [-- 프롬프트…]"); process.exit(sub ? 1 : 0); }
} catch (e) { console.error(`오류: ${e.message}`); process.exit(1); }
