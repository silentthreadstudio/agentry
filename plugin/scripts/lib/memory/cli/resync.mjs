// mem resync — force-rebuild the derived index from the files (the MCP's memory_resync) and report the
// fact and episode counts before and after. Each `agentry mem` call reads the files afresh, so this is
// the check that the store reads as expected after another process wrote to it.
//
// run(argv) -> { exit, out }   exit 0 = done, 1 = refused, 2 = usage
import { flagHelp, usage } from "../tools/args.mjs";
import { EXITS, command } from "../tools/command.mjs";
import { ok } from "../tools/result.mjs";

const fields = {};

export const noSpec = true;
export const help = {
  usage: usage("resync", fields),
  purpose: "Rebuild the index from the files and report the counts before and after.",
  args: {},
  flags: flagHelp(fields),
  exits: EXITS,
  example: "agentry mem resync",
};

export const run = (argv) => command("resync", fields, argv, (service) => ok(service.resync()));
