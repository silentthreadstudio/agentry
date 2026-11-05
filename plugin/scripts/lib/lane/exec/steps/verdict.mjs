// exec/steps/verdict — `lane exec verdict <id>`: the verifier's report read, the verdict written, the
// next round briefed.
import * as ledgers from "../../../process/ledger.mjs";
import { gateOf } from "../../../process/spec/workflow.mjs";
import { summaryOf, usedMemories, verdictOf } from "../../report.mjs";
import { expects, gateTally, notesBudget, verdicts } from "../../rounds.mjs";
import { nestedTrees } from "../admission.mjs";
import { boardEvent } from "../board.mjs";
import { buildTier, dispatchNext } from "../briefs.mjs";
import { headOf } from "../guard/snapshot.mjs";
import { isFlagged, laneLine, mustLedger, now, readReport, refuse, stepWith } from "../lane.mjs";
import {
  coveredBy,
  leftNotes,
  liveNotes,
  onlyFixCommits,
  openNotesOf,
  sentBack,
} from "../notes.mjs";
import { view } from "../view.mjs";

export function run(ctx, id) {
  const { root, spec, value: agent } = ctx;
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
