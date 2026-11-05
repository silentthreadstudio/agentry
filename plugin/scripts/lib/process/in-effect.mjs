// in-effect — is a change still in effect on a later commit, at the place it landed (`inEffect`): the
// judgment `board fix` makes before it writes done. The git I/O primitives (the raw diff, the -U0 hunks,
// the blob lines, `blame --reverse`) are read through `git.mjs`'s timed runner; `hunkHolds` and what it
// leans on are pure on the parsed inputs. Read-only; never throws: an answer git cannot give is `git`.
import { FULL_SHA, isAncestor, runGit, topLevel } from "./git.mjs";

// git's stdout, or null on any failure.
function git(root, args) {
  const res = runGit(root, args);
  return res.status === 0 ? res.stdout : null;
}

// ---- is a change still in effect on a later commit (done = on main now) ----
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
