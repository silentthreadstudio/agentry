// exec/steps/fact — `lane exec fact <id> --text "<fact>"` (or `--clear`): a fact for the builder. Each is
// kept in the ledger (`facts[]`, text and time; the same text twice is kept once), and the brief waiting
// for the builder's report lists them all under `## Facts`; every later builder brief carries the same
// section. `--clear` empties the list and drops the section.
import { readFileSync, writeFileSync } from "node:fs";
import * as ledgers from "../../../process/ledger.mjs";
import { now } from "../../fmt.mjs";
import { expects } from "../../rounds.mjs";
import { withFacts } from "../briefs.mjs";
import { laneLine, mustLedger, refuse } from "../lane.mjs";

export function run(ctx, id) {
  const { root, text, clear } = ctx;
  const ledger = mustLedger(root, id);
  const round = ledger.rounds.at(-1);
  if (ledger.state === "held" && ledger.hold?.for === "context")
    refuse(
      `${id} is held for more context: answer it with ${laneLine(root, "resume", id, ' --note "<the fact>"')}`,
    );
  if (expects(ledger) !== "report")
    refuse(
      `fact is for a builder round waiting for its report: ${id} is ${ledger.state} (next ${ledger.next})`,
    );
  const kept = ledger.facts ?? [];
  const facts = clear
    ? []
    : kept.some((f) => f.text === text)
      ? kept
      : [...kept, { text, at: now() }];
  ledgers.write(root, { ...ledger, facts: facts.length ? facts : undefined });
  writeFileSync(round.brief, withFacts(readFileSync(round.brief, "utf8"), facts));
  return {
    exit: 0,
    out: JSON.stringify(
      {
        id,
        step: "fact",
        next: ledger.next,
        state: ledger.state,
        brief: round.brief,
        facts: facts.length,
      },
      null,
      2,
    ),
  };
}
