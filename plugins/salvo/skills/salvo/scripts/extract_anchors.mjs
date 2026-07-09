#!/usr/bin/env node
// Extracts a closed anchor vocabulary from a target file at form time
// (SPEC 003 §2.1 anchors, kind closed_list). The printed array is embedded in
// the shooter output schema as the allowed anchor values, which is what makes
// fold matching pure code (C6, I-6).
// usage: extract_anchors.mjs <target> --mode headings|regex [--pattern <re>]
// Prints a JSON array (unique, document order); exit 2 on an empty vocabulary.
import { readFileSync } from 'node:fs'

const [file, ...rest] = process.argv.slice(2)
const opt = name => {
  const i = rest.indexOf(name)
  return i === -1 ? null : rest[i + 1]
}
const mode = opt('--mode')
if (!file || !mode) {
  console.error('usage: extract_anchors.mjs <target> --mode headings|regex [--pattern <re>]')
  process.exit(2)
}

const text = readFileSync(file, 'utf8')
let matches = []
if (mode === 'headings') {
  matches = [...text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map(m => m[1])
} else if (mode === 'regex') {
  const pattern = opt('--pattern')
  if (!pattern) {
    console.error('regex mode requires --pattern')
    process.exit(2)
  }
  matches = [...text.matchAll(new RegExp(pattern, 'gm'))].map(m => m[0])
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(2)
}

const values = [...new Set(matches)]
if (values.length === 0) {
  console.error('empty vocabulary — choose another extraction or a quote vocabulary')
  process.exit(2)
}
console.log(JSON.stringify(values))
