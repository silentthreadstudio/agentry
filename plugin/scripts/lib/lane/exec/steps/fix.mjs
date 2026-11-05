// exec/steps/fix — `lane exec fix <id>`: a verified lane back to its builder, on the verifier's notes
// or the owner's change.
import * as ledgers from "../../../process/ledger.mjs";
import { now } from "../../fmt.mjs";
import { expects, notesBudget, verdicts } from "../../rounds.mjs";
import { nestedTrees, refuseAtWriterCap } from "../admission.mjs";
import { dispatchNext } from "../briefs.mjs";
import { laneLine, mustLedger, readReport, refuse, stepWith } from "../lane.mjs";
import { liveNotes, notesOf, withOpen } from "../notes.mjs";
import { view } from "../view.mjs";

// A verified lane (PASS WITH NOTES) goes back to its builder for the notes the conductor names; the rounds
// after it are the usual recheck. The board is not written: the next verdict is.
export function run(ctx, id) {
  if (ctx.owner !== null) return ownerFix(ctx, id);
  const { root, value: given } = ctx;
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
