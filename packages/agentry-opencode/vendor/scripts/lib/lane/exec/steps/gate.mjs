// exec/steps/gate — `lane exec gate <id>`: the repo's gate run in the worktree under the gate lock, and
// recorded.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as ledgers from "../../../process/ledger.mjs";
import { gateOf } from "../../../process/spec/workflow.mjs";
import { now, short } from "../../fmt.mjs";
import { gateLockDir, holdGate } from "../../gate-lock.mjs";
import { flakyReds, runGate } from "../../gate.mjs";
import { markGating } from "../../restack.mjs";
import { expects, gateTally } from "../../rounds.mjs";
import { gateRefusal, stackOf } from "../../stack.mjs";
import { laneTier, refreshBrief } from "../briefs.mjs";
import { headOf } from "../guard/snapshot.mjs";
import { Stopped, laneLine, mustLedger, refuse, stepWith } from "../lane.mjs";
import { view } from "../view.mjs";

// Gates queue behind the lock (`gate.concurrency` slots, in the main checkout's run directory); a flaky
// re-run holds every slot, so it runs alone. The gate's intent is marked before it reads the ledger and
// cleared on any exit, so a restack waits for a gate that is only queued (`restack.mjs`).
export function run(ctx, id) {
  const clear = markGating(ctx.root, id);
  try {
    return gateOnce(ctx, id);
  } finally {
    clear();
  }
}

// What moved in the lane while its gate ran (`was` the ledger it read, `ran` its run): its base, its restacks
// or its branch's tip; empty when nothing did.
function movedUnder(root, was, ran) {
  const now = mustLedger(root, was.id);
  const tip = headOf(root, `refs/heads/${was.branch}`);
  const count = (l) => l.restacks?.length ?? 0;
  return [
    now.base !== was.base && `base ${short(was.base)} → ${short(now.base)}`,
    count(now) !== count(was) && `restacks ${count(was)} → ${count(now)}`,
    tip !== ran.commit && `${was.branch} ${short(ran.commit)} → ${short(tip)}`,
  ].filter(Boolean);
}

function gateOnce(ctx, id) {
  const { root, spec } = ctx;
  let ledger = mustLedger(root, id);
  if (ledger.state === "stopped" || ledger.next === "merge")
    refuse(`the lane is ${ledger.state} (next ${ledger.next}): no gate to run`);
  // A held lane waits for its answer: a gate run now would be recorded and decide nothing. A guard hold is
  // answered by its report, any other by the resume.
  if (ledger.state === "held")
    refuse(
      ledger.hold?.for === "guard"
        ? `${id} is held by a guard trip: run its report once main is fixed`
        : `${id} is held (${ledger.hold?.for}): resume it first`,
    );
  const config = gateOf(spec);
  if (!config) refuse("the workflow file has no gate: add one (/agentry:init) to run it here");
  // A stacked lane whose parent moved, landed or ended is restacked first: a gate on this tip would not count.
  const due = gateRefusal(root, ledger, stackOf(root, ledger, ledgers.list(root)));
  if (due) refuse(due);
  // While a verifier is out the gate runs the verify role's tier; else the build role's.
  const role = expects(ledger) === "verdict" ? "verify" : "build";
  const tier = laneTier(ctx, ledger, config, role);
  if (!tier.tier)
    refuse(
      `${tier.reason}: the verifier reads the recorded gate; the lane runs the build tier after the verdict`,
    );
  const { command } = tier;
  const lockDir = gateLockDir(root);
  let runs = ledger.gates?.length ?? 0;
  let startedAt = 0;
  const once = (exclusive) => {
    // The log exists before the wait, so a queued gate says so there (a gate that is waiting is not hung).
    // A number no log holds yet: a killed gate is not in the ledger, and its log must not be written into.
    let logFile;
    do logFile = join(ledgers.runDir(root, id), "logs", `gate-${++runs}.log`);
    while (existsSync(logFile));
    const held = holdGate(lockDir, {
      slots: config.concurrency,
      exclusive,
      who: `lane ${id}`,
      log: logFile,
    });
    if (held.busy)
      refuse(
        `another gate holds the gate lock (${held.busy.who || "unknown"}, pid ${held.busy.pid ?? "?"}) at ${held.busy.file} and did not end within an hour: run this step again when it has, or delete that file if nothing holds it`,
      );
    try {
      startedAt = Date.now();
      const res = runGate(ledger.worktree, command, { tier: tier.tier, logFile });
      // A refused run wrote nothing but the wait: the next run starts that number's log afresh.
      if (res.refused) {
        rmSync(logFile, { force: true });
        runs--;
      }
      return res;
    } finally {
      held.release();
    }
  };
  const first = once(false);
  if (first.refused)
    refuse(
      `the worktree is not clean, so the gate did not run: ${first.files.slice(0, 10).join(", ")}`,
    );
  // A red that failed only in listed flaky tests, on a clean tree, is re-run once, alone.
  const flaky =
    first.exit !== 0 && first.cleanAfter
      ? flakyReds(first.log, config.flaky, {
          logs: config.flakyLogs,
          cwd: ledger.worktree,
          since: startedAt,
        })
      : null;
  const again = flaky ? once(true) : null;
  const reran = again && !again.refused;
  const ran = reran ? again : first;
  // The ledger read before the wait must still be the lane's: else writing it back would undo what moved.
  const moved = movedUnder(root, ledger, ran);
  if (moved.length)
    throw new Stopped(
      `${id} moved while its gate ran (${moved.join("; ")}): the gate's record is not written → ${laneLine(root, "gate", id)}`,
    );
  const records = [
    {
      where: "worktree",
      role,
      ...first,
      command,
      ...(reran && { flakyRed: flaky }),
      why: tier.reason,
      at: now(),
    },
    ...(reran
      ? [{ where: "worktree", role, ...again, command, rerun: true, why: tier.reason, at: now() }]
      : []),
  ];
  let res = { ledger };
  for (const record of records) res = stepWith(res.ledger, { type: "gate", record });
  ledger = res.ledger;
  ledgers.write(root, ledger);
  // Any run, green or red, changes what the waiting verifier's brief says about the gate.
  const refreshed = expects(ledger) === "verdict" ? refreshBrief(ctx, ledger) : null;
  const shown = view(ctx, ledger, {
    step: "gate",
    extra: {
      ...(refreshed && { briefUpdated: refreshed }),
      gate: {
        exit: ran.exit,
        role,
        tier: ran.tier,
        why: tier.reason,
        commit: short(ran.commit),
        seconds: ran.seconds,
        log: ran.log,
        ...(reran && { flaky, runs: records.length }),
      },
      gates: gateTally(ledger.gates, ran.commit).text,
      ...(res.reason && { why: res.reason }),
    },
  });
  return { ...shown, exit: ran.exit === 0 ? shown.exit : 1 };
}
