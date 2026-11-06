// mem episode — record a structured episode: task, shape, outcome, retries,
// lesson, the memories it used: the episodic layer that distill graduates into facts.
//
// run(argv) -> { exit, out }   exit 0 = recorded, 1 = refused, 2 = usage
import { flagHelp, usage } from "../tools/args.mjs";
import { EXITS, command } from "../tools/command.mjs";
import { ok } from "../tools/result.mjs";

const fields = {
  task: { kind: "string", required: true, doc: "what the run was for" },
  shape: {
    kind: "string",
    required: true,
    doc: "how it was routed (one-shot, spec-first, decompose+verify)",
  },
  outcome: { kind: "string", required: true, doc: "how it ended" },
  retries: { kind: "int", min: 0, doc: "how many retries it took" },
  lesson: { kind: "string", doc: "what to remember from it" },
  usedMemories: { kind: "list", doc: "a fact id the run cited" },
  recallMisses: { kind: "list", doc: "a fact id recall should have returned but did not" },
  repoId: { kind: "string", value: "<repo>", doc: "the repo it was in" },
};

export const noSpec = true;
export const help = {
  usage: usage("episode", fields),
  purpose: "Record an episode: what was done, how it ended and what to remember.",
  args: {},
  flags: flagHelp(fields),
  exits: EXITS,
  example: 'agentry mem episode --task "port the store" --shape spec-first --outcome pass',
};

export const run = (argv) =>
  command("episode", fields, argv, (service, args) => ok(service.episodeWrite(args)));
