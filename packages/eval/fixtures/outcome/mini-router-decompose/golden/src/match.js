// GOLDEN overlay — match.js: split on "/" (trailing slash ignored), compare segment by segment. A ":name"
// pattern segment matches any one segment; a literal must match exactly; differing counts never match.
function toSegments(p) {
  return p.split("/").filter((s) => s.length > 0); // drops leading/trailing-slash empties
}

function matches(pattern, path) {
  const ps = toSegments(pattern);
  const xs = toSegments(path);
  if (ps.length !== xs.length) return false;
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(":")) continue; // dynamic segment matches anything
    if (ps[i] !== xs[i]) return false;
  }
  return true;
}

module.exports = { matches, toSegments };
