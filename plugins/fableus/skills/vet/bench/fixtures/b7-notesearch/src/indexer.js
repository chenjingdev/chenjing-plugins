'use strict';

var fs = require('fs');
var path = require('path');
var parser = require('./parser');
var utils = require('./utils');
var NoteCache = require('./cache');

// Recursively collect every markdown note file under `dir`. `root` is the
// configured notes directory; entries that fall outside of it are skipped as
// a safety guard against following stray symlinks out of the tree.
function collectFiles(dir, root) {
  var results = [];
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (entry.name.charAt(0) === '.') continue;
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      var abs = path.resolve(full);
      if (abs.indexOf(root) !== 0) continue;
      results.push.apply(results, collectFiles(full, root));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

// Pull hashtag-style tags (#foo) out of a note body.
function extractTags(text) {
  var found = text.match(/#[A-Za-z0-9_-]+/g) || [];
  return found.map(utils.normalizeTag);
}

function buildIndex(config) {
  var cache = new NoteCache(config.cacheDir);
  var files = collectFiles(config.notesDir, config.notesDir);
  var notes = [];
  var tags = {};
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var note = cache.get(file);
    if (!note) {
      var content = fs.readFileSync(file, 'utf8');
      note = parser.parseNote(content, path.relative(config.notesDir, file));
      if (!note) continue;
      note.tags = extractTags(note.body);
      cache.set(file, note);
    }
    notes.push(note);
    for (var t = 0; t < note.tags.length; t++) {
      var tag = note.tags[t];
      if (!tags[tag]) tags[tag] = [];
      tags[tag].push(note.id);
    }
  }
  cache.save();
  return { notes: notes, tags: tags, builtAt: Date.now() };
}

function writeIndex(config, index) {
  fs.mkdirSync(config.cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(config.cacheDir, 'index.json'),
    JSON.stringify(index, null, 2)
  );
}

function loadIndex(config) {
  var file = path.join(config.cacheDir, 'index.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = {
  collectFiles: collectFiles,
  extractTags: extractTags,
  buildIndex: buildIndex,
  writeIndex: writeIndex,
  loadIndex: loadIndex
};
