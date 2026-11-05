// lane exec <step> <id> — the exec lane's stepper: each step checks the ledger
// expects it, does the git and board work, records it and prints the next step as readable text, or with
// `--json` as one object `{ id, step, next, prompt?, brief?, reportPath, worktree, branch, guards, nested, … }`.
//
//   start <id>                cut `agentry/<id>` in a worktree, write `dispatched`, brief the builder
//   report <id> [--agent a]   read the builder's report, run the guards, brief the next round
//   verdict <id> [--agent a]  read the verifier's report, write the verdict, brief the next round;
//     [--leave N2,N9 [--by owner|conductor]]   those notes of the report are left as built (`left[]`), never
//                             counted as sent back
//   gate <id>                 run the repo's gate in the worktree and record it (exit 1 when red)
//   fix <id> --notes N1,N3    a verified lane (PASS WITH NOTES): a builder round on those notes, then recheck
//                             (at most `exec.noteRounds` of them, read live from the workflow file)
//   fix <id> --owner "<text>" a verified lane the owner sends back: a builder round on the change, then the
//                             lane's route (the gate where the route skipped the verifier, else a recheck)
//   rebase <id>               a verified lane whose branch no longer lands: its builder rebases it onto main,
//                             then a verifier reads the resolution (`exec.rebase: "recheck"`) or the gate
//   reverify <id>             a lane closed with no verifier (the route skipped it): one fresh verifier
//   close <id> [--lesson "<text>"] [--used-memories a,b]   write the lane's episode (with the lesson and
//                             the memories the run used) to the repo's memory store and stamp its id
//                             (`--episode e`, deprecated, stamps an id written elsewhere and says whether
//                             the store holds it)
//   show <id>                 the ledger and the pending step, for a cold resume (the route fixed at start, the
//                             workflow as the file says now, the notes kept open)
//   owns <id> [--set a,b]     the owned files the briefs name (parsed once at start); `--set … --apply`
//                             replaces them, `--add … --apply` appends to them (not on a verified or merged
//                             lane), and the brief waiting to be answered is rewritten
//   hold <id> --for owner|later [--agent a]   a builder's round waits for the owner's review (its reply
//                             saved), or is parked (its builder stopped); the ledger alone is written
//   resume <id> --note "<the OK>" [--redo] [--fresh|--same]   the owner's answer to a hold, then the next round
//   start <id> --on <Y>       stack the lane on Y's lane: cut from agentry/<Y>, `on` and `base` in the ledger
//   restack <id> [--main]     a stacked lane, no agent out: rebase it onto its parent's new tip, or main
//                             (its parent landed, or --main); the branch and ledger alone are written
//   restart <id> [--carry]    a lane not merged, no agent out: archive its ledger and run files as
//                             `<id>.<n>`, keep its branch as `agentry/<id>.<n>`, start it again from main;
//                             `--carry` picks its commits and applies its uncommitted diff (stops on a conflict)
//   adopt <id> --branch <b>   work built outside exec becomes the lane: `start`'s checks and records, a lane cut
//                             from main, `main..<b>` picked onto it and the uncommitted diff of <b>'s worktree
//                             applied (stops on a conflict); <b> and its worktree are left as they are
//   cut <id> --decision <D> [--keep <paths>] [--message <m>] [--apply]   retire a lane on a board decision:
//                             the kept paths land from its tip as one gated commit (`exec/cut/`), `cut` is
//                             written, the ledger closed, the worktree removed, the branch kept as `<id>.cut`
//
// Board writes go through `applyEvent` only (no `lifecycle` → none), and a restart's clear of the old
// lane's verdict through `board set`, which records it. Exit 0 = next printed, 1 = the lane stopped (or
// the gate is red), 2 = usage or refusal (nothing changed).
//
// Each step is the `run(ctx, id)` of `../exec/steps/<step>.mjs`, on one `ctx`: the caller's, the
// flags, `root`, the lane's `kind` and `value` (--agent, --episode, --notes); shared code is `../exec/`.
//
// run(argv, { root, spec, model }) -> { exit, out }
import { realpathSync } from "node:fs";
import { flagsOf, say, usageError } from "../../cli/help.mjs";
import { idProblem } from "../../id.mjs";
import { mainRoot } from "../../process/git.mjs";
import { kindOf, runId } from "../../process/ids.mjs";
import * as ledgers from "../../process/ledger.mjs";
import { WriteError } from "../../process/write.mjs";
import { humanView } from "../exec-view.mjs";
import { Refusal, Stopped } from "../exec/lane.mjs";
import * as adopt from "../exec/steps/adopt.mjs";
import * as close from "../exec/steps/close.mjs";
import * as cut from "../exec/steps/cut.mjs";
import * as fix from "../exec/steps/fix.mjs";
import * as gate from "../exec/steps/gate.mjs";
import * as hold from "../exec/steps/hold.mjs";
import * as owns from "../exec/steps/owns.mjs";
import * as rebase from "../exec/steps/rebase.mjs";
import * as report from "../exec/steps/report.mjs";
import * as restack from "../exec/steps/restack.mjs";
import * as restart from "../exec/steps/restart.mjs";
import * as resume from "../exec/steps/resume.mjs";
import * as reverify from "../exec/steps/reverify.mjs";
import * as show from "../exec/steps/show.mjs";
import * as start from "../exec/steps/start.mjs";
import * as verdict from "../exec/steps/verdict.mjs";
import { withModelSource } from "../exec/view.mjs";
import { RestackError } from "../restack.mjs";

// The steps, each `run(ctx, id)`, in the order the usage line names them.
const HANDLERS = {
  start,
  report,
  verdict,
  gate,
  fix,
  close,
  show,
  owns,
  hold,
  resume,
  rebase,
  reverify,
  restack,
  restart,
  adopt,
  cut,
};
const STEPS = Object.keys(HANDLERS);
export const help = {
  usage: `exec <${STEPS.join("|")}> <id> [--agent <agent id>] [--leave <N2,N9>] [--by <owner|conductor>] [--episode <episode id>] [--lesson <text>] [--used-memories <ids>] [--notes <N1,N3>] [--owner <text>] [--cite <A40,A41>] [--set <paths>] [--add <paths>] [--apply] [--for <owner|later>] [--evidence <path>] [--note <text>] [--redo] [--fresh] [--same] [--on <id>] [--main] [--carry] [--branch <b>] [--decision <D>] [--keep <paths>] [--message <subject>] [--json]`,
  purpose: "Step one task's build lane: worktree, briefs, rounds, gate, episode. Prints text.",
  args: {
    start: "cut agentry/<id> in a worktree, write dispatched, brief the builder",
    report: "read the builder's report, run the guards, brief the next round",
    verdict: "read the verifier's report, write the verdict, brief the next round",
    gate: "run the repo's gate in the worktree and record it",
    fix: "after PASS WITH NOTES: a builder round on the named notes, then a recheck; or the owner's change (--owner)",
    close:
      "write the lane's episode to the memory store and stamp its id (--lesson: the one thing worth remembering)",
    show: "the ledger and the pending step, for a cold resume",
    owns: "the owned files every brief names, parsed once at start (--set replaces them)",
    hold: "a builder's round waits for the owner (--for owner), or is parked (--for later)",
    resume: "the owner's answer to a hold (--note), then the next round",
    rebase:
      "a verified lane that no longer lands: its builder rebases it, then the resolution is checked",
    reverify: "a lane closed with no verifier (the route skipped it): one fresh verifier",
    restack:
      "a stacked lane at rest: rebase it onto its parent's new tip, or main once the parent landed",
    restart:
      "a lane not merged, no agent out: archive it and start it again from main (--carry its work)",
    adopt:
      "work built outside exec becomes the lane: cut from main, the branch's commits and uncommitted diff carried (--branch)",
    cut: "retire a lane on a board decision: land only the kept paths, write cut, keep its branch as <id>.cut",
    "<id>": "the task's id, any case",
  },
  flags: {
    "--agent <agent id>":
      "report and verdict: the agent that answered, so a later round resumes it; hold: the builder out on the round",
    "--leave <N2,N9>":
      "verdict: notes of this report left as built on the owner's or conductor's word; never sent back",
    "--by <owner|conductor>": "verdict --leave: whose word leaves them (default conductor)",
    "--episode <episode id>": "close, deprecated: stamp an episode id written elsewhere",
    "--lesson <text>":
      "close: the one thing worth remembering from the run, written into the episode distill reads",
    "--used-memories <ids>":
      "close: comma-separated memory ids the run used, added to the ones its reports cited",
    "--notes <N1,N3>": "fix: the verifier's notes to fix, by their labels",
    "--owner <text>": "fix: the owner's change to a verified lane, for one builder round",
    "--cite <A40,A41>":
      "start: decisions to quote in every brief, by id (rows naming the task are quoted anyway)",
    "--set <paths>": "owns: the comma-separated owned files to use from now on",
    "--add <paths>":
      "owns: comma-separated files to own as well (a lane held for context, or in needs-context)",
    "--apply":
      "owns: write the --set or --add list; cut: retire the lane (without it either is only shown)",
    "--for <owner|later>":
      "hold: the owner reviews the round (its reply saved), or later: the lane is parked",
    "--evidence <path>": "hold --for owner: what the owner opens (default: the round's report)",
    "--note <text>": "resume: the owner's words; hold --for later: why the lane is parked",
    "--redo": "resume: the owner sent the finished run back: build the same steps again",
    "--fresh": "resume: a fresh builder with the same brief (the held round's agent is gone)",
    "--same":
      "resume: the next step keeps the builder of the step before (default: a fresh builder per step)",
    "--on <id>":
      "start: stack the lane on that lane's branch (verified, held or at its gate); it lands after it",
    "--main": "restack: onto main's tip, off the parent (the owner's call)",
    "--carry":
      "restart: carry the old branch's commits and its uncommitted diff into the new worktree",
    "--branch <b>":
      "adopt: the branch built outside exec; it and its worktree are left as they are",
    "--decision <D>": "cut: the board decision the cut follows, by id",
    "--keep <paths>":
      "cut: comma-separated files or folders the branch changes, landed on main from its tip",
    "--message <subject>":
      "cut --keep: the kept commit's message (default chore(<scope>): keep <n> files from <id>)",
    "--json": "print the step's one JSON object instead of the readable text",
  },
  exits: { 0: "next printed", 1: "the lane stopped, or the gate is red", 2: "usage or refusal" },
  example: "lane exec owns T-4 --set src/a.ts,src/a.test.ts --apply",
};
const flags = flagsOf(help);
const STEPS_OF = {
  "--agent": ["report", "verdict", "hold"],
  "--leave": ["verdict"],
  "--by": ["verdict"],
  "--episode": ["close"],
  "--lesson": ["close"],
  "--used-memories": ["close"],
  "--notes": ["fix"],
  "--owner": ["fix"],
  "--cite": ["start"],
  "--set": ["owns"],
  "--add": ["owns"],
  "--apply": ["owns", "cut"],
  "--for": ["hold"],
  "--evidence": ["hold"],
  "--note": ["hold", "resume"],
  "--redo": ["resume"],
  "--fresh": ["resume"],
  "--same": ["resume"],
  "--on": ["start"],
  "--main": ["restack"],
  "--carry": ["restart"],
  "--branch": ["adopt"],
  "--decision": ["cut"],
  "--keep": ["cut"],
  "--message": ["cut"],
};

// argv → { step, id, value, set, leave, by, add, cite, apply, json, holdFor, evidence, note, owner, redo, fresh, same, on, toMain,
// carry, branch, decision, keep, message, lesson, usedMemories } or { error }.
// `value` is the --agent / --episode / --notes value.
function parse(argv) {
  const words = [];
  const given = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!Object.hasOwn(flags, flag)) {
      words.push(flag);
      continue;
    }
    if (Object.hasOwn(given, flag)) return { error: `${flag} is given twice` };
    given[flag] = true;
    if (flags[flag]) {
      given[flag] = argv[++i];
      if (given[flag] === undefined || given[flag].startsWith("--"))
        return { error: `${flag} needs a value` };
    }
  }
  const [step, id, ...rest] = words;
  if (!STEPS.includes(step) || !id || rest.length)
    return { error: `needs <${STEPS.join("|")}> <id>` };
  for (const flag of Object.keys(given))
    if (flag !== "--json" && !STEPS_OF[flag].includes(step))
      return { error: flag === "--on" ? "--on goes with start only" : `${step} takes no ${flag}` };
  if (step === "fix" && (given["--notes"] === undefined) === (given["--owner"] === undefined))
    return { error: 'fix needs --notes N1,N3 or --owner "<the change>", one of them' };
  if (step === "adopt" && given["--branch"] === undefined)
    return { error: "adopt needs --branch <b>: the branch built outside exec" };
  if (given["--same"] && given["--fresh"])
    return { error: "resume takes --same or --fresh, not both" };
  if (given["--by"] !== undefined && given["--leave"] === undefined)
    return { error: "--by goes with --leave" };
  if (given["--by"] !== undefined && !["owner", "conductor"].includes(given["--by"]))
    return { error: `--by takes owner or conductor, not "${given["--by"]}"` };
  if (given["--set"] !== undefined && given["--add"] !== undefined)
    return { error: "owns takes --set or --add, not both" };
  if (step === "cut" && given["--decision"] === undefined)
    return { error: "cut needs --decision <D>: the board decision it follows" };
  if (
    given["--episode"] !== undefined &&
    (given["--lesson"] !== undefined || given["--used-memories"] !== undefined)
  )
    return {
      error:
        "--lesson and --used-memories go with the close that writes the episode, not --episode",
    };
  if (given["--lesson"] !== undefined && !given["--lesson"].trim())
    return { error: "--lesson needs the lesson's text" };
  const usedMemories = (given["--used-memories"] ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (given["--used-memories"] !== undefined && !usedMemories.length)
    return { error: "--used-memories needs comma-separated memory ids" };
  if (given["--message"] !== undefined && given["--keep"] === undefined)
    return { error: "--message names the kept commit: it goes with --keep" };
  if (
    step === "owns" &&
    given["--apply"] &&
    given["--set"] === undefined &&
    given["--add"] === undefined
  )
    return { error: "--apply writes the --set list: give --set <paths> (or --add <paths>)" };
  return {
    step,
    id,
    value: given["--agent"] ?? given["--episode"] ?? given["--notes"] ?? null,
    set: given["--set"] ?? null,
    leave: given["--leave"] ?? null,
    by: given["--by"] ?? "conductor",
    add: given["--add"] ?? null,
    cite: given["--cite"]?.split(",").map((c) => c.trim()) ?? [],
    apply: Boolean(given["--apply"]),
    json: Boolean(given["--json"]),
    holdFor: given["--for"] ?? null,
    evidence: given["--evidence"] ?? null,
    note: given["--note"] ?? null,
    owner: given["--owner"] ?? null,
    redo: Boolean(given["--redo"]),
    fresh: Boolean(given["--fresh"]),
    same: Boolean(given["--same"]),
    on: given["--on"] ?? null,
    toMain: Boolean(given["--main"]),
    carry: Boolean(given["--carry"]),
    branch: given["--branch"] ?? null,
    decision: given["--decision"] ?? null,
    keep: given["--keep"] ?? null,
    message: given["--message"] ?? null,
    lesson: given["--lesson"]?.trim() ?? null,
    usedMemories,
  };
}

export function run(argv, ctx) {
  const { step, id: typed, value, json, error, ...given } = parse(argv);
  if (error) return usageError("lane exec", error);
  const resolved = runId(ctx.spec, ctx.model, typed);
  if (resolved.error) return { exit: 2, out: say(`lane exec ${step} ${typed}`, resolved.error) };
  const { id } = resolved;
  const what = `lane exec ${step} ${id}`;
  const problem = idProblem(id);
  if (problem) return usageError("lane exec", problem);
  const root = realpathSync(ctx.root);
  const main = mainRoot(root);
  if (!main || realpathSync(main) !== root)
    return {
      exit: 2,
      out: say(what, `runs from the main checkout: pass --root ${main ?? "<the repository>"}`),
    };
  // The lane's kind: its ledger's (the lifecycle's for a ledger from before kinds), else the id's.
  let lane = null;
  try {
    lane = ledgers.read(root, id);
  } catch {} // the step itself refuses an unreadable ledger
  const kind = lane ? kindOf(lane, ctx.spec) : resolved.kind;
  try {
    const res = HANDLERS[step].run({ ...ctx, root, kind, ...given, value }, id);
    return json ? res : { ...res, out: humanView(withModelSource(JSON.parse(res.out))) };
  } catch (e) {
    if (e instanceof Refusal || e instanceof WriteError)
      return { exit: 2, out: say(what, e.message) };
    if (e instanceof Stopped || e instanceof RestackError)
      return { exit: e.exit ?? 1, out: say(what, e.message) };
    throw e;
  }
}
