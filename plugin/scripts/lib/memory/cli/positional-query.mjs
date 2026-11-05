// positional-query — `mem recall "<text>"` and `mem search "<text>"` take the query as one bare argument,
// the same as `--query <text>`. The text is moved behind `--query` so the verb's own parsing sees one
// spelling; giving it twice (a bare argument and `--query`) or more than one bare argument is a usage error.
//
// queryFirst(verb, argv, run) -> { exit, out }    run(argv) is the verb's command with the argv it parses
import { refuse } from "../../cli/help.mjs";

/** Every flag of these verbs but `--json` takes a value, so a bare token after a flag is that flag's value. */
function split(argv) {
  const rest = [];
  const bare = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json" || !arg.startsWith("--")) {
      (arg === "--json" ? rest : bare).push(arg);
    } else {
      rest.push(arg);
      if (i + 1 < argv.length) rest.push(argv[++i]);
    }
  }
  return { rest, bare };
}

export function queryFirst(verb, argv, run) {
  const { rest, bare } = split(argv);
  if (!bare.length) return run(argv);
  const fail = (why) => refuse(`mem ${verb}`, why, `agentry mem ${verb} --help`);
  if (bare.length > 1)
    return fail(`takes one query, got ${bare.length} arguments (quote the text: "${bare[0]} …")`);
  if (rest.includes("--query"))
    return fail("the query was given twice: as an argument and as --query");
  return run([...rest, "--query", bare[0]]);
}
