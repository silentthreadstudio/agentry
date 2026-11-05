// keep — the worktrees the repo keeps on purpose (`worktrees.keep` in the process file): names or globs
// (`*` and `?`) matched against a worktree's branch and its directory name. A kept worktree is shown as
// kept and never raised as drift. PURE.
import { basename } from "node:path";
import { wildcardSource } from "./glob.mjs";

/** Whether `tree` (`{ path, branch }`) matches one of the spec's `worktrees.keep` entries. */
export function isKept(spec, tree) {
  const names = [tree.branch, basename(tree.path)].filter(Boolean);
  return (spec.worktrees?.keep ?? []).some((glob) => {
    const re = new RegExp(`^${wildcardSource(glob)}$`);
    return names.some((n) => re.test(n));
  });
}
