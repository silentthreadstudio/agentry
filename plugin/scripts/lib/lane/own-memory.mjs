// own-memory — "is this Agentry's own memory write", and the one clean/dirty read built on it
// (`dirtyEntries`): `lane exec`'s main guard, `lane merge`'s clean checks and the gate share it, so a stop
// cannot move from one step to the next. Agentry's memory
// store writes a new `.agentry/memory/<facts|episodes>/<slug>-<ULID>.md` per record; in a repo that
// commits `.agentry/` such a file sits untracked on main until the owner commits it, and neither step
// may count it as the builder's or the owner's work. Only that shape, only as a new file: an edit of a
// tracked record, a deletion or any other file under the store is still a change. (A well-formed fact
// planted by hand looks the same as a conductor's `memory_write`; that stays open.)
import { git } from "./worktree.mjs";

const STORE = /^\.agentry\/memory\/(?:facts|episodes)\/[a-z0-9-]+-[0-9A-Z]{26}\.md$/;

/** Is `path` (repo-relative, `/`-separated) a record file of the memory store? */
export const isMemoryPath = (path) => STORE.test(path);

/** Is this `git status --porcelain` entry (`"XY path"`) a new, untracked memory record? One staged as new
 *  is not: a land that picks the same path would refuse on it, so it counts as the owner's change. */
export const isMemoryWrite = (entry) => entry.startsWith("?? ") && isMemoryPath(entry.slice(3));

/** The `git status` entries of `dir` that are not Agentry's own new memory records, as `"XY path"` read
 *  untrimmed (a rename's or copy's source follows as its own field); null when git fails. The one answer to
 *  "is this checkout clean": exec's main guard, the land, the carry, the recovery and the gate use it. */
export function dirtyEntries(dir) {
  const res = git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return res.status === 0
    ? res.stdout.split("\0").filter((entry) => entry && !isMemoryWrite(entry))
    : null;
}

/** Does commit `sha` (not a merge) do nothing but add memory records? */
export function isMemoryCommit(root, sha) {
  const res = git(root, [
    "diff-tree",
    "-r",
    "-z",
    "--no-commit-id",
    "--name-status",
    "--no-renames",
    sha,
  ]);
  if (res.status !== 0) return false;
  const parts = res.stdout.split("\0").filter(Boolean);
  if (!parts.length || parts.length % 2) return false;
  for (let i = 0; i < parts.length; i += 2)
    if (parts[i] !== "A" || !isMemoryPath(parts[i + 1])) return false;
  return true;
}
