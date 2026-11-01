// git — the process kit's only git I/O: does a commit exist, recent history, ancestry, a branch's reflog,
// worktrees, patch ids (to match a cherry-picked commit to its branch original), whether a change is still
// in a tree, the default branch and the tracked files.
//
// Every function takes the git root first and never throws: outside a repo, or on any git error, it
// answers false / [] / null. Refs and SHAs are checked before they reach argv, so a board cell can never
// become a git option. Nothing here changes the repository: `reverseApplies` works on a throwaway index.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHA = /^[0-9a-f]{4,40}$/i;
const safeRef = (ref) => typeof ref === "string" && ref.length > 0 && !ref.startsWith("-");

function git(root, args, input, env) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      input,
      env,
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

const known = new Map(); // `${root}\0${sha}` → boolean

/** The `shas` that name a commit in the repo at `root`, as a Set. The ones not yet cached are asked in
 *  one `git cat-file --batch-check` (one line out per line in), so a board's every SHA costs one process. */
export function knownCommits(root, shas) {
  const key = (sha) => `${root}\0${sha}`;
  const asked = [...new Set(shas)].filter((sha) => SHA.test(sha ?? "") && !known.has(key(sha)));
  if (asked.length) {
    const input = asked.map((sha) => `${sha}^{commit}\n`).join("");
    const out = git(root, ["cat-file", "--batch-check=%(objecttype)"], input)?.split("\n") ?? [];
    asked.forEach((sha, i) => known.set(key(sha), out[i] === "commit"));
  }
  return new Set(shas.filter((sha) => known.get(key(sha)) === true));
}

/** True when `sha` names a commit in the repo at `root`. Cached per root and SHA (see `knownCommits`). */
export const hasCommit = (root, sha) => knownCommits(root, [sha]).has(sha);

// The tracked files under `root` matching `pattern`, a glob pathspec in which `**` crosses directories
// (`**/TASKS.md`), relative to `root` and sorted; null when git cannot answer (not a repository).
export function trackedFiles(root, pattern) {
  const out = git(root, ["ls-files", "-z", "--", `:(glob)${pattern}`]);
  return out === null ? null : out.split("\0").filter(Boolean).sort();
}

/** The last `n` commits on `ref` (newest first): `{ sha, subject }`. */
export function log(root, { ref = "HEAD", n = 10, firstParent = false } = {}) {
  if (!safeRef(ref)) return [];
  const args = ["log", "--no-color", `-n${Math.max(1, Math.trunc(n))}`, "--format=%H%x00%s"];
  if (firstParent) args.push("--first-parent");
  const out = git(root, [...args, ref, "--"]);
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, subject = ""] = line.split("\0");
      return { sha, subject };
    });
}

/** Every worktree (`git worktree list --porcelain`): `{ path, head, branch }`, `branch` null when
 *  detached or bare. */
export function worktrees(root) {
  const out = git(root, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  return out
    .split(/\n\n+/)
    .filter((block) => block.startsWith("worktree "))
    .map((block) => {
      const tree = { path: "", head: null, branch: null };
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) tree.path = line.slice("worktree ".length);
        else if (line.startsWith("HEAD ")) tree.head = line.slice("HEAD ".length);
        else if (line.startsWith("branch "))
          tree.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      }
      return tree;
    });
}

/** Stable patch ids of the non-merge commits in `range` (e.g. `main..feature`): `{ patchId, sha }`.
 *  The same change cherry-picked onto another branch has the same patch id. */
export function patchIds(root, range) {
  if (!safeRef(range)) return [];
  const patches = git(root, [
    "log",
    "-p",
    "--no-color",
    "--no-ext-diff",
    "--no-merges",
    range,
    "--",
  ]);
  if (!patches) return [];
  const out = git(root, ["patch-id", "--stable"], patches);
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [patchId, sha] = line.split(" ");
      return { patchId, sha };
    });
}

/** The full SHA of the commit `ref` names, or null. */
export const commitOf = (root, ref) =>
  (safeRef(ref) && git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])?.trim()) ||
  null;

/** True when commit `a` is an ancestor of (or is) commit `b`. */
export const isAncestor = (root, a, b) =>
  safeRef(a) && safeRef(b) && git(root, ["merge-base", "--is-ancestor", a, b]) !== null;

/** The best common ancestor of `a` and `b`, or null. */
export const mergeBase = (root, a, b) =>
  (safeRef(a) && safeRef(b) && git(root, ["merge-base", a, b])?.trim()) || null;

/** The commits `range` lists (e.g. `base..tip`), oldest first. `firstParent` follows first parents only;
 *  `noMerges` leaves merge commits out. */
export function commits(root, range, { firstParent = false, noMerges = false } = {}) {
  if (!safeRef(range)) return [];
  const flags = [firstParent && "--first-parent", noMerges && "--no-merges"].filter(Boolean);
  const out = git(root, ["rev-list", "--reverse", ...flags, range, "--"]);
  return (out ?? "").split(/\s+/).filter(Boolean);
}

/** The reflog of local branch `branch`, newest first: `{ sha, says }`, `says` being the entry's message
 *  (`commit: …`, `cherry-pick: …`, `reset: …`). [] when it has none. */
export function reflog(root, branch) {
  if (!safeRef(branch)) return [];
  const out = git(root, ["log", "-g", "--format=%H %gs", `refs/heads/${branch}`, "--"]);
  return (out ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(" ");
      return { sha: line.slice(0, at), says: line.slice(at + 1) };
    });
}

/** The top of the working tree `root` is in, or null. */
export const topLevel = (root) => git(root, ["rev-parse", "--show-toplevel"])?.trim() || null;

/** True when the net change `from..to` reverse-applies to commit `onto`'s tree (`git apply --check -R`):
 *  every line it added is there, in its context, and every line it removed is still gone. False for an
 *  empty change. Checked on a throwaway index from the top of the tree, so a board in a subfolder still
 *  checks the whole change, and the repository's own index and files are never touched. */
export function reverseApplies(root, { from, to, onto }) {
  const top = topLevel(root);
  if (!top || ![from, to, onto].every(safeRef)) return false;
  const diff = ["diff", "--binary", "--no-renames", "--no-ext-diff", "--no-color", from, to, "--"];
  const patch = git(top, diff);
  if (!patch) return false;
  const dir = mkdtempSync(join(tmpdir(), "agentry-apply-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
  try {
    return (
      git(top, ["read-tree", onto], undefined, env) !== null &&
      git(top, ["apply", "--cached", "--check", "-R"], patch, env) !== null
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The default branch: `origin/HEAD`'s target, else a local `main` or `master`, else null. */
export function defaultBranch(root) {
  const remote = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remote?.trim()) return remote.trim().replace(/^[^/]+\//, "");
  for (const name of ["main", "master"]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]) !== null) return name;
  }
  return null;
}
