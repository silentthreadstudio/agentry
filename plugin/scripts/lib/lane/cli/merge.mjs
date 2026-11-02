// lane merge <id> — land one task on main (plan R1b-5, F14): one procedure, stepped by the ledger.
//
//   merge <id> [--branch <b>] --preflight                what landing needs (adopts --branch work)
//   merge <id> --check <skill>=pass|fail [--note <t>]    record a repo check (extensions.merge.checks)
//   merge <id> [--branch <b>] --message <m> [--summary <t>] [--drop-carry]
//                                                        land → gate or skip → record → board commit
//   merge <id> --push [--approved]                       push per config merge.push (ask|auto|never)
//   merge <id> --cleanup [--discard-ignored]             the worktree and branch, found by branch
//
// `--branch` adopts work built outside exec: the ledger is created with origin "adopted". Each call
// prints a step table and the next step. Exit 0 = done, next printed; 1 = a red step stopped it (the
// row says why); 2 = usage or refusal. A call stops at its first red row and is idempotent from the
// ledger: re-running the land after a stop resumes from what the ledger says already happened.
//
// A land can be killed (a long gate outlives the host's foreground limit), so it writes what it is
// about to do to the ledger before it does it, and a rerun starts from there (`merge/recover.mjs`).
// This file parses the call and sequences the steps; each step lives in `../merge/`: the carry of
// exec's board writes (`carry`), the picks (`picks`), the gate (`gating`), the board write and commit
// (`record`), the rows the preflight shares (`rows`) and the modes after the land (`modes`).
//
// run(argv, { root, spec, model }) -> { exit, out }
import { realpathSync } from "node:fs";
import { gateOf } from "../../process/spec.mjs";
import { changedSince, pickTier } from "../gate.mjs";
import { idProblem } from "../id.mjs";
import { attributionIn, mergeBaseOf, pickInProgress } from "../land.mjs";
import { carryBackStep, giveBack, mainRow, mainStep, takeCarryStep } from "../merge/carry.mjs";
import { gateStep } from "../merge/gating.mjs";
import { FRESH, afterLand, checkNext, done, landNext, ok, red, short } from "../merge/lane.mjs";
import { check, cleanupMode, pushMode } from "../merge/modes.mjs";
import { landStep } from "../merge/picks.mjs";
import { commitStep, recordStep } from "../merge/record.mjs";
import { clearedByTheLand, recoverStep } from "../merge/recover.mjs";
import {
  boardRow,
  checksState,
  commitsRow,
  lastWorktreeGate,
  ledgerStep,
  pushRow,
} from "../merge/rows.mjs";
import { mainRoot } from "../worktree.mjs";

export const usage = [
  "merge <id> [--branch <b>] --preflight",
  "merge <id> --check <skill>=pass|fail [--note <t>]",
  "merge <id> [--branch <b>] --message <board commit> [--summary <t>] [--drop-carry]",
  "merge <id> --push [--approved]",
  "merge <id> --cleanup [--discard-ignored]",
].join("\n       ");
export const flags = {
  "--preflight": false,
  "--check": true,
  "--note": true,
  "--branch": true,
  "--message": true,
  "--summary": true,
  "--drop-carry": false,
  "--push": false,
  "--approved": false,
  "--cleanup": false,
  "--discard-ignored": false,
};
// Each mode and the options that go with it.
const MODES = {
  "--preflight": ["--branch"],
  "--check": ["--note"],
  "--message": ["--branch", "--summary", "--drop-carry"],
  "--push": ["--approved"],
  "--cleanup": ["--discard-ignored"],
};
// argv → { id, mode, opts } or { error }.
function parse(argv) {
  const words = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!Object.hasOwn(flags, arg)) {
      words.push(arg);
      continue;
    }
    if (Object.hasOwn(opts, arg)) return { error: `${arg} is given twice` };
    if (!flags[arg]) {
      opts[arg] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value` };
    opts[arg] = value;
  }
  if (words.length !== 1) return { error: `usage: ${usage}` };
  const modes = Object.keys(MODES).filter((m) => Object.hasOwn(opts, m));
  if (modes.length !== 1)
    return { error: `give exactly one of ${Object.keys(MODES).join(", ")}\nusage: ${usage}` };
  const [mode] = modes;
  const stray = Object.keys(opts).find((k) => k !== mode && !MODES[mode].includes(k));
  if (stray) return { error: `${stray} does not go with ${mode}` };
  return { id: words[0], mode, opts };
}

// --- the land and its preflight ------------------------------------------------------------------

function preflight(lane) {
  const got = ledgerStep(lane, { adopt: true });
  if (got.exit) return done(got.exit, lane, got.rows);
  const rows = [got];
  if (lane.ledger.state === "merged") {
    rows.push(ok("land", `already merged (board commit ${short(lane.ledger.merge?.boardCommit)})`));
    return done(0, lane, rows, afterLand(lane));
  }
  const cleared = clearedByTheLand(lane);
  if (cleared) rows.push(ok("recover", cleared));
  else if (pickInProgress(lane.root).length > 0)
    rows.push(red("recover", "git is in the middle of a cherry-pick that is not this land's"));
  const merge = lane.ledger.merge;
  rows.push(boardRow(lane));
  if (!cleared) rows.push(mainRow(lane, { carry: true }));
  if (merge?.carry)
    rows.push(
      ok(
        "carry",
        `exec's board writes are set aside in the ledger (${merge.carry.files.join(", ")})`,
        ["the land puts them back on main first"],
      ),
    );
  if (FRESH.includes(merge?.step)) rows.push(commitsRow(lane).row);
  else rows.push(ok("land", `a land is under way (step "${merge.step}"): the land resumes it`));
  const gate = gateOf(lane.spec);
  if (!gate) rows.push(red("gate", "the process file has no gate: merge cannot prove main"));
  else {
    const { root, ledger } = lane;
    const base = mergeBaseOf(root, ledger.mainBranch, ledger.branch);
    const changed = (base && changedSince(root, base, ledger.branch)) || [];
    const { tier, reason } = pickTier(gate, changed);
    const record = lastWorktreeGate(ledger);
    rows.push(
      ok("gate", `${tier} would run (${reason})`, [
        record
          ? `worktree gate: ${record.tier} exit ${record.exit} on ${short(record.commit)}; the land skips only when canSkip holds`
          : "no worktree gate recorded: the land runs the gate on main",
      ]),
    );
  }
  const checks = checksState(lane);
  rows.push(checks.row);
  if (checks.exit) return done(2, lane, rows);
  rows.push(pushRow(lane));
  if (rows.some((r) => r.mark === "red"))
    return done(1, lane, rows, `fix the red row(s), then lane merge ${lane.id} --preflight`);
  const next = checks.pending.length > 0 ? checkNext(lane.id, checks.pending) : landNext(lane.id);
  return done(0, lane, rows, next);
}

function land(lane) {
  const { id, opts } = lane;
  const message = opts["--message"];
  if (!message.trim())
    return { exit: 2, out: "--message is empty: give the board commit's message" };
  const credit = attributionIn(message);
  if (credit)
    return {
      exit: 2,
      out: `the board commit message carries AI attribution ("${credit}"): commits carry the author only`,
    };
  const got = ledgerStep(lane, { adopt: true });
  if (got.exit) return done(got.exit, lane, got.rows);
  const rows = [got];
  const merged = lane.ledger.merge;
  if (lane.ledger.state === "merged") {
    rows.push(
      ok("land", `already merged: ${merged.landed.map(short).join(" ")}`, [
        `board commit ${short(merged.boardCommit)}`,
      ]),
    );
    return done(0, lane, rows, afterLand(lane));
  }
  lane.gate = gateOf(lane.spec);
  if (!lane.gate) {
    rows.push(red("gate", "the process file has no gate: merge cannot prove main"));
    return done(2, lane, rows, "add a gate to the process file (/agentry:init)");
  }
  const board = boardRow(lane);
  rows.push(board);
  if (board.mark === "red") return done(2, lane, rows);
  const checks = checksState(lane);
  rows.push(checks.row);
  if (checks.exit) return done(2, lane, rows);
  if (checks.failed.length > 0)
    return done(1, lane, rows, `fix what ${checks.failed.join(", ")} found, then record it again`);
  if (checks.pending.length > 0) return done(2, lane, rows, checkNext(id, checks.pending));
  if (opts["--drop-carry"] && !merged?.carry)
    return done(2, lane, [
      ...rows,
      red("carry", "--drop-carry: the ledger holds no set-aside board writes, so nothing to drop"),
    ]);
  const steps = [
    recoverStep,
    carryBackStep,
    mainStep,
    takeCarryStep,
    landStep,
    gateStep,
    recordStep,
    commitStep,
  ];
  for (const step of steps) {
    const stop = step(lane, rows);
    if (!stop) continue;
    // At a stop, main gets exec's writes back, unless git is mid-pick or they would not go back.
    const back = stop.keepCarry ? null : giveBack(lane);
    if (back) rows.push(back);
    return done(stop.exit, lane, rows, stop.next);
  }
  return done(0, lane, rows, afterLand(lane));
}

const RUN = {
  "--preflight": preflight,
  "--check": check,
  "--message": land,
  "--push": pushMode,
  "--cleanup": cleanupMode,
};

export function run(argv, { root, spec, model }) {
  const parsed = parse(argv);
  if (parsed.error) return { exit: 2, out: parsed.error };
  const problem = idProblem(parsed.id);
  if (problem) return { exit: 2, out: problem };
  const main = mainRoot(root);
  if (!main || main !== realpathSync(root))
    return {
      exit: 2,
      out: `run merge from the main checkout${main ? ` (${main})` : ""}, not ${root}`,
    };
  const lane = { root, spec, model, id: parsed.id, opts: parsed.opts, ledger: null, files: [] };
  return RUN[parsed.mode](lane);
}
