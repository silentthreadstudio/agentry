// glob — the one glob test over repo-relative paths: `*` and `?` stay inside one folder, a `**` segment
// crosses folders, case counts, and a `..` or absolute path never matches. The gate tiers, the checklist,
// the land and the guard match changed files with it; the `models` key matches owned files with it. Pure.
//
// globMatch(globs, path) -> boolean
// segmentToRegExp(segment) -> the regexp source one path segment of a glob matches (no anchors)
// wildcardSource(pattern) -> the regexp source a flat name pattern matches (no anchors)

// One character as a regexp matches it, itself.
const literal = (c) => c.replace(/[.+^${}()|[\]\\]/g, "\\$&");

// A glob over repo-relative paths, matched per segment: a segment that is exactly `**` crosses directories;
// anywhere else `*` and `?` stay inside one segment (`a**b` is just `a*b`). A glob with a `..` segment
// matches nothing.
export function segmentToRegExp(segment) {
  let re = "";
  for (const c of segment) {
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += literal(c);
  }
  return re;
}

/** The regexp source of a flat name pattern, for a name that is not a path (a branch, a file's basename,
 *  an id in a filename): `*` is any run of characters, a `/` too, `?` any one character, the rest literal.
 *  A path takes `globMatch`, where `*` stops at a `/`. */
export const wildcardSource = (pattern) =>
  [...pattern].map((c) => (c === "*" ? ".*" : c === "?" ? "." : literal(c))).join("");
function globToRegExp(glob) {
  const segments = glob.split("/");
  if (segments.includes("..")) return /(?!)/;
  let re = "";
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === "**") re += last ? ".+" : "(?:[^/]+/)*";
    else re += segmentToRegExp(segment) + (last ? "" : "/");
  });
  return new RegExp(`^${re}$`);
}

// A changed path as a glob sees it: a leading `./` dropped; absolute paths, empty segments and `..` (which
// could make `docs/../src/x` look like docs) are not repo-relative paths at all.
function plainPath(file) {
  if (typeof file !== "string") return null;
  const path = file.replace(/^(?:\.\/)+/, "");
  return path && !path.split("/").some((s) => s === "" || s === "..") ? path : null;
}

const matcher = (globs) => {
  const res = (globs ?? []).map(globToRegExp);
  return (file) => {
    const path = plainPath(file);
    return path !== null && res.some((re) => re.test(path));
  };
};

/** Does `path` (repo-relative) match one of `globs`: `*` and `?` stay inside one folder, a `**` segment
 *  crosses folders, case counts, and a `..` or absolute path never matches. */
export const globMatch = (globs, path) => matcher(globs)(path);
