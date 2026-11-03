// idle — how long a building lane's worktree has gone without a change (field 53): the newest of the
// current round's dispatch, the last commit on the lane branch and the mtime of every file git does not
// ignore in the worktree, tracked or not. A builder that stopped (killed, lost, waiting on a hung command) shows here. Reads git
// and the file system; writes nothing.
//
//   IDLE_MINUTES                                   a lane quiet this long is idle
//   idleOf(worktree, ledger, now) -> { minutes, lastChange, file } | null
import { statSync } from "node:fs";
import { join } from "node:path";
import { git } from "./worktree.mjs";

export const IDLE_MINUTES = 20;
// Only a builder's round can go idle: held, verifying and verified lanes wait on someone else.
const WORKING = ["building", "fixing"];

/** The lane's idle time when it is building or fixing and nothing changed for `IDLE_MINUTES` or more
 *  before `now` (ms): `{ minutes, lastChange (ISO), file }`, `file` relative to the worktree, or null
 *  when the newest change is the last commit or the round's dispatch (a builder just sent is not idle). null for any other lane, or a worktree git can't read. */
export function idleOf(worktree, ledger, now = Date.now()) {
  if (!worktree || !WORKING.includes(ledger?.state)) return null;
  const commit = git(worktree, ["log", "-1", "--format=%ct", ledger.branch ?? "HEAD", "--"]);
  const listed = git(worktree, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (commit.status !== 0 || listed.status !== 0) return null;
  const sent = Date.parse(ledger.rounds?.at(-1)?.at ?? "");
  let newest = { at: Math.max(Number(commit.stdout.trim()) * 1000, sent || 0), file: null };
  for (const file of new Set(listed.stdout.split("\0").filter(Boolean))) {
    let at;
    try {
      at = statSync(join(worktree, file)).mtimeMs;
    } catch {
      continue; // a tracked file deleted in the worktree
    }
    if (at > newest.at) newest = { at, file };
  }
  if (!Number.isFinite(newest.at)) return null;
  const minutes = Math.floor((now - newest.at) / 60_000);
  if (minutes < IDLE_MINUTES) return null;
  return { minutes, lastChange: new Date(newest.at).toISOString(), file: newest.file };
}
