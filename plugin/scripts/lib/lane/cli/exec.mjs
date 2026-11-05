// lane exec <step> <id> — the exec lane's stepper (plan R1b §3.2, ADR-R1): each step checks the ledger
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
//   close <id> [--episode e]  print the episode payload; `--episode` stamps the id episode_write gave
//                             (and says whether the memory store holds it)
//   show <id>                 the ledger and the pending step, for a cold resume (the route fixed at start, the
//                             workflow as the file says now, the notes kept open)
//   owns <id> [--set a,b]     the owned files the briefs name (parsed once at start); `--set … --apply`
//                             replaces them, `--add … --apply` appends to them (not on a verified or merged
//                             lane), and the brief waiting to be answered is rewritten
//   hold <id> --for owner|later [--agent a]   a builder's round waits for the owner's review (its reply
//                             saved), or is parked (its builder stopped); the ledger alone is written
//   resume <id> --note "<the OK>" [--redo] [--fresh|--same]   the owner's answer to a hold, then the next round
//   start <id> --on <Y>       stack the lane on Y's lane (A45): cut from agentry/<Y>, `on` and `base` in the ledger
//   restack <id> [--main]     a stacked lane, no agent out: rebase it onto its parent's new tip, or main
//                             (its parent landed, or --main); the branch and ledger alone are written
//   restart <id> [--carry]    a lane not merged, no agent out: archive its ledger and run files as
//                             `<id>.<n>`, keep its branch as `agentry/<id>.<n>`, start it again from main;
//                             `--carry` picks its commits and applies its uncommitted diff (stops on a conflict)
//   adopt <id> --branch <b>   work built outside exec becomes the lane: `start`'s checks and records, a lane cut
//                             from main, `main..<b>` picked onto it and the uncommitted diff of <b>'s worktree
//                             applied (stops on a conflict); <b> and its worktree are left as they are
//   cut <id> --decision <D> [--keep <paths>] [--message <m>] [--apply]   retire a lane on a board decision:
//                             the kept paths land from its tip as one gated commit (`cut.mjs`), `cut` is
//                             written, the ledger closed, the worktree removed, the branch kept as `<id>.cut`
//
// Board writes go through `applyEvent` only (no `lifecycle` → none), and a restart's clear of the old
// lane's verdict through `board set`, which records it. Exit 0 = next printed, 1 = the lane stopped (or
// the gate is red), 2 = usage or refusal (nothing changed).
//
// run(argv, { root, spec, model }) -> { exit, out }
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PREVIEW, flagsOf, say, usageError } from "../../cli/help.mjs";
import { episodeStored } from "../../memory/episodes.mjs";
import { run as boardSet } from "../../process/cli/set.mjs";
import { branchTips } from "../../process/git.mjs";
import { kindOf, runId } from "../../process/ids.mjs";
import * as ledgers from "../../process/ledger.mjs";
import { applyEvent } from "../../process/lifecycle.mjs";
import { idleMinutes, resolveWorkflow } from "../../process/spec/presets.mjs";
import { own } from "../../process/spec/shape.mjs";
import { gateOf, lifecycleOf } from "../../process/spec/workflow.mjs";
import { runText } from "../../process/steps.mjs";
import { WriteError } from "../../process/write.mjs";
import { cleanupSteps, pickOnto, resolveBranch, shellWord, source } from "../adopt.mjs";
import { appendedAfter, ownedFiles, unknownCites, withNew } from "../brief.mjs";
import { cutLane } from "../cut.mjs";
import { answerLabel, humanView, restackText, routeFixedText } from "../exec-view.mjs";
import { nestedTrees, refuseAtWriterCap, refuseLane, refuseMidLand } from "../exec/admission.mjs";
import { boardEvent, writeBuilt } from "../exec/board.mjs";
import { brief, buildTier, dispatchNext, laneTier, refreshBrief } from "../exec/briefs.mjs";
import {
  archivedPath,
  carriedVerdicts,
  carriesVerified,
  carryCheck,
  keptOwned,
  lastReport,
  progressOf,
} from "../exec/carried.mjs";
import { episodeOf } from "../exec/episode.mjs";
import { ownsPath } from "../exec/guard/allow.mjs";
import { mainGuard, mainTouched } from "../exec/guard/main-guard.mjs";
import { headOf, ownStart } from "../exec/guard/snapshot.mjs";
import {
  Refusal,
  Stopped,
  contractFile,
  heldCopy,
  isFile,
  isFlagged,
  isVerifiedPark,
  laneLine,
  leaves,
  mustLedger,
  normalised,
  now,
  ownedOf,
  readReport,
  refuse,
  saved,
  short,
  stepWith,
} from "../exec/lane.mjs";
import {
  coveredBy,
  leftNotes,
  liveNotes,
  notesOf,
  onlyFixCommits,
  openNotesOf,
  sentBack,
  withOpen,
} from "../exec/notes.mjs";
import { contractOf, mainBranchOf, openLane, stackParent } from "../exec/open-lane.mjs";
import { finishRebase, rebasing } from "../exec/rebasing.mjs";
import {
  answerOf,
  routeNow,
  stepCount,
  stepLines,
  view,
  waysOn,
  withModelSource,
} from "../exec/view.mjs";
import { gateLockDir, holdGate } from "../gate-lock.mjs";
import { flakyReds, runGate } from "../gate.mjs";
import { idProblem } from "../id.mjs";
import { idleOf } from "../idle.mjs";
import { isAncestor } from "../land.mjs";
import { builderStatus, summaryOf, unwrap, usedMemories, verdictOf } from "../report.mjs";
import { RestackError, gatingNow, markGating, restackLane } from "../restack.mjs";
import {
  archive,
  archiveNumber,
  carry,
  carryRange,
  leftover,
  retire,
  saveWork,
} from "../restart.mjs";
import {
  PASSES,
  expects,
  gateTally,
  notesBudget,
  redoRefusal,
  routeOf,
  skipsVerifier,
  verdicts,
} from "../rounds.mjs";
import { setSpikeCalls } from "../spikes.mjs";
import { childrenOf, gateRefusal, restackLine, stackOf } from "../stack.mjs";
import { brokenIn, rulesOf } from "../subjects.mjs";
import { branchOf, git, mainRoot, porcelain, remove } from "../worktree.mjs";

const STEPS = [
  "start",
  "report",
  "verdict",
  "gate",
  "fix",
  "close",
  "show",
  "owns",
  "hold",
  "resume",
  "rebase",
  "reverify",
  "restack",
  "restart",
  "adopt",
  "cut",
];
export const help = {
  usage: `exec <${STEPS.join("|")}> <id> [--agent <agent id>] [--leave <N2,N9>] [--by <owner|conductor>] [--episode <episode id>] [--notes <N1,N3>] [--owner <text>] [--cite <A40,A41>] [--set <paths>] [--add <paths>] [--apply] [--for <owner|later>] [--evidence <path>] [--note <text>] [--redo] [--fresh] [--same] [--on <id>] [--main] [--carry] [--branch <b>] [--decision <D>] [--keep <paths>] [--message <subject>] [--json]`,
  purpose: "Step one task's build lane: worktree, briefs, rounds, gate, episode. Prints text.",
  args: {
    start: "cut agentry/<id> in a worktree, write dispatched, brief the builder",
    report: "read the builder's report, run the guards, brief the next round",
    verdict: "read the verifier's report, write the verdict, brief the next round",
    gate: "run the repo's gate in the worktree and record it",
    fix: "after PASS WITH NOTES: a builder round on the named notes, then a recheck; or the owner's change (--owner)",
    close: "print the episode payload (--episode stamps the id episode_write gave)",
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
    "--episode <episode id>": "close: the id episode_write returned",
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
// carry, branch, decision, keep, message } or { error }.
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
    const res = HANDLERS[step]({ ...ctx, root, kind, ...given }, id, value);
    return json ? res : { ...res, out: humanView(withModelSource(JSON.parse(res.out))) };
  } catch (e) {
    if (e instanceof Refusal || e instanceof WriteError)
      return { exit: 2, out: say(what, e.message) };
    if (e instanceof Stopped || e instanceof RestackError)
      return { exit: e.exit ?? 1, out: say(what, e.message) };
    throw e;
  }
}

// The outside cause a `BLOCKED: external: <reason>` report names, read on the status line builderStatus
// matched (the first of the first 5 lines that holds a status), or undefined: any other BLOCKED is a
// code problem and stops the lane.
function externalBlock(text) {
  const lines = unwrap(text)
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 5);
  const line = lines.find((l) => builderStatus(l) !== null);
  if (builderStatus(line) !== "BLOCKED") return undefined;
  const m =
    /^[\s>#*`_-]*(?:[Ss]tatus\s*:\s*)?[*`]*BLOCKED[*`]*\s*:\s*[*`]*external[*`]*\s*:\s*(.+?)[\s*`_]*$/.exec(
      line,
    );
  return m ? (m[1].length > 120 ? `${m[1].slice(0, 119)}…` : m[1]) : undefined;
}

function start(ctx, id) {
  const { root, spec, model, cite } = ctx;
  const unknown = unknownCites({ spec, model, cite });
  if (unknown.length) refuse(`--cite names no decision on the board: ${unknown.join(", ")}`);
  refuseLane(root, id);
  refuseMidLand(root);
  const parent = ctx.on === null ? null : stackParent(ctx, id);
  refuseAtWriterCap(root, spec);
  const found = contractOf(ctx, id);
  return openLane(ctx, id, { found, parent, mainBranch: mainBranchOf(root) });
}

// The owned files the briefs name. `--set a,b` replaces them and `--add a,b` appends the ones not owned yet
// (shown until `--apply`); on apply the brief waiting to be answered is rewritten, so the agent reads the
// amended list. `--add` is for a lane still building: a builder that asked for a file it does not own.
function owns(ctx, id) {
  const { root, set, add, apply } = ctx;
  let ledger = mustLedger(root, id);
  const shown = (extra = {}) => ({
    exit: 0,
    out: JSON.stringify(
      { id, step: "owns", next: ledger.next, state: ledger.state, owned: ledger.owned, ...extra },
      null,
      2,
    ),
  });
  if (set === null && add === null) {
    ledger.owned = ownedOf(root, ledger);
    return shown({ amend: laneLine(root, "owns", id, " --set <paths> --apply") });
  }
  const flag = set === null ? "--add" : "--set";
  const paths = [...new Set((set ?? add).split(",").map((p) => p.trim()))];
  const bad = paths.find((p) => !p || /\s/.test(p));
  if (bad !== undefined) refuse(`${flag} takes comma-separated paths, no blanks: "${bad}"`);
  const outside = paths.find((p) => leaves(normalised(p)));
  if (outside !== undefined) refuse(`${flag}: ${outside} leaves the repository`);
  const already = [];
  if (set !== null)
    ledger = { ...ledger, owned: withNew(ledger.worktree, [...new Set(paths.map(normalised))]) };
  else {
    // Past a passing verdict: verified, landing or landed, parked verified, held at its notes cap, or on
    // to its gate (the last verdict passed and no builder round came after it).
    const capped = ledger.hold?.when === "verdict";
    const verdict = verdicts(ledger).at(-1);
    const passed =
      PASSES.includes(verdict?.verdict) &&
      !ledger.rounds.some((r) => r.role === "build" && r.n > verdict.n);
    const verified =
      ["verified", "merging", "merged"].includes(ledger.state) ||
      isVerifiedPark(ledger) ||
      capped ||
      passed;
    const where = capped
      ? "held at its notes cap"
      : passed && ledger.state === "verifying"
        ? `past a passing verdict (${verdict.verdict})`
        : ledger.state;
    if (verified)
      refuse(
        `owns --add is for a lane still building: ${id} is ${where} (next ${ledger.next}); a change now is the owner's (${laneLine(root, "fix", id, ' --owner "<the change>"')})`,
      );
    // Each path as `start` reads it (a bare name found in the tree), normalised, kept only when no owned
    // entry covers it yet: the guard's own reading (a directory, a glob, a bare name).
    const owned = [...ownedOf(root, ledger)];
    const before = owned.length;
    const covered = (path) => owned.some((e) => ownsPath(e.path, path));
    for (const given of paths) {
      const path = normalised(given);
      const fresh = covered(path)
        ? []
        : withNew(ledger.worktree, [path]).filter((o) => !covered(o.path));
      if (fresh.length) owned.push(...fresh);
      else already.push(given);
    }
    ledger = { ...ledger, owned };
    if (owned.length === before)
      return shown({ applied: false, unchanged: `already owned: ${already.join(", ")}` });
  }
  const said = already.length ? { "already owned": already.join(", ") } : {};
  if (!apply) return shown({ applied: false, ...said, preview: PREVIEW });
  const round = ledger.rounds.at(-1);
  // A held lane has no brief waiting: the round after the resume reads the new list.
  const waiting = round && ledger.state !== "held" && expects(ledger);
  ledgers.write(root, ledger);
  if (waiting) {
    // The brief is rendered again from its template: a section the conductor appended to it (the fact a
    // needs-context round asks for) goes back at the end.
    const old = readFileSync(round.brief, "utf8");
    brief(ctx, { ...ledger, rounds: ledger.rounds.slice(0, -1) }, round);
    const kept = appendedAfter(old, readFileSync(round.brief, "utf8"));
    if (kept) appendFileSync(round.brief, kept);
  }
  return shown({ applied: true, ...said, ...(waiting && { rewrote: round.brief }) });
}

// The commits past `base` on the branch that break the workflow file's `commits` rules. A read that fails
// is one broken entry (`failed`), never "nothing breaks a rule": the rev-list as `<base>..<tip>`, a
// `git show` that failed as the range it was reading.
function subjectsOf(root, spec, base, branch) {
  if (!rulesOf(spec)) return [];
  const range = `${short(base)}..${short(headOf(root, branch))}`;
  const listed = git(root, ["rev-list", "--reverse", `${base}..${branch}`, "--"]);
  if (listed.status !== 0)
    return [
      {
        sha: range,
        subject: "",
        why: `git rev-list failed: ${listed.stderr.trim().split("\n", 1)[0]}`,
        failed: true,
      },
    ];
  return brokenIn(root, spec, listed.stdout.split("\n").filter(Boolean)).map((c) =>
    c.why.startsWith("git show failed") ? { ...c, sha: c.sha || range, failed: true } : c,
  );
}

function report(ctx, id, agent) {
  const { root } = ctx;
  const ledger = mustLedger(root, id);
  // A lane a guard trip holds takes a report again: it reads the saved one (field 75).
  const parked = ledger.state === "held" && ledger.hold?.for === "guard";
  if (!parked && expects(ledger) !== "report")
    refuse(
      `the lane expects ${expects(ledger) ?? "nothing"} now, not a report (next is ${ledger.next})`,
    );
  const round = ledger.rounds.at(-1);
  const saved = parked ? ledger.hold.report : heldCopy(round.reportPath);
  const text = readReport(parked ? saved : round.reportPath, "builder");
  const all = ledgers.list(root);
  const isRebase = round.step === "rebase";
  if (isRebase && rebasing(ledger.worktree))
    refuse(
      `a rebase is still in progress in the worktree ${ledger.worktree}: finish it (git rebase --continue) or abort it, then report again`,
    );
  let dirty;
  try {
    dirty = porcelain(ledger.worktree);
  } catch (e) {
    refuse(`the worktree ${ledger.worktree} is not readable: ${e.message}`);
  }
  const tip = headOf(root, ledger.branch);
  // A rebase moves the base: the guards count from the new one.
  const before = structuredClone(ledger);
  const changed = isRebase ? finishRebase(root, before, tip) : undefined;
  // From the new base after a rebase: the lane's own changes are the files main may not touch.
  const main = mainGuard(ctx, before, all);
  // The lane's own commits: from its moved start when the branch holds main, never main's own.
  const start = ownStart(root, before);
  const count = git(root, ["rev-list", "--count", `${start}..${ledger.branch}`]);
  const guards = {
    mainTouched: main.touched,
    dirty,
    commits: count.status === 0 ? Number(count.stdout.trim()) : 0,
    subjects: subjectsOf(root, ctx.spec, start, ledger.branch),
  };
  const flagged = isFlagged(ctx, ledger);
  const res = stepWith(before, {
    type: "report",
    status: builderStatus(text),
    blocked: externalBlock(text),
    report: round.reportPath,
    agent,
    summary: summaryOf(text),
    guards,
    skipVerify: skipsVerifier(ledger.route, flagged),
    tip,
    gate: gateOf(ctx.spec) !== null,
    tier: buildTier(ctx, before),
    ...(isRebase && { changed }),
    saved,
    at: now(),
  });
  let next = res.ledger;
  if (next.hold?.for === "guard" && !parked) writeFileSync(saved, text);
  if (ledger.route) next.route = { ...ledger.route, flagged };
  next.usedMemories = [...new Set([...(next.usedMemories ?? []), ...usedMemories(text)])];
  next.nested = nestedTrees(root, next);
  // A rebase builds nothing new: built was written when the work was first checked.
  const board = isRebase ? null : writeBuilt(ctx, next, res);
  next = dispatchNext(ctx, next, res.dispatch);
  ledgers.write(root, next);
  const allowed = main.allowed.length
    ? [
        `main moved by allowed commits: ${main.allowed.length} (${main.allowed.map(short).join(", ")})`,
      ]
    : [];
  return view(ctx, next, {
    step: "report",
    guards: [...(next.rounds.at(res.dispatch ? -2 : -1).guards ?? []), ...allowed],
    nested: next.nested,
    extra: { ...(res.reason && { why: res.reason }), ...(board && { board }) },
  });
}

function verdict(ctx, id, agent) {
  const { root, spec } = ctx;
  const ledger = mustLedger(root, id);
  if (expects(ledger) !== "verdict")
    refuse(
      `the lane expects ${expects(ledger) ?? "nothing"} now, not a verdict (next is ${ledger.next})`,
    );
  const round = ledger.rounds.at(-1);
  const text = readReport(round.reportPath, "verifier");
  const left = leftNotes(ctx, text, round);
  const tip = headOf(root, ledger.branch);
  // A recheck's facts, pinned on its round: every note sent back passed, and the tip moved only by fix
  // commits since the last verdict.
  const facts =
    round.step === "recheck"
      ? {
          covered: coveredBy(text, sentBack(ledger)),
          onlyFixCommits: onlyFixCommits(root, verdicts(ledger).at(-1)?.tip, tip),
        }
      : {};
  // The notes this verdict would leave open: a flagged item at the notes cap holds on them (field 84).
  const opened = round.step === "resolve" ? [] : openNotesOf(text, round, ledger.openNotes);
  const res = stepWith(ledger, {
    type: "verdict",
    verdict: verdictOf(text),
    report: round.reportPath,
    agent,
    summary: summaryOf(text),
    tip,
    gate: gateOf(spec) !== null,
    tier: buildTier(ctx, ledger),
    flagged: isFlagged(ctx, ledger),
    openNotes: opened.length,
    noteRounds: liveNotes(ctx),
    at: now(),
    ...facts,
  });
  let next = res.ledger;
  if (left.length) next.left = [...(next.left ?? []), ...left];
  next.usedMemories = [...new Set([...(next.usedMemories ?? []), ...usedMemories(text)])];
  next.nested = nestedTrees(root, next);
  const judged = next.rounds.at(-1);
  const counted = judged.verdict && !judged.void;
  const resolveCheck = judged.step === "resolve";
  // The notes a verdict that lets the lane go on leaves open; a resolve check's are about the resolution.
  const notes = { line: null };
  const capped = next.hold?.when === "verdict";
  if (counted && !resolveCheck && (["gate", "close"].includes(next.next) || capped)) {
    const open = openNotesOf(text, judged, next.openNotes);
    if (open.length) next.openNotes = open;
    else next.openNotes = undefined;
    if (judged.verdict === "PASS WITH NOTES") {
      const kept = new Set(left.map((l) => l.label));
      const labels = openNotesOf(text, judged)
        .map((n) => n.split(" ", 1)[0])
        .filter((label) => !kept.has(label));
      const { used, max } = notesBudget(next, liveNotes(ctx));
      notes.line =
        used < max && labels.length
          ? `${laneLine(root, "fix", id)} --notes ${labels.join(",")}`
          : `notes kept open (exec.noteRounds is ${max})`;
    }
  }
  // A resolve check judges the conflict resolution, not the item: the board keeps its verifier's verdict.
  const written =
    counted && !resolveCheck ? boardEvent(ctx, "verdict", id, { verdict: judged.verdict }) : null;
  const board = written?.board ?? null;
  next.boardWrites = [...(next.boardWrites ?? []), ...(written?.moves ?? [])];
  next = dispatchNext(ctx, next, res.dispatch);
  ledgers.write(root, next);
  return view(ctx, next, {
    step: "verdict",
    nested: next.nested,
    extra: {
      verdict: judged.void ? "void" : (judged.verdict ?? null),
      ...(gateTally(next.gates, judged.tip).text && {
        gates: gateTally(next.gates, judged.tip).text,
      }),
      ...(notes.line && { notes: notes.line }),
      ...(res.reason && { why: res.reason }),
      ...(board && { board }),
    },
  });
}

// Gates queue behind the lock (`gate.concurrency` slots, in the main checkout's run directory); a flaky
// re-run holds every slot, so it runs alone. The gate's intent is marked before it reads the ledger and
// cleared on any exit, so a restack waits for a gate that is only queued (`restack.mjs`).
function gate(ctx, id) {
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

// A verified lane (PASS WITH NOTES) goes back to its builder for the notes the conductor names; the rounds
// after it are the usual recheck. The board is not written: the next verdict is.
function fix(ctx, id, given) {
  if (ctx.owner !== null) return ownerFix(ctx, id);
  const { root } = ctx;
  const ledger = mustLedger(root, id);
  const labels = [...new Set(given.split(",").map((n) => n.trim().toUpperCase()))];
  if (!labels.every((n) => /^N\d+$/.test(n)))
    refuse(`--notes takes the verifier's note labels, like N1,N3 (got ${given})`);
  // A notes round already out: its report comes first, whatever the budget says.
  const out = ledger.rounds.at(-1);
  if (out?.notes && out.report === undefined) refuse("a notes round is out: wait for its report");
  // A note the last verdict left as built is not one to fix: the recheck would never judge it.
  const judged = verdicts(ledger).at(-1);
  const left = (ledger.left ?? []).find((l) => l.round === judged?.n && labels.includes(l.label));
  if (left)
    refuse(
      `${left.label} was left as built (by ${left.by}): leave it, or send it back with fix --owner`,
    );
  const byOwner = laneLine(root, "fix", id, ' --owner "<the change>"');
  const { used, max } = notesBudget(ledger, liveNotes(ctx));
  // Held at the notes cap: a cap raised since lets one more notes round go; else the owner decides.
  if (ledger.hold?.when === "verdict" && used >= max)
    refuse(
      `${used} of ${max} notes rounds are used (exec.noteRounds is ${max}) and this flagged item holds for you at the cap: resume to close as is (${laneLine(root, "resume", id, ' --note "<the OK>"')}), or fix --owner (${byOwner})`,
    );
  if (used >= max)
    refuse(
      `${used} of ${max} notes rounds are used (exec.noteRounds is ${max}; next is ${ledger.next}: ${laneLine(root, ledger.next === "close" ? "close" : "gate", id)} goes on with the notes open) → raise exec.noteRounds, or send it back on your word: ${byOwner}`,
    );
  const res = stepWith(ledger, { type: "notes", notes: labels, noteRounds: max, at: now() });
  const verifier = verdicts(ledger).at(-1);
  const report = verifier ? readReport(verifier.reportPath, "verifier") : "";
  const found = withOpen(notesOf(report), ledger.openNotes);
  const missing = labels.filter((n) => !found.has(n));
  if (missing.length)
    refuse(
      `${missing.join(", ")} not in the verifier's report ${verifier?.reportPath ?? "(none)"} or the open notes (they have ${[...found.keys()].join(", ") || "no N<number> notes"})`,
    );
  const next = dispatchNext(ctx, res.ledger, res.dispatch);
  next.nested = nestedTrees(root, next);
  ledgers.write(root, next);
  return view(ctx, next, {
    step: "fix",
    nested: next.nested,
    extra: { notes: labels, ...(res.reason && { why: res.reason }) },
  });
}

// The owner sends a verified lane back with a change (field 77): one builder round on it (the lane's last
// builder resumed, a fresh one with the brief when none can be), then the lane's own route. Recorded in
// `ownerFixes[]`; the board is not written until the work is built again.
function ownerFix(ctx, id) {
  const { root, spec, owner } = ctx;
  if (!owner.trim()) refuse(`--owner needs the owner's change, in words`);
  const ledger = mustLedger(root, id);
  if (ledger.state === "merged") refuse(`${id} is merged: the owner's change is a new task`);
  if (expects(ledger) === "report")
    refuse(
      `a builder is out on round ${ledger.rounds.at(-1).n} (${ledger.next}): report it first (${laneLine(root, "report", id)})`,
    );
  // A lane the notes cap holds for the owner (field 84) goes back on the owner's word too.
  const capped = ledger.state === "held" && ledger.hold?.when === "verdict";
  // Any other hold is answered by its resume: the owner's change is the note (--redo past a finished run).
  if (ledger.state === "held" && !capped) {
    const { hold } = ledger;
    const redo = hold.when === "after" ? " --redo" : "";
    // A parked verified lane's resume only makes it verified again: the change is a fix after it.
    if (hold.when === "verified")
      refuse(
        `${id} is parked verified: resume it (${laneLine(root, "resume", id, ' --note "<why>"')}), then send the change with ${laneLine(root, "fix", id, ' --owner "<the change>"')}`,
      );
    refuse(
      `${id} is held (${hold.for}): its change goes in the resume, ${laneLine(root, "resume", id, `${redo} --note "<the change>"`)}`,
    );
  }
  if (!capped && (ledger.state !== "verified" || !["close", "merge"].includes(ledger.next)))
    refuse(`fix --owner is for a verified lane: ${id} is ${ledger.state} (next ${ledger.next})`);
  refuseAtWriterCap(root, spec);
  const res = stepWith(ledger, { type: "owner", note: owner, at: now() });
  const next = dispatchNext(ctx, res.ledger, res.dispatch);
  next.nested = nestedTrees(root, next);
  ledgers.write(root, next);
  return view(ctx, next, {
    step: "fix",
    nested: next.nested,
    extra: { owner: next.ownerFixes.at(-1), why: res.reason },
  });
}

// A builder's round waits: for the owner, who reviews what its saved reply points at (`--evidence`, by
// default that reply), or for later, a parked lane whose builder was stopped mid-round (no reply needed,
// the worktree kept as it is). The ledger alone is written: no board cell, nothing on main. A touched main
// refuses the owner's hold; a park records it anyway and says so (field 57): `resume` checks main again.
// A verified lane (next close or merge) parks too, `--for later` only (field 63): no builder is out, so
// main is not checked, and the resume makes it verified again with the same next step.
function hold(ctx, id, agent) {
  const { root, holdFor, evidence: given, note } = ctx;
  if (!["owner", "later"].includes(holdFor)) refuse("--for takes owner or later");
  const ledger = mustLedger(root, id);
  const held = ledger.state === "held";
  const verified =
    isVerifiedPark(ledger) ||
    (ledger.state === "verified" && ["close", "merge"].includes(ledger.next));
  if (verified && holdFor === "owner")
    refuse(
      `hold --for owner is for a builder's round: ${id} is verified (next ${ledger.hold?.next ?? ledger.next}); park it with --for later`,
    );
  if (!held && !verified && expects(ledger) !== "report")
    refuse(`hold is for a builder's round: the lane is ${ledger.state} (next ${ledger.next})`);
  // The owner's review at a run's end is the owner's to answer: a park would let the lane go on without it.
  if (
    held &&
    holdFor === "later" &&
    ledger.hold?.for === "owner" &&
    ["after", "verdict"].includes(ledger.hold.when)
  )
    refuse(
      `${id} waits for the owner ${ledger.hold.when === "verdict" ? "at its notes cap" : `after step ${ledger.hold.stepRun?.[1] ?? "?"}`}: resume it with the owner's words (exec resume ${id} --note "…"), or keep it held`,
    );
  // A context hold is answered by the fact: another hold would drop its re-dispatch (R1d-38 r2 N2).
  if (held && ledger.hold?.for === "context")
    refuse(`${id} is held for more context: resume it with --note "<the fact>"`);
  // A blocked hold is answered by the cause cleared: another hold would turn its resume into a continue.
  if (held && ledger.hold?.for === "blocked")
    refuse(`${id} is held, blocked: clear it, then resume with --note "<what changed>"`);
  // A guard hold is answered by fixing main and reporting again, not by the owner's review (R1d-29 N2).
  if (held && holdFor === "owner" && ledger.hold?.for === "guard")
    refuse(`the lane is held for the guard: fix it and run ${laneLine(root, "report", id)}`);
  const round = ledger.rounds.at(-1);
  if (!held && holdFor === "owner" && !saved(round.reportPath))
    refuse(`the builder is still out: save its reply to ${round.reportPath} first, then hold`);
  const evidence = given === null ? null : resolve(root, given);
  // The evidence the owner opens, given or defaulted, is a file.
  const opened = evidence ?? (holdFor === "owner" ? round.reportPath : null);
  if (opened !== null && !isFile(opened))
    refuse(
      `no file at ${given ?? opened}: save the builder's reply there first, or pass --evidence`,
    );
  const touched =
    !verified && (!held || holdFor === "later")
      ? mainTouched(ctx, ledger, ledgers.list(root))
      : null;
  if (touched && holdFor === "owner")
    refuse(
      `main touched: ${touched}: run ${laneLine(root, "report", id)} (the report holds the lane for the guard)`,
    );
  const res = stepWith(ledger, {
    type: "hold",
    for: holdFor,
    evidence: evidence ?? (holdFor === "owner" ? round.reportPath : null),
    at: now(),
    ...(note && { why: note }),
    ...(agent && { agent }),
  });
  ledgers.write(root, res.ledger);
  return view(ctx, res.ledger, {
    step: "hold",
    extra: {
      ...(res.reason && { why: res.reason }),
      ...(touched && { "main moved while parked": `${touched}; resume re-checks it` }),
    },
  });
}

// The owner's answer to a hold: recorded with its time, then the held round's builder carries on (the
// next run, the same run with --redo, or the same round after a hold during it), or after the last step
// the verifier (or the gate) is next and built is written. Main must be as the lane left it.
function resume(ctx, id) {
  const { root, spec, note, redo, fresh, same } = ctx;
  const ledger = mustLedger(root, id);
  if (ledger.state !== "held")
    refuse(`the lane is not held (state ${ledger.state}, next ${ledger.next})`);
  if (!note) refuse(`resume needs --note "<the owner's words>"`);
  if (redo && ledger.hold?.when !== "after") refuse(redoRefusal(ledger.hold));
  // A parked verified lane, or one the notes cap holds: no builder is out or sent, and built is written.
  const parked = isVerifiedPark(ledger) || ledger.hold?.when === "verdict";
  // Main may have moved by commits that touch none of the lane's files (field 68): the guard's own rule.
  const main = parked ? null : mainGuard(ctx, ledger, ledgers.list(root));
  if (main?.touched)
    refuse(
      main.overlap
        ? `main changed while ${id} was held: ${main.touched} → ${laneLine(root, "restart", id, " --carry")}`
        : `main changed while ${id} was held: ${main.touched}: undo that, then resume`,
    );
  const moved = main?.moved
    ? `main moved by ${main.moved} commits, none touching this lane's files: resuming on base ${short(ledger.base)}`
    : null;
  const flagged = isFlagged(ctx, ledger);
  const res = stepWith(ledger, {
    type: "resume",
    note,
    redo,
    same,
    at: now(),
    skipVerify: skipsVerifier(ledger.route, flagged),
    tip: headOf(root, ledger.branch),
    gate: gateOf(spec) !== null,
    tier: buildTier(ctx, ledger),
  });
  if (res.dispatch?.role === "build") refuseAtWriterCap(root, spec);
  let next = res.ledger;
  if (ledger.route) next.route = { ...ledger.route, flagged };
  next.nested = nestedTrees(root, next);
  // A verified lane (or one past its verifier) wrote built long ago: its resume writes no board cell.
  const board = parked ? null : writeBuilt(ctx, next, res);
  let dispatch = res.dispatch;
  if (dispatch && fresh) {
    const { agent, ...rest } = dispatch;
    dispatch = { ...rest, mode: "fresh" };
  }
  next = dispatchNext(ctx, next, dispatch);
  ledgers.write(root, next);
  const answer = next.holds.at(-1);
  return view(ctx, next, {
    step: "resume",
    nested: next.nested,
    lead: { [answerLabel(answer)]: answerOf(answer, stepCount(next)), ...(moved && { moved }) },
    extra: { ...(res.reason && { why: res.reason }), ...(board && { board }) },
  });
}

function close(ctx, id, episodeId) {
  const { root } = ctx;
  let ledger = mustLedger(root, id);
  if (episodeId !== null) {
    if (!ledger.episode?.payload) refuse(`no episode to stamp: run ${laneLine(root, "close", id)}`);
    const existing = ledger.episode.writtenId;
    if (existing && existing !== episodeId)
      refuse(`the episode is already stamped as ${existing}; not replacing it with ${episodeId}`);
    ledger = { ...ledger, episode: { ...ledger.episode, writtenId: episodeId } };
    ledgers.write(root, ledger);
    // The id is stamped as given; whether the memory store holds it is said, so a typo shows.
    const stored = episodeStored(root, episodeId);
    const warning = `no episode ${episodeId} in the memory store: check the id episode_write returned`;
    const shown = { id, step: "close", episode: ledger.episode, stored };
    return {
      exit: 0,
      out: JSON.stringify(stored ? shown : { ...shown, warning }, null, 2),
    };
  }
  if (ledger.episode?.writtenId) {
    // Closed again after a rebase or an owner's fix: the episode stands, and the land is next again.
    if (ledger.state === "verified" && ledger.next === "close") {
      ledger = { ...ledger, next: "merge" };
      ledgers.write(root, ledger);
    }
    return {
      exit: 0,
      out: JSON.stringify(
        {
          id,
          step: "close",
          next: ledger.next,
          episode: ledger.episode,
          already: `the episode is written (${ledger.episode.writtenId}): write nothing more`,
        },
        null,
        2,
      ),
    };
  }
  const closable =
    ledger.next === "close" ||
    ledger.state === "stopped" ||
    ledger.state === "merged" ||
    ledger.cut ||
    ledger.episode;
  if (!closable) refuse(`the lane is not done (state ${ledger.state}, next ${ledger.next})`);
  const payload = episodeOf(ledger);
  ledger = {
    ...ledger,
    episode: { ...ledger.episode, payload },
    ...(ledger.state === "verified" && { next: "merge" }),
  };
  ledgers.write(root, ledger);
  const shown = view(ctx, ledger, {
    step: "close",
    extra: {
      episode: payload,
      afterwards: `episode_write with this payload, then ${laneLine(root, "close", id, " --episode <its id>")}`,
    },
  });
  return { ...shown, exit: 0 };
}

function show(ctx, id) {
  const { root, spec } = ctx;
  const ledger = mustLedger(root, id);
  const children = childrenOf(ledgers.list(root), id);
  const idle = idleOf(ledger.worktree, ledger, Date.now(), idleMinutes(spec));
  return view(ctx, ledger, {
    step: "show",
    nested: nestedTrees(root, ledger),
    lead: {
      ...(idle && { idle: { ...idle, park: laneLine(root, "hold", id, " --for later") } }),
      ...(ledger.state === "stopped" && waysOn(root, ledger)),
    },
    extra: {
      owned: ownedOf(root, ledger),
      ...(ledger.steps && { steps: stepLines(ledger.steps) }),
      ...(ledger.holds?.length && {
        holds: ledger.holds
          .map((h) => `${answerLabel(h)}: ${answerOf(h, stepCount(ledger))}`)
          .join("\n"),
      }),
      workflow: resolveWorkflow(spec),
      "route fixed at start": routeFixedText(routeOf(ledger), liveNotes(ctx)),
      route: routeNow(ctx, ledger),
      ...(ledger.openNotes?.length && { openNotes: ledger.openNotes }),
      ...(ledger.left?.length && {
        left: ledger.left
          .map((l) => `${l.label}: left as built by the ${l.by} at ${l.at} (round ${l.round})`)
          .join("\n"),
      }),
      rounds: ledger.rounds.map((r) => ({
        n: r.n,
        step: r.step,
        mode: r.mode,
        ...(r.resend && { resend: true }),
        ...(r.agent && { agent: r.agent }),
        ...(r.status && { status: r.status }),
        ...(r.verdict && { verdict: r.verdict }),
        ...(r.void && { void: true }),
        ...(r.held && { held: true }),
        ...(r.stepRun && { stepRun: r.stepRun }),
        ...(r.guards && { guards: r.guards }),
      })),
      gates: (ledger.gates ?? []).map((g) => ({
        exit: g.exit,
        tier: g.tier,
        commit: short(g.commit),
        log: g.log,
      })),
      ...(ledger.rebases?.length && { rebases: ledger.rebases }),
      ...(ledger.restacks?.length && { restacks: ledger.restacks.map(restackText).join("\n") }),
      ...(children.length && { "stacked on it": children.join(", ") }),
      ...(ledger.episode && { episode: ledger.episode }),
    },
  });
}

// A verified lane whose branch must be rebased onto main (a land conflict, or a branch moved past where it
// closed). A land that stopped on a conflict put nothing on main, so its lane is still the verified one.
// `{ fromBase, fromTip }` goes into `rebases[]` before the dispatch: a rerun that finds the last entry
// unfinished reuses it, and one whose rebase round is out prints it again. A branch that already sits on
// main past `closedTip` is recorded as rebased, with no builder round.
function rebase(ctx, id) {
  const { root, spec } = ctx;
  const ledger = mustLedger(root, id);
  const out = ledger.rounds.at(-1);
  if (out?.step === "rebase" && expects(ledger) === "report")
    return view(ctx, ledger, { step: "rebase", extra: { why: "the rebase round is out already" } });
  const conflicted =
    ledger.state === "merging" &&
    ["conflict", "rolled-back"].includes(ledger.merge?.step) &&
    ledger.merge?.stateBefore === "verified";
  if (ledger.state !== "verified" && !conflicted)
    refuse(`rebase is for a verified lane: ${id} is ${ledger.state} (next ${ledger.next})`);
  // A stacked lane moves with its parent until the parent lands (R1d-14 N2).
  const stack = stackOf(root, ledger, ledgers.list(root));
  if (stack.on && stack.state !== "merged")
    refuse(
      `${id} is stacked on ${stack.on}: restack it (${restackLine(root, id)}), never rebase it onto main`,
    );
  const tip = headOf(root, ledger.branch);
  const main = headOf(root, ledger.mainBranch);
  const moved =
    Boolean(ledger.closedTip) && tip !== ledger.closedTip && isAncestor(root, main, tip);
  if (!moved) refuseAtWriterCap(root, spec);
  let next = {
    ...structuredClone(ledger),
    state: "verified",
    ...(conflicted && { next: "merge" }),
  };
  // `mainHead`: main as the rebase was asked for, the furthest the guard's start may move to (N7).
  if (next.rebases?.at(-1)?.toTip === undefined && next.rebases?.length) {
    // A killed run's entry: reused as it is.
    next.rebases.at(-1).mainHead ??= headOf(root);
  } else {
    next.rebases = [
      ...(next.rebases ?? []),
      {
        fromBase: ledger.base,
        fromTip: moved ? ledger.closedTip : tip,
        mainHead: headOf(root),
        at: now(),
      },
    ];
    ledgers.write(root, next);
  }
  let res;
  if (moved) {
    const changed = finishRebase(root, next, tip);
    res = stepWith(next, {
      type: "rebased",
      tip,
      changed,
      gate: gateOf(spec) !== null,
      tier: buildTier(ctx, next),
    });
  } else res = stepWith(next, { type: "rebase" });
  next = dispatchNext(ctx, res.ledger, res.dispatch);
  next.nested = nestedTrees(root, next);
  ledgers.write(root, next);
  return view(ctx, next, {
    step: "rebase",
    nested: next.nested,
    extra: {
      ...(moved && { rangeDiff: next.rebases.at(-1).rangeDiff }),
      ...(res.reason && { why: res.reason }),
    },
  });
}

// A lane closed with no verdict because its route skipped the verifier (R1c-9 N4): one fresh verifier now,
// then the usual rows.
function reverify(ctx, id) {
  const { root } = ctx;
  const ledger = mustLedger(root, id);
  if (ledger.state !== "verified")
    refuse(
      `reverify is for a lane closed without a verifier: ${id} is ${ledger.state} (next ${ledger.next})`,
    );
  if (verdicts(ledger).length)
    refuse(
      `reverify is for a lane closed without a verifier: a verifier closed ${id} (${verdicts(ledger).at(-1).verdict})`,
    );
  const res = stepWith(ledger, { type: "reverify" });
  const next = dispatchNext(ctx, res.ledger, res.dispatch);
  next.nested = nestedTrees(root, next);
  ledgers.write(root, next);
  return view(ctx, next, { step: "reverify", nested: next.nested, extra: { why: res.reason } });
}

// A stacked lane's branch onto its parent's new tip, or main's (its parent landed, or `--main`, the owner's
// call): `restack.mjs` does the guards, the rebase and the record; a hand resolution's check is dispatched here.
function restack(ctx, id) {
  const { root, toMain } = ctx;
  const ledger = mustLedger(root, id);
  const done = restackLane(ctx, ledger, {
    toMain,
    dispatch: (next, plan) => {
      const out = dispatchNext(ctx, next, plan);
      out.nested = nestedTrees(root, out);
      return out;
    },
  });
  if (done.nothing) return view(ctx, ledger, { step: "restack", extra: { restack: done.nothing } });
  return view(ctx, done.ledger, {
    step: "restack",
    nested: nestedTrees(root, done.ledger),
    extra: {
      restacked: done.restacked,
      commits: done.commits,
      ...(done.reason && { why: done.reason }),
    },
  });
}

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

// A lane started again (field 69): not merged and no agent out, its ledger and run files archived as
// `<id>.<n>` (a hold's `holds[]` with them), its worktree removed (only `cleanup.disposable` ignored files
// may go), its branch kept as `agentry/<id>.<n>`, and a fresh `agentry/<id>` cut from main with every
// `start` record. `--carry` picks the old branch's commits and applies its uncommitted diff; the kept
// branch goes once all of it is carried, and a stop leaves the conflict in the new worktree (exit 1). A
// verified lane carried whole goes to the resolve check, its board verdict kept; any other a build round.
function restart(ctx, id) {
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
  // What a carry picks: the branch's commits not on main, never base..tip (field 100), from a branch
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
  const archived = archive(root, id, n);
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
    // The owner's calls are the lane's, not the attempt's: the new ledger keeps them (field 90).
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
      ...(withWork && work.files.length ? [`git apply --3way ${diff}`] : []),
      ...(unclear ? [unclear.slice(unclear.indexOf("agentry board set"))] : []),
    ];
    throw new Stopped(
      `${id} is archived (${archived.ledger}, ${archived.runs}), its old work is on ${held ?? "no branch"}${work.files.length ? ` and its uncommitted diff at ${diff}` : ""}, but the restart stopped: ${e.message} → fix that, then: ${steps.join("; ")}`,
    );
  }
}

// Work built outside exec taken in as the lane (field 86): `start`'s checks and board write, a fresh
// `agentry/<id>` cut from main, `main..<b>`'s commits picked onto it and, when <b> is checked out in a
// worktree, that worktree's uncommitted diff applied (`restart.mjs`'s `saveWork` and `carry`). <b> and its
// worktree are only read. Every refusal comes before the cut; a carry that stops leaves the conflict in the
// new worktree, named in the output and the brief, as `restart --carry` does (exit 1).
function adopt(ctx, id) {
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
  cut: (ctx, id) =>
    cutLane(ctx, id, {
      ledger: mustLedger(ctx.root, id),
      refuse,
      stop: (message) => {
        throw new Stopped(message);
      },
      laneLine,
      episodeOf,
    }),
};
