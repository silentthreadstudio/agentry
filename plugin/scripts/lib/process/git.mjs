// git — the process kit's only git I/O: does a commit exist, recent history, ancestry, parents and
// identities, a branch's reflog, worktrees, patch ids (to match a cherry-picked commit to its branch
// original), the default branch, the branch checked out, the main checkout of a linked worktree, a commit's
// shortest unique prefix, the tracked files and the ignored ones. Whether a change is still in effect where
// it landed (`inEffect`) is `in-effect.mjs`, built on `runGit` and these.
//
// Every function takes the git root first and never throws: outside a repo, or on any git error, it
// answers false / [] / null. Refs and SHAs are checked before they reach argv, so a board cell can never
// become a git option. Nothing here changes the repository: `reverseApplies` works on a throwaway index.
// `runGit` is the same timed runner for a caller that needs git's status and stderr: it answers
// `{ status, stdout, stderr }` and passes its argv as given, so its callers build that argv themselves.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SHA = /^[0-9a-f]{4,64}$/i;
/** A full commit id: 40 hex digits (SHA-1) to 64 (SHA-256). */
export const FULL_SHA = /^[0-9a-f]{40,64}$/;
const safeRef = (ref) => typeof ref === "string" && ref.length > 0 && !ref.startsWith("-");

// A git call never waits forever: past the timeout it is killed, with every process it started, and
// answers like any git error. The default is 120 s; AGENTRY_GIT_TIMEOUT_MS shortens it for a test. Read at
// each call; anything but a positive number is the default.
const timeoutMs = () => {
  const ms = Number(process.env.AGENTRY_GIT_TIMEOUT_MS);
  return ms > 0 ? Math.min(ms, 2 ** 31 - 1) : 120_000;
};

// No stdin at all unless the call passes `input`: a git that waits on a stdin nobody writes would hang.
// The child leads its own process group, so a timeout takes its children down with it.
/** Run git in `root`: `{ status, stdout, stderr }`, never throwing. A call that cannot run, or is killed
 *  at the timeout, answers a non-zero status. */
export function runGit(root, args, input, env) {
  const res = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    input,
    env,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs(),
    killSignal: "SIGKILL",
    detached: true,
  });
  if (res.error?.code === "ETIMEDOUT" && res.pid) {
    try {
      process.kill(-res.pid, "SIGKILL");
    } catch {} // the group is already gone
  }
  const status = res.error ? res.status || 1 : (res.status ?? 1);
  return { status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// git's stdout, or null on any failure.
function git(root, args, input, env) {
  const res = runGit(root, args, input, env);
  return res.status === 0 ? res.stdout : null;
}

// `${root}\0${sha}` of each commit found. Only a commit is remembered: a SHA git did not have may
// arrive later (a fetch, a cherry-pick), so a miss is asked again.
const known = new Set();

/** The `shas` that name a commit in the repo at `root`, as a Set. The ones not yet cached are asked in
 *  one `git cat-file --batch-check` (one line out per line in), so a board's every SHA costs one process. */
export function knownCommits(root, shas) {
  const key = (sha) => `${root}\0${sha}`;
  const asked = [...new Set(shas)].filter((sha) => SHA.test(sha ?? "") && !known.has(key(sha)));
  if (asked.length) {
    const input = asked.map((sha) => `${sha}^{commit}\n`).join("");
    const out = git(root, ["cat-file", "--batch-check=%(objecttype)"], input)?.split("\n") ?? [];
    asked.forEach((sha, i) => out[i] === "commit" && known.add(key(sha)));
  }
  return new Set(shas.filter((sha) => known.has(key(sha))));
}

/** True when `sha` names a commit in the repo at `root`. A commit found is cached per root and SHA (see `knownCommits`). */
export const hasCommit = (root, sha) => knownCommits(root, [sha]).has(sha);

/** True when git ignores `path` (relative to `root`; `git check-ignore`). False outside a repository. */
export const isIgnored = (root, path) => git(root, ["check-ignore", "-q", "--", path]) !== null;

/** The untracked paths git ignores under `root`, relative to it, a wholly ignored directory as one entry
 *  ending in `/` (`ls-files --others --ignored --exclude-standard --directory`). [] when git cannot say. */
export function ignoredPaths(root) {
  const args = ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"];
  return (git(root, args) ?? "").split("\0").filter(Boolean);
}

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

/** Stable patch ids of the non-merge commits `revs` lists (a range like `main..feature`, or a list like
 *  `[main, feature, "^base"]`): `{ patchId, sha }`. The same change cherry-picked onto another branch has
 *  the same patch id; a commit that changes nothing has none. */
export function patchIds(root, revs) {
  const list = [revs].flat();
  if (!list.length || !list.every(safeRef)) return [];
  const patches = git(root, [
    "log",
    "-p",
    "--no-color",
    "--no-ext-diff",
    "--no-merges",
    ...list,
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

/** The shortest prefix of commit `sha`, from 7 characters, that names that commit and no other object of
 *  any type (a tag or a blob sharing the prefix would make the board's checker fail on it), in one
 *  `rev-parse --short=7` (pinned, so `core.abbrev` cannot change it). null when `sha` is not a commit:
 *  `cat-file -t` does not peel a tag to the commit it points at. */
export function shortestUnique(root, sha) {
  if (!safeRef(sha) || git(root, ["cat-file", "-t", sha])?.trim() !== "commit") return null;
  return git(root, ["rev-parse", "--short=7", "--verify", `${sha}^{commit}`])?.trim() || null;
}

/** The full SHA of the commit each of `refs` names, in one `cat-file --batch-check`: Map ref → SHA, a ref
 *  that names no commit left out. */
export function commitsOf(root, refs) {
  const asked = [...new Set(refs)].filter((r) => safeRef(r) && !/\s/.test(r));
  const input = asked.map((ref) => `${ref}^{commit}\n`).join("");
  const out = asked.length ? git(root, ["cat-file", "--batch-check"], input) : "";
  const lines = out?.split("\n") ?? [];
  const found = new Map();
  for (const [i, ref] of asked.entries()) {
    const m = /^([0-9a-f]{40,64}) commit /.exec(lines[i] ?? "");
    if (m) found.set(ref, m[1]);
  }
  return found;
}

/** True when commit `a` is an ancestor of (or is) commit `b`. */
export const isAncestor = (root, a, b) =>
  safeRef(a) && safeRef(b) && git(root, ["merge-base", "--is-ancestor", a, b]) !== null;

/** The best common ancestor of `a` and `b`, or null. */
export const mergeBase = (root, a, b) =>
  (safeRef(a) && safeRef(b) && git(root, ["merge-base", a, b])?.trim()) || null;

/** A best common ancestor of all of `shas` (`merge-base --octopus`), or null. */
export const octopusBase = (root, shas) =>
  (shas.length > 0 &&
    shas.every(safeRef) &&
    git(root, ["merge-base", "--octopus", ...shas])?.trim()) ||
  null;

/** Every local branch's tip, in one `for-each-ref`: Map name → full SHA. With `on` (a commit), only the
 *  branches whose tip is on its history. */
export function branchTips(root, { on } = {}) {
  if (on !== undefined && !safeRef(on)) return new Map();
  const format = "--format=%(objectname) %(refname)";
  const out = git(root, ["for-each-ref", ...(on ? [`--merged=${on}`] : []), format, "refs/heads/"]);
  const tips = new Map();
  for (const line of (out ?? "").split("\n")) {
    const at = line.indexOf(" refs/heads/");
    if (at > 0) tips.set(line.slice(at + " refs/heads/".length), line.slice(0, at));
  }
  return tips;
}

/** The commits reachable from `heads` and not from `not`, children before parents (`--topo-order`), in
 *  one `rev-list`: a Map sha → [parent…] in that order. Empty when git cannot answer. */
export function graph(root, heads, not) {
  const revs = [...heads, ...(not ? [`^${not}`] : [])];
  if (!heads.length || !revs.every(safeRef)) return new Map();
  const out = git(root, ["rev-list", "--topo-order", "--parents", ...revs, "--"]);
  return new Map(
    (out ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ...up] = line.split(" ");
        return [sha, up];
      }),
  );
}

/** The paths each of `pairs` (`[to, from]`, full SHAs) changes from `from` to `to`: a Set per pair, in
 *  order, from one `diff-tree --stdin`. null when git cannot answer. */
export function changedPaths(root, pairs) {
  if (!pairs.flat().every((c) => FULL_SHA.test(c ?? ""))) return null;
  if (!pairs.length) return [];
  const args = ["diff-tree", "--stdin", "--always", "-r", "--raw", "-z", "--no-renames"];
  const out = git(root, args, pairs.map(([to, from]) => `${to} ${from}\n`).join(""));
  if (out === null) return null;
  const found = [];
  const tokens = out.split("\0");
  // Each pair: its `to` alone (a header, even with no change), then a raw entry and its path per change.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].startsWith(":")) found.at(-1)?.add(tokens[++i]);
    else if (FULL_SHA.test(tokens[i])) found.push(new Set());
  }
  return found.length === pairs.length ? found : null;
}

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

/** The main checkout for `dir`, which may be inside a linked worktree. Null outside a repository. */
export function mainRoot(dir) {
  const out = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return out === null ? null : dirname(out.trim());
}

/** The branch checked out at `dir`, or null when HEAD is detached. */
export const currentBranch = (dir) =>
  git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"])?.trim() ?? null;

const tops = new Map(); // root → its top, once found

/** The top of the working tree `root` is in, or null. Cached per root once found. */
export function topLevel(root) {
  if (!tops.has(root)) {
    const top = git(root, ["rev-parse", "--show-toplevel"])?.trim();
    if (!top) return null;
    tops.set(root, top);
  }
  return tops.get(root);
}

// What a commit is never changes: a fact about a full SHA is asked of git once per root, then served from
// here. `ask(missing)` answers the SHAs not known yet as a Map sha → value.
const facts = new Map(); // `${what}\0${root}\0${sha}` → value
function remembered(root, what, shas, ask) {
  const key = (sha) => `${what}\0${root}\0${sha}`;
  const found = new Map();
  const missing = [];
  for (const sha of new Set(shas.filter((s) => SHA.test(s ?? "")))) {
    if (facts.has(key(sha))) found.set(sha, facts.get(key(sha)));
    else missing.push(sha);
  }
  for (const [sha, value] of missing.length ? ask(missing) : []) {
    if (FULL_SHA.test(sha)) facts.set(key(sha), value);
    found.set(sha, value);
  }
  return found;
}

/** The parents of each of `shas` (full SHAs), as a Map sha → [parent…]: a merge has two or more, a root
 *  commit none. A SHA git does not know is left out. Asked in one call, cached per SHA. */
export const parents = (root, shas) =>
  remembered(root, "parents", shas, (asked) => {
    const out = git(root, ["log", "--no-walk=unsorted", "--format=%H %P", ...asked]);
    return (out ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ...up] = line.split(" ").filter(Boolean);
        return [sha, up];
      });
  });

/** Who and what each of `shas` (full SHAs) is: author, author date and message, which a cherry-pick
 *  keeps. A Map sha → text; a SHA git does not know is left out. Asked in one call, cached per SHA. */
export const identities = (root, shas) =>
  remembered(root, "identity", shas, (asked) => {
    const format = "--format=%H%x1f%an <%ae> %ad%x1f%B%x1e";
    const out = git(root, ["show", "-s", "--date=raw", format, ...asked]);
    const found = [];
    for (const record of (out ?? "").split("\x1e")) {
      const [sha, who, body] = record.replace(/^\n/, "").split("\x1f");
      if (sha && who !== undefined) found.push([sha, `${who}\n${(body ?? "").trim()}`]);
    }
    return found;
  });

/** True when the net change `from..to` reverse-applies to commit `onto`'s tree (`git apply --check -R`).
 *  It matches at any offset, so it is only a hint that a change LOOKS present (a squash nobody can name
 *  commits for); never a proof that it is still where it landed (that is `inEffect`). False for an
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
    const file = join(dir, "change.patch");
    writeFileSync(file, patch);
    return (
      git(top, ["read-tree", onto], undefined, env) !== null &&
      git(top, ["apply", "--cached", "--check", "-R", file], undefined, env) !== null
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
