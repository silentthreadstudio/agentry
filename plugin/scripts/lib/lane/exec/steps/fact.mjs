// exec/steps/fact — `lane exec fact <id> --text "<fact>"`: the fact a builder asked for, written at the end
// of the needs-context brief waiting for it under `## The fact`. A second call replaces the section, so
// the brief never holds two. The ledger is not written.
import { readFileSync, writeFileSync } from "node:fs";
import { expects } from "../../rounds.mjs";
import { laneLine, mustLedger, refuse } from "../lane.mjs";

const SECTION = /^## The fact$/m;

export function run(ctx, id) {
  const { root, text } = ctx;
  const ledger = mustLedger(root, id);
  const round = ledger.rounds.at(-1);
  if (ledger.state === "held" && ledger.hold?.for === "context")
    refuse(
      `${id} is held for more context: answer it with ${laneLine(root, "resume", id, ' --note "<the fact>"')}`,
    );
  if (expects(ledger) !== "report" || round.step !== "needs-context")
    refuse(
      `fact is for a needs-context round waiting for its builder: ${id} is ${ledger.state} (next ${ledger.next})`,
    );
  const brief = readFileSync(round.brief, "utf8");
  const at = brief.search(SECTION);
  const kept = at === -1 ? brief : brief.slice(0, at);
  writeFileSync(round.brief, `${kept.trimEnd()}\n\n## The fact\n\n${text}\n`);
  return {
    exit: 0,
    out: JSON.stringify(
      { id, step: "fact", next: ledger.next, state: ledger.state, brief: round.brief },
      null,
      2,
    ),
  };
}
