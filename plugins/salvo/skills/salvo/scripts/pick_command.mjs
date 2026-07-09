#!/usr/bin/env node
// Mechanical pick, command kind (SPEC 003 §2.1 pick_criterion, I-7): runs the
// stated test command once per candidate file ({candidate} placeholder) and
// deterministically picks the FIRST passing candidate in argument order.
// usage: pick_command.mjs --command "<cmd with {candidate}>" <file…>
// Prints {"choice": <index>, "passed": [indices]}; exit 1 if nothing passes.
import { execSync } from 'node:child_process'

const argv = process.argv.slice(2)
const i = argv.indexOf('--command')
const command = i === -1 ? null : argv[i + 1]
const files = argv.filter((_, j) => j !== i && j !== i + 1)
if (!command || files.length === 0) {
  console.error('usage: pick_command.mjs --command "<cmd with {candidate}>" <file…>')
  process.exit(2)
}

const passed = []
for (let j = 0; j < files.length; j++) {
  try {
    execSync(command.replaceAll('{candidate}', files[j]), { stdio: 'pipe', timeout: 120000 })
    passed.push(j)
  } catch {
    // non-zero exit = this candidate fails the criterion
  }
}
if (passed.length === 0) {
  console.error('no candidate passed the stated command')
  process.exit(1)
}
console.log(JSON.stringify({ choice: passed[0], passed }))
