// exec/steps/owns — `lane exec owns <id>`: the owned files the briefs name, shown, replaced or added
// to.
import { appendFileSync, readFileSync } from "node:fs";
import { PREVIEW } from "../../../cli/help.mjs";
import * as ledgers from "../../../process/ledger.mjs";
import { appendedAfter } from "../../brief.mjs";
import { withNew } from "../../owns.mjs";
import { leaves } from "../../paths.mjs";
import { PASSES, expects, verdicts } from "../../rounds.mjs";
import { brief } from "../briefs.mjs";
import { ownsPath } from "../guard/allow.mjs";
import { isVerifiedPark, laneLine, mustLedger, normalised, ownedOf, refuse } from "../lane.mjs";

// The owned files the briefs name. `--set a,b` replaces them and `--add a,b` appends the ones not owned yet
// (shown until `--apply`); on apply the brief waiting to be answered is rewritten, so the agent reads the
// amended list. `--add` is for a lane still building: a builder that asked for a file it does not own.
export function run(ctx, id) {
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
