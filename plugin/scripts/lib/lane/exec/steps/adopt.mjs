// exec/steps/adopt — `lane exec adopt <id> --branch <b>`: work built outside exec taken in as the lane.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { branchTips } from "../../../process/git.mjs";
import * as ledgers from "../../../process/ledger.mjs";
import { applyEvent } from "../../../process/lifecycle.mjs";
import { cleanupSteps, pickOnto, shellWord, source } from "../../adopt.mjs";
import { ownedFiles, withNew } from "../../brief.mjs";
import { carry, saveWork } from "../../restart.mjs";
import { setSpikeCalls } from "../../spikes.mjs";
import { branchOf, git, remove } from "../../worktree.mjs";
import { refuseAtWriterCap, refuseLane, refuseMidLand } from "../admission.mjs";
import { ownsPath } from "../guard/allow.mjs";
import { headOf } from "../guard/snapshot.mjs";
import { Stopped, laneLine, now, refuse, short } from "../lane.mjs";
import { contractOf, mainBranchOf, openLane } from "../open-lane.mjs";

// Work built outside exec taken in as the lane (field 86): `start`'s checks and board write, a fresh
// `agentry/<id>` cut from main, `main..<b>`'s commits picked onto it and, when <b> is checked out in a
// worktree, that worktree's uncommitted diff applied (`restart.mjs`'s `saveWork` and `carry`). <b> and its
// worktree are only read. Every refusal comes before the cut; a carry that stops leaves the conflict in the
// new worktree, named in the output and the brief, as `restart --carry` does (exit 1).
export function run(ctx, id) {
  const { root, spec, branch } = ctx;
  refuseLane(root, id);
  refuseMidLand(root);
  const mainBranch = mainBranchOf(root);
  const base = headOf(root);
  const from = source(root, { id, branch, base, mainBranch, lanes: ledgers.list(root) });
  if (from.problem) refuse(from.problem);
  // `agentry/<id>` and its worktree are what the cut makes: a ledgerless one with this id lands as it is.
  if (branch === branchOf(id))
    refuse(
      `${branch} is the branch a lane for ${id} cuts: land it as it is with lane merge ${id} --branch ${shellWord(branch)}, or adopt it for another id`,
    );
  refuseAtWriterCap(root, spec, null, from.worktree);
  const found = contractOf(ctx, id);
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
  // The uncommitted work is saved outside the repository until the cut, so a refusal leaves no run dir.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "agentry-adopt-")));
  try {
    const saved = join(scratch, "uncommitted.diff");
    const work = from.dirty.length ? saveWork(from.worktree, saved) : { files: [] };
    if (work.error) refuse(`the worktree's uncommitted work could not be saved: ${work.error}`);
    // What the carry writes in the run dir, so a failure removes that and nothing that was there before:
    // `runs/<id>`, and `runs/` itself when the adopt made it and no other lane has put a run dir in it.
    const runsAt = join(root, ".agentry", "run", "process", "runs", id);
    const made = existsSync(runsAt) ? [] : [runsAt];
    const runsMade = !existsSync(dirname(runsAt));
    const carryIn = (path) => {
      const diff = join(ledgers.runDir(root, id), "adopt", "uncommitted.diff");
      if (work.files.length) {
        const dir = mkdirSync(dirname(diff), { recursive: true });
        if (dir) made.push(dir);
        copyFileSync(saved, diff);
        made.push(diff);
      }
      // The commits are picked as a list, merges left out (`pickOnto`); `carry` then applies the diff.
      const picked = pickOnto(path, {
        commits: from.commits,
        diff: work.files.length ? diff : null,
      });
      const res = picked.ok
        ? carry(path, { base, tip: null, diff })
        : { ok: false, applied: false, conflict: picked.conflict };
      const adopted = {
        branch,
        tip: from.tip,
        commits: from.commits.map(({ sha, subject }) => ({ sha, subject })),
        ...(from.merges.length && { merges: from.merges }),
        worktree: from.worktree,
        files: work.files.length,
        ...(work.files.length && { applied: res.applied, diff }),
        ...(res.conflict && { conflict: res.conflict }),
        at: now(),
      };
      return {
        adopted,
        calls: from.calls,
        warnings: outsideAdopted(root, id, found, path, from.commits),
        exit: res.ok ? 0 : 1,
        shown: {
          adopted: `${branch} at ${short(from.tip)}: ${adopted.commits.length} commits picked${from.merges.length ? ` (${from.merges.length} merge commits left out)` : ""}, ${adopted.files} files uncommitted${from.worktree ? ` from ${from.worktree}` : ""}`,
          ...(res.conflict && { conflict: `${res.conflict} in ${path}` }),
          cleanup: `${branch} and its worktree are left as they are; once ${id} has landed: ${cleanupSteps(adopted).join("; ")}`,
        },
      };
    };
    // A throw inside the carry (not a conflict: those are a stop with the ledger written) takes the new
    // lane down again, its worktree, branch and run files, so no lane is left without a ledger.
    const again = (path) => {
      try {
        return carryIn(path);
      } catch (e) {
        const left = takeDown(root, { path, branch: branchOf(id) });
        for (const p of made.reverse()) rmSync(p, { recursive: true, force: true });
        if (runsMade) rmEmpty(dirname(runsAt));
        throw new Stopped(
          left.length
            ? `the adopt stopped: ${e.message}; the new lane could not be taken down, left: ${left.join("; ")}; ${branch} is as it was`
            : `the adopt stopped: ${e.message}; the new lane was taken down, nothing is kept and ${branch} is as it was`,
        );
      }
    };
    const res = openLane({ ...ctx, on: null }, id, { found, parent: null, mainBranch, again });
    // The spike's calls are the ledger's now (written above): the spike keeps none (field 90).
    if (from.calls.length) setSpikeCalls(root, branch, []);
    return res;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Remove the lane worktree at `path` and then its `branch` (force: the lane holds only what was just
// carried): what is left, one entry each, with the command that removes it. Empty when both went. The
// branch goes by `update-ref -d` at its listed tip, never `branch -D` (that could take a case twin too),
// and only once the worktree is gone: a branch is not deleted from under its checkout.
function takeDown(root, { path, branch }) {
  const gone = remove(root, { path, branch: null, force: true });
  const tip = branchTips(root).get(branch);
  const drop = tip && `git update-ref -d ${shellWord(`refs/heads/${branch}`)} ${tip}`;
  if (!gone.removed)
    return [
      `the worktree ${path} (${gone.reason}): git worktree remove -f ${shellWord(path)}`,
      ...(drop ? [`the branch ${branch}: ${drop}`] : []),
    ];
  if (!tip) return [];
  const deleted = git(root, ["update-ref", "-d", `refs/heads/${branch}`, tip]);
  return deleted.status === 0
    ? []
    : [`the branch ${branch} (${deleted.stderr.trim().split("\n")[0]}): ${drop}`];
}

// Remove the directory `dir` when it is empty; one that holds anything is left.
function rmEmpty(dir) {
  try {
    rmdirSync(dir);
  } catch {
    /* not empty, or gone already */
  }
}

// The adopted commits that change files outside the contract's owns, as warning lines, the last one the
// way to own them: never a refusal.
function outsideAdopted(root, id, found, path, commits) {
  const owned = withNew(path, ownedFiles(found.block, path)).map((o) => o.path);
  const out = commits
    .map((c) => ({ ...c, out: c.files.filter((f) => !owned.some((o) => ownsPath(o, f))) }))
    .filter((c) => c.out.length);
  if (!out.length) return [];
  const paths = [...new Set(out.flatMap((c) => c.out))];
  return [
    ...out.map(
      (c) =>
        `! adopted ${short(c.sha)} ${c.subject} changes files outside owns: ${c.out.join(", ")}`,
    ),
    `! to own them: ${laneLine(root, "owns", id, ` --add ${shellWord(paths.join(","))} --apply`)}`,
  ];
}
