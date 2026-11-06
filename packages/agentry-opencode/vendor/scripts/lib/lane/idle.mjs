// idle — how long a building lane's worktree has gone without a change: the newest of the
// current round's dispatch, the last commit on the lane branch and the mtime of every file git does not
// ignore in the worktree, tracked or not. A builder that stopped (killed, lost, waiting on a hung command) shows here. Reads git
// and the file system; writes nothing.
//
//   idleOf(worktree, ledger, now, threshold) -> { minutes, lastChange, file, newest } | null
//                                   a lane quiet `threshold` minutes or more is idle (the workflow file's
//                                   `exec.idleMinutes`, which the caller reads)
import { statSync } from "node:fs";
import { join } from "node:path";
import { git } from "./worktree.mjs";

// Only a builder's round can go idle: held, verifying and verified lanes wait on someone else.
const WORKING = ["building", "fixing"];

/** The lane's idle time when it is building or fixing and nothing changed for `threshold` minutes or
 *  more before `now` (ms): `{ minutes, lastChange (ISO), file, newest }`, `newest` what changed last
 *  ("file", "commit": the branch's last commit, or "dispatch": the round's dispatch, so a builder just
 *  sent is not idle early) and `file` the file, relative to the worktree (null unless a file is newest).
 *  null for any other lane, or a worktree git can't read. */
export function idleOf(worktree, ledger, now, threshold) {
  if (!worktree || !WORKING.includes(ledger?.state)) return null;
  const commit = git(worktree, ["log", "-1", "--format=%ct", ledger.branch ?? "HEAD", "--"]);
  const listed = git(worktree, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (commit.status !== 0 || listed.status !== 0) return null;
  const sent = Date.parse(ledger.rounds?.at(-1)?.at ?? "") || 0;
  const committed = Number(commit.stdout.trim()) * 1000;
  let newest =
    committed >= sent
      ? { at: committed, file: null, newest: "commit" }
      : { at: sent, file: null, newest: "dispatch" };
  for (const file of new Set(listed.stdout.split("\0").filter(Boolean))) {
    let at;
    try {
      at = statSync(join(worktree, file)).mtimeMs;
    } catch {
      continue; // a tracked file deleted in the worktree
    }
    if (at > newest.at) newest = { at, file, newest: "file" };
  }
  if (!Number.isFinite(newest.at)) return null;
  const minutes = Math.floor((now - newest.at) / 60_000);
  if (minutes < threshold) return null;
  return {
    minutes,
    lastChange: new Date(newest.at).toISOString(),
    file: newest.file,
    newest: newest.newest,
  };
}
