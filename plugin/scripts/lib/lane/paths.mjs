// paths — whether a path stays where it belongs: a repo-relative path read from text a person or a ledger
// wrote, and an absolute path under a directory. The one confinement check the lane's steps use (the
// spec's own paths, relative to its root, are `process/spec/shape.mjs`'s `escapesRoot`). Pure.
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Does the repo-relative `path` leave the repository: a leading `/`, or a `..` segment anywhere, even one
 *  that would come back in (`a/../b`)? Judge the form the path is used in (`exec/lane.mjs`'s `normalised`
 *  for an owns path), so `.//etc` is `/etc` before the check, never after. */
export const leaves = (path) => path.startsWith("/") || path.split("/").includes("..");

/** Is `path` strictly inside the directory `dir` (both resolved; `dir` itself is not inside)? A child whose
 *  name only starts with `..` (`..cache`) is inside. */
export function insideDir(dir, path) {
  const rel = relative(resolve(dir), resolve(dir, path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
