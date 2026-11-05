// mem consolidate — cluster recurring facts and PROPOSE skill promotions (the MCP's memory_consolidate).
// It never installs anything: skills are the owner's call. Returns the proposals with their provenance.
//
// run(argv) -> { exit, out }   exit 0 = done (no proposals is still 0), 1 = refused, 2 = usage
import { consolidate } from "../application/flows.mjs";
import { flagHelp, usage } from "../tools/args.mjs";
import { EXITS, command } from "../tools/command.mjs";
import { ok } from "../tools/result.mjs";

const fields = {
  minRecurrence: { kind: "int", min: 1, doc: "facts a tag must recur across (default 3)" },
  minUsefulness: { kind: "number", min: 0, doc: "average usefulness those facts need (default 2)" },
};

export const noSpec = true;
export const help = {
  usage: usage("consolidate", fields),
  purpose: "Propose skills from recurring facts; installs nothing.",
  args: {},
  flags: flagHelp(fields),
  exits: EXITS,
  example: "agentry mem consolidate --min-recurrence 4",
};

export const run = (argv) =>
  command("consolidate", fields, argv, (service, { minRecurrence, minUsefulness }) =>
    ok({ proposals: consolidate(service.activeFacts(), minRecurrence, minUsefulness) }),
  );
