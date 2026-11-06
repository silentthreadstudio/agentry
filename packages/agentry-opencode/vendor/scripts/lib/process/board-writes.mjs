// board-writes — the content ids the main-touched guard compares, and the board writes `board add` and
// `board set --apply` make, recorded so a running lane's guard follows them as it follows lifecycle writes:
// `<root>/.agentry/run/process/board-writes.jsonl`, one `{ file, from, to, at, by }` per line. `file` is
// relative to the git root, `from` / `to` are content ids. A record excuses that file going from exactly
// `from` to exactly `to`, nothing else. A write is recorded in the checkout it ran in, so one made in a
// lane's worktree never reaches the main checkout's guard. Node built-ins and git.
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGit as git } from "./git.mjs";

const ABSENT = "-";
const fileOf = (root) => join(root, ".agentry", "run", "process", "board-writes.jsonl");

/** What is stored for each path (relative to the git root) as it is in the working tree, "-" when it is
 *  nothing there (or a directory): the blob id, plus a suffix for what the blob id leaves out: ":x" an
 *  executable file, ":l" a symlink (the blob is its target). A plain file is its bare blob id. Throws
 *  when git fails. */
export function contentOf(root, paths) {
  const out = Object.fromEntries(paths.map((p) => [p, ABSENT]));
  const files = [];
  for (const p of paths) {
    let st;
    try {
      st = lstatSync(join(root, p));
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      const res = git(root, ["hash-object", "--stdin"], readlinkSync(join(root, p)));
      if (res.status !== 0)
        throw new Error(`git hash-object failed in ${root}: ${res.stderr.trim()}`);
      out[p] = `${res.stdout.trim()}:l`;
    } else if (st.isFile()) files.push([p, st.mode & 0o111 ? ":x" : ""]);
  }
  if (!files.length) return out;
  const res = git(root, ["hash-object", "--", ...files.map(([p]) => p)]);
  if (res.status !== 0) throw new Error(`git hash-object failed in ${root}: ${res.stderr.trim()}`);
  res.stdout
    .split("\n")
    .filter(Boolean)
    .forEach((id, i) => {
      out[files[i][0]] = id + files[i][1];
    });
  return out;
}

/** Run `write`, which changes `paths` (relative to the git root `root`), and record each one it changed,
 *  stamped with the time and `by` (the command). Returns what `write` returns. When the content cannot be
 *  read (git fails) the write still runs, unrecorded: a running lane's guard then stops on it. */
export function recorded(root, paths, by, write) {
  let before = null;
  try {
    before = contentOf(root, paths);
  } catch {
    /* unrecorded */
  }
  const result = write();
  if (!before) return result;
  let after;
  try {
    after = contentOf(root, paths);
  } catch {
    return result;
  }
  const at = new Date().toISOString();
  const lines = paths
    .filter((file) => before[file] !== after[file])
    .map((file) => `${JSON.stringify({ file, from: before[file], to: after[file], at, by })}\n`);
  if (lines.length) {
    mkdirSync(dirname(fileOf(root)), { recursive: true });
    appendFileSync(fileOf(root), lines.join(""));
  }
  return result;
}

/** The recorded writes stamped at or after `since` (an ISO time), oldest first, as `{ file, from, to }`.
 *  No file is none; a line that is not a record is left out. */
export function recordedSince(root, since) {
  let text;
  try {
    text = readFileSync(fileOf(root), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const raw of text.split("\n").filter(Boolean)) {
    let r;
    try {
      r = JSON.parse(raw);
    } catch {
      continue;
    }
    const fields = [r?.file, r?.from, r?.to, r?.at];
    if (fields.every((v) => typeof v === "string") && r.at >= since)
      out.push({ file: r.file, from: r.from, to: r.to });
  }
  return out;
}
