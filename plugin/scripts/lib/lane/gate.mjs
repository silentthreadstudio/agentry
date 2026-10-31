// gate — running a repo's gate command as a ledger fact (ADR-R4), plus the two pure decisions around it.
//
// `runGate` reads the gate command's OWN exit code: argv, no shell, so nothing can pipe the failure away
// (#1). It refuses to start on a dirty tree (an untracked file made "tree identical" lie, #2), counts a gate
// that leaves files behind as red, and writes the command's stdout and stderr to a per-run log file.
// `pickTier` and `canSkip` are pure: which tier a change needs, and whether a merge may skip the main gate.
// Node built-ins only.
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { git, porcelain } from "./worktree.mjs";

const DEFAULT_TIMEOUT_SEC = 3600;

/** Run `cmd` (argv) at the git root of `dir`. `logFile` should sit outside the tree under test, or the log
 *  itself would dirty it. `timeoutSec` (callers pass the gate config's, default 3600) bounds the run: past
 *  it the command's whole process group is killed and the gate is red. Returns `{ refused: "dirty", files }`
 *  without running when the tree is not clean; otherwise `{ exit, tier, commit, tree, cleanBefore,
 *  cleanAfter, log, seconds }`. When the command exits 0 but leaves files behind, `exit` is 1 (`commandExit`
 *  keeps the command's own code). */
export function runGate(dir, cmd, { tier, logFile, timeoutSec = DEFAULT_TIMEOUT_SEC }) {
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((a) => typeof a !== "string"))
    throw new TypeError("runGate: cmd must be a non-empty argv array");
  if (typeof timeoutSec !== "number" || !(timeoutSec > 0))
    throw new TypeError("runGate: timeoutSec must be a positive number");
  const before = porcelain(dir);
  if (before.length > 0) return { refused: "dirty", files: before };

  const top = git(dir, ["rev-parse", "--show-toplevel"]).stdout.trim() || dir;
  const commit = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
  const tree = git(dir, ["rev-parse", "HEAD^{tree}"]).stdout.trim();

  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "w");
  const started = Date.now();
  let res;
  let timedOut = false;
  try {
    // detached: the command leads its own process group, so a timeout can take its children down too.
    res = spawnSync(cmd[0], cmd.slice(1), {
      cwd: top,
      stdio: ["ignore", fd, fd],
      detached: true,
      timeout: timeoutSec * 1000,
      killSignal: "SIGKILL",
    });
    timedOut = res.error?.code === "ETIMEDOUT";
    if (timedOut) {
      try {
        process.kill(-res.pid, "SIGKILL");
      } catch {
        /* the group is already gone */
      }
      writeSync(fd, `\n[agentry] ${cmd[0]} timed out after ${timeoutSec} s and was killed\n`);
    } else if (res.error)
      writeSync(fd, `\n[agentry] could not run ${cmd[0]}: ${res.error.message}\n`);
    else if (res.signal) writeSync(fd, `\n[agentry] ${cmd[0]} was killed by ${res.signal}\n`);
  } finally {
    closeSync(fd);
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;

  const commandExit = res.status ?? 1;
  const left = porcelain(dir);
  const cleanAfter = left.length === 0;
  // A gate that commits leaves a clean tree behind, but not the commit it was asked to prove.
  const headMoved = git(dir, ["rev-parse", "HEAD"]).stdout.trim() !== commit;
  const exit = commandExit === 0 && (!cleanAfter || headMoved) ? 1 : commandExit;
  const notes = [
    !cleanAfter && `the gate left ${left.length} file(s) behind: ${left.slice(0, 10).join(", ")}`,
    headMoved && "the gate changed HEAD",
  ].filter(Boolean);
  if (notes.length > 0) {
    const out = openSync(logFile, "a");
    writeSync(out, notes.map((note) => `\n[agentry] ${note}\n`).join(""));
    closeSync(out);
  }
  return {
    exit,
    ...(exit !== commandExit && { commandExit }),
    tier,
    commit,
    tree,
    cleanBefore: true,
    cleanAfter,
    log: logFile,
    seconds,
  };
}

// A glob over repo-relative paths, matched per segment: a segment that is exactly `**` crosses directories;
// anywhere else `*` and `?` stay inside one segment (`a**b` is just `a*b`). A glob with a `..` segment
// matches nothing.
function segmentToRegExp(segment) {
  let re = "";
  for (const c of segment) {
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return re;
}
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

/** The tier a change needs: `quick` only when the gate has one and EVERY changed file matches its `only`
 *  globs; otherwise `full`. Always with the reason. */
export function pickTier(gate, changedFiles) {
  const quick = gate?.quick;
  if (!quick?.command?.length) return { tier: "full", reason: "the gate has no quick tier" };
  if (!changedFiles?.length)
    return { tier: "full", reason: "no changed files to judge a quick run by" };
  const inOnly = matcher(quick.only);
  const outside = changedFiles.find((file) => !inOnly(file));
  if (outside !== undefined)
    return { tier: "full", reason: `${outside} is outside the quick tier's "only" globs` };
  return {
    tier: "quick",
    reason: `all ${changedFiles.length} changed file(s) match the quick tier's "only"`,
  };
}

/** The files that differ between `commit` (the gated commit) and `tip` (default HEAD): the input `canSkip`
 *  wants as `changedSinceGate`. A rename lists both its paths, so moving a file out of `src/` into `docs/`
 *  is never read as a docs-only change. Null when git cannot say. */
export function changedSince(dir, commit, tip = "HEAD") {
  const res = git(dir, ["diff", "--no-renames", "--name-only", "-z", commit, tip, "--"]);
  return res.status === 0 ? res.stdout.split("\0").filter(Boolean) : null;
}

/** May a merge skip re-running the gate on main? Only when the recorded worktree gate was green and clean
 *  both sides, main's tree equals the branch tip's tree, and everything changed since that gate matches
 *  `after` (docs and the like). `changedSinceGate` must be known (see `changedSince`): missing, or empty
 *  while the tree moved since the gate, is "unknown" and never skips. Each refusal names its reason. */
export function canSkip({ record, mainTree, branchTipTree, changedSinceGate, after }) {
  if (!record) return { skip: false, reason: "no gate record" };
  if (record.exit !== 0) return { skip: false, reason: `the recorded gate exited ${record.exit}` };
  // A quick-tier gate only proved the files it was allowed to cover; it never stands in for the full gate on main.
  if (record.tier !== "full")
    return {
      skip: false,
      reason: `the recorded gate ran the ${record.tier ?? "unknown"} tier, not full`,
    };
  if (!record.cleanBefore || !record.cleanAfter)
    return {
      skip: false,
      reason: "the recorded gate did not run on a clean tree both before and after",
    };
  if (!mainTree || mainTree !== branchTipTree)
    return { skip: false, reason: "main's tree differs from the branch tip's tree" };
  if (!record.tree)
    return { skip: false, reason: "the recorded gate has no tree to compare against" };
  if (!Array.isArray(changedSinceGate))
    return { skip: false, reason: "unknown changes since the gate" };
  if (record.tree !== branchTipTree && changedSinceGate.length === 0)
    return {
      skip: false,
      reason: "the tree moved since the gate but no changed files explain it",
    };
  const inAfter = matcher(after);
  const stray = changedSinceGate.find((file) => !inAfter(file));
  if (stray !== undefined)
    return { skip: false, reason: `${stray} changed since the gate and is not in "after"` };
  return { skip: true, reason: "green clean gate on this tree; only post-gate files changed" };
}
