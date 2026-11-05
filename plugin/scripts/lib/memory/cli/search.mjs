// mem search — broader full-text search with snippets, for exploration when
// recall's few are not enough.
//
// run(argv) -> { exit, out }   exit 0 = done (no match is still 0), 1 = refused, 2 = usage
import { flagHelp, usage } from "../tools/args.mjs";
import { EXITS, command } from "../tools/command.mjs";
import { ok } from "../tools/result.mjs";

const fields = {
  query: { kind: "string", required: true, doc: "the words to look for" },
  limit: { kind: "int", min: 1, doc: "how many to return (default 10)" },
};

export const noSpec = true;
export const help = {
  usage: usage("search", fields),
  purpose: "Full-text search over the active facts, with snippets.",
  args: {},
  flags: flagHelp(fields),
  exits: EXITS,
  example: 'agentry mem search --query "sqlite external"',
};

export const run = (argv) =>
  command("search", fields, argv, (service, { query, limit }) =>
    ok({ results: service.search(query, limit) }),
  );
