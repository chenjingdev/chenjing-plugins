// walks the notes tree recursively (see README)
const fs = require('fs');
const path = require('path');

// keep only valid note files (skip temp and lock files)
const VALID_NOTE = /^[\w-]+\.md$/;

function walk(root, ignore = []) {
  const entries = fs.readdirSync(root, { recursive: true });
  const files = [];

  for (const entry of entries) {
    // skip anything inside an ignored directory
    const segments = entry.split(path.sep);
    if (segments.some((seg) => ignore.includes(seg))) continue;

    if (!VALID_NOTE.test(entry)) continue;

    files.push(path.join(root, entry));
  }

  return files;
}

module.exports = { walk };
