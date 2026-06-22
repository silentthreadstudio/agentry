// BROKEN overlay — match.js: the PLAUSIBLE-NAIVE single-regex matcher. It turns the pattern into a regex where
// ":name" becomes "([^/]+)" and tests the WHOLE path against it. It does NOT normalize a trailing slash, so
// "/users/" fails to match "/users". Exported for params.js to reuse the same brittle parse.
function toRegex(pattern) {
  const names = [];
  const source = pattern.replace(/:([^/]+)/g, (_, name) => {
    names.push(name);
    return "([^/]+)";
  });
  return { re: new RegExp(`^${source}$`), names };
}

function matches(pattern, path) {
  const { re } = toRegex(pattern);
  return re.test(path); // trailing slash NOT handled -> "/users/" won't match "/users"
}

module.exports = { matches, toRegex };
