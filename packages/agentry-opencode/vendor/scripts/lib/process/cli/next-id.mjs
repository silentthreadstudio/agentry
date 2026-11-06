// board next-id <kind> — the next free id from the kind's `create.id` pattern (see
// `ids.mjs`), or with `--family <prefix>` the next free one in that prefix family across the board, whatever
// `create.id` says. Exit 2 when the kind asks for its ids (`"ask"`) and no family is given, the
// pattern needs more than a number, or the family is missing or has no letter. Writes nothing.
//
// run(argv, { spec, model }) -> { exit, out }
import { refuse, usageError } from "../../cli/help.mjs";
import { nextId, nextInFamily } from "../ids.mjs";
import { own } from "../spec/shape.mjs";

export const help = {
  usage: "next-id <kind> [--family <prefix>] [--json]",
  purpose:
    "The next free id of a kind, from its create.id pattern or a prefix family. Writes nothing.",
  args: { "<kind>": "a kind the process file knows (task, sprint, decision…)" },
  flags: {
    "--family <prefix>":
      "the next free id among every board id that is <prefix>, a separator and a number (ART-19 after ART-18)",
    "--json": "print { kind, id } (and family) as one JSON object",
  },
  exits: {
    0: "printed",
    2: "usage, or the kind's ids are chosen by hand and no --family is given",
  },
  example: "board next-id task --family ART",
};

export function run(argv, { spec, model }) {
  const at = argv.indexOf("--family");
  if (at >= 0 && argv.lastIndexOf("--family") !== at)
    return usageError("board next-id", "--family is given twice");
  const family = at < 0 ? undefined : argv[at + 1];
  const name = argv.find((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));
  const kind = own(spec.kinds, name);
  if (!kind)
    return usageError(
      "board next-id",
      `${name ? `unknown kind "${name}"` : "needs a kind"} (kinds: ${Object.keys(spec.kinds).join(", ")})`,
    );
  const json = argv.includes("--json");
  if (at >= 0) {
    if (!family || family.startsWith("--"))
      return usageError("board next-id", "--family needs a value");
    const next = nextInFamily(spec, model, family);
    if (next.error) return usageError("board next-id", next.error);
    return {
      exit: 0,
      out: json ? JSON.stringify({ kind: name, family: next.family, id: next.id }) : next.id,
    };
  }
  const { id, error } = nextId(name, kind, model);
  const byHand = !kind.create?.id || kind.create.id === "ask";
  if (error)
    return refuse(
      "board next-id",
      error,
      byHand ? `board next-id ${name} --family <prefix>` : undefined,
    );
  return { exit: 0, out: json ? JSON.stringify({ kind: name, id }) : id };
}
