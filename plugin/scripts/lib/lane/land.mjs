// land — the git and process I/O that lands a task's branch on main (plan R1b-5): which commits to
// pick, the cherry-pick (aborted on any stop), which picks main really holds, the rollback after a red
// gate, the carry of exec's uncommitted board writes, the board commit, the push, the cleanup by branch,
// and the gate's process group across a killed run. `cli/merge.mjs` sequences these steps against the
// ledger.
//
// Every git call is an argv array, never a shell line (a zsh variable that did not split once turned a
// cherry-pick into a silent no-op), and every one reads its own exit code. A git refusal is an answer
// (`{ ok: false, reason }`), not a throw: the stepper turns it into a red row. Node built-ins only.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { boardFiles } from "../process/board-diff.mjs";
import { readProcess } from "../process/read.mjs";
import { findByBranch, git, ignoredFiles, porcelain, remove } from "./worktree.mjs";

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
  const restored = commitOf(root, "HEAD") === preHead && porcelain(root).length === 0;
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

/** The cherry-pick git is in the middle of in `root` (a killed run leaves one): `[{ name, path }]`
 *  for each of `.git/sequencer` and `CHERRY_PICK_HEAD` that exists; empty when none. */
export function pickInProgress(root) {
  return ["sequencer", "CHERRY_PICK_HEAD"].flatMap((name) => {
    const res = git(root, ["rev-parse", "--git-path", name]);
    const path = resolve(root, res.stdout.trim());
    return res.status === 0 && existsSync(path) ? [{ name, path }] : [];
  });
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
  const dirty = porcelain(root);
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

/** `git status` entries as `"XY path"`, read untrimmed so the first keeps its leading " " column
 *  (`porcelain` trims it); null when git fails. */
export function statusEntries(dir) {
  const res = git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return res.status === 0 ? res.stdout.split("\0").filter(Boolean) : null;
}

/** The entries that are not a plain edit of one of `files` (a rename's source field included). */
export function notEdits(entries, files) {
  const wanted = new Set(files);
  return entries.filter(
    (entry) => !wanted.has(entry.slice(3)) || !/^(?: M|M |MM)$/.test(entry.slice(0, 2)),
  );
}

/** The sha256 of `text`, hex. */
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** The uncommitted edits of `files` against HEAD as one binary patch, and its sha256: `{ patch,
 *  sha256 }`, or `{ error }` when git cannot say. */
export function uncommittedPatch(root, files) {
  const res = git(root, ["--literal-pathspecs", "diff", "--binary", "HEAD", "--", ...files]);
  if (res.status !== 0) return { error: first(res.stderr) || "git diff failed" };
  return { patch: res.stdout, sha256: sha256(res.stdout) };
}

/** Apply `patch` to the working tree, all or nothing; `check` only asks git whether it would, and
 *  `reverse` takes it off (a reverse check that passes: the edits are on the tree already). `{ ok }` or
 *  `{ ok: false, reason }`. */
export function applyPatch(root, patch, { check = false, reverse = false } = {}) {
  const flags = [...(check ? ["--check"] : []), ...(reverse ? ["--reverse"] : [])];
  const res = git(root, ["apply", "--whitespace=nowarn", ...flags, "-"], patch);
  return res.status === 0
    ? { ok: true }
    : { ok: false, reason: first(res.stderr) || "git apply failed" };
}

/** The working tree's board in the shape `board-diff` reads: `{ model, text(file) }`. */
export function workingBoard(root, spec) {
  const text = (file) => {
    try {
      return readFileSync(join(root, file), "utf8");
    } catch {
      return null;
    }
  };
  return { model: readProcess({ root, spec }), text };
}

/** HEAD's board in the same shape: HEAD's copy of each board file `model` (the working board's) was
 *  read from goes to a scratch directory and is read there, by the same reader. */
export function headBoard(root, spec, model) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentry-head-")));
  const texts = new Map();
  try {
    for (const file of boardFiles(spec, model)) {
      const res = git(root, ["--literal-pathspecs", "cat-file", "blob", `HEAD:${file}`]);
      if (res.status !== 0) continue;
      texts.set(file, res.stdout);
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), res.stdout);
    }
    return { model: readProcess({ root: dir, spec }), text: (file) => texts.get(file) ?? null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  return { ok: true, sha: commitOf(root, "HEAD"), left: porcelain(root) };
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
 * on `main`. Refused while the worktree holds ignored files (build output, screenshots: they would be
 * lost), unless `discardIgnored`. Returns `{ ok, path, removed, branchDeleted, ignored?, reason? }`.
 */
export function cleanup(root, { branch, main, fallbackPath, discardIgnored = false }) {
  const path = findByBranch(root, branch) ?? fallbackPath;
  if (path === root)
    return { ok: false, path, reason: `${branch} is checked out in the main checkout` };
  let ignored = [];
  try {
    ignored = ignoredFiles(path);
  } catch {
    ignored = []; // no work tree there (already gone): nothing to lose
  }
  if (ignored.length > 0 && !discardIgnored)
    return {
      ok: false,
      path,
      ignored,
      reason: `${path} holds ${ignored.length} ignored file(s) that removal would delete`,
    };
  const res = remove(root, { path, branch, onto: main });
  const ok = res.removed && (res.branchDeleted || !commitOf(root, `refs/heads/${branch}`));
  return { ok, path, ...res, ...(ignored.length > 0 && { ignored }) };
}

// The gate runs under this wrapper: it writes its own pid to `pidFile`, then runs the gate as its
// child. `runGate` starts it detached, so the wrapper leads the group the gate runs in and its pid is
// the group's id. A merge killed mid-gate leaves that group running; the next run finds it by the file.
const WRAP = `const [, pidFile, ...cmd] = process.argv.slice(1);
require("node:fs").writeFileSync(pidFile, String(process.pid));
const r = require("node:child_process").spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
if (r.error) { console.error("[agentry] could not run " + cmd[0] + ": " + r.error.message); process.exit(127); }
process.exit(r.status ?? 1);`;

/** The argv that runs the gate `cmd` under the pid-writing wrapper. `nonce` sits in the wrapper's own
 *  argv, so a later run can tell the group is this gate's and not a process that reused the pid. */
export function gateArgv(cmd, { pidFile, nonce }) {
  return [process.execPath, "-e", WRAP, nonce, pidFile, ...cmd];
}

const alive = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // there, but not ours to signal
  }
};

/**
 * End the gate a killed run left behind (`run` = `{ pidFile, nonce }`, as the ledger recorded it).
 * `{ ok: true, pgid, killed }` (`killed`: a group was still running and is gone now), or `{ ok: false,
 * pgid, reason }` when the group will not die. A live group is the gate's when its leader's argv holds
 * the nonce, or when it has no leader left (a live group's id is never reused); one whose leader is
 * another process is left alone.
 */
export function endStrayGate(run) {
  let pgid;
  try {
    pgid = Number.parseInt(readFileSync(run.pidFile, "utf8").trim(), 10);
  } catch {
    return { ok: true, pgid: null, killed: false }; // the wrapper never started
  }
  if (!Number.isInteger(pgid) || pgid <= 1 || !alive(pgid))
    return { ok: true, pgid, killed: false };
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pgid)], { encoding: "utf8" });
  if (ps.error)
    return {
      ok: false,
      pgid,
      reason: `ps cannot say what process ${pgid} is: ${ps.error.message}`,
    };
  const leader = ps.status === 0 ? ps.stdout.trim() : "";
  if (leader && !leader.includes(run.nonce)) return { ok: true, pgid, killed: false }; // a reused pid
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    return { ok: false, pgid, reason: `cannot kill process group ${pgid}: ${error.code}` };
  }
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; waited < 5000 && alive(pgid); waited += 20) Atomics.wait(nap, 0, 0, 20);
  if (alive(pgid)) return { ok: false, pgid, reason: `process group ${pgid} is still running` };
  return { ok: true, pgid, killed: true };
}
