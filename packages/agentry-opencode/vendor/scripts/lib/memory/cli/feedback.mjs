// mem feedback — record the usefulness signal after a run: used + pass boosts,
// recalled but unused decays (and self-archives after enough strikes), used + fail lowers confidence,
// a recall miss nudges confidence up. An id that is not an active fact is skipped with its reason; when
// every id is skipped the call is refused as not-found.
//
// run(argv) -> { exit, out }   exit 0 = applied (some ids may be skipped), 1 = refused, 2 = usage
import { flagHelp, usage } from "../tools/args.mjs";
import { EXITS, command } from "../tools/command.mjs";
import { partial } from "../tools/result.mjs";

const fields = {
  recalled: { kind: "list", doc: "a fact id recall returned (default none)" },
  used: { kind: "list", doc: "a fact id the run cited (default none)" },
  outcome: { kind: "enum", options: ["pass", "fail"], required: true, doc: "how the run ended" },
  recallMisses: { kind: "list", doc: "a fact id recall should have returned but did not" },
};

export const noSpec = true;
export const help = {
  usage: usage("feedback", fields),
  purpose: "Record which recalled memories a run used, and whether it passed.",
  args: {},
  flags: flagHelp(fields),
  exits: EXITS,
  example: "agentry mem feedback --recalled g:01J… --used g:01J… --outcome pass",
};

export const run = (argv) =>
  command("feedback", fields, argv, (service, args) =>
    partial(service.feedback({ recalled: [], used: [], ...args })),
  );
