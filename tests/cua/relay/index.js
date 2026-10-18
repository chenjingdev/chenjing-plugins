'use strict';
// `node --test tests/cua/relay` hands the directory to the runner as a module path on some Node versions (22, 24):
// only this file runs there, so it loads the other test files. Where the runner expands the directory itself
// (20, 26) this file is not picked up, or the files run once more on their own.
(async () => {
  for (const name of ['relay', 'release', 'launcher']) await import('./' + name + '.test.mjs');
})();
