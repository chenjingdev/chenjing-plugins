// 결과·기록 파일 잠금 규칙(scripts/locks.mjs)을 훅 없이 바로 시험한다. 훅 입력을 손으로 만들어 훅 프로세스에 넣는 시험은 hooks.test.mjs에 있다.
// 실제로 있는 임시 프로젝트(명세, 실행 폴더)를 쓴다: 잠금은 명세가 있는 판에만 걸리기 때문이다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRest, lockForPath, lockMessage, bashLocks, checkLocks, VERIFIER } from '../scripts/locks.mjs';

const ID = '2026-10-29-출결-관리';
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

// 명세와 실행 폴더가 있는 프로젝트 하나, 명세 없이 `.pact/`만 있는 폴더, 다른 프로젝트
function world() {
  const root = mkdtempSync(path.join(tmpdir(), 'pact-locks-'));
  made.push(root);
  const project = path.join(root, 'project');
  const run = path.join(project, '.pact', ID);
  mkdirSync(path.join(project, 'docs', 'pact'), { recursive: true });
  writeFileSync(path.join(project, 'docs', 'pact', `${ID}.md`), '---\npact: 2\ntopic: x\nstatus: building\n---\n# x\n');
  for (const dir of ['log', 'wt/sub', 'tasks', 'shots']) mkdirSync(path.join(run, dir), { recursive: true });
  writeFileSync(path.join(run, 'results.json'), '{}');
  const bare = path.join(root, 'bare'); // 명세 없는 임시 폴더
  mkdirSync(path.join(bare, '.pact', ID), { recursive: true });
  return { root, project, run, bare, bareRun: path.join(bare, '.pact', ID), other: path.join(root, 'other') };
}
const w = world();
const R = w.run;

const bash = (command, { cwd = w.project, verifier = false, home } = {}) => checkLocks({ tool_name: 'Bash', tool_input: { command }, cwd }, { verifier, ...(home ? { home } : {}) });
const tool = (tool_name, file, { cwd = w.project, verifier = false } = {}) => checkLocks({
  tool_name, tool_input: tool_name === 'NotebookEdit' ? { notebook_path: file } : { file_path: file }, cwd,
}, { verifier });
const blocked = (v, label) => assert.ok(v && v.reason && v.instead, `막혀야 한다: ${label}`);
const free = (v, label) => assert.equal(v, null, `지나가야 한다: ${label} → ${v && v.reason}`);

// ---------- 어느 파일이 잠겼나 ----------

test('classifyRest: results, verification, approvals and log/ are locked; the worktree and everything else are not', () => {
  assert.deepEqual(classifyRest(['results.json']), { kind: 'results', name: 'results.json' });
  assert.deepEqual(classifyRest(['results-round1.json']), { kind: 'results', name: 'results-round1.json' });
  assert.deepEqual(classifyRest(['results-round12.json']), { kind: 'results', name: 'results-round12.json' });
  assert.deepEqual(classifyRest(['results-round1-check.json']), { kind: 'results', name: 'results-round1-check.json' }, 'results-round*.json');
  assert.deepEqual(classifyRest(['verification.json']), { kind: 'verification', name: 'verification.json' });
  assert.deepEqual(classifyRest(['approvals.jsonl']), { kind: 'approvals', name: 'approvals.jsonl' });
  assert.deepEqual(classifyRest(['log']), { kind: 'log', name: 'log/' });
  assert.deepEqual(classifyRest(['log', 'subagents.jsonl']), { kind: 'log', name: 'log/subagents.jsonl' });
  assert.deepEqual(classifyRest(['log', 'a', 'b']), { kind: 'log', name: 'log/a/b' });
  for (const rest of [[], ['wt'], ['wt', 'results.json'], ['wt', 'log', 'x'], ['summary.json'], ['report.html'], ['plan.md'], ['shots', 'S1-1.jpg'], ['tasks', '1-report.md'], ['tasks', 'log', 'x'],
    ['results.json.bak'], ['results.json', 'x'], ['results.jsonl'], ['my-results.json'], ['verification.json.tmp'], ['approvals.json'], ['logs'], ['items.json']]) {
    assert.equal(classifyRest(rest), null, rest.join('/'));
  }
});

test('lockForPath: only files directly under a run dir whose spec exists, and the leftmost .pact/<run-id> decides', () => {
  const lock = lockForPath(path.join(R, 'results.json'));
  assert.deepEqual({ kind: lock.kind, name: lock.name, runId: lock.runId, project: lock.project, runDir: lock.runDir }, { kind: 'results', name: 'results.json', runId: ID, project: w.project, runDir: R });
  assert.equal(lockForPath(path.join(R, 'log', 'subagents.jsonl')).kind, 'log');
  assert.equal(lockForPath(path.join(R, 'approvals.jsonl')).kind, 'approvals');
  assert.equal(lockForPath(path.join(R, 'verification.json')).kind, 'verification');
  // 잠기지 않는 것
  for (const rest of ['summary.json', 'report.html', 'plan.md', 'shots/S1-1.jpg', 'tasks/3-report.md', 'wt/results.json', 'wt/sub/log/x', 'wt/.pact/other/results.json', 'tasks/x/.pact/r2/results.json', '']) {
    assert.equal(lockForPath(path.join(R, rest)), null, rest);
  }
  assert.equal(lockForPath(path.join(w.project, '.pact', '.gitignore')), null);
  assert.equal(lockForPath(path.join(w.project, 'results.json')), null);
  assert.equal(lockForPath(path.join(w.other, '.pact', ID, 'results.json')), null, '다른 프로젝트');
  assert.equal(lockForPath(path.join(w.bareRun, 'results.json')), null, '명세 없는 임시 .pact/');
  assert.equal(lockForPath('/results.json'), null);
  assert.equal(lockForPath('/.pact'), null);
  assert.equal(lockForPath('/.pact/x/results.json', () => '/spec.md').kind, 'results', '프로젝트가 루트여도 읽는다');
  // 명세를 찾는 함수를 바꿔 끼우면 그 판에만 건다
  assert.equal(lockForPath(path.join(w.bareRun, 'results.json'), () => '/some/spec.md').kind, 'results');
});

test('lockForPath: a dated spec locks its undated run folder too (old specs keep the same lock, R5)', () => {
  const x = world();
  const undated = path.join(x.project, '.pact', '출결-관리');
  mkdirSync(undated, { recursive: true });
  assert.equal(lockForPath(path.join(undated, 'results.json')).kind, 'results', '날짜 없는 옛 실행 폴더');
  assert.equal(lockForPath(path.join(x.project, '.pact', '없는-판', 'results.json')), null);
});

test('lockMessage says why and what to do instead for each kind, and names the file', () => {
  const say = (kind, name) => lockMessage({ kind, name });
  assert.match(say('results', 'results.json').reason, /검수 결과\(results\.json\)는 verifier만 쓴다/);
  assert.match(say('results', 'results.json').instead, /build로 되돌려 고치고 verifier로 다시 검수한다. 보고 칸.*summary\.json/);
  assert.match(say('results', 'results-round2.json').instead, /snapshot.*results-round<n>\.json/);
  assert.match(say('verification', 'verification.json').reason, /verification\.mjs snapshot만 쓴다/);
  assert.match(say('verification', 'verification.json').instead, /snapshot을 다시 실행한다/);
  assert.match(say('approvals', 'approvals.jsonl').reason, /spec\.mjs approve·delegate만 쓴다/);
  assert.match(say('approvals', 'approvals.jsonl').instead, /spec\.mjs approve/);
  assert.match(say('log', 'log/subagents.jsonl').reason, /log\/ 밑의 기록\(log\/subagents\.jsonl\)은 훅이.*훅과 pact 스크립트만 쓴다/);
  assert.match(say('log', 'log/subagents.jsonl').instead, /hook-error\.log를 보고 사용자에게 알린다/);
  for (const kind of ['results', 'verification', 'approvals', 'log']) for (const text of Object.values(say(kind, 'x'))) assert.doesNotMatch(text, /\n/);
});

// ---------- Edit·Write·MultiEdit·NotebookEdit ----------

test('file tools: main and other sub-agents are denied on every locked file; only the verifier may write results', () => {
  for (const name of ['results.json', 'results-round1.json', 'verification.json', 'approvals.jsonl', 'log/subagents.jsonl', 'log/new.txt']) {
    for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) blocked(tool(t, path.join(R, name)), `${t} ${name}`);
  }
  for (const name of ['results.json', 'results-round1.json']) for (const t of ['Write', 'Edit', 'MultiEdit']) free(tool(t, path.join(R, name), { verifier: true }), `verifier ${t} ${name}`);
  for (const name of ['verification.json', 'approvals.jsonl', 'log/subagents.jsonl']) blocked(tool('Write', path.join(R, name), { verifier: true }), `verifier ${name}`);
  for (const name of ['summary.json', 'report.html', 'plan.md', 'shots/a.jpg', 'tasks/1-report.md', 'wt/results.json', 'wt/sub/log/x']) {
    for (const verifier of [false, true]) free(tool('Write', path.join(R, name), { verifier }), name);
  }
  free(tool('Write', path.join(w.bareRun, 'results.json')), '명세 없는 폴더');
  free(tool('Write', path.join(w.other, '.pact', ID, 'results.json')), '다른 프로젝트');
});

test('file tools: a relative path is read from the cwd, ~ from the home folder, and $ or * in a tool path are plain characters', () => {
  blocked(tool('Write', 'results.json', { cwd: R }), '실행 폴더 안에서 상대 경로');
  blocked(tool('Write', `.pact/${ID}/results.json`, { cwd: w.project }), '프로젝트에서 상대 경로');
  blocked(tool('Write', `../.pact/${ID}/log/x`, { cwd: path.join(w.project, 'src') }), '..');
  free(tool('Write', 'results.json', { cwd: path.join(R, 'wt') }), 'worktree 안에서');
  free(tool('Write', 'results.json', { cwd: w.project }), '프로젝트 맨 위');
  const home = checkLocks({ tool_name: 'Write', tool_input: { file_path: `~/project/.pact/${ID}/results.json` }, cwd: '/' }, { home: w.root });
  blocked(home, '~');
  free(tool('Write', path.join(R, 'wt', '$HOME', 'results.json')), '$는 글자다');
  blocked(tool('Write', path.join(R, 'results.json'), { cwd: '/' }), '절대 경로');
});

test('checkLocks never throws on odd input and passes it', () => {
  for (const input of [undefined, null, {}, { tool_name: 'Write' }, { tool_name: 'Write', tool_input: null }, { tool_name: 'Write', tool_input: { file_path: 42 } },
    { tool_name: 'Edit', tool_input: 'text' }, { tool_name: 'Bash' }, { tool_name: 'Bash', tool_input: { command: 42 } }, { tool_name: 'Bash', tool_input: { command: '' } },
    { tool_name: 'Read', tool_input: { file_path: path.join(R, 'results.json') } }, { tool_name: 'Agent', tool_input: { prompt: path.join(R, 'results.json') } }]) {
    free(checkLocks(input), JSON.stringify(input));
  }
});

// ---------- Bash: 쓰기 꼴 ----------

test('Bash: redirects, tee, sed -i, perl -i, cp, mv, rm, truncate, touch, dd that target a locked file are denied', () => {
  const writes = [
    `echo x > ${R}/results.json`, `echo x >> ${R}/results-round1.json`, `echo x>${R}/results.json`, `echo x 2>&1 >${R}/results.json`, `echo x &> ${R}/results.json`, `echo x >| ${R}/results.json`,
    `> ${R}/results.json`, `: > ${R}/verification.json`, `cat a > "${R}/approvals.jsonl"`, `echo x > '${R}/log/subagents.jsonl'`, `echo x >> ${R}/log/new.log`,
    `jq '.x=1' ${R}/results.json > ${R}/results.json`, `jq . a.json > ${R}/results.json`, `curl -s u > ${R}/results.json`,
    `jq '.x=1' ${R}/results.json | tee ${R}/results.json`, `echo x | tee -a ${R}/results.json`, `echo x | sponge ${R}/results.json`, `echo x | tee /tmp/a ${R}/results.json`,
    `sed -i '' 's/a/b/' ${R}/results.json`, `sed -i 's/a/b/' ${R}/results.json`, `sed -i.bak 's/a/b/' ${R}/results.json`, `sed --in-place=.bak s/a/b/ ${R}/results.json`,
    `sed -E -i -e 's/a/b/' ${R}/results.json`, `sed -ni 's/a/b/p' ${R}/results.json`,
    `perl -pi -e 's/a/b/' ${R}/results.json`, `perl -i.bak -pe 's/a/b/' ${R}/results.json`, `perl -0pi -e 's/a/b/' ${R}/results.json`,
    `cp a.json ${R}/results.json`, `cp -f a.json ${R}/results-round1.json`, `cp a.json ${R}/`, `cp -t ${R} results.json`, `cp --target-directory=${R} results.json`, `install a ${R}/results.json`, `rsync a ${R}/results.json`, `ln -sf a ${R}/results.json`,
    `mv a.json ${R}/results.json`, `mv ${R}/results.json /tmp/gone.json`, `mv /tmp/x.json ${R}/results.json`, `mv results.json ${R}/`,
    `rm ${R}/results.json`, `rm -f ${R}/results-round1.json ${R}/verification.json`, `rm -rf ${R}/log`, `rm -rf ${R}/log/subagents.jsonl`, `unlink ${R}/approvals.jsonl`,
    `truncate -s 0 ${R}/approvals.jsonl`, `touch ${R}/log/subagents.jsonl`, `touch ${R}/results.json`, `dd if=a of=${R}/results.json`, `dd if=a of=${R}/verification.json bs=1`,
  ];
  // cp·mv의 `results.json` 원본은 상대 경로라 폴더(R)로 가는 것만 의미가 있다: cp a.json R/ 은 a.json이라는 이름의 파일이라 막지 않는다
  const exceptions = new Set([`cp a.json ${R}/`]);
  for (const command of writes) {
    if (exceptions.has(command)) { free(bash(command), command); continue; }
    blocked(bash(command, { cwd: R }), command);
    blocked(bash(command, { cwd: '/' }), `다른 cwd에서 ${command}`);
  }
});

test('Bash: reading, copying out, and every file that is not locked pass', () => {
  const reads = [
    `cat ${R}/results.json`, `jq . ${R}/results.json`, `jq '.scenarios | length' ${R}/results.json`, `grep headline ${R}/results.json`, `head -c 100 ${R}/results.json`, `wc -c ${R}/results.json ${R}/verification.json`,
    `ls -la ${R}`, `ls ${R}/*.json`, `ls ${R}/results*.json`, `cat ${R}/log/subagents.jsonl | jq .`, `tail -n 3 ${R}/log/subagents.jsonl`, `sed -n '1,5p' ${R}/results.json`, `sed -e 's/a/b/' ${R}/results.json`,
    `cat ${R}/results.json > /tmp/copy.json`, `jq . ${R}/results.json > /tmp/pretty.json && diff /tmp/pretty.json ${R}/results.json`, `cp ${R}/results.json /tmp/backup.json`, `cp -p ${R}/verification.json /tmp/`, `mv /tmp/a ${R}/summary.json`,
    `echo x > ${R}/summary.json`, `echo x > ${R}/report.html`, `echo x >> ${R}/plan.md`, `echo x > ${R}/tasks/3-report.md`, `echo x > ${R}/shots/S1-1.txt`, `cp a ${R}/results.json.bak`, `touch ${R}/items.json`, `rm -f ${R}/shots/*.png`, `rm -rf ${R}/wt/node_modules`,
    `echo x > ${R}/wt/results.json`, `echo x > ${R}/wt/sub/log/x`, `rm ${R}/wt/results.json`, `perl -ne 'print' ${R}/results.json`, `perl -MList::Util=sum -le 'print sum(1,2)' ${R}/results.json`,
    `echo x > ${w.bareRun}/results.json`, `echo x > ${w.other}/.pact/${ID}/results.json`, `echo x > /tmp/results.json`,
    // 훅이 막는 것은 쓰기 꼴이지 낱말이 아니다: 커밋 메시지, 검색, echo
    `git commit -m "echo x > ${R}/results.json 같은 쓰기를 막는다 fs.writeFileSync('${R}/results.json')"`,
    `git commit -m "$(cat <<'EOF'\nfeat: cp a ${R}/results.json 와 sed -i ${R}/results.json 를 막는다\n\n- echo x > ${R}/results.json\nEOF\n)"`,
    `grep -rn "results.json" ${R}`, `echo "rm ${R}/results.json"`, `echo 'tee ${R}/results.json'`, `# echo x > ${R}/results.json`, `printf '%s\\n' "echo x > ${R}/results.json" > /tmp/note.txt`,
    `ls ${R}; echo done 2>&1`, `node --test tests/`, `python3 -m pytest -q`, `git status --short`,
  ];
  for (const command of reads) {
    free(bash(command), command);
    free(bash(command, { cwd: R }), `실행 폴더 안에서 ${command}`);
  }
  // 상대 경로는 cwd로 정해진다: 프로젝트 맨 위에서는 그냥 파일이고, 실행 폴더 안에서는 잠긴 파일이다
  free(bash('echo x > results.json'), '프로젝트 맨 위의 results.json');
  free(bash('echo x > results.json', { cwd: path.join(R, 'wt') }), 'worktree 안의 results.json');
  blocked(bash('echo x > results.json', { cwd: R }), '실행 폴더 안의 results.json');
});

test('Bash: a pact script call passes, and a write form in the same command is still caught', () => {
  const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const command of [
    `node ${plugin}/scripts/verification.mjs snapshot ${w.project}/docs/pact/${ID}.md ${R}/wt ui`,
    `node ${plugin}/scripts/verification.mjs finish ${w.project}/docs/pact/${ID}.md ${w.project}`,
    `node ${plugin}/scripts/verification.mjs check ${w.project}/docs/pact/${ID}.md ${R}/wt 2>&1 | tail -3`,
    `node ${plugin}/scripts/report.mjs ${R}`, `node ${plugin}/scripts/report.mjs ${R} > /tmp/report.txt`,
    `node ${plugin}/scripts/spec.mjs approve ${w.project}/docs/pact/${ID}.md - <<'EOF'\n승인\nEOF`,
    `node /somewhere/else/scripts/report.mjs ${R}`,
  ]) free(bash(command), command);
  for (const command of [
    `node ${plugin}/scripts/verification.mjs snapshot a b ui && echo x > ${R}/results.json`,
    `node ${plugin}/scripts/report.mjs ${R} && cp /tmp/x ${R}/results.json`,
    `node ${plugin}/scripts/verification.mjs snapshot a b ui; rm ${R}/results-round1.json`,
    `node ${plugin}/scripts/report.mjs ${R} | tee ${R}/results.json`,
    `node ${plugin}/scripts/verification.mjs snapshot a b ui > ${R}/verification.json`,
    `node /somewhere/else/scripts/report.mjs ${R} > ${R}/results.json`,
  ]) blocked(bash(command), command);
});

test('Bash: cd, shell variables, wrappers and nested shells are followed', () => {
  for (const command of [
    `cd ${R} && echo x > results.json`, `cd ${R}; cp /tmp/a results-round1.json`, `cd "${R}" && sed -i '' s/a/b/ results.json`, `cd ${R} && cd log && echo x > subagents.jsonl`,
    `(cd ${R} && echo x > results.json)`, `cd ${w.project} && cd .pact/${ID} && echo x > results.json`, `cd ${w.project}/.pact && cd ${ID} && rm results.json`,
    `RUN=${R}; echo x > $RUN/results.json`, `RUN=${R} && jq . $RUN/results.json > $RUN/results.new && mv $RUN/results.new $RUN/results.json`,
    `export RUN=${R}; echo x > "$RUN/results.json"`, `RUN=${w.project}/.pact; echo x > \${RUN}/${ID}/results.json`,
    `bash -c 'echo x > ${R}/results.json'`, `sh -c "cp a ${R}/results.json"`, `bash -lc 'cd ${R} && echo x > results.json'`, `eval "echo x > ${R}/results.json"`,
    `bash <<'EOF'\necho x > ${R}/results.json\nEOF`, `bash -c "bash -c 'echo x > ${R}/results.json'"`,
    `env FOO=1 tee ${R}/results.json`, `FOO=1 BAR=2 cp a ${R}/results.json`, `nohup cp a ${R}/results.json &`, `time cp a ${R}/results.json`, `sudo rm ${R}/results.json`, `env -i PATH=/bin cp a ${R}/results.json`,
    `if true; then echo x > ${R}/results.json; fi`, `for f in a; do cp $f ${R}/results.json; done`, `true && { echo x > ${R}/results.json; }`, `echo $(echo x > ${R}/results.json)`, `echo \`cp a ${R}/results.json\``,
    `echo "$(cp a ${R}/results.json)"`, `cd ${R}/.. && cd .. && cd .pact/${ID} && echo x > results.json`,
  ]) blocked(bash(command, { cwd: '/' }), command);
  blocked(bash(`D=.pact; echo x > $D/${ID}/results.json`, { cwd: w.project }), '상대 경로 변수');
  // 풀 수 없으면 건드리지 않는다: 이 명령 안에서 정하지 않은 변수, 모르는 cwd
  for (const command of [`echo x > $UNKNOWN/results.json`, `cd $UNKNOWN && echo x > results.json`, `cd - && echo x > results.json`, `echo x > "$(pwd)/results.json"`, `echo x > ${R}/\${NAME:-a}.json`]) {
    free(bash(command, { cwd: w.project }), command);
  }
  // cd로 worktree 밑에 들어가면 대상이 아니다. 잠긴 폴더로 다시 나오면 건다
  free(bash(`cd ${R}/wt/sub && echo x > results.json`), 'worktree 안');
  free(bash(`cd ${R}/wt && cp a log/x && rm results.json`), 'worktree 안 log/');
  blocked(bash(`cd ${R}/wt && cd .. && echo x > results.json`), 'wt에서 나옴');
});

test('Bash: a heredoc is text unless it is the script of an interpreter, and the target of its redirect is what counts', () => {
  blocked(bash(`cat > ${R}/results.json <<'EOF'\n{"scenarios": []}\nEOF`), 'cat > results.json <<EOF');
  free(bash(`cat > ${R}/results.json <<'EOF'\n{"scenarios": []}\nEOF`, { verifier: true }), 'verifier가 같은 것을 쓴다');
  blocked(bash(`cat > ${R}/verification.json <<'EOF'\n{}\nEOF`, { verifier: true }), 'verifier도 verification.json은 못 쓴다');
  free(bash(`cat > /tmp/notes.md <<'EOF'\nresults.json에 쓴다: echo x > ${R}/results.json 그리고 cp a ${R}/results.json\nfs.writeFileSync('${R}/results.json', 'x')\nEOF`), '본문은 글이다');
  free(bash(`cat > ${R}/summary.json <<'EOF'\n{"headline": "results.json을 읽는다. open('${R}/results.json', 'w')"}\nEOF`), 'summary.json 본문');
  free(bash(`node /x/scripts/spec.mjs approve spec.md - <<'EOF'\nresults.json fs.writeFileSync('${R}/results.json')\nEOF`), '스크립트 파일을 돌릴 때 붙은 heredoc은 그 스크립트의 입력이다');
  free(bash(`python3 script.py <<'EOF'\nopen('${R}/results.json', 'w')\nEOF`), 'python 스크립트 파일의 입력');
  free(bash(`git commit -m "$(cat <<'EOF'\nopen('${R}/results.json', 'w') echo x > ${R}/results.json\nEOF\n)"`), '커밋 메시지');
});

// ---------- Bash: 한 줄 스크립트 ----------

test('inline scripts: Python and Node writes to a locked file are denied, in every way a path is built', () => {
  const py = (code) => `python3 -c ${JSON.stringify(code)}`;
  const node = (code) => `node -e ${JSON.stringify(code)}`;
  const denies = [
    py(`import json; json.dump({}, open('${R}/results.json','w'))`),
    py(`open('${R}/results.json','w').write('x')`), py(`open('${R}/results.json',"a").write('x')`), py(`open('${R}/results.json', mode='w').write('x')`), py(`open('${R}/results.json','r+').write('x')`),
    py(`open('${R}/results.json','wb').write(b'x')`), py(`open('${R}/verification.json','x')`), py(`open('${R}/approvals.jsonl','a').write('x')`), py(`open('${R}/log/subagents.jsonl','a').write('x')`),
    py(`import io; io.open('${R}/results.json','w')`), py(`import codecs; codecs.open('${R}/results.json','w','utf8')`),
    py(`p='${R}/results.json'; d=open(p).read(); open(p,'w').write(d)`), py(`p = "${R}/results.json"\nwith open(p, 'w') as f:\n  f.write('x')`),
    py(`import os; RUN='${R}'; open(os.path.join(RUN,'results.json'),'w').write('x')`), py(`RUN='${R}'; open(RUN + '/results.json','w').write('x')`), py(`RUN='${R}'; open(f'{RUN}/results.json','w').write('x')`),
    py(`import os; RUN='${R}'; p = os.path.join(RUN, 'results.json'); open(p, 'w').write('x')`), py(`from pathlib import Path; Path('${R}/results.json').write_text('x')`),
    py(`from pathlib import Path; Path('${R}', 'results.json').write_text('x')`), py(`from pathlib import Path; p = Path('${R}') / 'results.json'; p.write_text('x')`), py(`from pathlib import Path; (Path('${R}') / 'results.json').write_bytes(b'x')`),
    py(`from pathlib import Path; Path('${R}/results.json').unlink()`), py(`import os; os.remove('${R}/results.json')`), py(`import os; os.rename('/tmp/a', '${R}/results.json')`), py(`import os; os.replace('/tmp/a', '${R}/results.json')`),
    py(`import shutil; shutil.copy('/tmp/a', '${R}/results.json')`), py(`import shutil; shutil.copyfile('/tmp/a', '${R}/results.json')`), py(`import shutil; shutil.move('/tmp/a', '${R}/results.json')`), py(`import shutil; shutil.move('${R}/results.json', '/tmp/a')`),
    py(`import os, tempfile, json; RD='${R}'; t=tempfile.NamedTemporaryFile('w', delete=False); json.dump({}, t); t.close(); os.replace(t.name, f'{RD}/results.json')`),
    node(`require('fs').writeFileSync('${R}/results.json', '{}')`), node(`const fs=require('fs'); fs.writeFileSync('${R}/results.json', JSON.stringify({}))`), node(`const fs=require('fs'); fs.appendFileSync('${R}/log/subagents.jsonl', 'x')`),
    node(`const fs=require('fs'); const p='${R}/results.json'; const r=JSON.parse(fs.readFileSync(p,'utf8')); fs.writeFileSync(p, JSON.stringify(r))`),
    node(`import fs from 'node:fs'; fs.promises.writeFile('${R}/results.json', 'x')`), node(`const fsp=require('fs/promises'); fsp.writeFile('${R}/results.json', 'x')`), node(`const {writeFileSync}=require('fs'); writeFileSync('${R}/results.json','x')`),
    node(`const fs=require('fs'); fs.createWriteStream('${R}/results.json')`), node(`const fs=require('fs'); fs.copyFileSync('/tmp/a', '${R}/results.json')`), node(`const fs=require('fs'); fs.renameSync('/tmp/a', '${R}/results.json')`),
    node(`const fs=require('fs'); fs.unlinkSync('${R}/results.json')`), node(`const fs=require('fs'); fs.rmSync('${R}/results-round1.json')`), node(`const fs=require('fs'); fs.rename('/tmp/a', '${R}/results.json', ()=>{})`),
    node(`const fs=require('fs'); const run='${R}'; const p=run+'/results.json'; fs.writeFileSync(p,'x')`), node(`const fs=require('fs'), path=require('path'); const run='${R}'; fs.writeFileSync(path.join(run,'results.json'),'x')`),
    `node -e 'const fs=require("fs"); const run="${R}"; fs.writeFileSync(\`\${run}/results.json\`, "x")'`, node(`const fs=require('fs'); fs.openSync('${R}/results.json','w')`),
    `node -p "require('fs').writeFileSync('${R}/results.json','x')"`, `node --eval="require('fs').writeFileSync('${R}/results.json','x')"`, `node --input-type=module -e "import {writeFileSync} from 'node:fs'; writeFileSync('${R}/results.json','x')"`,
    `bun -e "require('fs').writeFileSync('${R}/results.json','x')"`, `python3 -I -c "open('${R}/results.json','w')"`, `/usr/bin/python3 -c "open('${R}/results.json','w')"`, `python -c "open('${R}/results.json','w')"`,
    `python3 - <<'EOF'\nimport json\np='${R}/results.json'\nd=json.load(open(p))\njson.dump(d, open(p,'w'))\nEOF`,
    `python3 <<'EOF'\nopen('${R}/results.json','w').write('x')\nEOF`, `python3 - <<< "open('${R}/results.json','w')"`,
    `node <<'EOF'\nrequire('fs').writeFileSync('${R}/results.json','x')\nEOF`, `node - <<'EOF'\nrequire('fs').writeFileSync('${R}/results.json','x')\nEOF`, `node --input-type=module <<'EOF'\nimport fs from 'fs'; fs.writeFileSync('${R}/results.json','x')\nEOF`,
    `cd ${R} && python3 - <<'EOF'\nimport json\nd=json.load(open('results.json'))\njson.dump(d, open('results.json','w'))\nEOF`,
    `cd ${R} && node -e "const fs=require('fs'); fs.writeFileSync('results.json', '{}')"`,
    `cd ${R}; /usr/bin/python3 -I - <<'EOF'\nimport json\nRD='${R}'\nd=json.load(open(f'{RD}/results.json'))\njson.dump(d, open(f'{RD}/results.json','w'))\nEOF`,
    `cd ${R} && node - <<'EOF'\nconst fs=require("fs"); const r=JSON.parse(fs.readFileSync("results.json","utf8")); r.rulings=[]; fs.writeFileSync("results.json", JSON.stringify(r,null,2));\nEOF`,
    `RUN=${R}; python3 -c "open('$RUN/results.json','w')"`,
  ];
  for (const command of denies) blocked(bash(command, { cwd: '/' }), command);
});

test('inline scripts: reading a locked file, writing any other file, and code that only appears inside a string pass', () => {
  const py = (code) => `python3 -c ${JSON.stringify(code)}`;
  const node = (code) => `node -e ${JSON.stringify(code)}`;
  const frees = [
    py(`import json; print(json.load(open('${R}/results.json'))['scenarios'])`), py(`print(open('${R}/results.json').read())`), py(`print(open('${R}/results.json', 'r').read())`), py(`print(open('${R}/results.json', 'rb').read())`),
    py(`import json; d=json.load(open('${R}/results.json')); json.dump(d, open('${R}/summary.json','w'))`), py(`import json,os; RUN='${R}'; d=json.load(open(os.path.join(RUN,'results.json'))); open(os.path.join(RUN,'summary.json'),'w').write('x')`),
    py(`import json; RUN='${R}'; d=json.load(open(RUN+'/results.json')); p=RUN+'/summary.json'; open(p,'w').write(json.dumps({s['id']: s['title'] for s in d['scenarios']}))`),
    py(`import sys; sys.stdout.write(open('${R}/results.json').read())`), py(`open('/tmp/results.json','w').write('x')`), py(`import os; open(os.path.join('/tmp/x','results.json'),'w').write('x')`),
    py(`open('${R}/wt/results.json','w').write('x')`), py(`open('${R}/tasks/3-report.md','w').write('x')`), py(`open('${R}/report.html','w').write('x')`), py(`from pathlib import Path; Path('${R}/summary.json').write_text('x')`),
    py(`s='${R}/results.json'.replace('results.json', 'x.json'); print(s)`), py(`p='${R}/results.json'; print(p.replace('json','txt'))`),
    node(`const r=require('${R}/results.json'); process.stdout.write(String(r.scenarios.length))`), node(`const fs=require('fs'); console.log(JSON.parse(fs.readFileSync('${R}/results.json','utf8')).scenarios.length)`),
    node(`const fs=require('fs'); const r=JSON.parse(fs.readFileSync('${R}/results.json','utf8')); fs.writeFileSync('${R}/summary.json', JSON.stringify({headline:String(r.scenarios.length)}))`),
    node(`const fs=require('fs'); fs.writeFileSync('/tmp/results.json','x')`), node(`const fs=require('fs'); fs.writeFileSync('${R}/wt/log','x')`), node(`const s='x'.replace('a','b'); console.log(s, '${R}/results.json')`),
    // 문자열로 적어 둔 코드는 호출이 아니다
    `python3 - <<'EOF'\nimport pathlib\np = pathlib.Path('tests/a.test.mjs')\ns = p.read_text()\nnew = """test('x', () => {\n  writeFileSync(path.join(w.run, 'results.json'), '{}');\n  fs.appendFileSync('${R}/log/subagents.jsonl', 'x');\n});"""\np.write_text(s + new)\nEOF`,
    `node -e "const code = 'fs.writeFileSync(\\"${R}/results.json\\", 1)'; console.log(code)"`,
    // 이 폴더 밖의 폴더에 쓰는 것: 실행 폴더 조각이 아니라 cwd 밑 이름이다
    `cd ${R}/wt && node --input-type=module -e "import fs from 'node:fs'; import path from 'node:path'; const dir = path.join('/tmp/jobs', 'j1'); fs.writeFileSync(path.join(dir, 'log'), 'x'); fs.writeFileSync(path.join(dir, 'results.json'), 'x')"`,
    `cd ${R}/wt && python3 -c "import os; open(os.path.join('/tmp/q', 'log'), 'w'); open('results.json', 'w')"`,
    // 스크립트 파일은 못 본다
    `python3 fix.py ${R}/results.json`, `node fix.mjs ${R}/results.json`, `python3 -m json.tool ${R}/results.json`, `node --test tests/ ${R}/results.json`,
  ];
  for (const command of frees) free(bash(command, { cwd: w.project }), command);
});

test('a relative path in a script is read from the cwd only when it is the whole path; a piece joined onto another folder is not', () => {
  const py = (code) => `python3 -c ${JSON.stringify(code)}`;
  const node = (code) => `node -e ${JSON.stringify(code)}`;
  // cwd가 실행 폴더일 때 경로 전체가 이름 하나이면 잠긴 파일이다
  for (const code of [
    py(`open('results.json', 'w')`), py(`open("results.json", "w")`), py(`p = 'results.json'; open(p, 'w')`), `python3 - <<'EOF'\np = "./results.json"\nwith open(p, "w") as f:\n  f.write('x')\nEOF`,
    py(`import json; d = json.load(open('results.json')); json.dump(d, open('results.json', 'w'))`), py(`open(r'results-round1.json', 'w')`), py(`open('log/subagents.jsonl', 'a')`), py(`open('approvals.jsonl', 'a')`),
    node(`require('fs').writeFileSync('results.json', '{}')`), node(`const fs=require('fs'); const f='verification.json'; fs.writeFileSync(f, '{}')`),
  ]) blocked(bash(code, { cwd: R }), code);
  // 같은 글을 프로젝트 맨 위나 worktree에서 쓰면 잠긴 파일이 아니다
  for (const cwd of [w.project, path.join(R, 'wt'), path.join(R, 'tasks')]) {
    free(bash(py(`open('results.json', 'w')`), { cwd }), `cwd ${cwd}`);
    free(bash(node(`require('fs').writeFileSync('log/subagents.jsonl', 'x')`), { cwd }), `cwd ${cwd}`);
  }
  // 다른 폴더에 이름을 이어 붙인 것은 cwd 밑 파일이 아니다: 임시 폴더나 연습 폴더에 results.json을 쓰는 것
  for (const code of [
    py(`import os, tempfile; d = tempfile.mkdtemp(); open(os.path.join(d, 'results.json'), 'w').write('x')`),
    py(`import os; S = '/tmp/scratch'; open(os.path.join(S, 'results.json'), 'w').write('x')`),
    py(`import os; S = '/tmp/scratch'; p = os.path.join(S, 'verification.json'); open(p, 'w').write('x')`),
    py(`from pathlib import Path; (Path('/tmp/s') / 'results.json').write_text('x')`),
    py(`import sys; open(sys.argv[1] + '/results.json', 'w').write('x')`),
    node(`const fs=require('fs'), path=require('path'); fs.writeFileSync(path.join('/tmp/s', 'results.json'), 'x')`),
    node(`const fs=require('fs'), path=require('path'); const dir=fs.mkdtempSync('/tmp/x-'); fs.writeFileSync(path.join(dir, 'log'), 'x')`),
  ]) free(bash(code, { cwd: R }), `실행 폴더 안에서 ${code}`);
  // 절대 경로와, 실행 폴더 글에 이어 붙인 이름은 cwd와 상관없이 잠긴 파일이다
  blocked(bash(py(`open('${R}/results.json', 'w')`), { cwd: w.project }), '절대 경로');
  blocked(bash(py(`import os; open(os.path.join('${R}', 'results.json'), 'w')`), { cwd: w.project }), '실행 폴더 글 + 이름');
  blocked(bash(py(`import os; RUN = '.pact/${ID}'; open(os.path.join(RUN, 'results.json'), 'w')`), { cwd: w.project }), '상대 실행 폴더 글 + 이름');
});

test('a path through the worktree or another folder under the run dir is not a run-dir piece: joining a locked name onto it is not a locked file', () => {
  const py = (code) => `python3 -c ${JSON.stringify(code)}`;
  for (const code of [
    py(`import os; open(os.path.join('${R}/wt', 'log'), 'w')`), py(`import os; open(os.path.join('${R}/wt/sub', 'results.json'), 'w')`),
    py(`import os; open(os.path.join('${R}/tasks', 'results.json'), 'w')`), py(`import os; RUN='${R}/shots'; open(os.path.join(RUN, 'approvals.jsonl'), 'w')`),
    py(`import os; open(os.path.join('${w.project}/.pact', 'results.json'), 'w')`), py(`import os; open(os.path.join('${w.project}', 'results.json'), 'w')`),
    // 앞에 폴더가 붙은 글은 경로 전체이지 이름 조각이 아니다: 실행 폴더 조각과 이어 보지 않는다
    py(`import os; RUN='${R}'; open(os.path.normpath(RUN + '/../..' + '/tmp/other/results.json'), 'w')`),
  ]) free(bash(code, { cwd: w.project }), code);
  // 실행 폴더 바로 그것에 이어 붙이면 잠긴 파일이다
  for (const code of [py(`import os; open(os.path.join('${R}', 'log'), 'w')`), py(`import os; open(os.path.join('${R}/', 'results.json'), 'w')`), py(`import os; open(os.path.join('.pact/${ID}', 'verification.json'), 'w')`)]) {
    blocked(bash(code, { cwd: w.project }), code);
  }
});

test('commands taken from real conversation records (paths moved into the test project) are caught or passed as they should be', () => {
  // 0.5.0 때 메인 세션이 results.json을 고친 꼴들: 모두 막힌다
  const edits = [
    `R=${R}; jq --slurpfile r $R/rulings.tmp.json '.rulings = $r[0]' $R/results.json > $R/results.tmp.json && mv $R/results.tmp.json $R/results.json && rm $R/rulings.tmp.json`,
    `node -e '\nconst fs = require("fs");\nconst spec = fs.readFileSync("docs/pact/${ID}.md", "utf8");\nconst rulings = spec.slice(spec.indexOf("## 결정 기록")).split("\\n").filter(l => l.startsWith("- Ruling:")).map(l => l.slice(2));\nconst f = ".pact/${ID}/results.json";\nconst r = JSON.parse(fs.readFileSync(f, "utf8")); r.rulings = rulings; fs.writeFileSync(f, JSON.stringify(r, null, 2));\n'`,
    `python3 -I - <<'EOF'\nimport json\np = '.pact/${ID}/results.json'\nd = json.load(open(p, encoding='utf8'))\nd['headline'] = '다 됐다'\njson.dump(d, open(p, 'w', encoding='utf8'), ensure_ascii=False, indent=2)\nEOF`,
    `cd ${R} && python3 - <<'EOF'\nimport json\nd=json.load(open('results.json',encoding='utf-8'))\njson.dump(d,open('results.json','w',encoding='utf-8'),ensure_ascii=False,indent=2)\nEOF`,
    `perl -CSD -0pi -e 's/화면 정리 명세 R13으로/화면 정리 명세 R26으로/' ${R}/results.json`,
    `cd ${R} && cp results.json results-round1.json && node /x/plugin/scripts/verification.mjs snapshot ${w.project}/docs/pact/${ID}.md $PWD/wt command`,
    `R=${R}; cp $R/results.json $R/results-round2.json && cat >> $R/plan.md <<'EOF'\n## build 4\nEOF`,
  ];
  for (const command of edits) blocked(bash(command, { cwd: w.project }), command);
  // 같은 기록에서 오탐이었던 것: 시험 코드를 글로 다루는 worker, worktree 안의 시험 폴더
  free(bash(`cd ${R}/wt/plugins/pact && python3 - <<'EOF'\nimport pathlib\np = pathlib.Path('tests/approval.test.mjs')\ns = p.read_text()\nnew_tests = """test('x', () => {\n  writeFileSync(path.join(w.run, 'log', 'subagents.jsonl'), '{}');\n  writeFileSync(path.join(w.run, 'approvals.jsonl'), '{}');\n});"""\np.write_text(s + new_tests)\nEOF`), '코드를 글로 다루는 worker');
  free(bash(`cd ${R}/wt && node --input-type=module -e '\nimport fs from "node:fs"; import path from "node:path";\nconst dir = path.join(fake.jobsDir, "j0000abcd");\nfs.writeFileSync(path.join(dir, "pid"), "1");\nfs.writeFileSync(path.join(dir, "log"), "x");\n'`), 'worktree 안의 시험 폴더');
  // results.json을 읽고 summary.json을 쓰는 메인의 새 흐름
  free(bash(`python3 - <<'EOF'\nimport json\nR = '${R}'\nd = json.load(open(f'{R}/results.json', encoding='utf8'))\nsummary = {'headline': '다 됐다', 'todo': [], 'changes': [], 'decision': {s['id']: '그대로 둔다' for s in d['scenarios'] if s['result'] == 'doubt'}}\njson.dump(summary, open(f'{R}/summary.json', 'w', encoding='utf8'), ensure_ascii=False, indent=2)\nEOF`), 'summary.json 쓰기');
});

test('a call that only builds a path (Path(...), path.resolve(...), Path.cwd() / ...) around one name still counts as the whole path', () => {
  const heredoc = (code) => `python3 - <<'EOF'\n${code}\nEOF`;
  const node = (code) => `node -e ${JSON.stringify(code)}`;
  // 진짜 기록에서 본 꼴: Path('상대 경로') 변수에 write_text, Path('results.json')을 열어 json.dump
  for (const [command, cwd] of [
    [heredoc(`from pathlib import Path\nimport json\nR = Path(".pact/${ID}/results.json")\nr = json.loads(R.read_text(encoding="utf-8"))\nR.write_text(json.dumps(r), encoding="utf-8")`), w.project],
    [heredoc(`from pathlib import Path\nR = Path("results.json")\nR.write_text("{}")`), R],
    [heredoc(`import json\nfrom pathlib import Path\np=Path('results.json'); d=json.load(open(p))\njson.dump(d, open(p,'w'))`), R],
    [heredoc(`import pathlib\nopen(pathlib.Path('results-round1.json'), 'w')`), R],
    [heredoc(`from pathlib import Path\n(Path.cwd() / 'results.json').write_text('x')`), R],
    [heredoc(`import os\nopen(os.path.abspath('results.json'), 'w')`), R],
    [heredoc(`import os\nopen(os.path.join(os.getcwd(), 'results.json'), 'w')`), R],
    [node(`const fs=require('fs'), path=require('path'); fs.writeFileSync(path.resolve('results.json'), '{}')`), R],
    [node(`const fs=require('fs'), path=require('path'); fs.writeFileSync(path.join(process.cwd(), 'results.json'), '{}')`), R],
    [node(`const fs=require('fs'), path=require('path'); const f = path.resolve(".pact/${ID}/results.json"); fs.writeFileSync(f, '{}')`), w.project],
  ]) blocked(bash(command, { cwd }), `${cwd === R ? '실행 폴더 안' : '프로젝트'}: ${command}`);
  // 같은 꼴이라도 cwd가 실행 폴더가 아니면 잠긴 파일이 아니다
  for (const command of [
    heredoc(`from pathlib import Path\nPath("results.json").write_text("x")`),
    heredoc(`from pathlib import Path\n(Path.cwd() / 'results.json').write_text('x')`),
    node(`const fs=require('fs'), path=require('path'); fs.writeFileSync(path.resolve('results.json'), '{}')`),
  ]) {
    free(bash(command, { cwd: w.project }), `프로젝트 맨 위: ${command}`);
    free(bash(command, { cwd: path.join(R, 'wt') }), `worktree 안: ${command}`);
  }
  // 이어 붙인 경로는 여전히 경로 전체가 아니다
  free(bash(heredoc(`from pathlib import Path\n(Path('/tmp/s') / 'results.json').write_text('x')`), { cwd: R }), 'Path / 이름');
  free(bash(heredoc(`import os\nopen(os.path.join(os.getcwd(), 'sub', 'results.json'), 'w')`), { cwd: R }), '두 칸 이상 이어 붙임');
});

test('the verifier may write results.json by script, but not a lock it may not touch, even when the same script also writes results', () => {
  const py = (code) => `python3 -c ${JSON.stringify(code)}`;
  free(bash(py(`import json; d=json.load(open('${R}/results.json')); json.dump(d, open('${R}/results.json','w'))`), { verifier: true }), 'results by script');
  free(bash(`node -e "require('fs').writeFileSync('${R}/results-round1.json','x')"`, { verifier: true }), 'round file');
  blocked(bash(py(`open('${R}/verification.json','w')`), { verifier: true }), 'verification.json by script');
  blocked(bash(py(`import json; v=json.load(open('${R}/verification.json')); open('${R}/results.json','w'); open('${R}/log/subagents.jsonl','a')`), { verifier: true }), 'log by script next to results');
  free(bash(py(`import json; v=json.load(open('${R}/verification.json')); json.dump({'verification_id': v['verification_id']}, open('${R}/results.json','w'))`), { verifier: true }), '읽는 verification.json은 막지 않는다');
});

test('a path that ends in subagents.jsonl is a log/ file: the verifier may not write it even when the path is derived from results.json', () => {
  const py = (code) => `python3 -c ${JSON.stringify(code)}`;
  const RES = `res = Path('${R}/results.json')`;
  for (const code of [
    py(`from pathlib import Path; ${RES}; (res.parent / 'log' / 'subagents.jsonl').write_text('x')`),
    py(`from pathlib import Path; ${RES}; res.with_name('subagents.jsonl').write_text('x')`),
    py(`import os; res = '${R}/results.json'; open(os.path.join(os.path.dirname(res), 'log', 'subagents.jsonl'), 'a')`),
  ]) {
    for (const verifier of [false, true]) blocked(bash(code, { verifier }), `${verifier ? 'verifier' : 'main'}: ${code}`);
    assert.match(bash(code, { verifier: true }).reason, /log\/ 밑의 기록\(log\/subagents\.jsonl\)/, '종류는 log다');
  }
  // 가운데에 폴더가 낀 경로는 풀어 주되, 위로 올라가거나 log/ 밑이거나 모르는 칸이 끼면 그대로 막는다
  for (const code of [
    py(`import os; RUN = '${R}'; open(os.path.join(RUN, 'wt', '..', 'results.json'), 'w')`),
    py(`import os; RUN = '${R}'; open(os.path.join(RUN, 'log', 'results.json'), 'w')`),
    py(`import os, sys; RUN = '${R}'; open(os.path.join(RUN, sys.argv[1], 'results.json'), 'w')`),
    py(`import os; RUN = '${R}'; open(os.path.join(RUN, '.', 'results.json'), 'w')`),
    py(`import os; RUN = '${R}'; open(os.path.join(RUN, 'wt', '${R}/results.json'), 'w')`),
    py(`from pathlib import Path; RUN = Path('${R}'); (RUN / '..' / '${path.basename(R)}' / 'results.json').write_text('x')`),
  ]) blocked(bash(code), code);
});

test('a glob is read against the names that exist and the locked names, and a broken pattern is only text', () => {
  blocked(bash(`rm -f ${R}/results*.json`), 'results*.json');
  blocked(bash(`rm ${R}/results-round*.json`), 'results-round*.json');
  blocked(bash(`rm -rf ${R}/*`), '*');
  blocked(bash(`rm ${R}/ver*`), 'ver*');
  blocked(bash(`rm ${R}/appr?vals.jsonl`), '?');
  blocked(bash(`rm ${R}/[rv]*.json`), '[rv]*.json');
  blocked(bash(`rm ${R}/l*`), 'l* → log');
  blocked(bash(`mv ${R}/*.json /tmp/`), '*.json');
  blocked(bash(`cd ${R} && rm results*`), 'cd 뒤');
  free(bash(`rm ${R}/*.png`), '*.png');
  free(bash(`rm ${R}/shots/*`), 'shots/*');
  free(bash(`rm ${R}/wt/*`), 'wt/*');
  free(bash(`rm -f ${R}/summ*.json ${R}/rep*`), 'summary·report');
  free(bash(`rm ${w.bare}/.pact/*/results*.json`), '앞 폴더의 와일드카드는 따지지 않는다');
  free(bash(`sed -i 's/[a/b/' file.txt && echo done`), '짝이 안 맞는 [');
  free(bash(`rm ${R}/[abc`), '짝이 안 맞는 [');
});

test('a locked file in the same command is found whichever part of a long command it hides in', () => {
  blocked(bash(`ls && git status && echo a | tee /tmp/b; cat /tmp/b > /dev/null; cp /tmp/b ${R}/results.json; echo done`), '끝에 숨은 cp');
  blocked(bash(`echo 1\n\necho 2\n# 주석\ncp a ${R}/results.json\n`), '줄바꿈 뒤');
  blocked(bash(`echo start && python3 - <<'EOF'\nprint(1)\nEOF\nrm ${R}/log/subagents.jsonl`), 'heredoc 뒤');
  free(bash(`${'echo x; '.repeat(2000)}`), '아주 긴 명령도 지나간다');
  blocked(bash(`echo ${'x'.repeat(300000)} > ${R}/results.json`), '30만 자도 본다');
});

// ---------- 검토 반영: 잠긴 파일의 경로에서 이끌어 낸 다른 파일은 막지 않는다 ----------

test('a file derived from a locked path (parent, dirname, with_name, replace, a slice, a suffix) is judged by its own last name: summary.json, shots/… and plan.md pass', () => {
  const py = (code) => `python3 -c ${JSON.stringify(code)}`;
  const node = (code) => `node -e ${JSON.stringify(code)}`;
  const RES = `res = Path('${R}/results.json')`;
  const main = [
    // 메인의 새 흐름: results.json을 읽고 그 옆에 summary.json을 쓴다
    py(`from pathlib import Path; ${RES}; (res.parent / 'summary.json').write_text('x')`),
    py(`from pathlib import Path; ${RES}; res.parent.joinpath('summary.json').write_text('x')`),
    py(`from pathlib import Path; ${RES}; (res.parent / 'shots' / 'S1-1.txt').write_text('x')`),
    py(`from pathlib import Path; ${RES}; res.with_name('summary.json').write_text('x')`),
    py(`from pathlib import Path; ${RES}; res.with_suffix('.bak').write_text('x')`),
    py(`from pathlib import Path; ${RES}; Path(str(res).replace('results', 'summary')).write_text('x')`),
    py(`import os; res = '${R}/results.json'; open(os.path.join(os.path.dirname(res), 'summary.json'), 'w')`),
    py(`import os; res = '${R}/results.json'; open(os.path.join(os.path.dirname(res), 'plan.md'), 'a')`),
    py(`src = '${R}/results.json'; open(src.replace('results.json', 'summary.json'), 'w')`),
    py(`res = '${R}/results.json'; open(res[:-12] + 'summary.json', 'w')`),
    node(`const fs=require('fs'), path=require('path'); const res='${R}/results.json'; fs.writeFileSync(path.join(path.dirname(res),'summary.json'),'x')`),
    node(`const fs=require('fs'); const res='${R}/results.json'; fs.writeFileSync(res.replace('results.json','summary.json'), '{}')`),
    node(`const fs=require('fs'); const res='${R}/results.json'; fs.writeFileSync(res.slice(0,-12) + 'summary.json', '{}')`),
    `node -e 'const fs=require("fs"), path=require("path"); const res="${R}/results.json"; fs.writeFileSync(\`\${path.dirname(res)}/summary.json\`, "{}")'`,
    // 이름 뒤에 글자를 붙인 것(백업, 임시)은 잠긴 이름이 아니다
    py(`import shutil; res = '${R}/results.json'; shutil.copy(res, res + '.bak')`),
    py(`res = '${R}/results.json'; open(res + '.tmp', 'w')`),
    py(`res = '${R}/results.json'; open(f'{res}.bak', 'w')`),
    // 마지막 칸을 모르면 이끌어 낸 값 안은 따라가지 않는다
    py(`import os, sys; res = '${R}/results.json'; name = sys.argv[1]; open(os.path.join(os.path.dirname(res), name), 'w')`),
    py(`import sys; from pathlib import Path; ${RES}; name = sys.argv[1]; open(f'{res.parent}/{name}', 'w')`),
    py(`import os; res = '${R}/results.json'; open(os.path.join(os.path.dirname(res), 'shots', f'S1-{1 + 1}.txt'), 'w')`),
    // .parent·.parents·with_name에 이름을 모르는 것을 이은 것, 폴더를 받는 쪽(shutil.copy의 도착지)도 같다
    py(`import sys; from pathlib import Path; ${RES}; name = sys.argv[1]; (res.parent / name).write_text('x')`),
    py(`import sys; from pathlib import Path; ${RES}; name = sys.argv[1]; (res.parents[0] / name).write_text('x')`),
    py(`import sys; from pathlib import Path; ${RES}; name = sys.argv[1]; res.with_name(name).write_text('x')`),
    py(`import shutil; from pathlib import Path; ${RES}; shutil.copy('/tmp/x', res.parent)`),
    // 검토 반영: JS 문자열 메서드 normalize('NFC')는 경로 호출이 아니라 마지막 칸을 정하지 않는다(summary.json은 통과)
    node(`const fs=require('fs'); const p='${R}/summary.json'; fs.writeFileSync(p.normalize('NFC'), '{}')`),
    node(`const fs=require('fs'); const p='${R}/results.json'.replace('results','summary'); fs.writeFileSync(p.normalize('NFC'), '{}')`),
    // 읽기 모드 'rs'와 pathlib가 아닌 문자열 replace(인자 둘)는 쓰기가 아니다
    node(`const fs=require('fs'); fs.openSync('${R}/results.json', 'rs')`),
    py(`res = '${R}/results.json'; name = res.replace('results', 'summary'); open('/tmp/out.txt', 'w').write(name)`),
    py(`from pathlib import Path; ${RES}; tmp = res.with_name('summary.tmp'); tmp.write_text('x'); tmp.replace(res.with_name('summary.json'))`),
    // strip은 경로를 바꾸지 않으니 따라간다: 마지막 칸이 잠긴 이름이 아니면 통과
    py(`res = '${R}/results.json'; open(res.strip() + '.bak', 'w')`),
    // 가운데 칸이 폴더면 실행 폴더 바로 밑이 아니다(wt/ 밑 worker의 작업 공간)
    py(`import os; RUN = '${R}'; open(os.path.join(RUN, 'wt', 'results.json'), 'w')`),
    py(`from pathlib import Path; RUN = Path('${R}'); (RUN / 'wt' / 'results.json').write_text('x')`),
    py(`from pathlib import Path; RUN = Path('${R}'); RUN.joinpath('wt', 'approvals.jsonl').write_text('x')`),
    py(`from pathlib import Path; RUN = Path('${R}'); Path(RUN, 'wt', 'sub', 'verification.json').write_text('x')`),
    node(`const fs=require('fs'), path=require('path'); const RUN='${R}'; fs.writeFileSync(path.join(RUN, 'wt', 'results.json'), '{}')`),
    node(`const fs=require('fs'), path=require('path'); const RUN='${R}'; fs.writeFileSync(path.resolve(RUN, 'tasks', 'log'), '{}')`),
  ];
  for (const code of main) free(bash(code), code);
  // verifier의 shots 쓰기: verification.json 경로에서 이끌어 낸 것
  for (const code of [
    py(`import os; v = '${R}/verification.json'; open(os.path.join(os.path.dirname(v), 'shots', 'S1-1.txt'), 'w')`),
    py(`from pathlib import Path; v = Path('${R}/verification.json'); (v.parent / 'shots' / 'S1-1.txt').write_text('x')`),
    node(`const fs=require('fs'), path=require('path'); const v='${R}/verification.json'; fs.writeFileSync(path.join(path.dirname(v),'shots','S1-1.png'),'x')`),
    py(`import os; v = '${R}/approvals.jsonl'; open(os.path.join(os.path.dirname(v), 'plan.md'), 'a')`),
  ]) free(bash(code, { verifier: true }), `verifier: ${code}`);
});

test('the shapes that are the locked file itself stay blocked: joined names, f-strings, Path(name), a variable, a derived path whose last name is locked, and anything under log/', () => {
  const py = (code) => `python3 -c ${JSON.stringify(code)}`;
  const nodeCode = (code) => `node -e ${JSON.stringify(code)}`;
  const RES = `res = Path('${R}/results.json')`;
  for (const [code, options] of [
    [py(`import os; RUN='${R}'; open(os.path.join(RUN,'results.json'),'w')`), {}],
    [py(`RD='${R}'; open(f'{RD}/results.json','w')`), {}],
    [py(`from pathlib import Path; p=Path('results.json'); p.write_text('x')`), { cwd: R }],
    [py(`res='${R}/results.json'; open(res,'w')`), {}],
    [py(`res='${R}/results.json'; open(f'{res}', 'w')`), {}],
    [py(`import os; res='${R}/results.json'; os.replace(res + '.tmp', res)`), {}],
    [py(`import shutil; res='${R}/results.json'; shutil.copy('/tmp/x', res)`), {}],
    // 마지막 칸이 잠긴 이름이면 이끌어 낸 값도 따라가 그 폴더를 찾는다. 잠긴 종류는 그 이름으로 정한다
    [py(`from pathlib import Path; ${RES}; (res.parent / 'results.json').write_text('x')`), {}],
    [py(`from pathlib import Path; ${RES}; res.with_name('results-round3.json').write_text('x')`), {}],
    [py(`import os; res='${R}/results.json'; open(os.path.join(os.path.dirname(res), 'verification.json'), 'w')`), {}],
    [py(`from pathlib import Path; ${RES}; (res.parent / 'approvals.jsonl').write_text('x')`), {}],
    [py(`from pathlib import Path; ${RES}; (res.parent / 'approvals.jsonl').write_text('x')`), { verifier: true }],
    // log/ 밑은 이름이 무엇이든 잠겼다
    [py(`import os; RUN='${R}'; open(os.path.join(RUN, 'log', 'notes.txt'), 'w')`), {}],
    [py(`import os; LOG='${R}/log'; open(os.path.join(LOG, 'notes.txt'), 'w')`), {}],
    [py(`p='${R}/log/notes.txt'; open(p, 'w')`), {}],
    [py(`open('${R}/log/subagents.jsonl' + '.copy', 'w')`), {}],
    // 검토 반영 ① f-string·템플릿의 {x.속성}·{x()}·${x.trim()}: 마지막 칸이 잠긴 이름이면 그 변수를 따라간다
    [py(`from pathlib import Path; ${RES}; open(f'{res.parent}/results.json','w')`), {}],
    [py(`from pathlib import Path; RUN = Path('${R}'); open(f'{RUN.resolve()}/results.json','w')`), {}],
    [py(`from pathlib import Path; ${RES}; open(f'{res.parent}/approvals.jsonl','a')`), {}],
    [py(`from pathlib import Path; ${RES}; open(f'{res.parent}/verification.json','w')`), {}],
    [py(`from pathlib import Path; ${RES}; open(f'{res.parent}/log/subagents.jsonl','a')`), {}],
    [py(`from pathlib import Path; ${RES}; open(f'{res.parent}/approvals.jsonl','a')`), { verifier: true }],
    [py(`import os; res='${R}/results.json'; open(f'{os.path.dirname(res)}/results.json','w')`), {}],
    [`node -e 'const fs=require("fs"); const run="${R}"; fs.writeFileSync(\`\${run.trim()}/results.json\`, "{}")'`, {}],
    [`node -e 'const fs=require("fs"), path=require("path"); const res="${R}/results.json"; fs.writeFileSync(\`\${path.dirname(res)}/results.json\`, "{}")'`, {}],
    [`node - <<'EOF'\nconst fs=require('fs'); const run='${R}';\nfs.writeFileSync(\`\${run.trim()}/results.json\`, '{}');\nEOF`, {}],
    // ② 목록·사전에서 고른 경로(고르기 x[0]·x['k']는 따라가고, 슬라이스만 이끌어 낸 값이다)
    [py(`RUN='${R}'; paths=[f'{RUN}/results.json']; open(paths[0],'w')`), {}],
    [py(`cfg={'out': '${R}/results.json'}; open(cfg['out'],'w')`), {}],
    [py(`RUN='${R}'; cfg={'out': f'{RUN}/results.json'}; open(cfg['out'],'w')`), {}],
    [py(`RUN='${R}'; fs=[f'{RUN}/approvals.jsonl']; open(fs[0],'a')`), {}],
    [nodeCode(`const fs=require('fs'); const paths=['${R}/results.json']; fs.writeFileSync(paths[0], '{}')`), {}],
    // ③ JS 문자열 메서드 p.normalize('NFC')는 경로 호출이 아니다. 인자 없는 p.normalize()도 막힌다
    [nodeCode(`const fs=require('fs'); const p='${R}/results.json'; fs.writeFileSync(p.normalize('NFC'), '{}')`), {}],
    [nodeCode(`const fs=require('fs'); const p='${R}/results.json'; fs.writeFileSync(p.normalize('NFKD'), '{}')`), {}],
    [nodeCode(`const fs=require('fs'); const p='${R}/results.json'; fs.writeFileSync(p.normalize(), '{}')`), {}],
    // ④ Node 플래그 'as'·'rs+'
    [nodeCode(`const fs=require('fs'); const p='${R}/results.json'; fs.openSync(p, 'as')`), {}],
    [nodeCode(`const fs=require('fs'); fs.openSync('${R}/results.json', 'rs+')`), {}],
    [nodeCode(`const fs=require('fs'); fs.openSync('${R}/approvals.jsonl', 'as+')`), {}],
    // ⑤ pathlib의 원자 쓰기: tmp.replace(res)·tmp.rename(res)
    [py(`from pathlib import Path; ${RES}; tmp = res.with_suffix('.tmp'); tmp.write_text('x'); tmp.replace(res)`), {}],
    [py(`from pathlib import Path; ${RES}; tmp = res.with_suffix('.tmp'); tmp.write_text('x'); tmp.rename(res)`), {}],
    [py(`from pathlib import Path; ${RES}; Path('/tmp/x').replace(res)`), {}],
    [py(`from pathlib import Path; p = Path('${R}/approvals.jsonl'); Path('/tmp/x').with_suffix('.tmp').replace(p)`), {}],
    // ⑦ strip은 경로를 바꾸지 않는다
    [py(`p='${R}/results.json'; open(p.strip(),'w')`), {}],
    [py(`p='${R}/verification.json'; open(p.rstrip(),'w')`), {}],
    [nodeCode(`const fs=require('fs'); const p='${R}/results.json'; fs.writeFileSync(p.trim(), '{}')`), {}],
  ]) blocked(bash(code, options), code);
  assert.match(bash(py(`from pathlib import Path; ${RES}; (res.parent / 'approvals.jsonl').write_text('x')`)).reason, /승인 기록\(approvals\.jsonl\)/, '이름으로 종류를 정한다');
  assert.match(bash(py(`from pathlib import Path; ${RES}; res.with_name('results-round3.json').write_text('x')`)).reason, /검수 결과\(results-round3\.json\)/);
  assert.match(bash(py(`import os; RUN='${R}'; open(os.path.join(RUN, 'log', 'notes.txt'), 'w')`)).reason, /log\/ 밑의 기록\(log\/\)/, '폴더 이름뿐이면 log/');
});

test('Path.open and p.open take the mode as their first argument: a write mode is a write, a read or a file name is not', () => {
  const py = (code) => `python3 -c ${JSON.stringify(code)}`;
  for (const [code, options] of [
    [py(`from pathlib import Path; Path('${R}/results.json').open('w').write('x')`), {}],
    [py(`from pathlib import Path; p = Path('${R}/results.json'); p.open('w')`), {}],
    [py(`from pathlib import Path; p = Path('${R}/results.json'); p.open(mode='a')`), {}],
    [py(`from pathlib import Path; p = Path('${R}/results.json'); p.open('wb')`), {}],
    [py(`from pathlib import Path; p = Path('${R}/results.json'); p.open('r+', encoding='utf8')`), {}],
    [py(`from pathlib import Path; p = Path('${R}/verification.json'); f = p.open('x')`), {}],
    [py(`from pathlib import Path; Path('${R}/approvals.jsonl').open('a')`), {}],
    [py(`from pathlib import Path; Path('results.json').open('w')`), { cwd: R }],
    [py(`from pathlib import Path; p = Path('${R}/results.json'); p.open('w')`), { verifier: true }],
  ]) {
    const verdict = bash(code, options);
    if (options.verifier) free(verdict, `verifier: ${code}`); else blocked(verdict, code);
  }
  for (const code of [
    py(`from pathlib import Path; p = Path('${R}/results.json'); p.open()`), py(`from pathlib import Path; Path('${R}/results.json').open('r').read()`),
    py(`from pathlib import Path; p = Path('${R}/results.json'); p.open('rb')`), py(`from pathlib import Path; p = Path('${R}/results.json'); p.open(mode='r')`),
    py(`from pathlib import Path; Path('${R}/summary.json').open('w').write('x')`), py(`from pathlib import Path; Path('${R}/wt/results.json').open('w')`),
    py(`import zipfile; z = zipfile.ZipFile('${R}/results.json'); z.open('results.json')`), py(`import webbrowser; webbrowser.open('${R}/results.json')`),
    py(`import gzip; gzip.open('${R}/results.json', 'rt')`),
    // 모드 자리가 모드 글자만 든 글자가 아니면 모드가 아니다: zip 안의 이름 `word/document.xml`에는 w·a·x가 들어 있다
    py(`import zipfile; z = zipfile.ZipFile('${R}/results.json'); z.open('word/document.xml')`),
  ]) free(bash(code), code);
  free(bash(py(`from pathlib import Path; Path('results.json').open('w')`), { cwd: w.project }), '프로젝트 맨 위');
  // 이름이 모드 글자 같아도 open(경로, 모드)의 경로 자리는 모드로 읽지 않는다
  free(bash(py(`open('${R}/summary.json', 'w'); open('${R}/results.json')`)), '읽기 open과 다른 파일 쓰기');
  free(bash(py(`open('a.json', 'r')`), { cwd: R }), '모드 글자가 든 파일 이름');
});

test('$PWD and ${PWD} are the cwd when it is known, so a write through $PWD is the same write as the relative one', () => {
  for (const command of [`echo x > $PWD/results.json`, `echo x > \${PWD}/results-round1.json`, `echo x >> "$PWD/log/subagents.jsonl"`, `cp /tmp/a "$PWD"/approvals.jsonl`, `tee $PWD/verification.json`]) {
    blocked(bash(command, { cwd: R }), `실행 폴더 안: ${command}`);
    free(bash(command, { cwd: path.join(R, 'wt') }), `worktree 안: ${command}`);
    free(bash(command, { cwd: w.project }), `프로젝트 맨 위: ${command}`);
  }
  blocked(bash(`cd ${R} && echo x > $PWD/results.json`, { cwd: w.project }), 'cd 뒤의 $PWD');
  free(bash(`cd ${R}/wt && echo x > $PWD/results.json`, { cwd: R }), 'worktree로 cd한 뒤의 $PWD');
  blocked(bash(`PWD=${R}; echo x > $PWD/results.json`, { cwd: w.project }), '이 명령 안에서 정한 PWD가 먼저다');
  free(bash(`cd $UNKNOWN && echo x > $PWD/results.json`, { cwd: R }), 'cd를 풀 수 없으면 $PWD도 모른다');
  free(bash(`echo x > $OLDPWD/results.json`, { cwd: R }), '$OLDPWD는 풀지 않는다');
});

test('locked names are compared without regard to case, because this Mac does not tell them apart: RESULTS.JSON is the real results.json', () => {
  for (const name of ['RESULTS.JSON', 'Results.json', 'results.JSON', 'RESULTS-ROUND1.JSON', 'Results-Round12.json', 'VERIFICATION.JSON', 'Verification.json', 'APPROVALS.JSONL', 'Approvals.jsonl', 'LOG/subagents.jsonl', 'Log/SUBAGENTS.JSONL', 'LOG/new.txt']) {
    for (const toolName of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) blocked(tool(toolName, path.join(R, name)), `${toolName} ${name}`);
    blocked(bash(`echo x > ${R}/${name}`), `echo > ${name}`);
    blocked(bash(`rm ${R}/${name}`), `rm ${name}`);
  }
  blocked(bash(`python3 -c "open('${R}/RESULTS.JSON','w')"`), 'python RESULTS.JSON');
  blocked(bash(`python3 -c "import os; open(os.path.join('${R}', 'Results.json'), 'w')"`), 'join Results.json');
  blocked(bash(`node -e "require('fs').writeFileSync('${R}/APPROVALS.JSONL','x')"`), 'node APPROVALS.JSONL');
  blocked(bash(`cd ${R} && echo x > RESULTS.JSON`), 'cd 뒤 RESULTS.JSON');
  blocked(tool('Write', path.join(w.project, '.PACT', ID, 'results.json')), '.PACT');
  blocked(tool('Write', path.join(w.project, '.Pact', ID, 'LOG', 'x')), '.Pact/LOG');
  // 이름이 비슷할 뿐인 것과 worktree·다른 폴더 밑은 그대로 통과한다
  for (const name of ['SUMMARY.JSON', 'Plan.md', 'RESULTS.JSON.bak', 'RESULTS.JSONL', 'WT/RESULTS.JSON', 'Wt/LOG/x', 'TASKS/results.json', 'LOGS/x', 'LOGBOOK.txt']) {
    free(tool('Write', path.join(R, name)), `Write ${name}`);
    free(bash(`echo x > ${R}/${name}`), `echo > ${name}`);
  }
  // 글 속 이름 조각도 같다
  assert.equal(classifyRest(['RESULTS.json']).kind, 'results');
  assert.equal(classifyRest(['Verification.JSON']).kind, 'verification');
  assert.equal(classifyRest(['LOG']).name, 'LOG/');
  assert.equal(classifyRest(['Log', 'a', 'b']).name, 'Log/a/b');
  assert.equal(lockForPath(path.join(R, 'RESULTS.JSON')).kind, 'results');
  assert.equal(lockForPath(path.join(w.project, '.PACT', ID, 'approvals.jsonl')).kind, 'approvals');
  assert.equal(lockForPath(path.join(w.project, '.PACT', ID, 'WT', 'results.json')), null);
});

test('a command of a few megabytes is still read: a heredoc that rewrites the whole results.json is caught, and only a command longer than the limit is left alone', () => {
  const json = JSON.stringify({ scenarios: Array.from({ length: 3000 }, (_, i) => ({ id: `S${i}`, title: `시나리오 ${i} "인용" (괄호) [대괄호]`, steps: [{ action: 'a'.repeat(40), output: 'o'.repeat(60) }] })) });
  assert.ok(json.length > 500_000, `통째로 다시 쓰는 글은 지난 상한(20만 자)을 넘는다: ${json.length}`);
  const rewrite = `cat > ${R}/results.json <<'EOF'\n${json}\nEOF`;
  blocked(bash(rewrite), 'cat 으로 통째로 다시 쓰기');
  free(bash(rewrite, { verifier: true }), 'verifier는 같은 것을 쓴다');
  blocked(bash(`python3 - <<'EOF'\nimport json\nd = ${JSON.stringify(json)}\nopen('${R}/results.json','w').write(d)\nEOF`), 'python heredoc으로 통째로 다시 쓰기');
  blocked(bash(`echo ${'x'.repeat(300_000)} > ${R}/results.json`), '30만 자');
  blocked(bash(`${'echo x >> /tmp/out.txt\n'.repeat(60_000)}echo x > ${R}/results.json`), '명령 6만 개 뒤의 쓰기');
  const started = Date.now();
  blocked(bash(`echo ${'x'.repeat(3_900_000)} > ${R}/results.json`), '상한 바로 아래');
  assert.ok(Date.now() - started < 10_000, `수 MB도 몇 초 안에 읽는다: ${Date.now() - started}ms`);
  // 상한을 넘는 글은 보지 않는다(지문이 그물이다)
  free(bash(`echo ${'x'.repeat(4_100_000)} > ${R}/results.json`), '상한을 넘는 글');
});

test('the line that says what to do instead fits who called: a sub-agent is told to hand the matter to the main session, the main session is told what to do itself', () => {
  const hit = (kind, name) => ({ kind, name });
  const main = (kind, name) => lockMessage(hit(kind, name));
  const sub = (kind, name) => lockMessage(hit(kind, name), { sub: true });
  // 메인
  assert.match(main('approvals', 'approvals.jsonl').instead, /사용자가 승인한 말을 그대로 넣어 spec\.mjs approve로 기록한다/);
  assert.match(main('verification', 'verification.json').instead, /worktree를 커밋하고 snapshot을 다시 실행한다/);
  assert.match(main('results', 'results.json').instead, /build로 되돌려 고치고 verifier로 다시 검수한다/);
  assert.match(main('log', 'log/subagents.jsonl').instead, /hook-error\.log를 보고 사용자에게 알린다\. 다른 기록은 log\/ 밖에 둔다/);
  // 하위 에이전트: 하위 에이전트의 approve·snapshot·build 되돌리기는 막혀 있거나 메인 세션의 일이다
  assert.match(sub('approvals', 'approvals.jsonl').instead, /메인 세션이 사용자 말을 받아 spec\.mjs approve로 기록한다.*답장에 적어 메인 세션에 넘긴다/);
  assert.doesNotMatch(sub('approvals', 'approvals.jsonl').instead, /사용자가 승인한 말을 그대로 넣어/);
  assert.match(sub('verification', 'verification.json').instead, /snapshot은 메인 세션이 돌린다.*답장에 적어 메인 세션에 넘긴다/);
  assert.match(sub('results', 'results.json').instead, /답장에 적어 메인 세션에 넘긴다.*메인 세션이 summary\.json에 쓴다/);
  assert.doesNotMatch(sub('results', 'results.json').instead, /build로 되돌려/);
  assert.match(sub('results', 'results-round1.json').instead, /snapshot을 다시 실행할 때 스크립트가 results-round<n>\.json으로 남긴다/);
  assert.match(sub('log', 'log/x').instead, /답장에 적어 메인 세션에 알린다\. 다른 기록은 log\/ 밖에 둔다/);
  for (const kind of ['results', 'verification', 'approvals', 'log']) for (const text of [...Object.values(main(kind, 'x')), ...Object.values(sub(kind, 'x'))]) assert.doesNotMatch(text, /\n/);
  // checkLocks는 agent_id로 부른 쪽을 안다
  const call = (extra) => checkLocks({ tool_name: 'Write', tool_input: { file_path: path.join(R, 'approvals.jsonl') }, cwd: w.project, ...extra });
  assert.match(call({}).instead, /사용자가 승인한 말을 그대로 넣어/);
  assert.match(call({ agent_id: 'agent-9', agent_type: 'pact:worker' }).instead, /메인 세션이 사용자 말을 받아/);
  assert.match(call({ agent_id: '' }).instead, /사용자가 승인한 말을 그대로 넣어/, 'agent_id가 비면 메인 세션이다');
});

test('VERIFIER names the pact verifier agent', () => {
  assert.equal(VERIFIER, 'pact:verifier');
});
