// board set <kind> <id> <field>=<value> [--apply] — change one mechanical field of one item: a table cell,
// or a frontmatter key for a one-file-per-item kind. One cell per write, every other byte kept.
// Without `--apply` it runs the same edit and refusals and writes nothing. A write is
// recorded (`board-writes.mjs`) so a running lane's main-touched guard lets it through. Setting a kind's
// parent field also moves the item's row from the old parent's file to the new parent's, for each
// `create.rows` entry placed `in: "parent.file:<section>"`, in the same write; a new parent with no file
// is refused, naming the file.
//
// run(argv, { root, spec, model }) -> { exit, out }   exit 0 = written or previewed, 2 = usage or refusal
// (nothing written)
import { join, relative } from "node:path";
import { PREVIEW, refuse, renamed, usageError } from "../../cli/help.mjs";
import { recorded } from "../board-writes.mjs";
import { boardId } from "../ids.mjs";
import { landInProgress, landRefusal } from "../ledger.mjs";
import { escapesRoot, own } from "../spec/shape.mjs";
import { WriteError, applyAll, insertRow, setCell, setKey, takeRow } from "../write.mjs";

export const help = {
  usage: "set <kind> <id> <field>=<value> [--apply] [--json]",
  purpose: "Change one field of one item: its table cell, or its frontmatter key.",
  args: {
    "<kind>": "a kind the process file knows",
    "<id>": "the item's id, any case (D7 for a decision numbered 7)",
    "<field>=<value>": "a field of that kind (not its id) and the text to write",
  },
  flags: {
    "--apply": "write it (without: say what it would write, and write nothing)",
    "--json": "print { kind, id, field, value, file, applied } as one JSON object",
  },
  exits: { 0: "written, or previewed", 2: "usage, or refused (nothing written)" },
  example: "board set task T-4 status=blocked --apply",
};
const fail = (why, next) => refuse("board set", why, next);

// `edit` whose refusals name `file`, as every `set` refusal does.
const inFile = (file, edit) => (text) => {
  try {
    return edit(text);
  } catch (error) {
    throw error instanceof WriteError ? new WriteError(`${file}: ${error.message}`) : error;
  }
};

// The edits that move an item's rows in its parents' files when its parent field becomes `value`, and a
// line for each: `{ edits, notes }`. The row leaves the old parent's file (refused when it is not there)
// and goes, cell for cell, to the new parent's; an old parent with no file has no row to take, and a
// `also` value (LATER) holds no row, so only the cell changes then.
function moveRows({ root, spec, model, kindName, kind, fieldName, field, value, item }) {
  const rows = (kind.create?.rows ?? []).filter((r) => r.in.startsWith("parent.file:"));
  const old = String(item.fields[fieldName] ?? "");
  if (field.role !== "parent" || !rows.length || old === value) return { edits: [], notes: [] };
  const parents = [field.ref].flat().flatMap((k) => own(model.kinds, k)?.items ?? []);
  const from = parents.find((p) => p.id === old);
  const to = parents.find((p) => p.id === value);
  if (!to && !field.also?.includes(value))
    throw new WriteError(`${fieldName} "${value}" is not on the board`);
  const edits = [];
  const notes = [];
  for (const row of rows) {
    const sectionName = row.in.slice("parent.file:".length);
    const owner = to ?? from;
    const section = own(spec.kinds[owner?.kind]?.file?.sections, sectionName);
    if (section?.as !== "table")
      throw new WriteError(`${owner?.kind} section "${sectionName}" is not a table`);
    const idColumn =
      section.column ?? Object.entries(row.cells).find(([, cell]) => cell === "{id}")?.[0];
    if (to && !to.own) {
      const glob = spec.kinds[to.kind].file?.glob ?? `a file for ${to.kind} {id}`;
      throw new WriteError(
        `${to.kind} ${to.id} has no file (${glob.replace("{id}", to.id)}) to hold the row of ${kindName} ${item.id}`,
      );
    }
    if (!from?.own) {
      notes.push(
        `no row to move: ${old} has no file${to ? `; add the row to ${to.own.path}` : ""}`,
      );
      continue;
    }
    let taken;
    const place = (path) => {
      if (escapesRoot(spec.root, path)) throw new WriteError(`${path} leaves the repository`);
      return join(root, spec.root, path);
    };
    edits.push({
      file: place(from.own.path),
      edit: inFile(from.own.path, (text) => {
        const out = takeRow(text, { heading: section.heading, idColumn, id: item.id });
        taken = out.cells;
        return out.text;
      }),
    });
    if (to) {
      const field = row.at.startsWith("after-last:") ? row.at.slice("after-last:".length) : null;
      const column = field === null ? null : own(kind.fields, field)?.column;
      const at = column ? `after-last:${column}` : "end";
      edits.push({
        file: place(to.own.path),
        edit: inFile(to.own.path, (text) =>
          insertRow(text, { heading: section.heading, cells: taken, at }),
        ),
      });
    }
    notes.push(
      `row ${item.id} ${to ? `moved to ${to.own.path}` : "removed"} from ${from.own.path}`,
    );
  }
  return { edits, notes };
}

export function run(argv, { root, spec, model }) {
  const [kindName, typed, assignment] = argv.filter((a) => !a.startsWith("--"));
  const write = argv.includes("--apply");
  const at = assignment?.indexOf("=") ?? -1;
  if (at < 1 && argv.includes("--json") && argv.some((a) => a.trimStart().startsWith("{")))
    return renamed("board set", "--json '{…}'", "<field>=<value>", "0.3");
  if (!kindName || !typed || at < 1)
    return usageError("board set", "needs <kind> <id> <field>=<value>");
  const landing = write ? landInProgress(root) : null;
  if (landing) return fail(landRefusal(landing));
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
  const id = boardId(spec, model, typed, kindName);
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
  const target = join(root, spec.root, file);
  let moved;
  try {
    moved = moveRows({
      root,
      spec,
      model,
      kindName,
      kind,
      fieldName,
      field,
      value,
      item: items[0],
    });
    const edits = [{ file: target, edit: inFile(file, edit) }, ...moved.edits];
    const files = [...new Set(edits.map((e) => relative(root, e.file)))];
    if (write) recorded(root, files, `board set ${kindName} ${id}`, () => applyAll(edits));
    else applyAll(edits, { preview: true });
  } catch (error) {
    if (error instanceof WriteError) return fail(error.message);
    throw error;
  }
  if (argv.includes("--json")) {
    const data = { kind: kindName, id, field: fieldName, value, file, applied: write };
    return {
      exit: 0,
      out: JSON.stringify(moved.notes.length ? { ...data, notes: moved.notes } : data),
    };
  }
  const line = `${kindName} ${id} ${fieldName}=${value} (${file})`;
  const notes = moved.notes.map((n) => `  ${n}`);
  return {
    exit: 0,
    out: write
      ? [`set ${line}`, ...notes].join("\n")
      : [`would set ${line}`, ...notes, PREVIEW].join("\n"),
  };
}
