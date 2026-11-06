// mem search — broader full-text search with snippets, for exploration when
// recall's few are not enough.
//
// run(argv) -> { exit, out }   exit 0 = done (no match is still 0), 1 = refused, 2 = usage
import { flagHelp, usage } from "../tools/args.mjs";
import { EXITS, command } from "../tools/command.mjs";
import { ok } from "../tools/result.mjs";
import { queryFirst } from "./positional-query.mjs";

const fields = {
  query: { kind: "string", required: true, doc: "the words to look for" },
  limit: { kind: "int", min: 1, doc: "how many to return (default 10)" },
};

export const noSpec = true;
export const help = {
  usage: usage("search", fields).replace(
    "search --query <text>",
    "search (<query> | --query <text>)",
  ),
  purpose: "Full-text search over the active facts, with snippets.",
  args: { "<query>": "the words to look for, the same as --query" },
  flags: flagHelp(fields),
  exits: EXITS,
  example: 'agentry mem search "sqlite external"',
};

export const run = (argv) =>
  queryFirst("search", argv, (a) =>
    command("search", fields, a, (service, { query, limit }) =>
      ok({ results: service.search(query, limit) }),
    ),
  );
