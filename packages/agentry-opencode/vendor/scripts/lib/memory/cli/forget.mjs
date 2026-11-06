// mem forget — remove a memory by id, from the live store and disk: the manual
// override; decay handles routine cleanup, so use it sparingly.
//
// run(argv) -> { exit, out }   exit 0 = forgotten, 1 = refused (no such id), 2 = usage
import { flagHelp, usage } from "../tools/args.mjs";
import { EXITS, command } from "../tools/command.mjs";
import { failed, ok } from "../tools/result.mjs";

const fields = {
  id: { kind: "string", value: "<id>", required: true, doc: "the fact or episode to remove" },
};

export const noSpec = true;
export const help = {
  usage: usage("forget", fields),
  purpose: "Remove a memory by id, from the store and from disk.",
  args: {},
  flags: flagHelp(fields),
  exits: EXITS,
  example: "agentry mem forget --id g:01J…",
};

export const run = (argv) =>
  command("forget", fields, argv, (service, { id }) => {
    const outcome = service.forget(id);
    return outcome.ok ? ok({ forgotten: true, kind: outcome.kind }) : failed(outcome);
  });
