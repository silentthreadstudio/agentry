// GOLDEN overlay — params.js: map each ":name" pattern segment to the corresponding path segment.
const { toSegments } = require("./match.js");

function extractParams(pattern, path) {
  const ps = toSegments(pattern);
  const xs = toSegments(path);
  const params = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(":")) {
      params[ps[i].slice(1)] = xs[i];
    }
  }
  return params;
}

module.exports = { extractParams };
