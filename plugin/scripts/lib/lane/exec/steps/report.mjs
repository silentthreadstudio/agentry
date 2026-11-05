// exec/steps/report — `lane exec report <id>`: the builder's report read, the guards run, the next
// round briefed.
import { copyFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as ledgers from "../../../process/ledger.mjs";
import { gateOf } from "../../../process/spec/workflow.mjs";
import { now, short } from "../../fmt.mjs";
import { builderStatus, summaryOf, unwrap, usedMemories } from "../../report.mjs";
import { expects, skipsVerifier } from "../../rounds.mjs";
import { brokenIn, rulesOf } from "../../subjects.mjs";
import { git, porcelain, rebaseInProgress } from "../../worktree.mjs";
import { nestedTrees } from "../admission.mjs";
import { writeBuilt } from "../board.mjs";
import { buildTier, dispatchNext } from "../briefs.mjs";
import { mainGuard } from "../guard/main-guard.mjs";
import { headOf, ownStart } from "../guard/snapshot.mjs";
import {
  heldCopy,
  isFlagged,
  saved as isSaved,
  mustLedger,
  readOr,
  readReport,
  refuse,
  stepWith,
} from "../lane.mjs";
import { finishRebase } from "../rebasing.mjs";
import { view } from "../view.mjs";

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

// A needs-context round resumes the builder that asked, whose first brief named its report `r<n>-build`:
// it may save the reply under that name instead of the round's own. One of the two is read: the other
// name's reply is copied to the round's path; both saved and different is refused, never one picked.
// Returns the name read when it is the build one, else undefined.
function buildNamed(round) {
  if (round.step !== "needs-context") return undefined;
  const alt = join(dirname(round.reportPath), `r${round.n}-build.report.md`);
  if (!isSaved(alt)) return undefined;
  if (!isSaved(round.reportPath)) {
    copyFileSync(alt, round.reportPath);
    return alt;
  }
  if (readOr(alt) !== readOr(round.reportPath))
    refuse(
      `two different reports for round ${round.n}: ${round.reportPath} and ${alt}: remove the one that is not the reply, then report again`,
    );
  return undefined;
}

export function run(ctx, id) {
  const { root, value: agent } = ctx;
  const ledger = mustLedger(root, id);
  // A lane a guard trip holds takes a report again: it reads the saved one.
  const parked = ledger.state === "held" && ledger.hold?.for === "guard";
  if (!parked && expects(ledger) !== "report")
    refuse(
      `the lane expects ${expects(ledger) ?? "nothing"} now, not a report (next is ${ledger.next})`,
    );
  const round = ledger.rounds.at(-1);
  const saved = parked ? ledger.hold.report : heldCopy(round.reportPath);
  const named = parked ? undefined : buildNamed(round);
  const text = readReport(parked ? saved : round.reportPath, "builder");
  const all = ledgers.list(root);
  const isRebase = round.step === "rebase";
  if (isRebase && rebaseInProgress(ledger.worktree))
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
    extra: {
      ...(res.reason && { why: res.reason }),
      ...(board && { board }),
      ...(named && { "report read": `${named} (the round's own is ${round.reportPath})` }),
    },
  });
}
