// land — the git that lands a task's branch on main (plan R1b-5): which commits to pick, the
// cherry-pick (aborted on any stop), which picks main really holds, the rollback after a red gate, the
// board commit, the push and the cleanup by branch. `cli/merge.mjs` and `merge/` sequence these steps
// against the ledger; the carry's patch and boards are `carry-io.mjs`, the gate's process group
// `gate-group.mjs`.
//
// Every git call is an argv array, never a shell line (a zsh variable that did not split once turned a
// cherry-pick into a silent no-op), and every one reads its own exit code. A git refusal is an answer
// (`{ ok: false, reason }`), not a throw: the stepper turns it into a red row. Node built-ins only.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { globMatch } from "./gate.mjs";
import { dirtyEntries } from "./own-memory.mjs";
import { findByBranch, git, ignoredFiles, remove } from "./worktree.mjs";

const first = (text) => text.trim().split("\n")[0] ?? "";
const lines = (text) => text.split("\n").filter(Boolean);
const short = (sha) => sha.slice(0, 7);

/** The commit `ref` names, as a full SHA, or null. `--end-of-options` keeps a ref from reading as an
 *  option. */
export function commitOf(dir, ref) {
  if (typeof ref !== "string" || ref === "") return null;
  const res = git(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  return res.status === 0 ? res.stdout.trim() : null;
}

/** The tree of commit `ref`, or null. */
export function treeOf(dir, ref) {
  const sha = commitOf(dir, ref);
  if (!sha) return null;
  const res = git(dir, ["rev-parse", "--verify", "--quiet", `${sha}^{tree}`]);
  return res.status === 0 ? res.stdout.trim() : null;
}

/** The branch checked out at `dir`, or null when HEAD is detached. */
export function currentBranch(dir) {
  const res = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return res.status === 0 ? res.stdout.trim() : null;
}

/** `git rev-list --reverse [--first-parent] from..to`: the commits after `from` up to `to`, oldest
 *  first; null when git cannot say. */
export function commitsBetween(dir, from, to, { firstParent = false } = {}) {
  const args = ["rev-list", "--reverse", ...(firstParent ? ["--first-parent"] : [])];
  const res = git(dir, [...args, `${from}..${to}`, "--"]);
  return res.status === 0 ? lines(res.stdout) : null;
}

/** The best common ancestor of `a` and `b`, or null. */
export function mergeBaseOf(dir, a, b) {
  const [x, y] = [commitOf(dir, a), commitOf(dir, b)];
  if (!x || !y) return null;
  const res = git(dir, ["merge-base", x, y]);
  return res.status === 0 ? res.stdout.trim() : null;
}

/** True when commit `a` is an ancestor of (or is) commit `b`. */
export function isAncestor(dir, a, b) {
  const [x, y] = [commitOf(dir, a), commitOf(dir, b)];
  return Boolean(x && y) && git(dir, ["merge-base", "--is-ancestor", x, y]).status === 0;
}

/** The files commit `sha` changes against its first parent, or null when git cannot say. */
export function filesOf(dir, sha) {
  const res = git(dir, ["diff-tree", "--no-commit-id", "--name-only", "-z", "-r", sha, "--"]);
  return res.status === 0 ? res.stdout.split("\0").filter(Boolean) : null;
}

/** A commit's subject line. */
export const subjectOf = (dir, sha) =>
  git(dir, ["log", "-1", "--format=%s", sha, "--"]).stdout.trim();

/**
 * What `branch` holds that `main` lacks: `{ picks, onMain, merges }`, each a list of full SHAs, oldest
 * first. `picks` are the commits to cherry-pick; `onMain` are branch commits whose patch is already on
 * main (`git cherry` marks them "-"); `merges` are merge commits, which a cherry-pick cannot land (and
 * `git cherry` does not see), so the branch has to be rebased first. `{ error }` when a ref is unknown.
 */
export function toLand(root, { main, branch }) {
  const onto = commitOf(root, main);
  const tip = commitOf(root, branch);
  if (!onto) return { error: `"${main}" is not a commit` };
  if (!tip) return { error: `"${branch}" is not a commit` };
  const merges = git(root, ["rev-list", "--reverse", "--merges", `${onto}..${tip}`, "--"]);
  const cherry = git(root, ["cherry", onto, tip]);
  if (merges.status !== 0 || cherry.status !== 0)
    return { error: first(merges.stderr || cherry.stderr) || "git could not compare the branch" };
  const marked = lines(cherry.stdout).map((line) => line.split(" "));
  return {
    picks: marked.filter(([mark]) => mark === "+").map(([, sha]) => sha),
    onMain: marked.filter(([mark]) => mark === "-").map(([, sha]) => sha),
    merges: lines(merges.stdout),
  };
}

/**
 * Cherry-pick `shas` (oldest first) onto HEAD in one argv call. On any non-zero exit the sequence is
 * aborted (`cherry-pick --abort`, never a hand reset) and HEAD must be `preHead` again with a clean tree.
 * Returns `{ ok: true }` (which commits main then holds is `landedSince`'s answer) or `{ ok: false,
 * stopped, reason, restored }`: `stopped` is the commit it stopped on (null when git did not say),
 * `restored` whether main is back at `preHead` and clean.
 */
export function cherryPick(root, { shas, preHead }) {
  const res = git(root, ["cherry-pick", ...shas]);
  if (res.status === 0) return { ok: true };
  const stopped = commitOf(root, "CHERRY_PICK_HEAD");
  const reason = first(res.stderr) || first(res.stdout) || `git cherry-pick exited ${res.status}`;
  git(root, ["cherry-pick", "--abort"]); // no sequence in progress (a bad SHA) fails here, harmlessly
  const restored =
    commitOf(root, "HEAD") === preHead && (statusEntries(root) ?? ["?"]).length === 0;
  return { ok: false, stopped, reason, restored };
}

// Who and what a commit is: author, author date and message, which a cherry-pick keeps (its patch id
// can change when main's context lines differ from the branch's).
function identities(root, shas) {
  const res = git(root, [
    "show",
    "-s",
    "--date=raw",
    "--format=%H%x1f%an <%ae> %ad%x1f%B%x1e",
    ...shas,
  ]);
  const out = new Map();
  for (const record of res.status === 0 ? res.stdout.split("\x1e") : []) {
    const [sha, who, body] = record.replace(/^\n/, "").split("\x1f");
    if (sha) out.set(sha, `${who}\n${(body ?? "").trim()}`);
  }
  return out;
}

/**
 * Which of `planned` (branch commits, oldest first) main holds since `preHead`, read from main itself:
 * its first-parent commits since `preHead`, each the planned commit at the same place (same author,
 * date and message). `{ landed, rest }` (main's commits, and the planned ones not on it yet), or
 * `{ error }` when main holds anything else or lost `preHead` from its history.
 */
export function landedSince(root, { preHead, planned }) {
  if (!isAncestor(root, preHead, "HEAD"))
    return { error: `${short(preHead)} is no longer in main's history` };
  const chain = commitsBetween(root, preHead, "HEAD", { firstParent: true });
  if (chain === null) return { error: `git cannot list main's commits since ${short(preHead)}` };
  if (chain.length > planned.length)
    return {
      error: `main has ${chain.length} commit(s) since ${short(preHead)}, more than the ${planned.length} planned`,
    };
  if (chain.length === 0) return { landed: [], rest: [...planned] };
  const ids = identities(root, [...chain, ...planned.slice(0, chain.length)]);
  const off = chain.findIndex((sha, i) => !ids.get(sha) || ids.get(sha) !== ids.get(planned[i]));
  if (off >= 0)
    return {
      error: `${short(chain[off])} on main is not the planned pick of ${short(planned[off])}`,
    };
  return { landed: chain, rest: planned.slice(chain.length) };
}

const gitPath = (root, name) => {
  const res = git(root, ["rev-parse", "--git-path", name]);
  return res.status === 0 ? resolve(root, res.stdout.trim()) : null;
};

/** The cherry-pick or revert git is in the middle of in `root` (a killed run leaves one): `[{ name,
 *  path }]` for each of `.git/sequencer`, `CHERRY_PICK_HEAD` and `REVERT_HEAD` that exists; empty when
 *  none. */
export function pickInProgress(root) {
  return ["sequencer", "CHERRY_PICK_HEAD", "REVERT_HEAD"].flatMap((name) => {
    const path = gitPath(root, name);
    return path && existsSync(path) ? [{ name, path }] : [];
  });
}

/** What git's sequencer still has to do, as its todo file lists it: `[{ command, word, sha }]` (`sha`
 *  the full SHA `word` names, or null), or null when there is no todo file. */
export function sequencerTodo(root) {
  const path = gitPath(root, "sequencer/todo");
  if (!path || !existsSync(path)) return null;
  return lines(readFileSync(path, "utf8"))
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [command, word = ""] = line.split(/\s+/);
      return { command, word, sha: commitOf(root, word) };
    });
}

/** True when a conflict was resolved and staged by hand: nothing is unmerged, yet the index differs
 *  from HEAD (git stopping on a conflict leaves unmerged entries; a pick that committed leaves none). */
export function resolvedByHand(root) {
  const unmerged = git(root, ["ls-files", "-u", "-z"]);
  if (unmerged.status !== 0 || unmerged.stdout !== "") return false;
  return git(root, ["diff", "--cached", "--quiet", "HEAD", "--"]).status === 1;
}

/** The text of `file` (repo-relative) in `rev` (a commit, or "" for the index), or null. */
export function textAt(root, rev, file) {
  const res = git(root, ["cat-file", "blob", `${rev}:${file}`]);
  return res.status === 0 ? res.stdout : null;
}

/** End the cherry-pick git is in the middle of, with `cherry-pick --abort` until git keeps nothing of
 *  it: killed after a pick's commit, git does not rewind and keeps a stale CHERRY_PICK_HEAD the first
 *  abort leaves, so it can take two. Which picks stay on main is `landedSince`'s answer. `{ ok,
 *  aborts }`, or `{ ok: false, reason }` while one is still in progress. */
export function abortPick(root) {
  let aborts = 0;
  let res = null;
  while (pickInProgress(root).length > 0 && aborts < 3) {
    res = git(root, ["cherry-pick", "--abort"]);
    aborts++;
  }
  if (pickInProgress(root).length === 0) return { ok: true, aborts };
  return {
    ok: false,
    reason: first(res?.stderr ?? "") || "git cherry-pick --abort did not end it",
  };
}

/**
 * Put main back at `preHead` after a red gate, with `reset --keep` (git refuses rather than overwrite a
 * local change, one `git status` cannot see included), and only when HEAD's first-parent chain since
 * `preHead` is exactly `landed` and the tree is clean: anything else on main (someone else's commit,
 * files the gate left) is not ours to throw away. `{ ok }` or `{ ok: false, reason }`.
 */
export function rollback(root, { preHead, landed }) {
  const chain = commitsBetween(root, preHead, "HEAD", { firstParent: true });
  if (chain === null) return { ok: false, reason: `cannot list the commits since ${preHead}` };
  if (chain.join(" ") !== landed.join(" "))
    return {
      ok: false,
      reason: `main has ${chain.length} commit(s) since ${preHead.slice(0, 7)}, not exactly the ${landed.length} landed`,
    };
  const dirty = statusEntries(root) ?? ["git status failed"];
  if (dirty.length > 0)
    return {
      ok: false,
      reason: `main is not clean (${dirty.slice(0, 5).join(", ")}); not resetting over it`,
    };
  const res = git(root, ["reset", "--keep", "--quiet", preHead]);
  if (res.status !== 0)
    return {
      ok: false,
      reason: `git reset --keep refused: ${first(res.stderr) || "no reason given"}`,
    };
  return { ok: true };
}

/** `git status` entries as `"XY path"` (`dirtyEntries`, `own-memory.mjs`): Agentry's own new memory
 *  records are left out, so main counts as clean with them on it, and the land leaves them as they are. */
export const statusEntries = dirtyEntries;

/** The entries that are not a plain edit of one of `files` (a rename is two: its delete and its add). */
export function notEdits(entries, files) {
  const wanted = new Set(files);
  return entries.filter(
    (entry) => !wanted.has(entry.slice(3)) || !/^(?: M|M |MM)$/.test(entry.slice(0, 2)),
  );
}

/** Put `files` (repo-relative) back to HEAD's content, staged and working copy. */
export function restoreFiles(root, files) {
  if (files.length === 0) return { ok: true };
  const res = git(root, [
    "--literal-pathspecs",
    "restore",
    "--source=HEAD",
    "--staged",
    "--worktree",
    "--",
    ...files,
  ]);
  return res.status === 0 ? { ok: true } : { ok: false, reason: first(res.stderr) };
}

// A line of a commit message that credits an AI tool (A13: commits carry the author only).
const ATTRIBUTION = [
  /^co-authored-by:.*\b(claude|anthropic|openai|chatgpt|gpt|copilot|gemini|codex|ai)\b/i,
  /noreply@anthropic\.com/i,
  /^claude-session:/i,
  /\bgenerated (with|by)\b.*\b(claude|anthropic|chatgpt|copilot|gemini|ai)\b/i,
  /\u{1F916}/u,
];

/** The first line of `message` that carries AI attribution, or null. PURE. */
export function attributionIn(message) {
  const lines = String(message)
    .split(/\r?\n/)
    .map((line) => line.trim());
  return lines.find((line) => ATTRIBUTION.some((re) => re.test(line))) ?? null;
}

/**
 * Commit exactly `files` (repo-relative) on main with `message`, through the repo's own hooks (never
 * `--no-verify`). Refused when the tree holds any other change. Returns `{ ok: true, sha, left }`
 * (`left`: what the tree still shows after the commit, which should be nothing) or `{ ok: false,
 * reason }` with the index as it was (the caller restores the files).
 */
export function boardCommit(root, { files, message }) {
  const entries = statusEntries(root);
  if (entries === null) return { ok: false, reason: "git status failed" };
  const other = notEdits(entries, files);
  if (other.length > 0)
    return { ok: false, reason: `main has other changes: ${other.slice(0, 5).join(", ")}` };
  const add = git(root, ["--literal-pathspecs", "add", "--", ...files]);
  if (add.status !== 0) return { ok: false, reason: first(add.stderr) };
  const commit = git(root, ["commit", "--quiet", "-m", message]);
  if (commit.status !== 0) {
    git(root, ["--literal-pathspecs", "reset", "--quiet", "--", ...files]);
    const said = `${commit.stderr}\n${commit.stdout}`.trim();
    return { ok: false, reason: said || `git commit exited ${commit.status}` };
  }
  return {
    ok: true,
    sha: commitOf(root, "HEAD"),
    left: statusEntries(root) ?? ["git status failed"],
  };
}

/** `branch`'s upstream, from its git config: `{ remote, ref }`, or null when it has none. */
export function upstreamOf(root, branch) {
  const get = (key) => git(root, ["config", "--get", `branch.${branch}.${key}`]);
  const remote = get("remote");
  const ref = get("merge");
  if (remote.status !== 0 || ref.status !== 0) return null;
  return { remote: remote.stdout.trim(), ref: ref.stdout.trim() };
}

/** Push `branch` to its upstream (the repo's pre-push hooks run). `{ ok, remote, ref }` or `{ ok: false,
 *  reason }`. */
export function push(root, { branch }) {
  const up = upstreamOf(root, branch);
  if (!up) return { ok: false, reason: `${branch} has no upstream to push to; nothing pushed` };
  const res = git(root, ["push", "--quiet", up.remote, `refs/heads/${branch}:${up.ref}`]);
  if (res.status !== 0)
    return { ok: false, reason: first(res.stderr) || `git push exited ${res.status}` };
  return { ok: true, ...up };
}

/**
 * Take down the worktree that has `branch` checked out (found by branch, whatever its directory is
 * called; `fallbackPath` when none has it) with `-f -f`, and delete the branch when everything on it is
 * on `main`. Refused while the worktree holds ignored files (screenshots, a local `.env`: they would be
 * lost) that no default (`DEFAULT_DISPOSABLE`) or `disposable` glob matches, unless `discardIgnored`. Returns `{ ok, path, removed,
 * branchDeleted, ignored?, disposable?, reason? }`: `ignored` the others, `disposable` the matched ones.
 */
export function cleanup(
  root,
  { branch, main, fallbackPath, discardIgnored = false, disposable = [] },
) {
  const path = findByBranch(root, branch) ?? fallbackPath;
  if (path === root)
    return { ok: false, path, reason: `${branch} is checked out in the main checkout` };
  let found = [];
  try {
    found = ignoredFiles(path);
  } catch {
    found = []; // no work tree there (already gone): nothing to lose
  }
  const isDisposable = disposableMatcher(disposable);
  const thrown = found.filter(isDisposable);
  const ignored = found.filter((entry) => !isDisposable(entry));
  const kept = {
    ...(ignored.length > 0 && { ignored }),
    ...(thrown.length > 0 && { disposable: thrown }),
  };
  if (ignored.length > 0 && !discardIgnored)
    return {
      ok: false,
      path,
      ...kept,
      reason: `${path} holds ${ignored.length} ignored file(s) that removal would delete`,
    };
  const res = remove(root, { path, branch, onto: main });
  const ok = res.removed && (res.branchDeleted || !commitOf(root, `refs/heads/${branch}`));
  return { ok, path, ...res, ...kept };
}

/** Ignored files every lane worktree's cleanup and the sweep discard without asking, on top of the
 *  process file's `cleanup.disposable`: dependency installs and build output. */
export const DEFAULT_DISPOSABLE = ["**/node_modules/**", "**/dist/**"];

/** Is an ignored entry (`dir/` for a wholly ignored directory) one of `DEFAULT_DISPOSABLE` or `globs`
 *  (the configured `cleanup.disposable`)? Matched with the gate's own glob test, as its path without the
 *  slash; a `dir/**` glob also takes `dir` itself. A glob that names a folder covers what is under it
 *  (gitignore semantics): an entry is matched as itself and as each of its parent folders. Only ignored
 *  files are ever asked about, so a tracked file is never discarded. */
export function disposableMatcher(globs = []) {
  const forms = [...DEFAULT_DISPOSABLE, ...globs].flatMap((glob) => {
    const g = glob.replace(/\/+$/, "");
    return g.endsWith("/**") ? [g, g.slice(0, -3)] : [g];
  });
  return (entry) => {
    const parts = entry.replace(/\/$/, "").split("/");
    const paths = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    return paths.some((path) => globMatch(forms, path));
  };
}
