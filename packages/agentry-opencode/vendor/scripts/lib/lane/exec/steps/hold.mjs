// exec/steps/hold — `lane exec hold <id>`: a builder's round waits for the owner, or the lane is
// parked.
import { resolve } from "node:path";
import * as ledgers from "../../../process/ledger.mjs";
import { now } from "../../fmt.mjs";
import { expects, parkedVerified } from "../../rounds.mjs";
import { mainTouched } from "../guard/main-guard.mjs";
import { isFile, laneLine, mustLedger, refuse, saved, stepWith } from "../lane.mjs";
import { view } from "../view.mjs";

// A builder's round waits: for the owner, who reviews what its saved reply points at (`--evidence`, by
// default that reply), or for later, a parked lane whose builder was stopped mid-round (no reply needed,
// the worktree kept as it is). The ledger alone is written: no board cell, nothing on main. A touched main
// refuses the owner's hold; a park records it anyway and says so: `resume` checks main again.
// A verified lane (next close or merge) parks too, `--for later` only: no builder is out, so
// main is not checked, and the resume makes it verified again with the same next step.
export function run(ctx, id) {
  const { root, holdFor, evidence: given, note, value: agent } = ctx;
  if (!["owner", "later"].includes(holdFor)) refuse("--for takes owner or later");
  const ledger = mustLedger(root, id);
  const held = ledger.state === "held";
  const verified =
    parkedVerified(ledger) ||
    (ledger.state === "verified" && ["close", "merge"].includes(ledger.next));
  if (verified && holdFor === "owner")
    refuse(
      `hold --for owner is for a builder's round: ${id} is verified (next ${ledger.hold?.next ?? ledger.next}); park it with --for later: ${laneLine(root, "hold", id, " --for later")}`,
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
  // A context hold is answered by the fact: another hold would drop its re-dispatch.
  if (held && ledger.hold?.for === "context")
    refuse(`${id} is held for more context: resume it with --note "<the fact>"`);
  // A blocked hold is answered by the cause cleared: another hold would turn its resume into a continue.
  if (held && ledger.hold?.for === "blocked")
    refuse(`${id} is held, blocked: clear it, then resume with --note "<what changed>"`);
  // A guard hold is answered by fixing main and reporting again, not by the owner's review.
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
