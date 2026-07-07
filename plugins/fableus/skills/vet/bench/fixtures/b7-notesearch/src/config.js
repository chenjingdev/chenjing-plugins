'use strict';

var fs = require('fs');
var path = require('path');

var DEFAULTS = {
  notesDir: 'notes',
  cacheDir: '.cache',
  pageSize: 5,
  page: 1
};

var CONFIG_FILES = ['notesearch.config.json', '.notesearchrc'];

function readConfigFile(cwd) {
  for (var i = 0; i < CONFIG_FILES.length; i++) {
    var p = path.join(cwd, CONFIG_FILES[i]);
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (err) {
        process.stderr.write('warning: could not parse ' + CONFIG_FILES[i] + '\n');
        return {};
      }
    }
  }
  return {};
}

function parseFlags(argv) {
  var flags = {};
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--page-size') flags.pageSize = parseInt(argv[++i], 10);
    else if (a === '--page') flags.page = parseInt(argv[++i], 10);
    else if (a === '--notes-dir') flags.notesDir = argv[++i];
    else if (a === '--cache-dir') flags.cacheDir = argv[++i];
  }
  return flags;
}

function loadConfig(argv, cwd) {
  cwd = cwd || process.cwd();
  var flags = parseFlags(argv || []);
  var fileConfig = readConfigFile(cwd);
  var config = {};
  // Start from the built-in defaults, then layer command-line flags on top so
  // that explicit flags take precedence, and finally the project config file.
  Object.assign(config, DEFAULTS);
  Object.assign(config, flags);
  Object.assign(config, fileConfig);
  return config;
}

module.exports = {
  loadConfig: loadConfig,
  parseFlags: parseFlags,
  readConfigFile: readConfigFile,
  DEFAULTS: DEFAULTS
};
