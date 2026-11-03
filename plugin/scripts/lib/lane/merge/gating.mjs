// merge/gating — the land's `gate` step (plan R1b-5): skip on a trusted worktree gate (`canSkip`), or
// run the tier `pickTier` picks on main, in a process group the ledger names first (`merge.gateRun`) so
// a rerun can stop it if this run dies. A red gate takes the picks off main again (`rollBack`).
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "../../process/ledger.mjs";
import { gateArgv } from "../gate-group.mjs";
import { gateLockDir, holdGate } from "../gate-lock.mjs";
import { canSkip, changedSince, flakyReds, pickTier, runGate } from "../gate.mjs";
import { commitOf, rollback, treeOf } from "../land.mjs";
import { now, ok, red, save, setMerge, short } from "./lane.mjs";
import { lastWorktreeGate } from "./rows.mjs";

// The `after` glob a post-gate file matched, found with the gate's own matcher (a quick tier whose only
// glob is that one), so the table never names a glob the skip decision did not use.
const globOf = (file, globs) =>
  globs.find(
    (glob) => pickTier({ quick: { command: ["-"], only: [glob] } }, [file]).tier === "quick",
  );

export function gateStep(lane, rows) {
  const { root, id, gate } = lane;
  const { mainBranch, gates = [] } = lane.ledger;
  const merge = lane.ledger.merge;
  if (merge.step === "gated") {
    rows.push(ok("gate", `already passed: ${merge.gate.detail}`));
    return null;
  }
  const record = lastWorktreeGate(lane.ledger);
  const since = record ? changedSince(root, record.commit, merge.tip) : null;
  const decision = canSkip({
    record,
    mainTree: treeOf(root, "HEAD"),
    branchTipTree: treeOf(root, merge.tip),
    changedSinceGate: since,
    after: gate.after,
  });
  if (decision.skip) {
    const detail = `skipped: gate on ${short(record.commit)}, tree identical`;
    const more = [
      decision.reason,
      ...since.map((file) => `${file} matched after "${globOf(file, gate.after)}"`),
    ];
    save(lane, {
      merge: { ...merge, step: "gated", gate: { tier: "skipped", trusted: record.commit, detail } },
    });
    rows.push(ok("gate", detail, more));
    return null;
  }
  const { tier, reason } = pickTier(gate, changedSince(root, merge.preHead, "HEAD") ?? []);
  const dir = runDir(root, id);
  const cmd = tier === "quick" ? gate.quick.command : gate.command;
  let busy = null;
  // One run of the gate on main, behind the same lock as the lanes' gates, so load-sensitive tests never run
  // against each other (a flaky re-run takes every slot, so it runs alone). `n` is a number no log holds yet: a
  // killed gate is not in the ledger, and its log is the evidence of it. The log exists before the wait, so a
  // queued land says so there.
  let n = gates.filter((g) => g.where === "main").length;
  const runOnMain = (exclusive) => {
    n++;
    while (existsSync(join(dir, `merge-gate-${n}.log`))) n++;
    const logFile = join(dir, `merge-gate-${n}.log`);
    const held = holdGate(gateLockDir(root), {
      slots: gate.concurrency,
      exclusive,
      who: `land ${id}`,
      log: logFile,
    });
    if (held.busy) {
      busy = held.busy;
      return null;
    }
    // The gate's process group, written down before it starts, so a rerun can stop it if this run dies.
    const gateRun = {
      pidFile: join(dir, `merge-gate-${n}.pid`),
      nonce: randomBytes(8).toString("hex"),
    };
    setMerge(lane, { step: "gating", gateRun });
    const startedAt = Date.now();
    let res;
    try {
      res = runGate(root, gateArgv(cmd, gateRun), { tier, logFile });
    } finally {
      held.release();
    }
    rmSync(gateRun.pidFile, { force: true });
    return { res, startedAt };
  };
  const first = runOnMain(false);
  if (busy) {
    rows.push(
      red(
        "gate",
        `another gate holds the gate lock (${busy.who || "unknown"}, pid ${busy.pid ?? "?"}) at ${busy.file}`,
      ),
    );
    return {
      exit: 1,
      next: "land again when that gate has ended (it resumes), or delete the lock file if nothing holds it",
    };
  }
  if (first.res.refused) {
    setMerge(lane, { step: "landed", gateRun: undefined });
    rows.push(red("gate", `refused: ${mainBranch} is not clean`, first.res.files.slice(0, 10)));
    return {
      exit: 1,
      next: `move what makes ${mainBranch} dirty away, then land again (it resumes)`,
    };
  }
  // A red that failed only in listed flaky tests, on a clean tree, is re-run once, alone, as `exec gate` does.
  const flaky =
    first.res.exit !== 0 && first.res.cleanAfter
      ? flakyReds(first.res.log, gate.flaky, {
          logs: gate.flakyLogs,
          cwd: root,
          since: first.startedAt,
        })
      : null;
  const again = flaky ? runOnMain(true) : null;
  const reran = again && !again.res.refused;
  // A re-run refused on a dirty main is still a re-run that was tried: `flakyRed` stays on the first run.
  save(lane, {
    gates: [
      ...gates,
      { where: "main", ...first.res, ...(again && { flakyRed: flaky }), at: now() },
      ...(reran ? [{ where: "main", ...again.res, rerun: true, at: now() }] : []),
    ],
  });
  const res = reran ? again.res : first.res;
  const why = [`${tier}: ${reason}`, `not skipped: ${decision.reason}`, `log ${res.log}`];
  if (reran)
    why.push(
      `first run failed only in flaky tests (${flaky.join(", ")}); re-run alone, log ${first.res.log}`,
    );
  if (again?.res.refused)
    why.push(
      `first run failed only in flaky tests (${flaky.join(", ")}); the re-run was refused: ${mainBranch} is not clean (${again.res.files.slice(0, 3).join(", ")})`,
    );
  if (res.exit === 0) {
    const detail = `${tier} ran on ${mainBranch}: exit 0 in ${res.seconds} s${reran ? " (re-run alone after a red only in flaky tests)" : ""}`;
    setMerge(lane, { step: "gated", gateRun: undefined, gate: { tier, detail, log: res.log } });
    rows.push(ok("gate", detail, why));
    return null;
  }
  const refusedNote = again?.res.refused ? ` (flaky re-run refused: ${mainBranch} not clean)` : "";
  rows.push(
    red(
      "gate",
      `${tier} ran on ${mainBranch}: exit ${res.exit} in ${res.seconds} s${refusedNote}`,
      why,
    ),
  );
  // The flaky wording only when the re-run itself is red in listed tests alone: a different failure there is real.
  const again2 = reran
    ? flakyReds(res.log, gate.flaky, { logs: gate.flakyLogs, cwd: root, since: again.startedAt })
    : null;
  return rollBack(lane, rows, again2);
}

/** After a red gate, take the picks off main again. The intent goes to the ledger first (`step:
 *  "rolling-back"`), so a rerun after a kill finishes it: main already at preHead is the reset the
 *  killed run made. Always a stop: the gate was red. `flaky` names the listed tests a red failed in that
 *  also failed on the re-run alone: the stop says so, and does not send the builder back for it. */
export function rollBack(lane, rows, flaky = null) {
  const { root } = lane;
  const { mainBranch, branch } = lane.ledger;
  setMerge(lane, { step: "rolling-back", gateRun: undefined });
  const merge = lane.ledger.merge;
  const reset = commitOf(root, "HEAD") === merge.preHead;
  const back = reset
    ? { ok: true }
    : rollback(root, { preHead: merge.preHead, landed: merge.landed });
  save(lane, {
    ...(back.ok && { state: merge.stateBefore }),
    merge: { ...merge, step: back.ok ? "rolled-back" : "rollback-refused", at: now() },
  });
  if (!back.ok) {
    rows.push(red("rollback", back.reason));
    return {
      exit: 1,
      next: `${mainBranch} still holds the ${merge.landed.length} landed commit(s) on ${short(merge.preHead)}: run the same land again. It sets aside lifecycle writes of open lanes (one made while the gate ran, too) and gates again: green lands, red retries the rollback. Any other change it names stops it`,
    };
  }
  rows.push(ok("rollback", `${mainBranch} reset to ${short(merge.preHead)}: the picks are off it`));
  const log = lane.ledger.gates.findLast((g) => g.where === "main")?.log;
  return {
    exit: 1,
    next: flaky
      ? `${flaky.join(", ")} (listed in gate.flaky) failed again on the re-run alone, so it is not load: read ${log}, then land again once it passes alone, or fix it on ${branch}`
      : `read ${log}, fix on ${branch} (resume the builder), then land again`,
  };
}
