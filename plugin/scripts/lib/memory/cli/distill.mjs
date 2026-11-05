// mem distill — graduate episodes into facts (the MCP's memory_distill). `--mode list` returns the
// undistilled episodes with a draft fact each (provenance-linked); it writes nothing. `--mode stamp`
// marks the given episodes distilled; when none of the ids is an undistilled episode it is refused.
//
// run(argv) -> { exit, out }   exit 0 = done, 1 = refused, 2 = usage
import { distill } from "../application/flows.mjs";
import { flagHelp, usage } from "../tools/args.mjs";
import { EXITS, command } from "../tools/command.mjs";
import { ok, partial } from "../tools/result.mjs";

const fields = {
  mode: {
    kind: "enum",
    options: ["list", "stamp"],
    required: true,
    doc: "list the drafts, or stamp episodes",
  },
  episodeIds: { kind: "list", doc: "for stamp: an episode id to mark distilled" },
};

export const noSpec = true;
export const help = {
  usage: usage("distill", fields),
  purpose: "List the undistilled episodes with draft facts, or stamp episodes distilled.",
  args: {},
  flags: flagHelp(fields),
  exits: EXITS,
  example: "agentry mem distill --mode stamp --episode-ids p:01J…",
};

export const run = (argv) =>
  command("distill", fields, argv, (service, { mode, episodeIds }) =>
    mode === "stamp"
      ? partial(service.stampDistilled(episodeIds ?? []))
      : ok({ clusters: distill(service.undistilledEpisodes()) }),
  );
