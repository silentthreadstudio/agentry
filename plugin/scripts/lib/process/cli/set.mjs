// board set <kind> <id> <field>=<value> [--apply] — change one mechanical field of one item: a table cell,
// or a frontmatter key for a one-file-per-item kind. One cell per write, every other byte kept (plan F13
// §2.4). Without `--apply` it runs the same edit and refusals and writes nothing (A39).
//
// run(argv, { root, spec, model }) -> { exit, out }   exit 0 = written or previewed, 2 = usage or refusal
// (nothing written)
import { join } from "node:path";
import { PREVIEW, refuse, usageError } from "../../cli/help.mjs";
import { escapesRoot, own } from "../spec.mjs";
import { WriteError, apply, setCell, setKey } from "../write.mjs";

export const help = {
  usage: "set <kind> <id> <field>=<value> [--apply]",
  purpose: "Change one field of one item: its table cell, or its frontmatter key.",
  args: {
    "<kind>": "a kind the process file knows",
    "<id>": "the item's id",
    "<field>=<value>": "a field of that kind (not its id) and the text to write",
  },
  flags: { "--apply": "write it (without: say what it would write, and write nothing)" },
  exits: { 0: "written, or previewed", 2: "usage, or refused (nothing written)" },
  example: "board set task T-4 status=blocked --apply",
};
const fail = (why, next) => refuse("board set", why, next);

export function run(argv, { root, spec, model }) {
  const [kindName, id, assignment] = argv.filter((a) => !a.startsWith("--"));
  const write = argv.includes("--apply");
  const at = assignment?.indexOf("=") ?? -1;
  if (!kindName || !id || at < 1)
    return usageError("board set", "needs <kind> <id> <field>=<value>");
  const fieldName = assignment.slice(0, at);
  const value = assignment.slice(at + 1);
  const kind = own(spec.kinds, kindName);
  if (!kind)
    return fail(`unknown kind "${kindName}" (kinds: ${Object.keys(spec.kinds).join(", ")})`);
  const field = own(kind.fields, fieldName);
  if (!field) return fail(`${kindName} has no field "${fieldName}"`, "board explain");
  const idKey = kind.id?.column ?? kind.at.id?.replace(/^frontmatter:/, "");
  if (field.column === idKey)
    return fail(`"${fieldName}" shares the id column; not rewriting an id`);
  const known = kind.status?.values;
  if (kind.status?.field === fieldName && known && !Object.hasOwn(known, value))
    return fail(`"${value}" is not a ${kindName} status (${Object.keys(known).join(", ")})`);
  const items = model.kinds[kindName].items.filter((i) => i.id === id);
  if (items.length !== 1)
    return fail(
      `${items.length ? "several" : "no"} ${kindName} "${id}" on the board`,
      "board status",
    );

  const table = kind.at.table !== undefined;
  const file = table ? kind.at.table : items[0].file;
  if (escapesRoot(spec.root, file)) return fail(`${file} leaves the repository`);
  const edit = table
    ? (text) =>
        setCell(text, {
          heading: kind.at.heading,
          idColumn: kind.id.column,
          idMatch: kind.id.match,
          id,
          column: field.column,
          value,
        })
    : (text) => setKey(text, { key: field.column, value });
  try {
    apply(join(root, spec.root, file), edit, { preview: !write });
  } catch (error) {
    if (error instanceof WriteError) return fail(`${file}: ${error.message}`);
    throw error;
  }
  const line = `${kindName} ${id} ${fieldName}=${value} (${file})`;
  return { exit: 0, out: write ? `set ${line}` : `would set ${line}\n${PREVIEW}` };
}
