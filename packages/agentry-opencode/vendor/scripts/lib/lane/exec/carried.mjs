// exec/carried — what a restarted lane carries from the archive of the old one: its last report, its
// counted verdicts, its owner OKs and the step it stopped in, its owned files, and the range-diff
// check that lets a verified carry go on as a rebase does.
import { dirname, isAbsolute, join, relative } from "node:path";
import { runOf, runText } from "../../process/steps.mjs";
import { now } from "../fmt.mjs";
import { ownedFiles, withNew } from "../owns.mjs";
import { PASSES, parkedVerified, verdicts } from "../rounds.mjs";
import { git } from "../worktree.mjs";
import { ownsPath } from "./guard/allow.mjs";
import { headOf } from "./guard/snapshot.mjs";
import { heldCopy, saved } from "./lane.mjs";
import { keepRangeDiff } from "./rebasing.mjs";

// A path under lane `id`'s run dir as the archive `runs` holds it now; any other path as it is. The archive
// is `runs/.archive/<id>.<n>/` (`ledgers.archive`), so the lane's own dir is `runs/<id>/` two levels up.
export const archivedPath = (id, runs) => (path) => {
  const rel = relative(join(dirname(dirname(runs)), id), path ?? "");
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? join(runs, rel) : path;
};

// The old builder's last report, as the archive holds it: the report a guard trip saved, else the newest
// build round's report (or its held copy) that is there; null when no builder reported.
export function lastReport(ledger, runs) {
  const moved = archivedPath(ledger.id, runs);
  const builds = ledger.rounds.filter((r) => r.role === "build" && r.reportPath).reverse();
  const candidates = [
    ledger.hold?.report,
    ...builds.flatMap((r) => [r.reportPath, heldCopy(r.reportPath)]),
  ].filter(Boolean);
  return candidates.map(moved).find((p) => saved(p)) ?? null;
}

// Is the old lane's carry its verified work: its last verdict passed with nothing after it but the gate
// or the close, on the very tip carried, and no uncommitted work beside it?
export function carriesVerified(ledger, tip, files) {
  const settled = ["gate", "close", "merge"].includes(ledger.next) || parkedVerified(ledger);
  const trusted = ledger.next === "gate" ? ledger.gateTip : ledger.closedTip;
  return (
    settled &&
    PASSES.includes(verdicts(ledger).at(-1)?.verdict) &&
    Boolean(tip) &&
    trusted === tip &&
    files.length === 0
  );
}

// The old lane's counted verdicts, carried into the new ledger as its first rounds: numbered from 1, marked
// `carried: "<id>.<n>"` (the archive; a round carried before keeps its first one, where its files are) and
// their files read where the archive holds them, so the land's flagged-item check and the episode count the
// verification the carry stands on.
export const carriedVerdicts = (ledger, archive, runs) => {
  const moved = archivedPath(ledger.id, runs);
  return verdicts(ledger).map((r, i) => ({
    ...r,
    n: i + 1,
    carried: r.carried ?? archive,
    ...(r.brief && { brief: moved(r.brief) }),
    ...(r.reportPath && { reportPath: moved(r.reportPath) }),
  }));
};

// The old lane's progress through its contract's steps: the owner OKs of its passed gates
// (`holds[]` with `for: owner`, resolved) and, when a step past 1 follows an OK, the run it stopped in (its
// newest builder round's) for the new lane's first brief. Carried only while the contract's steps are the
// ones the OKs were given on, their evidence read where the archive holds it; what is not carried is named in `dropped`.
export function progressOf(old, steps, runs) {
  const oks = (old.holds ?? []).filter((h) => h.for === "owner");
  const none = { holds: [], approved: 0, stepRun: null, dropped: [] };
  if (!oks.length && old.hold?.for !== "owner") return none;
  const dropped = [];
  const held = old.hold?.for === "owner" ? old.hold : null;
  if (held) {
    // A step hold names its run; a hold with none (a stepless lane's, or the notes cap's) is no step's.
    const where = held.stepRun
      ? `on ${runText(held.stepRun, old.steps?.length ?? 0)}`
      : held.when === "verdict"
        ? "at the notes cap"
        : `on round ${held.round}`;
    dropped.push(
      `the owner hold ${where}: not an OK${held.stepRun ? ", the step is built again" : ", not carried"}`,
    );
  }
  if (JSON.stringify(old.steps ?? []) !== JSON.stringify(steps ?? []))
    return {
      ...none,
      dropped: [
        ...dropped,
        ...(oks.length
          ? [`${oks.length} owner OK(s) and the step pointer: the contract's steps changed`]
          : []),
      ],
    };
  const a = old.rounds.findLast((r) => r.role === "build" && r.stepRun)?.stepRun?.[0] ?? 1;
  const passed = oks.some((h) => h.when === "after" && !h.redo && h.stepRun?.[1] === a - 1);
  if (a > 1 && !passed) dropped.push(`the step pointer: no owner OK before step ${a}`);
  const moved = archivedPath(old.id, runs);
  const holds = oks.map((h) => ({ ...h, evidence: moved(h.evidence) }));
  const approved = oks.filter((h) => h.when === "after" && !h.redo).length;
  return { holds, approved, stepRun: a > 1 && passed ? runOf(steps, a) : null, dropped };
}

// The owned files a restart carries: the old ledger's `owned` entries as they are while the
// contract's owns are the ones the old lane started with; when the contract's owns changed, the contract's
// now plus the old ledger's grants (entries the old contract did not name), copied as they are. null when
// the old ledger kept none (the contract's own are read as `start` reads them).
export function keptOwned(old, oldBlock, block, dir) {
  if (!old.owned?.length) return null;
  const was = withNew(dir, ownedFiles(oldBlock, dir));
  const now = withNew(dir, ownedFiles(block, dir));
  if (JSON.stringify(was.map((o) => o.path)) === JSON.stringify(now.map((o) => o.path)))
    return structuredClone(old.owned);
  const grants = old.owned.filter((o) => !was.some((w) => w.path === o.path));
  return [
    ...now,
    ...structuredClone(grants).filter((g) => !now.some((o) => ownsPath(o.path, g.path))),
  ];
}

// A verified lane's carry, taken as a rebase: the range-diff of the old base..tip against the new
// `base`..HEAD of `worktree` as the new lane's first `rebases[]` entry, and the `rebased` facts (`tip`,
// `changed`) its next step is picked from.
export function carryCheck(root, id, { base: fromBase, tip: fromTip }, base, worktree) {
  const tip = headOf(worktree);
  const res = git(root, ["range-diff", "--no-color", `${fromBase}..${fromTip}`, `${base}..${tip}`]);
  const { file, changed } = keepRangeDiff(root, id, 1, res);
  return {
    rebases: [
      {
        fromBase,
        fromTip,
        mainHead: base,
        at: now(),
        toBase: base,
        toTip: tip,
        changed,
        rangeDiff: file,
        carried: true, // a restart's carry: main's start was never moved by it
      },
    ],
    rebased: { tip, changed },
  };
}
