'use strict';

var config = require('./config');
var indexer = require('./indexer');
var searcher = require('./search');
var utils = require('./utils');

var VALUE_FLAGS = ['--page-size', '--page', '--notes-dir', '--cache-dir'];

function extractQuery(rest) {
  for (var i = 0; i < rest.length; i++) {
    var a = rest[i];
    if (VALUE_FLAGS.indexOf(a) !== -1) { i++; continue; }
    if (a.indexOf('--') === 0) continue;
    return a;
  }
  return undefined;
}

function cmdIndex(cfg) {
  var index = indexer.buildIndex(cfg);
  indexer.writeIndex(cfg, index);
  var bytes = JSON.stringify(index).length;
  process.stdout.write(
    'Indexed ' + index.notes.length + ' notes (' + utils.formatBytes(bytes) + ')\n'
  );
}

function cmdSearch(cfg, query) {
  if (!query) {
    process.stderr.write('usage: notesearch search <query>\n');
    process.exitCode = 1;
    return;
  }
  var index = indexer.loadIndex(cfg);
  if (!index) {
    process.stderr.write('No index found. Run "notesearch index" first.\n');
    process.exitCode = 1;
    return;
  }
  var out = searcher.search(index, query, cfg);
  process.stdout.write(out.total + ' result(s) for "' + query + '"\n');
  out.results.forEach(function (r, i) {
    process.stdout.write(
      '  ' + (i + 1) + '. ' + r.title + '  [score ' + r.score + ']\n'
    );
  });
}

function main(argv) {
  var command = argv[0];
  var rest = argv.slice(1);
  var cfg = config.loadConfig(rest);
  if (command === 'index') {
    cmdIndex(cfg);
  } else if (command === 'search') {
    cmdSearch(cfg, extractQuery(rest));
  } else {
    process.stderr.write('usage: notesearch <index|search> [options]\n');
    process.exitCode = 1;
  }
}

main(process.argv.slice(2));

module.exports = { main: main };
