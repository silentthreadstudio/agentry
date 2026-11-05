// exec/guard/stray — what on main no recorded write explains: the files whose content no lifecycle or
// board write reaches from the lane's start, the first-parent commits that are neither a recorded land
// nor one the guard lets through, the files a commit on main may not touch while the lane runs, and
// the board files whose recorded writes it follows.
import { posix } from "node:path";
import { recordedSince } from "../../../process/board-writes.mjs";
import { own } from "../../../process/spec/shape.mjs";
import { blobsAt } from "../../carry-io.mjs";
import { isMemoryCommit } from "../../own-memory.mjs";
import { git, porcelain } from "../../worktree.mjs";
import { ownedOf } from "../lane.mjs";
import { STAGED, contentOf, dirtyPaths, headOf, heldMain, stagedKey } from "./snapshot.mjs";

// The files a lifecycle event of item `id` of `name` writes (relative to the git root).
export function boardFiles(spec, model, id, name) {
  if (!spec.lifecycle) return [];
  const kind = own(spec.kinds, name);
  const item = own(model.kinds, name)?.items.find((i) => i.id === id);
  const file = kind?.at?.table ?? item?.file;
  return file ? [posix.join(spec.root, file)] : [];
}

// Is `to` reachable from one of `from` through recorded writes?
function reachable(moves, from, to) {
  const seen = new Set(from);
  const queue = [...from];
  while (queue.length) {
    const at = queue.shift();
    if (at === to) return true;
    for (const m of moves)
      if (m.from === at && !seen.has(m.to)) {
        seen.add(m.to);
        queue.push(m.to);
      }
  }
  return false;
}

// The main files whose content no recorded lifecycle or board write explains, and whose path `excused`
// does not let through, as `git status` entries. Once a rebase (or the branch holding main, `startMoves`)
// moved the guard's start, a path clean on main whose start is one of the lane's own board writes was
// mid-write at start and is as HEAD holds it now: never "back to HEAD" (field 93). Before that, a discard of
// the board is a trip as any other.
export function strayFiles(root, ledger, head, all, boards, excused) {
  const was = ledger.mainAtStart;
  const started = was.files ?? {};
  const dirty = new Map([...dirtyPaths(root)].filter(([p]) => !excused(p)));
  const paths = [...new Set([...dirty.keys(), ...Object.keys(started)])].filter((p) => !excused(p));
  if (!paths.length) return [];
  const now = contentOf(root, paths);
  const atStart = blobsAt(root, was.head, paths);
  const atHead = head === was.head ? atStart : blobsAt(root, head, paths);
  // A ledger without `startedAt` predates the board-write log: no logged write is trusted for it.
  const logged = ledger.startedAt ? recordedSince(root, ledger.startedAt) : [];
  const moves = [
    ...all.flatMap((l) => l.boardWrites ?? []).filter((m) => boards.has(m.file)),
    ...logged,
  ];
  const moved =
    (ledger.rebases ?? []).some((r) => !r.carried) || Boolean(ledger.startMoves?.length);
  const ownWrites = new Set(
    moved ? (ledger.boardWrites ?? []).map((m) => `${m.file}\0${m.to}`) : [],
  );
  const changed = paths
    .filter((p) => {
      const start = Object.hasOwn(started, p) ? started[p] : atStart[p];
      if (now[p] === start) return false;
      if (!dirty.has(p) && Object.hasOwn(started, p) && ownWrites.has(`${p}\0${start}`))
        return false;
      // A ledger written before ids carried `:x` holds an executable file as its bare blob id.
      if (!was.modes && Object.hasOwn(started, p) && now[p] === `${start}:x`) return false;
      const from = atHead[p] === atStart[p] ? [start] : [start, atHead[p]];
      return !reachable(
        moves.filter((m) => m.file === p),
        from,
        now[p],
      );
    })
    .map((p) => dirty.get(p) ?? `${p} (back to HEAD)`);
  // An index-only change (`git rm --cached`) leaves the content as it was: any staged entry that was
  // not there at start is the builder's too.
  // The index column is compared, not the whole entry: a recorded write on a file staged at start turns
  // "M " into "MM" and the index is as it was.
  const stagedAtStart = new Set(was.porcelain.map(stagedKey));
  const staged = [...new Set(dirty.values())].filter(
    (e) => STAGED.test(e) && !stagedAtStart.has(stagedKey(e)),
  );
  return [...new Set([...changed, ...staged])];
}

// Are main's first-parent commits from `from` to `to`, end to end, merges other ledgers record or
// commits `blocked` lets through? A merge must be the run preHead → landed… → board commit its ledger
// names, in that order, on git's own first-parent line: a ledger is trusted only as far as git confirms
// it. `blocked(sha)` is null for a commit the guard lets through, else why not ("" for no reason to
// name). Returns `{ ok, allowed: [sha], why? }`: the allowed commits, and why the first other one is not.
export function landedOnly(root, from, to, others, blocked = () => "") {
  const no = (why = "") => ({ ok: false, allowed: [], why });
  const res = git(root, ["rev-list", "--first-parent", "--reverse", `${from}..${to}`, "--"]);
  const chain = res.stdout.split("\n").filter(Boolean);
  if (res.status !== 0 || !chain.length) return no();
  if (headOf(root, `${chain[0]}^`) !== from) return no();
  const allowed = [];
  const runs = others
    .map((l) => l.merge)
    .filter((m) => typeof m?.preHead === "string" && Array.isArray(m.landed) && m.landed.length)
    .map((m) => ({
      preHead: m.preHead,
      shas: [...m.landed, ...(typeof m.boardCommit === "string" ? [m.boardCommit] : [])],
    }));
  let at = from;
  for (let i = 0; i < chain.length; ) {
    if (isMemoryCommit(root, chain[i])) {
      at = chain[i++]; // the owner committing Agentry's own memory records
      continue;
    }
    const run = runs.find((r) => r.preHead === at && r.shas.every((s, k) => chain[i + k] === s));
    if (run) {
      i += run.shas.length;
      at = chain[i - 1];
      continue;
    }
    const why = blocked(chain[i]);
    if (why !== null) return no(why);
    allowed.push(chain[i]);
    at = chain[i++];
  }
  return { ok: true, allowed };
}

// The files a commit on main may not touch while this lane runs (field 81): its owned entries (as
// `ownsPath` reads them) and every path its worktree changed, committed past base or uncommitted. Once the
// branch holds main past its base (an in-branch rebase), "past base" is past that merge base: main's own
// changes are never this lane's files (field 102). null when they cannot be read: a doubt keeps the guard on.
export function laneFiles(root, ledger) {
  try {
    const owned = ownedOf(root, ledger).map((o) => (typeof o === "string" ? o : o.path));
    const res = git(root, [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      heldMain(root, ledger, ledger.base) ?? ledger.base,
      `refs/heads/${ledger.branch}`,
      "--",
    ]);
    if (res.status !== 0) return null;
    const changed = new Set(res.stdout.split("\0").filter(Boolean));
    for (const entry of porcelain(ledger.worktree)) changed.add(entry.slice(3));
    return { owned, changed };
  } catch {
    return null;
  }
}
