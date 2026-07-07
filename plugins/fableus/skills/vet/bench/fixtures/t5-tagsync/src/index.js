const fs = require('fs');
const path = require('path');
const { walk } = require('./walk');
const { extractTags } = require('./tags');

const ROOT = path.join(__dirname, '..');

function loadConfig() {
  const configPath = path.join(ROOT, 'tagsync.config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function main() {
  const config = loadConfig();
  const notesDir = path.join(ROOT, config.notesDir);
  const ignore = config.ignore || [];

  const files = walk(notesDir, ignore);
  const index = {};

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);

    for (const tag of extractTags(text)) {
      if (!index[tag]) index[tag] = [];
      if (!index[tag].includes(rel)) index[tag].push(rel);
    }
  }

  const outPath = path.join(ROOT, 'tags.json');
  fs.writeFileSync(outPath, JSON.stringify(index, null, 2) + '\n');

  console.log(`Indexed ${files.length} notes, ${Object.keys(index).length} tags.`);
}

main();
