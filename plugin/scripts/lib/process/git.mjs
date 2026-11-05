// git — the process kit's only git I/O: does a commit exist, recent history, ancestry, parents and
// identities, a branch's reflog, worktrees, patch ids (to match a cherry-picked commit to its branch
// original), whether a change is still in effect where it landed (`inEffect`), the default branch, the
// branch checked out, the main checkout of a linked worktree and the tracked files.
//
// Every function takes the git root first and never throws: outside a repo, or on any git error, it
// answers false / [] / null. Refs and SHAs are checked before they reach argv, so a board cell can never
// become a git option. Nothing here changes the repository: `reverseApplies` works on a throwaway index.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SHA = /^[0-9a-f]{4,40}$/i;
const FULL_SHA = /^[0-9a-f]{40,64}$/;
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
function git(root, args, input, env) {
  const res = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    input,
    env,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
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
  return res.error || res.status !== 0 ? null : res.stdout;
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

// ---- is a change still in effect on a later commit (A23: done = on main now) ----
//
// The question `board fix` asks before it writes done: is the net change `from..to` (commits on `onto`'s
// history) still in `onto`'s tree, AT THE PLACE IT LANDED? `git apply --check -R` cannot answer it: a
// patch matches at any offset, so a reverted hunk "applies" wherever the same lines and context repeat.
//
// What answers it is `git blame --reverse to..onto`: for each line of `to`'s copy of a file it names the
// last commit that still holds that very line, followed through every diff in between (by position, not by
// content). A line still in `onto` is reported at `onto`, with its line number there; a line a revert, a
// reset-and-redo or a hand edit took out is reported at the commit before that, and a line put back later
// (a re-add, a revert of the revert) is a new line, not this one. So, per hunk of the change:
//   - every line it added must still be in `onto` (the survivor test);
//   - where it removed lines, the lines just around the cut must still be in `onto`, and between them none
//     of the removed lines may be back (no more copies of a removed line there than `to` had).
// Diffs match equal lines arbitrarily (in `x X b` → `x X X b` either X is the new one), so when a hunk's
// own lines repeat right next to it the window grows to the nearest line not among them, and a line the
// hunk added may not have fewer copies in that window than `to` had either. A removed block (two or
// more lines, not all punctuation) or a specific single line may not have more copies anywhere in `onto`'s file than in `to`'s: put back
// elsewhere, the code it took out is in effect again. A file whose mode and blob are the same in `to` and
// `onto` holds outright, however it got back (a revert of the revert): byte for byte, every line is where
// it landed. The mode and the type (file, symlink, submodule) count as much as the lines: a mode the change
// set must still be set, a file must still be a file, and a change with no lines (a `chmod`, an empty file)
// is judged on them and on whether the file is there. A binary or submodule entry that differs is not
// provable, and neither is anything git cannot answer. The answer is conservative by design: a line next
// to a removal edited since, or a line re-added in a file that also differs otherwise, is reported, never
// written as done.

// A tree entry's kind by its mode (none for any other mode).
const KIND = { 100644: "file", 100755: "file", 120000: "link", 160000: "submodule" };

// `git diff --raw` of `a..b`, restricted to `paths` when given: Map path → { a, b, lines }, `a`/`b` each
// side's { mode, sha } or null when absent. With `numstat`, `lines` is true when the entry changed lines,
// false when it changed none (a mode, an empty file) and null for a binary. A path not in the map is the
// same on both sides, mode and blob. null when git cannot answer.
function rawDiff(top, a, b, { numstat = false, paths } = {}) {
  const args = ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", "--no-ext-diff"];
  const only = (paths ?? []).map((p) => `:(literal)${p}`);
  const out = git(top, [...args, ...(numstat ? ["--numstat"] : []), a, b, "--", ...only]);
  if (out === null) return null;
  const side = (mode, sha) => (mode === "000000" ? null : { mode, sha });
  const found = new Map();
  const tokens = out.split("\0");
  const RAW = /^:(\d{6}) (\d{6}) (\w+) (\w+) \w+$/;
  let i = 0;
  for (; RAW.test(tokens[i] ?? ""); i += 2) {
    const [, modeA, modeB, shaA, shaB] = RAW.exec(tokens[i]);
    found.set(tokens[i + 1], { a: side(modeA, shaA), b: side(modeB, shaB), lines: null });
  }
  for (; i < tokens.length; i++) {
    const [added, removed, ...path] = tokens[i].split("\t");
    const entry = found.get(path.join("\t"));
    if (entry && added !== "-") entry.lines = `${added}${removed}` !== "00";
  }
  if (paths) for (const path of found.keys()) if (!paths.includes(path)) found.delete(path);
  return found;
}

// Is `to`'s entry `was` (the change made it so from `prior`) still what the change left in `onto`'s
// `now`, as far as no line can tell: the same kind, not a submodule, the mode the change set. True when
// it is.
function entryHolds({ prior, was, now }) {
  const [then, there] = [was, now].map((e) => (e ? KIND[e.mode] : null));
  if ((was && now && then !== there) || [then, there].includes("submodule")) return false;
  const chmod = was && (!prior || prior.mode !== was.mode); // a created file's mode is one the change set
  return !(chmod && now && now.mode !== was.mode);
}

// The -U0 hunks of `from..to` in `path`: { start, count, removed: [line…] } with `start`/`count` the
// added lines' place in `to` (count 0: the removal sits after line `start`). Parsed by the counts in each
// header, so a removed line that itself starts with `--` is read as a line.
function hunksOf(top, from, to, path) {
  const args = ["diff", "-U0", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color"];
  const out = git(top, [...args, from, to, "--", path]);
  if (out === null) return null;
  const lines = out.split("\n");
  const hunks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
    if (!m) continue;
    const hunk = { start: Number(m[2]), count: Number(m[3] ?? 1), removed: [] };
    for (let left = Number(m[1] ?? 1); left > 0 && i + 1 < lines.length; ) {
      const line = lines[++i];
      if (line.startsWith("-")) {
        hunk.removed.push(line.slice(1));
        left--;
      } else if (!line.startsWith("\\")) break;
    }
    hunks.push(hunk);
  }
  return hunks;
}

// The lines of blob `rev:path` ([] when it is absent), or null when git cannot read it.
function linesAt(top, rev, path, present) {
  if (!present) return [];
  const out = git(top, ["cat-file", "blob", `${rev}:${path}`]);
  if (out === null) return null;
  const lines = out.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

// `git blame --reverse to..onto`: Map line in `to` → line in `onto`, for the lines of `to`'s `path` that
// `onto` still holds. null when git cannot answer.
function survivors(top, { to, onto, path }) {
  const args = ["blame", "--reverse", "--porcelain", "--ignore-revs-file", ""];
  const out = git(top, [...args, `${to}..${onto}`, "--", path]);
  if (out === null) return null;
  const kept = new Map();
  const fileOf = new Map();
  let at = null;
  for (const line of out.split("\n")) {
    const head = /^([0-9a-f]{40,64}) (\d+) (\d+)/.exec(line);
    if (head) at = { sha: head[1], there: Number(head[2]), here: Number(head[3]) };
    else if (at && line.startsWith("filename ")) fileOf.set(at.sha, line.slice("filename ".length));
    else if (at && line.startsWith("\t") && at.sha === onto && fileOf.get(onto) === path)
      kept.set(at.here, at.there);
  }
  return kept;
}

const countOf = (lines, value) => lines.reduce((n, l) => n + (l === value), 0);

// How many times the run of lines `block` occurs in `lines`.
function blockCount(lines, block) {
  let n = 0;
  for (let i = 0; i + block.length <= lines.length; i++)
    if (block.every((l, j) => lines[i + j] === l)) n++;
  return n;
}

// A line that says something on its own: a letter or digit and two words or eight characters, so `}`,
// `end` and `return;` do not.
function specific(line) {
  const bare = line.replace(/\s/g, "");
  return /[\p{L}\p{N}]/u.test(bare) && (line.trim().split(/\s+/).length >= 2 || bare.length >= 8);
}

// One hunk against `onto`: null while it holds, else { line, what } (`line` in `to`).
function hunkHolds({ was, now, kept, hunk }) {
  const added = Array.from({ length: hunk.count }, (_, i) => hunk.start + i);
  const gone = added.find((n) => !kept.has(n));
  if (gone !== undefined) return { line: gone, what: "added" };
  // A removed block (not one generic line like `}`) back anywhere in the file: the code is back.
  const block = hunk.removed;
  if (block.length > 1 ? block.some((l) => /\w/.test(l)) : block.length && specific(block[0]))
    if (blockCount(now, block) > blockCount(was, block))
      return { line: Math.max(1, hunk.start), what: "removed" };
  const own = new Set([...hunk.removed, ...added.map((n) => was[n - 1])]);
  let before = hunk.count ? hunk.start - 1 : hunk.start;
  let after = hunk.count ? hunk.start + hunk.count : hunk.start + 1;
  const repeats = (n) => n >= 1 && n <= was.length && own.has(was[n - 1]);
  if (!hunk.removed.length && !repeats(before) && !repeats(after)) return null;
  while (repeats(before)) before--;
  while (repeats(after)) after++;
  // The window: `to`'s lines strictly between `before` and `after`, and `onto`'s between where those are now.
  const low = before === 0 ? 0 : kept.get(before);
  const high = after > was.length ? now.length + 1 : kept.get(after);
  if (low === undefined || high === undefined || low >= high)
    return { line: Math.max(1, before), what: "around" };
  const then = was.slice(before, after - 1);
  const there = now.slice(low, high - 1);
  if (hunk.removed.some((l) => countOf(there, l) > countOf(then, l)))
    return { line: Math.max(1, before), what: "removed" };
  const fewer = added.find((n) => countOf(there, was[n - 1]) < countOf(then, was[n - 1]));
  return fewer === undefined ? null : { line: fewer, what: "added" };
}

/** Is the net change `from..to` still in effect on commit `onto` (`to` or a descendant of it), at the place
 *  it landed? All three are full SHAs. null when it is; else `{ file, line?, what }`, `what` being `added`
 *  (a line it added is gone or changed), `removed` (a line it removed is back), `around` (the lines around
 *  a removal changed, so where it was cannot be told), `file` (its mode, its type or whether it is there
 *  is not as the change left it, or a binary differs) or `git` (git could not tell). Read-only; see the
 *  comment above for why this is blame and not `git apply`. */
export function inEffect(root, { from, to, onto }) {
  const top = topLevel(root);
  if (!top || ![from, to, onto].every((c) => FULL_SHA.test(c ?? ""))) return { what: "git" };
  if (to === onto) return null;
  if (!isAncestor(top, to, onto)) return { what: "git" };
  const change = rawDiff(top, from, to, { numstat: true });
  const since = change?.size ? rawDiff(top, to, onto, { paths: [...change.keys()] }) : change;
  if (!change || !since) return { what: "git" };
  for (const [path, { a: prior, b: was, lines }] of change) {
    if (!since.has(path)) continue; // mode and blob as it landed: byte for byte
    const now = since.get(path).b;
    if (!entryHolds({ prior, was, now }) || lines === null) return { file: path, what: "file" };
    if (!lines) {
      if (!was !== !now) return { file: path, what: "file" };
      continue;
    }
    const hunks = hunksOf(top, from, to, path);
    const before = linesAt(top, to, path, was);
    const after = linesAt(top, onto, path, now);
    const kept = was ? survivors(top, { to, onto, path }) : new Map();
    if (!hunks || !before || !after || !kept) return { file: path, what: "git" };
    for (const hunk of hunks) {
      const off = hunkHolds({ was: before, now: after, kept, hunk });
      if (off) return { file: path, ...off };
    }
  }
  return null;
}

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
