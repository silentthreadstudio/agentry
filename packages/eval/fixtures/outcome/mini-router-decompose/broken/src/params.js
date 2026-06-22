// BROKEN overlay — params.js: extracts via the same single-regex parse. Because match.js does not normalize a
// trailing slash, a path like "/users/42/" yields no regex match and thus EMPTY params here too.
const { toRegex } = require("./match.js");

function extractParams(pattern, path) {
  const { re, names } = toRegex(pattern);
  const m = re.exec(path);
  if (!m) return {};
  const params = {};
  names.forEach((name, i) => {
    params[name] = m[i + 1];
  });
  return params;
}

module.exports = { extractParams };
