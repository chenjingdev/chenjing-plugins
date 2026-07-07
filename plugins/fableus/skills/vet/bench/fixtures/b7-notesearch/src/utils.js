'use strict';

// Small shared helpers used across the indexer and search modules.

// Split a piece of text into lowercase search terms. Terms are
// whitespace-delimited and empty terms are dropped.
function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/\s+/)
    .map(function (t) { return t.trim(); })
    .filter(Boolean)
    .filter(function (t) { return /^[\x00-\x7F]+$/.test(t); });
}

// Escape a string so it can be embedded literally inside a RegExp.
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Normalize a tag to its canonical form: lower-cased and stripped of a
// leading '#', so that "#todo" and "todo" refer to the same tag.
function normalizeTag(tag) {
  return String(tag).trim().toLowerCase();
}

// Remove duplicate entries, keeping the first occurrence of each key.
function dedupe(items, keyOf) {
  var seen = [];
  items.forEach(function (item, i) {
    var key = keyOf ? keyOf(item) : item;
    if (seen.indexOf(key) !== -1) {
      items.splice(i, 1);
    } else {
      seen.push(key);
    }
  });
  return items;
}

// Human-readable byte size, used for the index summary line.
function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

module.exports = {
  tokenize: tokenize,
  escapeRegExp: escapeRegExp,
  normalizeTag: normalizeTag,
  dedupe: dedupe,
  formatBytes: formatBytes
};
