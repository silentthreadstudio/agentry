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
import { flagsOf, refuse, usageError } from "../../cli/help.mjs";
import { gateOf } from "../../process/spec.mjs";
import { changedSince, pickTier } from "../gate.mjs";
import { idProblem } from "../id.mjs";
import { attributionIn, mergeBaseOf } from "../land.mjs";
import { carryBackStep, giveBack, mainRow, mainStep, takeCarryStep } from "../merge/carry.mjs";
import { gateStep } from "../merge/gating.mjs";
import { FRESH, afterLand, checkNext, done, landNext, ok, red, short } from "../merge/lane.mjs";
import { check, cleanupMode, pushMode } from "../merge/modes.mjs";
import { landStep } from "../merge/picks.mjs";
import { commitStep, recordStep } from "../merge/record.mjs";
import { recoverPreview, recoverStep } from "../merge/recover.mjs";
import {
  boardRow,
  checksState,
  commitsRow,
  lastWorktreeGate,
  ledgerStep,
  pushRow,
} from "../merge/rows.mjs";
import { mainRoot } from "../worktree.mjs";

export const help = {
  usage: [
    "merge <id> [--branch <b>] --preflight [--json]",
    "merge <id> --check <skill>=pass|fail [--note <t>]",
    "merge <id> [--branch <b>] --message <board commit> [--summary <t>] [--drop-carry]",
    "merge <id> --push [--approved]",
    "merge <id> --cleanup [--discard-ignored]",
  ],
  purpose: "Land one task on main, one mode per call; each prints a step table and the next step.",
  args: { "<id>": "the task's id, as the board writes it" },
  flags: {
    "--preflight": "what landing needs; changes nothing on main",
    "--check <skill>=pass|fail":
      "record one repo check (extensions.merge.checks) on the branch tip",
    "--note <t>": "with --check: one line on why",
    "--branch <b>": "with --preflight or --message: adopt work built outside lane exec",
    "--message <board commit>": "land: pick, gate or skip, record, board commit with this message",
    "--summary <t>": "with --message: the handoff text (default: the first commit's subject)",
    "--drop-carry": "with --message: land without exec's set-aside board writes (owner's call)",
    "--push": "push main per merge.push (ask|auto|never)",
    "--approved": "with --push: the owner said yes (merge.push ask)",
    "--cleanup": "remove the task's worktree and branch",
    "--discard-ignored": "with --cleanup: also when the worktree holds ignored files",
    "--json": "with any mode: print { id, branch, main, rows, next } as one JSON object",
  },
  exits: { 0: "done, next printed", 1: "a red step stopped it", 2: "usage or refusal" },
  example: "lane merge T-4 --preflight",
};
const flags = flagsOf(help);
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
  if (words.length !== 1) return { error: "needs one task id" };
  const modes = Object.keys(MODES).filter((m) => Object.hasOwn(opts, m));
  if (modes.length !== 1) return { error: `give exactly one of ${Object.keys(MODES).join(", ")}` };
  const [mode] = modes;
  const stray = Object.keys(opts).find(
    (k) => k !== mode && k !== "--json" && !MODES[mode].includes(k),
  );
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
  // What a killed land left: the land's own board writes are its to clear, any other change on main
  // still shows in main's row; git mid-pick in the land's own leaves main's row to the land.
  const left = recoverPreview(lane);
  if (left.row) rows.push(left.row);
  const merge = lane.ledger.merge;
  rows.push(boardRow(lane));
  if (!left.skipMain) rows.push(mainRow(lane, { carry: true, ignore: left.ignore }));
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
    return usageError(`lane merge ${id}`, "--message is empty: give the board commit's message");
  const credit = attributionIn(message);
  if (credit)
    return refuse(
      `lane merge ${id}`,
      `the board commit message carries AI attribution ("${credit}"): commits carry the author only`,
    );
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
  if (parsed.error) return usageError("lane merge", parsed.error);
  const problem = idProblem(parsed.id);
  if (problem) return usageError("lane merge", problem);
  const main = mainRoot(root);
  if (!main || main !== realpathSync(root))
    return refuse(
      `lane merge ${parsed.id}`,
      `run merge from the main checkout${main ? ` (${main})` : ""}, not ${root}`,
      main ? `pass --root ${main}` : undefined,
    );
  const lane = { root, spec, model, id: parsed.id, opts: parsed.opts, ledger: null, files: [] };
  return RUN[parsed.mode](lane);
}
