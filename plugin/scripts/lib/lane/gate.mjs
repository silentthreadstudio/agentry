// gate — running a repo's gate command as a ledger fact (ADR-R4), plus the two pure decisions around it.
//
// `runGate` reads the gate command's OWN exit code: argv, no shell, so nothing can pipe the failure away
// (#1). It refuses to start on a dirty tree (an untracked file made "tree identical" lie, #2), counts a gate
// that leaves files behind as red, and writes the command's stdout and stderr to a per-run log file (appended to, as it runs).
// The command runs under `cli/supervise.mjs`'s watchdog, so it never outlives the process that runs the
// gate: this one waits synchronously and can't act on a signal, and a SIGKILL ends it outright.
// `pickTier`, `checklistFor` and `canSkip` are pure: which tier a role runs on a change, which manual
// checks a land waits on, and whether a merge may skip the main gate. `globMatch` (`process/glob.mjs`) is
// the one glob test every lane step uses. Node built-ins only.
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
import { watchdogArgv } from "../cli/supervise.mjs";
import { globMatch, segmentToRegExp } from "../process/glob.mjs";
import { slotsHeldHere } from "./gate-lock.mjs";
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
    // detached: the watchdog leads the group the command runs in, so `endGroup` below takes the command
    // (and its children) down however the watchdog ended; the watchdog itself ends that group as soon as
    // this process is gone, and then frees the slots this process holds.
    const [exe, ...args] = watchdogArgv(cmd, { free: slotsHeldHere() });
    res = spawnSync(exe, args, {
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
// A JSON test event fails when its status, outcome, result or event says so (any case).
const JSON_STATUS = ["status", "outcome", "result", "event"];
const JSON_FAILED = ["fail", "failed", "failure", "error"];

// A JSON object line as a test event: `{ failed, name }`, the name its string `test` (or null). Null when the
// line is not one whole JSON object (a list, a cut line, plain text).
function jsonEvent(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const failed = JSON_STATUS.some(
    (key) => typeof value[key] === "string" && JSON_FAILED.includes(value[key].toLowerCase()),
  );
  return { failed, name: typeof value.test === "string" ? value.test : null };
}

// What a log line says about a failure: null when it reports none (a pass, a summary, a JSON event that
// did not fail), else `{ name }`, the test it names or null. Named forms: `FAILED TEST: <name>`, `not ok N
// - <name>`, `✗ <name>`, `FAIL <name>`, `FAILED <name>` (the next token), a `<path>::<test>` token, and a
// JSON event's `test`.
function failureOf(line) {
  const event = jsonEvent(line);
  if (event) return event.failed ? { name: event.name } : null;
  if (!FAILURE_LINE.test(line) || SUMMARY_LINE.test(line)) return null;
  for (const re of NAMED_FAILURE) {
    const m = re.exec(line);
    if (m) return { name: m[1] };
  }
  return { name: null };
}

// Does `text` hold the listed test `name` as a whole name: `test_slow` is not in `test_slow_case`.
const holdsName = (text, name) => {
  const word = /\w/;
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    const before = at > 0 && word.test(name[0]) && word.test(text[at - 1]);
    const end = at + name.length;
    const after = end < text.length && word.test(name.at(-1)) && word.test(text[end]);
    if (!before && !after) return true;
  }
  return false;
};

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

// The forms a failure line names its test in (the first that matches wins): `FAILED TEST: <name>`,
// `not ok N - <name>`, `✗ <name>`, `FAIL <name>`, `FAILED <name>` (the next token) and a `<path>::<test>`
// token. A failure line that names no test (an engine's `ERROR:` line) is noise in an extra log.
const NAMED_FAILURE = [
  /\bFAILED TEST:\s*(\S.*)/,
  /^\s*not ok\s+\d+\s*-?\s*(\S.*)/,
  /[✗✖×]\s*(\S.*)/,
  /\bFAIL\s+(\S.*)/,
  /\bFAILED\s+(\S+)/,
  /(\S+::\S+)/,
];

/** The listed `flaky` tests a gate's log shows failing, or null unless the red is ALL flaky: at least one
 *  failure line, and every failure line (count lines aside) naming a listed test. Anything else (an unlisted
 *  failure, no failure line to read, an unreadable log) is null: a real red. A line that names its test (the
 *  forms above, or a JSON event line `{"test": …, "status": "failed"}`) is judged by that name, any other
 *  failure line by its whole text; a listed name counts only whole (`test_slow` is not `test_slow_case`).
 *  The gate's own log decides when it has failure lines. Only when it has none (it prints a summary) are
 *  the `logs` (the gate's `flakyLogs` globs, from `cwd` or `$TMPDIR/`) read, for the lines in them that name
 *  a failing test; those must all be listed, and unnamed noise there is ignored. Only files modified since
 *  `since` (ms, when the gate started) are read. CRLF line ends read as LF. */
export function flakyReds(logFile, flaky, { logs = [], cwd = ".", since = 0 } = {}) {
  if (!flaky?.length) return null;
  let text;
  try {
    text = readFileSync(logFile, "utf8");
  } catch {
    return null;
  }
  const lines = (t) => t.split(/\r?\n/);
  const hit = new Set();
  // Every failure is a listed test: `failures` are [text to look for the listed names in].
  const judge = (failures) => {
    for (const text of failures) {
      const names = flaky.filter((n) => holdsName(text, n));
      if (names.length === 0) return false;
      for (const n of names) hit.add(n);
    }
    return true;
  };
  const own = lines(text).flatMap((line) => {
    const failure = failureOf(line);
    return failure ? [failure.name ?? line] : [];
  });
  if (own.length > 0) return judge(own) && hit.size > 0 ? [...hit] : null;
  for (const file of logsMatching(logs, { cwd, since })) {
    let named;
    try {
      named = lines(readFileSync(file, "utf8"))
        .map((line) => failureOf(line)?.name)
        .filter((name) => typeof name === "string");
    } catch {
      continue;
    }
    if (!judge(named)) return null;
  }
  return hit.size > 0 ? [...hit] : null;
}

// Does a tier's or checklist item's `when` hold for a change: any one of its conditions is enough. `only`:
// every changed file matches (no changed files never does); `any`: some changed file does; `flag`: the
// item is flagged. Returns `{ holds, reason }`, the reason naming what held or each miss.
function whenHolds(when, { changed, flagged }) {
  const misses = [];
  if (when?.only) {
    const outside = changed.find((file) => !globMatch(when.only, file));
    if (changed.length > 0 && outside === undefined)
      return { holds: true, reason: `every changed file (${changed.length}) matches its "only"` };
    misses.push(
      changed.length ? `${outside} is outside its "only"` : 'no changed files for its "only"',
    );
  }
  if (when?.any) {
    const hit = changed.find((file) => globMatch(when.any, file));
    if (hit !== undefined) return { holds: true, reason: `${hit} matches its "any"` };
    misses.push('no changed file matches its "any"');
  }
  if (when?.flag === true) {
    if (flagged) return { holds: true, reason: "the item is flagged" };
    misses.push("the item is not flagged");
  }
  return { holds: false, reason: misses.join(", ") };
}

const tierAt = (tier, why) => ({
  tier: tier.name,
  command: tier.command,
  reason: `${tier.name}: ${why}`,
});

/** The tier `role` (build, verify or merge) runs on a change, with its argv and why: `gate` is `gateOf`'s
 *  (roles filled; a role it lacks reads as "pick"), `changed` the changed files, `flagged` whether the
 *  item's flag is set. `gate.roles[role]`: `pick` = the first tier whose `when` holds (the last tier when
 *  none does), `full` = the last tier, a tier name = that tier, `none` = no tier (`{ tier: null, command:
 *  null }`). */
export function pickTier(gate, role, { changed = [], flagged = false } = {}) {
  const tiers = gate?.tiers ?? [];
  const value = gate?.roles?.[role] ?? "pick";
  const says = `gate.roles.${role} is "${value}"`;
  if (value === "none" || tiers.length === 0)
    return { tier: null, command: null, reason: value === "none" ? says : "the gate has no tiers" };
  const last = tiers.at(-1);
  if (value === "full") return tierAt(last, says);
  if (value !== "pick") {
    const named = tiers.find((t) => t.name === value);
    return named ? tierAt(named, says) : tierAt(last, `${says}, which names no tier`);
  }
  const files = Array.isArray(changed) ? changed : [];
  const misses = [];
  for (const tier of tiers.slice(0, -1)) {
    const res = whenHolds(tier.when, { changed: files, flagged });
    if (res.holds) return tierAt(tier, res.reason);
    misses.push(`${tier.name}: ${res.reason}`);
  }
  if (misses.length === 0) return tierAt(last, "the gate's only tier");
  return tierAt(last, `no earlier tier's "when" holds (${misses.join("; ")})`);
}

/** The checklist items a land waits on for this change: each with no `when`, or whose `when` holds
 *  (`changed`, `flagged` as `pickTier` takes them). */
export function checklistFor(gate, { changed = [], flagged = false } = {}) {
  const files = Array.isArray(changed) ? changed : [];
  return (gate?.checklist ?? [])
    .filter((item) => !item.when || whenHolds(item.when, { changed: files, flagged }).holds)
    .map(({ name, text }) => ({ name, text }));
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
 *  both sides, ran the tier and argv the land needs (`need`, `pickTier`'s `{ tier, command }`), main's tree
 *  equals the branch tip's tree, and everything changed since that gate matches `after` (docs and the
 *  like). A record with no `command` (from before gate tiers, such as an old `quick` one) never skips.
 *  `changedSinceGate` must be known (see `changedSince`): missing, or empty while the tree moved since the
 *  gate, is "unknown" and never skips. Each refusal names its reason. */
export function canSkip({ record, need, mainTree, branchTipTree, changedSinceGate, after }) {
  if (!record) return { skip: false, reason: "no gate record" };
  if (record.exit !== 0) return { skip: false, reason: `the recorded gate exited ${record.exit}` };
  if (!Array.isArray(record.command))
    return {
      skip: false,
      reason: `the recorded gate (${record.tier ?? "unknown"} tier) has no command: it ran before gate tiers`,
    };
  if (!need?.tier || !Array.isArray(need.command))
    return { skip: false, reason: "the land needs no tier the record could stand in for" };
  // A tier only proved what its own command covers; it never stands in for another on main.
  if (record.tier !== need.tier)
    return {
      skip: false,
      reason: `the recorded gate ran ${record.tier ?? "an unknown tier"}, the land needs ${need.tier}`,
    };
  if (
    record.command.length !== need.command.length ||
    record.command.some((arg, i) => arg !== need.command[i])
  )
    return { skip: false, reason: `the ${need.tier} tier's command changed since the gate ran` };
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
  const stray = changedSinceGate.find((file) => !globMatch(after, file));
  if (stray !== undefined)
    return { skip: false, reason: `${stray} changed since the gate and is not in "after"` };
  return { skip: true, reason: "green clean gate on this tree; only post-gate files changed" };
}
