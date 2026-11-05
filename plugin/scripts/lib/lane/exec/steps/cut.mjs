// exec/steps/cut — `lane exec cut <id> --decision <D> [--keep <paths>] [--message <subject>] [--apply]`
// (field 95): retire a lane on the owner's decision, landing only the paths the owner keeps. Every check
// comes first and writes nothing (`exec/cut/plan.mjs`), so a preview (no `--apply`) is the same answer with
// nothing written. With `--apply` the kept paths and the board's `cut` word land (`exec/cut/land.mjs`), a
// cut a kill left mid-land is rolled back first (`exec/cut/recover.mjs`), the ledger records `cut` and is
// closed, the worktree is removed (its uncommitted work saved) and the branch is kept as
// `agentry/<id>.cut`, by ref at its listed tip. `cli/exec.mjs` parses the call.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { PREVIEW } from "../../../cli/help.mjs";
import { branchTips } from "../../../process/git.mjs";
import * as ledgers from "../../../process/ledger.mjs";
import { shellWord } from "../../../text/shell.mjs";
import { short } from "../../fmt.mjs";
import { now } from "../../merge/lane.mjs";
import { keepBranchAs, saveWork } from "../../restart.mjs";
import { remove } from "../../worktree.mjs";
import { landCut, rowLines } from "../cut/land.mjs";
import { planCut } from "../cut/plan.mjs";
import { recoverCut } from "../cut/recover.mjs";
import { episodeOf } from "../episode.mjs";
import { laneLine, mustLedger, refuse, stop } from "../lane.mjs";

// The board's answer as one line: what it writes, or why nothing.
const boardLine = ({ writes, skipped }) =>
  [...writes.map((w) => `${w.file}: ${w.what}`), ...skipped.map((s) => `${s.what}: ${s.why}`)].join(
    "; ",
  ) || "nothing to write";

// Keep the branch as `keptName` at the listed tip, by restart's case-safe rename (`keepBranchAs`, both
// case-twin checks right where they count). null, or what is left as restart words a stop (why → fix
// that, then: the steps), read from the branch list where the rename stopped: nothing made (both steps
// owed), `keptName` made with the lane branch still at the tip (its delete owed), or the lane branch
// moved off it (no step: the owner checks the moved branch).
function keepBranch(root, { branch, tip, keptName }) {
  try {
    keepBranchAs(root, { branch, tip, kept: keptName });
    return null;
  } catch (e) {
    const tips = branchTips(root);
    const ref = (b) => shellWord(`refs/heads/${b}`);
    const del = `git update-ref -d ${ref(branch)} ${tip}`;
    if (tips.get(keptName) !== tip)
      return `its branch was not kept as ${keptName}: ${e.message} → fix that, then: git update-ref ${ref(keptName)} ${tip} ''; ${del}`;
    if (tips.get(branch) === tip)
      return `${keptName} holds ${short(tip)} and ${branch} was not deleted: ${e.message} → fix that, then: ${del}`;
    return `${keptName} holds ${short(tip)}, the old tip, and ${e.message}: ${branch} was left as it is; check it, then delete it by hand`;
  }
}

/** `lane exec cut <id> …`: the preview, or with `--apply` the cut, as the step's JSON `{ exit, out }`. */
export function run(ctx, id) {
  const ledger = mustLedger(ctx.root, id);
  const { root, spec, apply } = ctx;
  if (apply && ledger.state === "merging" && ledger.merge?.cut) recoverCut({ ...ctx, id }, ledger);
  const plan = planCut({ ...ctx, id }, ledger);
  const keeps = plan.files.length > 0;
  const shown = {
    decision: plan.decision,
    kept: keeps ? plan.files : "none: nothing lands on main",
    ...(keeps && {
      land: `one commit on ${ledger.mainBranch}, ${plan.files.length} file(s) as ${short(plan.tip)} has them: "${plan.message}"`,
      gate: `${plan.tier.tier ?? "none"} (${plan.tier.reason})`,
    }),
    ...(plan.main && { main: plan.main }),
    board: `${boardLine(plan.board)}${plan.board.writes.length ? `; committed on ${ledger.mainBranch} as "${plan.boardMessage}", with the board writes main carries` : ""}`,
    worktree: `${ledger.worktree} removed${plan.dirty.length ? `, its ${plan.dirty.length} uncommitted file(s) saved first` : ""}`,
    branch: plan.tip ? `${ledger.branch} kept as ${plan.keptName}` : "none",
    ...(plan.warnings.length && { warning: plan.warnings.join("\n") }),
  };
  const result = (fields) => ({
    exit: 0,
    out: JSON.stringify({ id, step: "cut", ...fields }, null, 2),
  });
  if (!apply) {
    const flags = [
      `--decision ${shellWord(plan.decision)}`,
      ...(keeps ? [`--keep ${shellWord(ctx.keep)}`] : []),
      ...(ctx.message !== null ? [`--message ${shellWord(ctx.message)}`] : []),
      "--apply",
    ];
    return result({
      next: laneLine(root, "cut", id, ` ${flags.join(" ")}`),
      state: ledger.state,
      ...shown,
      preview: PREVIEW,
    });
  }

  const diff = join(ledgers.runDir(root, id), "cut", "uncommitted.diff");
  if (plan.dirty.length) {
    const saved = saveWork(ledger.worktree, diff);
    if (saved.error) refuse(`the worktree's uncommitted work could not be saved: ${saved.error}`);
  }
  let landed = {
    commit: null,
    boardCommit: null,
    board: plan.board,
    rows: [],
    merge: ledger.merge,
    ledger,
  };
  if (keeps || spec.lifecycle) {
    try {
      landed = landCut({ ...ctx, id }, ledger, plan);
    } catch (e) {
      if (plan.dirty.length) rmSync(diff, { force: true });
      throw e;
    }
  }
  const { merge: _land, ...rest } = landed.ledger;
  const cutLedger = {
    ...rest,
    ...(landed.merge !== undefined && { merge: landed.merge }),
    state: "closed",
    next: null,
    cut: {
      decision: plan.decision,
      kept: plan.files,
      commit: landed.commit,
      boardCommit: landed.boardCommit,
      at: now(),
      ...(plan.dirty.length && { uncommitted: diff }),
    },
  };
  // The episode's payload goes in with the close, so session close lists it until `exec close --episode`
  // stamps it, as for any finished lane.
  const payload = episodeOf(cutLedger);
  const closed = ledgers.write(root, {
    ...cutLedger,
    episode: { ...cutLedger.episode, payload },
  });
  // Past the ledger the cut stands: what fails now is finished by hand, as the stop says.
  const done = `${id} is cut (its ledger is closed)${landed.commit ? `, ${short(landed.commit)} on ${ledger.mainBranch}` : ""}`;
  const gone = remove(root, { path: ledger.worktree, branch: null, force: true });
  if (!gone.removed)
    stop(
      `${done}, but its worktree was not removed: ${gone.reason} → git worktree remove -f -f ${shellWord(ledger.worktree)}`,
    );
  const why = plan.tip
    ? keepBranch(root, { branch: ledger.branch, tip: plan.tip, keptName: plan.keptName })
    : null;
  if (why) stop(`${done}, but ${why}`);
  const { gate: _gate, main: _main, ...told } = shown;
  return result({
    next: null,
    state: closed.state,
    ...told,
    board: boardLine(landed.board),
    ...(landed.commit && { commit: landed.commit }),
    ...(landed.boardCommit && { boardCommit: landed.boardCommit }),
    ...(landed.rows.length && { land: rowLines(landed.rows).join("\n") }),
    episode: payload,
    afterwards: `episode_write with this payload, then ${laneLine(root, "close", id, " --episode <its id>")}`,
    ...(plan.dirty.length && { uncommitted: diff }),
  });
}
