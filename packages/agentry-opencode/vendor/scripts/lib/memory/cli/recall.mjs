// mem recall — the few, ranked, scope-aware memories for a task: never superseded,
// safe to inject. `--mode prime` with no query is the session warm set: the top facts and recent episodes.
//
// run(argv) -> { exit, out }   exit 0 = done (an empty result is still 0), 1 = refused, 2 = usage
import { flagHelp, usage } from "../tools/args.mjs";
import { EXITS, command } from "../tools/command.mjs";
import { ok } from "../tools/result.mjs";
import { queryFirst } from "./positional-query.mjs";

const fields = {
  query: { kind: "string", doc: "what the task is about" },
  limit: { kind: "int", min: 1, doc: "how many to return (default 5)" },
  mode: { kind: "enum", options: ["task", "prime"], doc: "prime: no query, the session warm set" },
};

export const noSpec = true;
export const help = {
  usage: usage("recall", fields).replace("recall ", "recall [<query>] "),
  purpose: "The few ranked memories for a task; --mode prime is the session warm set.",
  args: { "<query>": "what the task is about, the same as --query" },
  flags: flagHelp(fields),
  exits: EXITS,
  example: 'agentry mem recall "bundling node:sqlite" --limit 3',
};

export const run = (argv) =>
  queryFirst("recall", argv, (a) =>
    command("recall", fields, a, (service, args) => ok(service.recall(args))),
  );
