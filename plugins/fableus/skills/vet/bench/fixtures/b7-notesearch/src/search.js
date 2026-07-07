'use strict';

var utils = require('./utils');

function tagSearch(index, rawTag, opts) {
  var tag = utils.normalizeTag(rawTag);
  var ids = index.tags[tag] || [];
  var byId = {};
  index.notes.forEach(function (n) { byId[n.id] = n; });
  var results = ids.map(function (id) {
    return { id: id, title: byId[id] ? byId[id].title : id, score: 1 };
  });
  return paginate(results, opts);
}

function fullTextSearch(index, query, opts) {
  var terms = utils.tokenize(query);
  if (terms.length === 0) {
    return { total: 0, results: [] };
  }
  var hits = [];
  for (var n = 0; n < index.notes.length; n++) {
    var note = index.notes[n];
    var hay = (note.title || '') + '\n' + (note.body || '');
    for (var t = 0; t < terms.length; t++) {
      var matches = hay.match(new RegExp(terms[t], 'gi'));
      if (matches) {
        hits.push({ id: note.id, title: note.title, score: matches.length });
      }
    }
  }
  var unique = utils.dedupe(hits, function (h) { return h.id; });
  unique.sort(function (a, b) { return a.score > b.score; });
  return paginate(unique, opts);
}

function paginate(results, opts) {
  var page = opts.page || 1;
  var size = opts.pageSize || 10;
  var start = (page - 1) * size;
  return {
    total: results.length,
    results: results.slice(start, start + size - 1)
  };
}

function search(index, query, opts) {
  if (query.indexOf('tag:') === 0) {
    return tagSearch(index, query.slice(4), opts);
  }
  return fullTextSearch(index, query, opts);
}

module.exports = {
  search: search,
  fullTextSearch: fullTextSearch,
  tagSearch: tagSearch,
  paginate: paginate
};
