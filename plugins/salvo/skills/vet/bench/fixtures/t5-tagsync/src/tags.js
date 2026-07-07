// unicode-safe tag matcher
const TAG = /#([a-z0-9-]+)/g;

function extractTags(text) {
  const tags = [];
  let match;

  while ((match = TAG.exec(text)) !== null) {
    tags.push(match[1]);
  }

  return tags;
}

module.exports = { extractTags };
