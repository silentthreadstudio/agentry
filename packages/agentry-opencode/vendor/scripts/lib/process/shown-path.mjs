// shown-path — a path as the output shows it: relative to the root the command runs from when it is
// inside that root, else as given. PURE.
import { isAbsolute, relative } from "node:path";

/** `path` as shown from `root`: relative when inside it, else unchanged. */
export function shownPath(root, path) {
  const rel = relative(root, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}
