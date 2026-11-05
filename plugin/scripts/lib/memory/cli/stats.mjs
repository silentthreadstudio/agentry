// mem stats — aggregate counts (the MCP's memory_stats): facts and episodes, active / superseded /
// archived, the undistilled-episode debt, facts by type, and the read errors of any store file that could
// not be read (a corrupt file is reported here, never hidden).
//
// run(argv) -> { exit, out }   exit 0 = done (read errors are listed, not a failure), 1 = refused, 2 = usage
import { flagHelp, usage } from "../tools/args.mjs";
import { EXITS, command } from "../tools/command.mjs";
import { ok } from "../tools/result.mjs";

const fields = {};

export const noSpec = true;
export const help = {
  usage: usage("stats", fields),
  purpose: "Counts across the store, and the files that could not be read.",
  args: {},
  flags: flagHelp(fields),
  exits: EXITS,
  example: "agentry mem stats --json",
};

export const run = (argv) => command("stats", fields, argv, (service) => ok(service.stats()));
