// mem recall — the few, ranked, scope-aware memories for a task (the MCP's memory_recall): never superseded,
// safe to inject. `--mode prime` with no query is the session warm set: the top facts and recent episodes.
//
// run(argv) -> { exit, out }   exit 0 = done (an empty result is still 0), 1 = refused, 2 = usage
import { flagHelp, usage } from "../tools/args.mjs";
import { EXITS, command } from "../tools/command.mjs";
import { ok } from "../tools/result.mjs";

const fields = {
  query: { kind: "string", doc: "what the task is about" },
  limit: { kind: "int", min: 1, doc: "how many to return (default 5)" },
  mode: { kind: "enum", options: ["task", "prime"], doc: "prime: no query, the session warm set" },
};

export const noSpec = true;
export const help = {
  usage: usage("recall", fields),
  purpose: "The few ranked memories for a task; --mode prime is the session warm set.",
  args: {},
  flags: flagHelp(fields),
  exits: EXITS,
  example: 'agentry mem recall --query "bundling node:sqlite" --limit 3',
};

export const run = (argv) =>
  command("recall", fields, argv, (service, args) => ok(service.recall(args)));
