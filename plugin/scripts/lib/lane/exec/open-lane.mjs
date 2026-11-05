// exec/open-lane — opening a lane, for `start`, `restart` and `adopt`: the contract found and
// checked, the lane it stacks on, the worktree on `agentry/<id>`, `dispatched` written, and the ledger
// with what main and the board look like now, its first round briefed.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findContract } from "../../process/contract.mjs";
import { worktrees } from "../../process/git.mjs";
import { runId } from "../../process/ids.mjs";
import * as ledgers from "../../process/ledger.mjs";
import { proseModelHint, unusedUiModel } from "../../process/spec/models.mjs";
import { resolveWorkflow } from "../../process/spec/presets.mjs";
import { flaggedItem, gateOf, lifecycleOf } from "../../process/spec/workflow.mjs";
import {
  outsideOwns,
  ownedFiles,
  ownsTestsWithoutFile,
  relatedNotes,
  suggestBuilder,
  withNew,
} from "../brief.mjs";
import { sha256 } from "../carry-io.mjs";
import { routeText } from "../exec-view.mjs";
import { idProblem } from "../id.mjs";
import { step as advance, begin, beginAt } from "../rounds.mjs";
import { chainOf } from "../stack.mjs";
import { create, git, remove } from "../worktree.mjs";
import { ownsOverlap } from "./admission.mjs";
import { boardEvent } from "./board.mjs";
import { buildTier, dispatchNext } from "./briefs.mjs";
import { RUNNING, boardPaths, committedSpec, configPaths } from "./guard/allow.mjs";
import { headOf, mainSnapshot } from "./guard/snapshot.mjs";
import { contractFile, laneLine, now, readOr, refuse, short } from "./lane.mjs";
import { stepLines, view } from "./view.mjs";

// The lane `start --on` stacks on: resolved like an id, a lane that is verified (any next), held or at
// its gate, its own `on` allowed (a chain). `{ id, tip, state }`, the tip its branch is at now.
export function stackParent({ root, spec, model, on }, id) {
  const resolved = runId(spec, model, on);
  if (resolved.error) refuse(`--on ${on}: ${resolved.error}`);
  const y = resolved.id;
  if (y === id) refuse("--on names the task itself");
  const problem = idProblem(y);
  if (problem) refuse(`--on ${on}: ${problem}`);
  let lane;
  try {
    lane = ledgers.read(root, y);
  } catch (e) {
    refuse(e.message);
  }
  if (!lane) refuse(`no lane for ${y}: start it first (${laneLine(root, "start", y)})`);
  if (lane.state === "merged") refuse(`${y} is merged: start ${id} without --on (main holds it)`);
  if (lane.state === "building")
    refuse(`${y} is building: stack on it once it is verified, held or at its gate`);
  if (!["verified", "held"].includes(lane.state) && lane.next !== "gate")
    refuse(
      `${y} is ${lane.state} (next ${lane.next}): stack on a lane that is verified, held or at its gate`,
    );
  const tip = headOf(root, `refs/heads/${lane.branch}`);
  if (!tip) refuse(`${y}'s branch ${lane.branch} is gone: start ${id} without --on`);
  return { id: y, tip, state: lane.state };
}

// A light contract (an `exec.kinds` kind's): an Owns line naming at least one path, and a bold Acceptance
// label with text after it on its line, both outside a code fence.
const ACCEPTANCE = /\*\*acceptance:?\*\*:?[ \t]*\S/i;
const FENCE = /^\s*(```|~~~)/;
function lightContract(block, root) {
  let fenced = false;
  const lines = block.split("\n").filter((line) => {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced) return true;
    return false;
  });
  const prose = lines.join("\n");
  return ownedFiles(prose, root).length > 0 && lines.some((l) => ACCEPTANCE.test(l));
}

// The route `start` prints: with the `models.verify.ui` warning for an item a designer builds (its first
// run's step marker, its Agent bullet or a UI-shaped path) that is not flagged when the route verifies only
// flagged items (field 70).
function startRoute({ root, spec }, ledger) {
  const route = routeText(ledger.route);
  const ui =
    suggestBuilder(
      ledger.owned.map((o) => o.path),
      {
        contract: readOr(contractFile(root, ledger.id)),
        steps: ledger.steps ?? [],
        stepRun: ledger.rounds.at(-1)?.stepRun ?? null,
      },
    ).agent === "designer";
  const unused = ui && !ledger.route.flagged && unusedUiModel(spec.models, ledger.route.verify);
  return unused ? `${route} · ${unused}` : route;
}

// The contract `start` and `restart` build, found and checked: its Steps part sound, a light contract with
// its Owns and Acceptance lines.
export function contractOf({ root, spec, kind }, id) {
  const found = findContract({ root, spec, id, kind });
  if (found.status !== "found") {
    const where = found.candidates.map((c) => `  ${c.file}:${c.line}`).join("\n");
    refuse(`contract ${id}: ${found.status}${where ? `\n${where}` : ""}`);
  }
  if (found.stepsProblem) refuse(`contract ${id}: ${found.stepsProblem}`);
  if (kind !== spec.lifecycle?.kind && lifecycleOf(spec, kind) && !lightContract(found.block, root))
    refuse(
      `contract ${id} is light and needs an Owns line naming files and an Acceptance line: ${found.file}:${found.line}`,
    );
  return found;
}

export function mainBranchOf(root) {
  const mainBranch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
  if (!mainBranch) refuse("the main checkout is on a detached HEAD");
  return mainBranch;
}

// The sha256 of the process file in use as it is now (null when it cannot be read): saved beside
// `boardAtStart`, so a later start can tell the file changed while lanes run (R1d-29 N6).
function processHash({ root, processPath }) {
  try {
    return sha256(readFileSync(processPath ?? join(root, ".agentry", "process.json"), "utf8"));
  } catch {
    return null;
  }
}

// With the process file untracked, its board paths are frozen into each lane at its start: a start (or
// restart) after it changed says so, when the oldest running lane took its paths from another copy.
function frozenBoard(ctx, hash) {
  const { processRel, workflowRel } = configPaths(ctx);
  if (!processRel || !hash || committedSpec(ctx.root, processRel, workflowRel).tracked) return null;
  const running = ledgers
    .list(ctx.root)
    .filter((l) => RUNNING.includes(l.state) && typeof l.boardAtStartHash === "string")
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  if (!running.length || running[0].boardAtStartHash === hash) return null;
  const ids = running.filter((l) => l.boardAtStartHash !== hash).map((l) => l.id);
  return `! ${processRel} changed while ${ids.join(", ")} run: its board paths are frozen into this lane as they are now`;
}

// Open the lane and brief its builder: the worktree on `agentry/<id>` (from the parent's tip when stacked,
// else main's HEAD), `dispatched`, the ledger with what main and the board look like now. `again(path)`, a
// restart's or an adopt's, runs in the new worktree before the brief: `{ restarted?, carried?, adopted?,
// calls?, shown, exit }`, the archive or the adopted branch and what it carried for the ledger (an adopt's
// spike calls too), its lines for the view and its exit (1 when the carry stopped).
export function openLane(ctx, id, { found, parent, mainBranch, again = null }) {
  const { root, spec, model, cite, kind } = ctx;
  // A stacked lane is cut from its parent's tip: `base..HEAD` is its own commits only.
  const base = parent ? parent.tip : headOf(root);
  const hash = processHash(ctx);
  const frozen = frozenBoard(ctx, hash);

  let tree;
  try {
    tree = create(root, { id, base });
  } catch (e) {
    refuse(e.message);
  }
  const {
    restarted = null,
    carried = null,
    adopted = null,
    calls = [],
    rebases = null,
    rebased = null,
    carriedRounds = [],
    holds = [],
    ownedKept = null,
    startAt = null,
    shown = {},
    warnings = [],
    exit = 0,
  } = again ? again(tree.path, base) : {};
  let board;
  let moves;
  try {
    ({ board, moves } = boardEvent(ctx, "dispatched", id));
    // A verified lane's carry goes on past the build: the item is built already.
    if (rebased) {
      const built = boardEvent(ctx, "built", id);
      board = {
        writes: [...board.writes, ...built.board.writes],
        skipped: [...board.skipped, ...built.board.skipped],
      };
      moves = [...moves, ...built.moves];
    }
  } catch (e) {
    remove(root, { ...tree, force: true });
    throw e;
  }
  writeFileSync(contractFile(root, id), `${found.block.trimEnd()}\n`);
  const at = now();
  const workflow = resolveWorkflow(spec);
  const owned = ownedKept ?? withNew(tree.path, ownedFiles(found.block, tree.path));
  let ledger = {
    v: 1,
    id,
    kind,
    contract: {
      file: found.file,
      line: found.line,
      ...(found.related?.length ? { related: relatedNotes(root, found.related) } : {}),
    },
    origin: "exec",
    mainBranch,
    base,
    ...(parent && { on: parent.id }),
    worktree: tree.path,
    branch: tree.branch,
    mainAtStart: mainSnapshot(root),
    // What the guard lets through as board files when the process file is not tracked (F2a), and the
    // copy of the process file they came from.
    boardAtStart: boardPaths(spec),
    ...(hash && { boardAtStartHash: hash }),
    worktreesAtStart: worktrees(root).map((t) => t.path),
    owned,
    ...(found.steps?.length && { steps: found.steps }),
    ...(cite.length && { cite }),
    // The route is fixed here: an edit of the workflow file mid-lane changes no running lane.
    route: {
      verify: workflow.exec.verify,
      flagged: flaggedItem(spec, model, id, kind),
      preset: workflow.preset,
      noteRounds: workflow.exec.noteRounds,
      final: workflow.exec.final,
      rebase: workflow.exec.rebase,
    },
    rounds: carriedRounds,
    ...(holds.length && { holds }),
    gates: [],
    checks: {},
    usedMemories: [],
    nested: [],
    boardWrites: moves,
    startedAt: at,
    ...(restarted && { restarted }),
    ...(carried && { carried }),
    ...(adopted && { adopted }),
    ...(calls.length && { calls }),
    ...(rebases && { rebases }),
    state: "building",
    next: "build",
  };
  const outside = outsideOwns(found.block, tree.path).map(
    (path) => `! owns names a path outside the repository: ${path} (dropped)`,
  );
  const noTests = ownsTestsWithoutFile(found.block, tree.path)
    ? "! owns names tests but no test file: add the test paths (exec owns <id> --set … --apply)"
    : null;
  const chain = parent ? chainOf(ledgers.list(root), parent.id) : [];
  const overlap = [...outside, ownsOverlap(root, ledger.owned, chain), noTests, frozen, ...warnings]
    .filter(Boolean)
    .join("\n");
  const hint = proseModelHint(found.block, ledger.steps);
  // A verified lane's carry (field 94) goes on as a rebase's does: a changed carry under `rebase: "recheck"`
  // to a fresh verifier (`resolve`), any other to the gate, or the close when one is green on the tip.
  const moved = rebased
    ? advance(
        { ...ledger, state: "verified" },
        { type: "rebased", ...rebased, gate: gateOf(spec) !== null, tier: buildTier(ctx, ledger) },
      )
    : {
        ledger,
        dispatch: startAt
          ? beginAt(startAt.stepRun, startAt.from, startAt.reason).dispatch
          : begin(ledger.steps).dispatch,
      };
  ledger = dispatchNext(ctx, moved.ledger, moved.dispatch);
  ledgers.write(root, ledger);
  const res = view(ctx, ledger, {
    step: adopted ? "adopt" : restarted ? "restart" : "start",
    lead: parent
      ? {
          stack: `on ${parent.id} at ${short(base)} (${parent.id} is ${parent.state}); ${parent.id} lands first`,
        }
      : {},
    extra: {
      owned: ledger.owned,
      amend: laneLine(root, "owns", id, " --set <paths> --apply"),
      ...(ledger.steps && { steps: stepLines(ledger.steps) }),
      workflow,
      route: startRoute(ctx, ledger),
      board,
      ...(overlap && { warning: overlap }),
      ...(hint && { hint }),
      ...(moved.reason && { why: moved.reason }),
      ...shown,
    },
  });
  return exit ? { ...res, exit } : res;
}
