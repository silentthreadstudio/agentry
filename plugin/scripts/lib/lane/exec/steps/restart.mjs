// exec/steps/restart — `lane exec restart <id>`: a lane archived and started again from main, its work
// carried with --carry.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run as boardSet } from "../../../process/cli/set.mjs";
import { branchTips } from "../../../process/git.mjs";
import * as ledgers from "../../../process/ledger.mjs";
import { applyEvent } from "../../../process/lifecycle.mjs";
import { own } from "../../../process/spec/shape.mjs";
import { lifecycleOf } from "../../../process/spec/workflow.mjs";
import { runText } from "../../../process/steps.mjs";
import { shellWord } from "../../../text/shell.mjs";
import { resolveBranch } from "../../adopt.mjs";
import { now, short } from "../../fmt.mjs";
import { gatingNow } from "../../restack.mjs";
import { archiveNumber, carry, carryRange, leftover, retire, saveWork } from "../../restart.mjs";
import { PASSES, expects, verdicts } from "../../rounds.mjs";
import { childrenOf, restackLine, stackOf } from "../../stack.mjs";
import { branchOf, git } from "../../worktree.mjs";
import { refuseAtWriterCap, refuseMidLand } from "../admission.mjs";
import {
  archivedPath,
  carriedVerdicts,
  carriesVerified,
  carryCheck,
  keptOwned,
  lastReport,
  progressOf,
} from "../carried.mjs";
import { headOf } from "../guard/snapshot.mjs";
import { Stopped, contractFile, laneLine, mustLedger, refuse } from "../lane.mjs";
import { contractOf, mainBranchOf, openLane } from "../open-lane.mjs";

// The board's verdict cell (`lifecycle.write.verdict`) is the old lane's: a restarted lane has none yet, so it
// is cleared through `board set` (recorded, so no running lane's guard trips on it). null when there was
// none or it was cleared, else the line saying how to clear it by hand.
function clearVerdict({ root, spec, model, kind }, id) {
  const life = lifecycleOf(spec, kind);
  const field = own(life?.write, "verdict");
  if (typeof field !== "string") return null;
  const item = own(model.kinds, life.kind)?.items.find((i) => i.id === id);
  const was = item?.fields?.[field];
  if (was === null || was === undefined || String(was).trim() === "") return null;
  let res;
  try {
    res = boardSet([life.kind, id, `${field}=`, "--apply", "--json"], { root, spec, model });
  } catch {
    res = { exit: 1 }; // a board it cannot write (read-only): the line says how to clear it by hand
  }
  return res.exit === 0
    ? null
    : `! board ${field} ${was} is from the old lane: agentry board set ${life.kind} ${id} ${field}= --apply`;
}

// A lane started again: not merged and no agent out, its ledger and run files archived as
// `<id>.<n>` (a hold's `holds[]` with them), its worktree removed (only `cleanup.disposable` ignored files
// may go), its branch kept as `agentry/<id>.<n>`, and a fresh `agentry/<id>` cut from main with every
// `start` record. `--carry` picks the old branch's commits and applies its uncommitted diff; the kept
// branch goes once all of it is carried, and a stop leaves the conflict in the new worktree (exit 1). A
// verified lane carried whole goes to the resolve check, its board verdict kept; any other a build round.
export function run(ctx, id) {
  const { root, spec, carry: withWork } = ctx;
  refuseMidLand(root);
  const old = mustLedger(root, id);
  if (old.state === "merged") refuse(`${id} is merged: nothing to restart`);
  if (old.state === "merging")
    refuse(`${id} is landing (merge step ${old.merge?.step ?? "?"}): finish the land first`);
  const out = expects(old);
  if (out === "report") refuse("a builder is out: hold it first");
  if (out === "verdict") refuse("a verifier is out: record its verdict first");
  if (gatingNow(root, id)) refuse(`a gate for ${id} is queued or running: restart after it`);
  const stack = stackOf(root, old, ledgers.list(root));
  if (stack.on && stack.state !== "merged")
    refuse(
      `${id} is stacked on ${stack.on}, which is not merged: a restart cuts from main, so take it off first (${restackLine(root, id, " --main")})`,
    );
  // A child built on this lane's work would restack onto a branch that no longer holds it.
  const children = childrenOf(ledgers.list(root), id);
  if (children.length)
    refuse(
      `${children.join(", ")} ${children.length > 1 ? "are" : "is"} stacked on ${id}: restack or close ${children.length > 1 ? "them" : "it"} first`,
    );
  refuseAtWriterCap(root, spec, id);
  const found = contractOf(ctx, id);
  const mainBranch = mainBranchOf(root);
  // The lane branch as the branch list has it, by its exact name: a case twin is refused, and the tip is
  // never read by name (on a case-insensitive filesystem that can open the twin's loose file). A branch
  // listed only in another case is refused too: the cut would make the twin pair beside it.
  const tips = branchTips(root);
  const named = resolveBranch(root, old.branch, tips);
  if (named.problem && !named.missing) refuse(named.problem);
  const caseOf = (name) => [...tips.keys()].find((b) => b.toLowerCase() === name.toLowerCase());
  const other = named.missing && caseOf(old.branch);
  if (other) refuse(`${old.branch} is listed only as ${other}: rename it to its exact name first`);
  const oldTip = named.tip ?? null;
  // The kept name, checked before anything is written: one another branch has in another case refuses.
  const n = archiveNumber(root, id);
  const keptName = oldTip ? branchOf(`${id}.${n}`) : null;
  const clash = keptName && caseOf(keptName);
  if (clash) refuse(`${clash} would be a case twin of ${keptName}: rename it first`);
  const left = leftover(root, old, spec.cleanup?.disposable ?? []);
  if (left.problem) refuse(left.problem);
  if (left.ignored.length)
    refuse(
      `the worktree ${old.worktree} holds ${left.ignored.length} ignored file(s) a restart would delete (${left.ignored.slice(0, 5).join(", ")}): copy what you need out and remove them, or add them to cleanup.disposable, then restart`,
    );
  // What a carry picks: the branch's commits not on main, never base..tip, from a branch
  // based on main's first-parent line; a patch main has already is left out and named.
  const range = withWork && oldTip ? carryRange(root, headOf(root), oldTip) : null;
  if (range && !range.based)
    refuse(
      `${old.branch} is not based on ${mainBranch}: rebase it onto ${mainBranch} or land it with lane merge --branch`,
    );
  // The new lane's board write, tried before anything is written: a row it cannot write refuses here.
  applyEvent({
    root,
    spec,
    model: ctx.model,
    event: "dispatched",
    id,
    kind: ctx.kind,
    preview: true,
  });
  const diffIn = (runs) => join(runs, "restart", "uncommitted.diff");
  const work = existsSync(old.worktree)
    ? saveWork(old.worktree, diffIn(ledgers.runDir(root, id)))
    : { files: [] };
  if (work.error) refuse(`the worktree's uncommitted work could not be saved: ${work.error}`);

  let oldBlock = "";
  try {
    oldBlock = readFileSync(contractFile(root, id), "utf8");
  } catch {} // an older run dir without it: every owned entry reads as a grant
  const archived = ledgers.archive(root, id, n);
  const diff = diffIn(archived.runs);
  let kept = null;
  let keptTip = null;
  let drop = false;
  const again = (path, base) => {
    const restarted = {
      from: `${id}.${n}`,
      ledger: archived.ledger,
      runs: archived.runs,
      at: now(),
    };
    if (!withWork)
      return {
        restarted: { ...restarted, branch: kept },
        warnings: [clearVerdict(ctx, id)].filter(Boolean),
        shown: { restarted: `archived as ${id}.${n}; the old branch is kept as ${kept ?? "none"}` },
      };
    const res = carry(path, { picks: range?.picks ?? [], diff });
    // The old commits' range-diff starts where they sat on main: after an in-branch rebase that is no
    // longer the old base.
    const checked =
      res.ok && carriesVerified(old, oldTip, work.files)
        ? {
            ...carryCheck(root, id, { base: range?.base ?? old.base, tip: oldTip }, base, path),
            carriedRounds: carriedVerdicts(old, `${id}.${n}`, archived.runs),
          }
        : null;
    // The verdict on the board stands for a checked carry, as it does for a rebase.
    const warnings = checked ? [] : [clearVerdict(ctx, id)].filter(Boolean);
    const report = lastReport(old, archived.runs);
    const skipped = range?.skipped ?? [];
    const progress = progressOf(old, found.steps, archived.runs);
    // A verified carry goes on past the build: only the owner OKs ride with it, no step to continue.
    const stepRun = checked ? null : progress.stepRun;
    const builds = old.rounds.filter((r) => r.role === "build").length;
    const lastVerdict = verdicts(old).at(-1);
    const carried = {
      ...(lastVerdict &&
        !PASSES.includes(lastVerdict.verdict) &&
        !checked && {
          verdict: {
            verdict: lastVerdict.verdict,
            report: archivedPath(old.id, archived.runs)(lastVerdict.reportPath),
          },
        }),
      rounds: { total: old.rounds.length, builds, verdicts: verdicts(old).length },
      ...(stepRun && { stepRun }),
      commits: oldTip ? left.commits : 0,
      ...(skipped.length && { skipped }),
      files: work.files.length,
      report,
      ...(work.files.length && { applied: res.applied, diff }),
      ...(res.conflict && { conflict: res.conflict }),
    };
    // All of the old work is in the new branch: the kept one goes once the new ledger is written; a stop
    // keeps it.
    drop = res.ok && Boolean(kept);
    const branch = res.ok ? null : kept;
    return {
      restarted: { ...restarted, branch },
      carried,
      holds: progress.holds,
      ownedKept: keptOwned(old, oldBlock, found.block, path),
      ...(stepRun && {
        startAt: {
          stepRun,
          from: report ?? undefined,
          reason: `restarted: ${id}.${n} stopped in ${runText(stepRun, found.steps.length)}`,
        },
      }),
      ...checked,
      warnings,
      exit: res.ok ? 0 : 1,
      shown: {
        restarted: `archived as ${id}.${n}${branch ? `; the old branch is kept as ${branch}` : ""}`,
        carried: `${carried.commits} commits, ${carried.files} files uncommitted${report ? `; last report ${report}` : ""}`,
        ...(skipped.length && {
          skipped: `${skipped.length} already on ${mainBranch}: ${skipped.map((c) => `${short(c.sha)} ${c.subject}`).join(", ")}`,
        }),
        ...(res.conflict && { conflict: `${res.conflict} in ${path}` }),
        ...(progress.approved && {
          progress: `${progress.approved} owner OK(s) carried${stepRun ? `; the first brief is for ${runText(stepRun, found.steps.length)}` : ""}`,
        }),
        ...(progress.dropped.length && { dropped: progress.dropped.join("; ") }),
        ...(checked && { rangeDiff: checked.rebases[0].rangeDiff }),
      },
    };
  };
  // Past the archive nothing is refused: a failure is a stop that says where the old work is.
  try {
    ({ kept, tip: keptTip } = retire(root, old, n));
    // The owner's calls are the lane's, not the attempt's: the new ledger keeps them.
    const withCalls = (path, base) => ({ calls: old.calls ?? [], ...again(path, base) });
    const res = openLane({ ...ctx, on: null, cite: old.cite ?? [] }, id, {
      found,
      mainBranch,
      again: withCalls,
    });
    // At the tip it was kept at, and only while no case twin has appeared: never the twin with it.
    if (drop && resolveBranch(root, kept).tip === keptTip)
      git(root, ["update-ref", "-d", `refs/heads/${kept}`, keptTip]);
    return res;
  } catch (e) {
    // Read from the branch list by exact name, as every step back is printed: `update-ref` at the listed
    // tip, which git refuses when the ref holds anything else (a delete or rename by name could take a
    // case twin).
    const listed = branchTips(root);
    const held = [keptName, old.branch].find((b) => b && listed.has(b));
    const ref = (b) => shellWord(`refs/heads/${b}`);
    // A new branch left beside the kept one holds only copies of its work.
    const copy = held && held !== old.branch && listed.get(old.branch);
    // The steps back by hand: the old branch out of the new one's way (a stop before the rename leaves it
    // under its own name), the start, then (for a carry) the old commits and the saved diff.
    const unrenamed = keptName && held === old.branch;
    // The old lane's verdict on the board does not stand for a restart that stopped: cleared now, or the
    // step that clears it named.
    const unclear = clearVerdict(ctx, id);
    const steps = [
      ...(copy ? [`git update-ref -d ${ref(old.branch)} ${copy}`] : []),
      ...(unrenamed
        ? [
            `git update-ref ${ref(keptName)} ${listed.get(held)} ''`,
            `git update-ref -d ${ref(old.branch)} ${listed.get(held)}`,
          ]
        : []),
      laneLine(root, "start", id),
      ...(withWork && held && keptName && range?.picks.length
        ? [`in its worktree git cherry-pick ${range.picks.map(short).join(" ")}`]
        : []),
      ...(withWork && work.files.length ? [`git apply --3way ${shellWord(diff)}`] : []),
      ...(unclear ? [unclear.slice(unclear.indexOf("agentry board set"))] : []),
    ];
    throw new Stopped(
      `${id} is archived (${archived.ledger}, ${archived.runs}), its old work is on ${held ?? "no branch"}${work.files.length ? ` and its uncommitted diff at ${diff}` : ""}, but the restart stopped: ${e.message} → fix that, then: ${steps.join("; ")}`,
    );
  }
}
