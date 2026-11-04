// restack — a stacked lane's restack (A45), the one core `lane exec restack` and a parent's land both run:
// the guards (no agent out, no gate queued or running for the lane, a clean worktree on its branch), the
// target, the planned move written to the ledger before the rebase, the guarded rebase, and the round
// machine's record. Only the lane's branch and ledger are written; a stop leaves both byte-identical.
//
// restackLane(ctx, ledger, { toMain, byHand, dispatch }) -> { ledger, restacked, commits, reason? } | { nothing }
// restackProblem(root, ledger) -> string | null    why the lane cannot be restacked now
// markGating(root, id) -> clear()                  `exec gate`'s intent, written before it waits for the lock
// gatingNow(root, id) -> boolean                   a gate of the lane is queued or running
// RestackError { message, exit: 2 (refused, nothing changed) | 1 (git stopped: aborted), files }
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "../fs/atomic.mjs";
import * as ledgers from "../process/ledger.mjs";
import { gateOf } from "../process/spec/workflow.mjs";
import { gateLockDir, heldSlots, holderOf, running } from "./gate-lock.mjs";
import { commitOf, currentBranch } from "./land.mjs";
import { step as advance, verifiedTip } from "./rounds.mjs";
import { onTarget, rebaseOnto, restackLine, stackOf, unclean } from "./stack.mjs";
import { branchOf, git } from "./worktree.mjs";

const short = (sha) => String(sha ?? "").slice(0, 7);
const now = () => new Date().toISOString();

export class RestackError extends Error {
  constructor(message, { exit = 2, files = [] } = {}) {
    super(message);
    this.exit = exit;
    this.files = files;
  }
}
const refused = (message) => {
  throw new RestackError(message);
};

// ---- the gate's intent ----------------------------------------------------------------------------
//
// A gate queued behind the gate lock holds no slot, yet it read the lane's ledger before its wait and
// writes it back after its run: a restack in between would be undone. So `exec gate` writes this marker
// before it reads anything and clears it on any exit; a marker whose process is gone counts for nothing.

const gatingFile = (root, id) => join(root, ".agentry", "run", "process", "gating", `${id}.json`);

/** Mark a gate of lane `id` queued or running (this process); returns the call that clears the mark. */
export function markGating(root, id) {
  const file = gatingFile(root, id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: process.pid, at: now() }));
  return () => {
    if (holderOf(file)?.pid === process.pid) rmSync(file, { force: true });
  };
}

/** Is a gate of lane `id` queued or running: its mark is there and its process alive. */
export const gatingNow = (root, id) => running(holderOf(gatingFile(root, id))?.pid);

// ---- the restack ----------------------------------------------------------------------------------

/** Why a stacked lane cannot be restacked now (null when it can): only with no agent out (its gate, close
 *  or merge next, or held), with no gate of it queued or running, and its worktree clean, on its branch. */
export function restackProblem(root, ledger) {
  const { id, worktree } = ledger;
  if (["stopped", "merging", "merged", "closed"].includes(ledger.state))
    return `${id} is ${ledger.state} (next ${ledger.next}): nothing to restack`;
  if (ledger.hold?.for === "guard")
    return `${id} is held by a guard trip: run its report once main is fixed, then restack`;
  if (ledger.hold?.when === "verified") return `${id} is parked verified: resume it, then restack`;
  if (ledger.state !== "held" && !["gate", "close", "merge"].includes(ledger.next)) {
    const round = ledger.rounds.at(-1);
    return `a ${round?.role ?? "build"} round is out (round ${round?.n ?? 0}, next ${ledger.next}): restack when the lane is at its gate, close or merge, or held`;
  }
  if (gatingNow(root, id) || heldSlots(gateLockDir(root)).some((s) => s.who === `lane ${id}`))
    return `a gate for ${id} is queued or running: restack after it`;
  let left;
  try {
    left = unclean(worktree);
  } catch (e) {
    return `the worktree ${worktree} is not readable: ${e.message}`;
  }
  if (left.length)
    return `the worktree ${worktree} is not clean (${left.slice(0, 5).join(", ")}): commit or remove them, then restack`;
  if (currentBranch(worktree) !== ledger.branch)
    return `the worktree ${worktree} is not on ${ledger.branch}: check it out again, then restack`;
  return null;
}

// The range-diff of a restack resolved by hand, as a resolve check reads it: the commits the lane's checks
// stood for against the ones the branch holds now, in `logs/restack-range-diff-<n>.txt`.
function rangeDiff(root, ledger, { base, from, onto, to }) {
  const n = (ledger.restacks?.length ?? 0) + 1;
  const res = git(root, ["range-diff", "--no-color", `${base}..${from}`, `${onto}..${to}`]);
  const file = join(ledgers.runDir(root, ledger.id), "logs", `restack-range-diff-${n}.txt`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    res.status === 0 ? res.stdout : `git range-diff failed: ${res.stderr.trim()}\n`,
  );
  return file;
}

// The ledger file's bytes put back as they were (atomically), after a rebase that stopped.
const ledgerFile = (root, id) => join(root, ".agentry", "run", "process", "ledger", `${id}.json`);
const restoreBytes = (file, text) => atomicWrite(file, text);

// Rebase the lane's branch as `move` plans, the plan in the ledger first so a rerun after a kill knows
// what the rebase was (`restacking`). A stop is aborted, and the ledger's bytes are put back.
function rebaseAsPlanned(root, ledger, move, again) {
  const file = ledgerFile(root, ledger.id);
  const before = readFileSync(file, "utf8");
  ledgers.write(root, { ...ledger, restacking: { ...move, at: now() } });
  const res = rebaseOnto(ledger.worktree, { onto: move.onto, base: move.base, tip: move.from });
  if (res.ok) return;
  restoreBytes(file, before);
  const back = res.restored
    ? `${ledger.branch} is back at ${short(move.from)}`
    : `but ${ledger.branch} is not back at ${short(move.from)} with a clean tree: look at ${ledger.worktree} before anything else`;
  const files = res.files.length ? ` (${res.files.slice(0, 5).join(", ")})` : "";
  throw new RestackError(
    res.stopped
      ? `${short(res.stopped)} ${res.subject} conflicts on ${move.ontoName} at ${short(move.onto)}${files}: aborted, ${back} → resolve it in ${ledger.worktree}: git rebase --onto ${move.ontoName} ${short(move.base)}, then ${again}`
      : `the rebase onto ${move.ontoName} at ${short(move.onto)} failed (${res.reason}): aborted, ${back}`,
    { exit: 1, files: res.files },
  );
}

/**
 * Restack the stacked lane `ledger` onto its parent's new tip (`due: parent`), or main's (its parent
 * landed, or `toMain`: the owner's call, on any state of the parent). A branch already on the target
 * (moved by hand, or by a restack killed after its rebase: the ledger's `restacking` plan says what that
 * rebase was) is recorded as resolved by hand, so the resolution is checked: never a silent pass; with
 * `byHand: false` it is refused instead. `dispatch(ledger, plan)` adds the round the machine sends (the
 * resolve check); without one a restack that would send a round is refused. Throws a `RestackError`.
 */
export function restackLane(
  { root, spec },
  ledger,
  { toMain = false, byHand = true, dispatch = null } = {},
) {
  const id = ledger.id;
  const stack = stackOf(root, ledger, ledgers.list(root));
  const { on } = stack;
  if (!on) refused(`${id} is not stacked on a lane (exec start --on): nothing to restack`);
  const problem = restackProblem(root, ledger);
  if (problem) refused(problem);
  const tip = commitOf(root, `refs/heads/${ledger.branch}`);
  const again = restackLine(root, id, toMain ? " --main" : "");
  const plan = ledger.restacking;
  // A killed restack whose rebase finished: the branch moved onto the target it planned, its old base gone
  // from it (`onTarget`), so a stale plan plus a hand commit is never read as one (R1d-14 N1).
  const killed =
    plan &&
    plan.from !== tip &&
    plan.base === ledger.base &&
    onTarget(root, { onto: plan.onto, base: plan.base, tip })
      ? plan
      : null;
  let move = killed;
  if (!move) {
    if (!stack.due && !toMain)
      return { ledger, nothing: `nothing to do: ${id} is on ${on}'s tip ${short(ledger.base)}` };
    if (stack.due === "orphan" && !toMain)
      refused(
        `${on} is ${stack.state}: ${id} lands only after it, or ${restackLine(root, id, " --main")} takes it off`,
      );
    const target = toMain || stack.due !== "parent" ? "main" : "parent";
    const onto = target === "main" ? commitOf(root, `refs/heads/${ledger.mainBranch}`) : stack.tip;
    const ontoName = target === "main" ? ledger.mainBranch : branchOf(on);
    if (!onto) refused(`${ontoName} is not a branch here: nothing to restack onto`);
    const why = stack.state === "merged" ? `${on} landed` : `${on} is ${stack.state}`;
    move = { target, onto, ontoName, base: ledger.base, from: tip, why };
  }
  const hand = Boolean(killed) || onTarget(root, { onto: move.onto, base: move.base, tip });
  if (hand && !byHand)
    refused(
      `${ledger.branch} is on ${move.ontoName} already (moved by hand): ${again} records it and sends the resolution recheck`,
    );
  if (!hand) rebaseAsPlanned(root, ledger, move, again);
  const to = commitOf(root, `refs/heads/${ledger.branch}`);
  // By hand, the tip before the move is gone from the branch: a killed restack's plan names it, else the
  // tip the lane's checks stood for.
  const from = killed
    ? killed.from
    : hand
      ? (verifiedTip(ledger) ?? ledger.rounds.at(-1)?.tip ?? tip)
      : tip;
  const count = git(root, ["rev-list", "--count", `${move.onto}..${to}`]);
  const commits = count.status === 0 ? Number(count.stdout.trim()) : 0;
  let res;
  try {
    res = advance(
      { ...ledger, restacking: undefined },
      {
        type: "restack",
        from,
        to,
        base: { from: move.base, to: move.onto },
        onto: move.target,
        parent: on,
        resolution: hand ? "by hand" : "none",
        gate: gateOf(spec) !== null,
        at: now(),
        ...(hand && {
          rangeDiff: rangeDiff(root, ledger, { base: move.base, from, onto: move.onto, to }),
        }),
      },
    );
  } catch (e) {
    refused(e.message);
  }
  if (res.dispatch && !dispatch)
    refused(`${id}'s restack sends a ${res.dispatch.step} round: run ${again}`);
  const next = res.dispatch ? dispatch(res.ledger, res.dispatch) : res.ledger;
  ledgers.write(root, next);
  const where =
    move.target === "parent"
      ? `onto ${on} at ${short(move.onto)} (was ${short(move.base)})`
      : `onto main at ${short(move.onto)} without ${on}'s old commits (${move.why})`;
  return {
    ledger: next,
    commits,
    restacked: `${where}: ${commits} commit(s), ${hand ? "resolved by hand" : "no conflict"}; tip ${short(from)} → ${short(to)}`,
    ...(res.reason && { reason: res.reason }),
  };
}
