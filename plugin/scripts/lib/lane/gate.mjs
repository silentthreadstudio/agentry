// gate — running a repo's gate command as a ledger fact (ADR-R4), plus the two pure decisions around it.
//
// `runGate` reads the gate command's OWN exit code: argv, no shell, so nothing can pipe the failure away
// (#1). It refuses to start on a dirty tree (an untracked file made "tree identical" lie, #2), counts a gate
// that leaves files behind as red, and writes the command's stdout and stderr to a per-run log file (appended to, as it runs).
// `pickTier` and `canSkip` are pure: which tier a change needs, and whether a merge may skip the main gate.
// Node built-ins only.
import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dirtyEntries } from "./own-memory.mjs";
import { git } from "./worktree.mjs";

const DEFAULT_TIMEOUT_SEC = 3600;
const SETTLE_MS = 2000;

// Kill the command's whole process group, whatever the outcome, so a background child of a green gate cannot
// write into the tree later; then wait (up to SETTLE_MS) for the group to be gone, so the clean-tree check
// that follows sees every write it made.
function endGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    return; // the group is already gone
  }
  const gone = () => {
    try {
      process.kill(-pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; waited < SETTLE_MS && !gone(); waited += 20) Atomics.wait(nap, 0, 0, 20);
}

/** Run `cmd` (argv) at the git root of `dir`. `logFile` should sit outside the tree under test, or the log
 *  itself would dirty it. `timeoutSec` (callers pass the gate config's, default 3600) bounds the run: past
 *  it the gate is red. Whatever the outcome, the command's whole process group is killed afterwards, so
 *  nothing it left in the background can touch the tree later. Returns `{ refused: "dirty", files }`
 *  without running when the tree is not clean; otherwise `{ exit, tier, commit, tree, cleanBefore,
 *  cleanAfter, log, seconds }`. When the command exits 0 but leaves files behind, `exit` is 1 (`commandExit`
 *  keeps the command's own code). */
export function runGate(dir, cmd, { tier, logFile, timeoutSec = DEFAULT_TIMEOUT_SEC }) {
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((a) => typeof a !== "string"))
    throw new TypeError("runGate: cmd must be a non-empty argv array");
  if (typeof timeoutSec !== "number" || !(timeoutSec > 0))
    throw new TypeError("runGate: timeoutSec must be a positive number");
  const before = dirtyEntries(dir) ?? ["git status failed"];
  if (before.length > 0) return { refused: "dirty", files: before };

  const top = git(dir, ["rev-parse", "--show-toplevel"]).stdout.trim() || dir;
  const commit = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
  const tree = git(dir, ["rev-parse", "HEAD^{tree}"]).stdout.trim();

  mkdirSync(dirname(logFile), { recursive: true });
  // Appended to: a queued gate has already written its waiting lines there.
  const fd = openSync(logFile, "a");
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
    endGroup(res.pid);
    if (timedOut)
      writeSync(fd, `\n[agentry] ${cmd[0]} timed out after ${timeoutSec} s and was killed\n`);
    else if (res.error)
      writeSync(fd, `\n[agentry] could not run ${cmd[0]}: ${res.error.message}\n`);
    else if (res.signal) writeSync(fd, `\n[agentry] ${cmd[0]} was killed by ${res.signal}\n`);
  } finally {
    closeSync(fd);
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;

  const commandExit = res.status ?? 1;
  const left = dirtyEntries(dir) ?? ["git status failed"];
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

// A line of a test log that reports a failure: an upper-case FAIL / FAILED / FAILURE / ERROR, `not ok`, or a
// cross mark. A count line (`3 failed`, `FAILED: 2`, `2 errors`) is a summary, not a failure of any one test.
const FAILURE_LINE = /\b(?:FAIL(?:ED|URES?)?|ERROR)\b|\bnot ok\b|[✗✖×]/;
const SUMMARY_LINE =
  /\d+\s+(?:tests?\s+)?(?:FAILED|failed|failures?|errors?)\b|\b(?:FAILED|FAILURES?|ERRORS?)\s*[:=(]?\s*\d+/;

// The files a `flakyLogs` glob names, modified at or after `since` (ms): the glob runs from `cwd`, or from the
// temp directory when it starts `$TMPDIR/`. Matched per segment like the other globs here; `**` crosses
// directories. Symlinks are not followed.
function logsMatching(globs, { cwd, since }) {
  const found = new Set();
  const walk = (dir, segments) => {
    const [segment, ...rest] = segments;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (segment === "**" && rest.length > 0) walk(dir, rest);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (segment === "**") {
        if (entry.isDirectory()) walk(path, segments);
        else if (rest.length === 0 && entry.isFile()) found.add(path);
      } else if (new RegExp(`^${segmentToRegExp(segment)}$`).test(entry.name)) {
        if (rest.length === 0 && entry.isFile()) found.add(path);
        else if (rest.length > 0 && entry.isDirectory()) walk(path, rest);
      }
    }
  };
  for (const glob of globs) {
    const tmp = glob.startsWith("$TMPDIR/");
    const segments = (tmp ? glob.slice("$TMPDIR/".length) : glob).split("/").filter(Boolean);
    if (segments.includes("..") || segments.length === 0) continue;
    walk(tmp ? tmpdir() : cwd, segments);
  }
  return [...found].filter((file) => {
    try {
      return statSync(file).mtimeMs >= since;
    } catch {
      return false;
    }
  });
}

// The test a line of an extra log names as failing, or null: `FAILED TEST: <name>`, `not ok N - <name>`,
// `✗ <name>` and `FAIL <name>`. A failure line that names no test (an engine's `ERROR:` line) is noise there.
const NAMED_FAILURE = [
  /\bFAILED TEST:\s*(\S.*)/,
  /^\s*not ok\s+\d+\s*-?\s*(\S.*)/,
  /[✗✖×]\s*(\S.*)/,
  /\bFAIL\s+(\S.*)/,
];
const namedFailure = (line) => {
  if (SUMMARY_LINE.test(line)) return null;
  for (const re of NAMED_FAILURE) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return null;
};

/** The listed `flaky` tests a gate's log shows failing, or null unless the red is ALL flaky: at least one
 *  failure line, and every failure line (count lines aside) naming a listed test. Anything else (an unlisted
 *  failure, no failure line to read, an unreadable log) is null: a real red. The gate's own log decides when
 *  it has failure lines. Only when it has none (it prints a summary) are the `logs` (the gate's `flakyLogs`
 *  globs, from `cwd` or `$TMPDIR/`) read, for the lines in them that name a failing test; those must all be
 *  listed, and unnamed noise there is ignored. Only files modified since `since` (ms, when the gate
 *  started) are read. */
export function flakyReds(logFile, flaky, { logs = [], cwd = ".", since = 0 } = {}) {
  if (!flaky?.length) return null;
  let text;
  try {
    text = readFileSync(logFile, "utf8");
  } catch {
    return null;
  }
  const hit = new Set();
  const judge = (lines, nameOf) => {
    for (const line of lines) {
      const name = nameOf(line);
      if (name === null) continue;
      const names = flaky.filter((n) => name.includes(n));
      if (names.length === 0) return false;
      for (const n of names) hit.add(n);
    }
    return true;
  };
  const own = text.split("\n").filter((l) => FAILURE_LINE.test(l) && !SUMMARY_LINE.test(l));
  if (own.length > 0) return judge(own, (line) => line) && hit.size > 0 ? [...hit] : null;
  for (const file of logsMatching(logs, { cwd, since })) {
    try {
      if (!judge(readFileSync(file, "utf8").split("\n"), namedFailure)) return null;
    } catch {}
  }
  return hit.size > 0 ? [...hit] : null;
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
  // Resolve both to commit SHAs first: a rev that is not a commit (or that git could read as an option, like
  // `--output=…`) resolves to nothing and answers null.
  const from = commitOf(dir, commit);
  const to = commitOf(dir, tip);
  if (!from || !to) return null;
  const res = git(dir, [
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    "--end-of-options",
    from,
    to,
    "--",
  ]);
  return res.status === 0 ? res.stdout.split("\0").filter(Boolean) : null;
}

function commitOf(dir, rev) {
  if (typeof rev !== "string" || rev === "") return null;
  const res = git(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
  return res.status === 0 ? res.stdout.trim() : null;
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
  if (record.cleanBefore !== true || record.cleanAfter !== true)
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
  if (after != null && !(Array.isArray(after) && after.every((g) => typeof g === "string")))
    return { skip: false, reason: 'the gate\'s "after" is not a list of globs' };
  const inAfter = matcher(after);
  const stray = changedSinceGate.find((file) => !inAfter(file));
  if (stray !== undefined)
    return { skip: false, reason: `${stray} changed since the gate and is not in "after"` };
  return { skip: true, reason: "green clean gate on this tree; only post-gate files changed" };
}
