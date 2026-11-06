// mem recover — restore a tombstoned (archived) memory to active: decay
// archives, this undoes a false archive. A fact that is not archived is refused as invalid-state.
//
// run(argv) -> { exit, out }   exit 0 = recovered, 1 = refused, 2 = usage
import { flagHelp, usage } from "../tools/args.mjs";
import { EXITS, command } from "../tools/command.mjs";
import { invalidState } from "../tools/errors.mjs";
import { failed, ok } from "../tools/result.mjs";

const fields = {
  id: { kind: "string", value: "<id>", required: true, doc: "the archived fact to restore" },
};

export const noSpec = true;
export const help = {
  usage: usage("recover", fields),
  purpose: "Restore an archived memory to active.",
  args: {},
  flags: flagHelp(fields),
  exits: EXITS,
  example: "agentry mem recover --id g:01J…",
};

const notArchived = ({ status }) =>
  invalidState(
    "cannot recover this memory",
    `it is '${status}', not archived`,
    "recover only applies to archived facts",
  );

export const run = (argv) =>
  command("recover", fields, argv, (service, { id }) => {
    const outcome = service.recover(id);
    return outcome.ok ? ok({ recovered: true }) : failed(outcome, notArchived);
  });
