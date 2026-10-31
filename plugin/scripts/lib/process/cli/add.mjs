// board add <kind> --json '{"id": "…", …}' — write a new item at every `create` location of its kind:
// each row (own table, or the parent's file) and each block (plan F13 §2.2, §2.4). The id is passed in
// (`next-id` proposes it); a duplicate id is refused. All files are edited as one step, or none. A
// parent given as one of its field's `also` values (LATER) is no item: the parent-file rows and the
// blocks that name `{parent.…}` are skipped, and the output says so.
//
// run(argv, { root, spec, model, today? }) -> { exit, out }   exit 0 = written, 2 = usage or refusal
import { join } from "node:path";
import { escapesRoot, own } from "../spec.mjs";
import { WriteError, appendBlock, applyAll, insertRow } from "../write.mjs";

export const usage = 'add <kind> --json \'{"id": "…", …}\'';
export const flags = { "--json": true };
const fail = (out) => ({ exit: 2, out });
const isoToday = () => new Date().toLocaleDateString("sv-SE");

// How a JSON value reads in a cell: lists joined, a flag as its mark, null as nothing.
function show(value, def) {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? (def?.mark ?? "yes") : "";
  return value === undefined || value === null ? "" : String(value);
}

export function run(argv, { root, spec, model, today = isoToday() }) {
  const kindName = argv.find((a) => !a.startsWith("--"));
  const json = argv[argv.indexOf("--json") + 1];
  if (!kindName || argv.indexOf("--json") < 0 || json === undefined) return fail(`usage: ${usage}`);
  const kind = own(spec.kinds, kindName);
  if (!kind)
    return fail(`unknown kind "${kindName}" (kinds: ${Object.keys(spec.kinds).join(", ")})`);
  const create = kind.create;
  if (!create) return fail(`${kindName} has no "create" in the process file`);
  let given;
  try {
    given = JSON.parse(json);
  } catch (error) {
    return fail(`--json is not valid JSON (${error.message})`);
  }
  if (given === null || typeof given !== "object" || Array.isArray(given))
    return fail("--json must be an object");
  const id = typeof given.id === "string" ? given.id.trim() : "";
  if (!id) return fail('--json needs an "id" (see next-id)');
  if (model.kinds[kindName].items.some((i) => i.id === id))
    return fail(`${kindName} "${id}" is already on the board`);

  // The parent item: the id held by the field with `role: parent`, looked up in the kinds it refs. A
  // value the field's `also` lists (a parking word such as LATER) is `{ also }`: no item, no file.
  const parentField = Object.entries(kind.fields ?? {}).find(([, d]) => d.role === "parent");
  const parentOf = () => {
    if (!parentField) throw new WriteError(`${kindName} has no parent field`);
    const [name, def] = parentField;
    const wanted = show(given[name]);
    if (def.also?.includes(wanted)) return { also: wanted };
    const found = [def.ref]
      .flat()
      .flatMap((k) => own(model.kinds, k)?.items ?? [])
      .find((i) => i.id === wanted);
    if (!found) throw new WriteError(`${name} "${wanted}" is not on the board`);
    return found;
  };
  let parent;
  const parentItem = () => {
    parent ??= parentOf();
    return parent;
  };
  // A `{parent.…}` placeholder when the parent is an `also` value: the place that needs it is skipped.
  class NoParent extends WriteError {}

  const values = { today, ...given, id };
  const known = new Set([...Object.keys(kind.fields ?? {}), ...(create.ask ?? []), "id", "today"]);
  const render = (template) =>
    template.replace(/\{([\w.]+)\}/g, (_, name) => {
      if (name.startsWith("parent.")) {
        const p = parentItem();
        if (p.also) throw new NoParent(`${p.also} is not an item on the board`);
        const key = name.slice("parent.".length);
        return show(
          own(p.fields, key) ?? (key === "id" ? p.id : undefined),
          own(spec.kinds[p.kind].fields, key),
        );
      }
      if (!known.has(name) && !Object.hasOwn(values, name))
        throw new WriteError(`unknown placeholder {${name}}`);
      return show(own(values, name), own(kind.fields, name));
    });

  const edits = [];
  const notes = [];
  const place = (file, edit, note) => {
    if (escapesRoot(spec.root, file)) throw new WriteError(`${file} leaves the repository`);
    edits.push({ file: join(root, spec.root, file), edit });
    notes.push(`${note} (${file})`);
  };
  try {
    for (const row of create.rows ?? []) {
      const cells = Object.fromEntries(Object.entries(row.cells).map(([h, t]) => [h, render(t)]));
      const field = row.at.startsWith("after-last:") ? row.at.slice("after-last:".length) : null;
      const column = field === null ? null : own(kind.fields, field)?.column;
      if (field !== null && !column)
        throw new WriteError(`after-last:${field} names no ${kindName} field`);
      const at = field === null ? row.at : `after-last:${column}`;
      let file;
      let heading;
      if (row.in === "self") {
        if (kind.at.table === undefined)
          throw new WriteError(`${kindName} lives in one file per item; no table to add a row to`);
        ({ table: file, heading } = kind.at);
      } else {
        const section = row.in.slice("parent.file:".length);
        const p = parentItem();
        if (p.also) {
          notes.push(`skipped the row in ${p.also}'s file: ${p.also} is not an item on the board`);
          continue;
        }
        const def = own(spec.kinds[p.kind].file?.sections, section);
        if (def?.as !== "table")
          throw new WriteError(`${p.kind} section "${section}" is not a table`);
        if (!p.own) {
          notes.push(`skipped the row in ${p.kind} ${p.id}'s file: it has none`);
          continue;
        }
        file = p.own.path;
        heading = def.heading;
      }
      place(
        file,
        (text) => insertRow(text, { heading, cells, at }),
        `row ${id} under "${heading}"`,
      );
    }
    for (const block of create.blocks ?? []) {
      let under;
      let lines;
      try {
        under = block.under === "ask" ? given.under : render(block.under);
        lines = render(block.text);
      } catch (error) {
        if (!(error instanceof NoParent)) throw error;
        notes.push(`skipped the block under "${block.under}": ${error.message}`);
        continue;
      }
      if (typeof under !== "string" || !under)
        throw new WriteError('--json needs an "under" heading for the block');
      place(
        block.file,
        (text) => appendBlock(text, { under, block: lines }),
        `block under "${under}"`,
      );
    }
    applyAll(edits);
  } catch (error) {
    if (error instanceof WriteError) return fail(error.message);
    throw error;
  }
  return { exit: 0, out: [`added ${kindName} ${id}`, ...notes.map((n) => `  ${n}`)].join("\n") };
}
