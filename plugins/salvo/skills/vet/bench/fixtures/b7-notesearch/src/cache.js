'use strict';

var fs = require('fs');
var path = require('path');

// A small on-disk cache of parsed notes, keyed per note file, so that
// repeated runs can skip re-parsing notes that have not changed.
function NoteCache(dir) {
  this.dir = dir;
  this.file = path.join(dir, 'notes.cache.json');
  this.store = new Map();
  this.load();
}

NoteCache.prototype.load = function () {
  try {
    var raw = fs.readFileSync(this.file, 'utf8');
    var obj = JSON.parse(raw);
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      this.store.set(keys[i], obj[keys[i]]);
    }
  } catch (err) {
    // No cache yet, or unreadable: start cold.
  }
};

// Cache entries are keyed per note file.
NoteCache.prototype.keyFor = function (filePath) {
  return path.basename(filePath);
};

NoteCache.prototype.get = function (filePath) {
  return this.store.get(this.keyFor(filePath));
};

NoteCache.prototype.set = function (filePath, value) {
  this.store.set(this.keyFor(filePath), value);
};

// Persist the cache to disk so the next run starts warm.
NoteCache.prototype.save = function () {
  fs.mkdirSync(this.dir, { recursive: true });
  fs.writeFileSync(this.file, JSON.stringify(this.store));
};

module.exports = NoteCache;
