// exec/guard/main-guard — the one rule for whether main still matches a lane's start, which report,
// hold and resume all ask, and the guard's start that follows the branch once it holds main.
//
// The main-touched guard is content-exact. `start` records the content id (git's blob id) of every
// file that is dirty in main, and each lifecycle write a lane makes records `{ file, from, to }` in its
// ledger (`boardWrites`); each `board add` / `board set --apply` in main records the same in a shared log
// (`board-writes.mjs`). At a report, a main file may differ from the lane's start only when its content is
// reachable from its start content, or from the content a recorded merge committed, through recorded
// lifecycle writes or board writes made since the lane started. Any other edit (another row, free text, a
// non-board file, a file dirty at start that changed since) is the builder's, unless its path is one
// `guard.allow` lets through (`allowOf`: its globs, the config files in use, the board's own files) and no
// running lane owns it. HEAD may move only by merges other ledgers record, each a run preHead → landed… →
// board commit that git's first-parent history confirms, by commits on main whose every path
// `guard.allow` lets through and no running lane owns (A44), and by any commit that touches none of this
// lane's owned files and none of the files its worktree changed (field 81). A report that finds main
// touched holds the lane for the guard, its report saved, until a report again finds main clean (field 75).
import { kindOf } from "../../../process/ids.mjs";
import { now, ownedOf, short } from "../lane.mjs";
import { allowOf, allowedCommit, allowedEdit, configTrips } from "./allow.mjs";
import { blobsAt, dirtyPaths, headOf, heldMain } from "./snapshot.mjs";
import { boardFiles, landedOnly, laneFiles, strayFiles } from "./stray.mjs";

// Whether the main checkout still matches the lane's start: `{ touched, allowed, moved, overlap }`,
// `touched` why not (or null), `allowed` the commits on main the guard let through, `moved` how many of
// them the rule judged when all passed (other lanes' landed picks and record-shaped memory commits not
// counted), `overlap` whether a commit touched this lane's files. The one rule for HEAD's move
// (`allowedCommit`), so report, hold and resume never disagree. The start follows the branch first
// (`followBranch`), which can change `ledger.mainAtStart` and `startMoves` in place.
export function mainGuard(ctx, ledger, all) {
  const { root, spec, model } = ctx;
  const allow = allowOf(ctx, ledger);
  followBranch(root, ledger, all, allow);
  const was = ledger.mainAtStart;
  const head = headOf(root);
  const others = all.filter((l) => l.id !== ledger.id);
  const reasons = [];
  let allowed = [];
  let moved = 0;
  let overlap = false;
  if (head !== was.head) {
    const blocked = allowedCommit(root, allow, all, laneFiles(root, ledger), () => {
      overlap = true;
    });
    const res = landedOnly(root, was.head, head, others, blocked);
    if (res.ok) {
      allowed = res.allowed;
      moved = res.allowed.length; // the commits the rule judged, not other lanes' landed picks
    } else
      reasons.push(
        `HEAD moved ${short(was.head)} → ${short(head)}${res.why ? ` (${res.why})` : ""}`,
      );
  }
  reasons.push(...configTrips(root, allow, dirtyPaths(root)));
  const boards = new Set(all.flatMap((l) => boardFiles(spec, model, l.id, kindOf(l, spec))));
  const stray = strayFiles(root, ledger, head, all, boards, allowedEdit(root, allow, all));
  if (stray.length) reasons.push(`files changed: ${stray.slice(0, 10).join(", ")}`);
  return { touched: reasons.length ? reasons.join("; ") : null, allowed, moved, overlap };
}

// Why the main checkout no longer matches the lane's start, or null.
export const mainTouched = (ctx, ledger, all) => mainGuard(ctx, ledger, all).touched;

// The guard's start follows the branch (field 102): when the branch holds main past the start, the start
// moves to that merge base, its snapshot with it (`moveStart`), recorded in `startMoves[]` as `{ from, to,
// why: "branch holds main", at }`. Only when every main commit from the start to there passes the guard's
// rule judged against the lane's owned files alone (its changed files hold main's own diffs after the
// rebase): a commit that touches an owned file (a builder's wrong-cwd commit it then rebased onto) keeps
// the start, so it trips as before. Changes `ledger` in place.
function followBranch(root, ledger, all, allow) {
  const to = heldMain(root, ledger, ledger.mainAtStart?.head);
  if (!to) return;
  let owned;
  try {
    owned = ownedOf(root, ledger).map((o) => (typeof o === "string" ? o : o.path));
  } catch {
    return; // a doubt keeps the start
  }
  const others = all.filter((l) => l.id !== ledger.id);
  const blocked = allowedCommit(root, allow, all, { owned, changed: new Set() });
  if (!landedOnly(root, ledger.mainAtStart.head, to, others, blocked).ok) return;
  const from = ledger.mainAtStart.head;
  moveStart(root, ledger, to);
  ledger.startMoves = [
    ...(ledger.startMoves ?? []),
    { from, to, why: "branch holds main", at: now() },
  ];
}

// The main guard's start moved to `to`, its snapshot with it (field 93): a path clean on main now whose
// content the commits from the old start to `to` changed was committed, so its start entry goes; a path
// still dirty, or clean with those commits leaving it as it was (its edit discarded), keeps its start.
export function moveStart(root, ledger, to) {
  const was = ledger.mainAtStart;
  const dirty = dirtyPaths(root);
  const paths = Object.keys(was.files ?? {});
  const before = blobsAt(root, was.head, paths);
  const after = blobsAt(root, to, paths);
  const keep = new Set(paths.filter((p) => dirty.has(p) || before[p] === after[p]));
  ledger.mainAtStart = {
    ...was,
    head: to,
    files: Object.fromEntries(Object.entries(was.files ?? {}).filter(([p]) => keep.has(p))),
    porcelain: (was.porcelain ?? []).filter((e) => keep.has(e.slice(3))),
  };
}
