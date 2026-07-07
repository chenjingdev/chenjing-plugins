'use strict';

// Parses a raw note file into a structured record: { id, title, body, meta }.
// Notes may begin with a YAML-ish frontmatter block delimited by '---' lines.

function extractFrontmatter(content) {
  if (!content.startsWith('---')) return null;
  var end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  var raw = content.slice(3, end);
  var body = content.slice(end + 4);
  return {
    raw: raw.replace(/^\r?\n/, ''),
    body: body.replace(/^\r?\n/, '')
  };
}

function parseFrontmatter(raw) {
  var meta = {};
  var lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line.trim()) continue;
    var idx = line.indexOf(':');
    if (idx === -1) {
      throw new Error('Invalid frontmatter line: ' + JSON.stringify(line));
    }
    var key = line.slice(0, idx).trim();
    var value = line.slice(idx + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(function (s) {
        return s.trim();
      }).filter(Boolean);
    }
    meta[key] = value;
  }
  return meta;
}

function parseNote(content, id) {
  var meta = {};
  var body = content;
  var fm = extractFrontmatter(content);
  if (fm) {
    try {
      meta = parseFrontmatter(fm.raw);
    } catch (err) {
      return null;
    }
    body = fm.body;
  }
  var lines = body.split('\n').filter(function (l) {
    return l.trim().length > 0;
  });
  var title = (meta.title && String(meta.title)) ||
    lines[0].replace(/^#+\s*/, '').trim();
  return { id: id, title: title, body: body, meta: meta };
}

module.exports = {
  parseNote: parseNote,
  extractFrontmatter: extractFrontmatter,
  parseFrontmatter: parseFrontmatter
};
