// board-diff — what changed between two versions of a board, read at the model level (plan R1b-5).
// `lane merge` uses it to tell which of main's uncommitted board edits it may carry into its board
// commit (only exec's lifecycle writes); anything else that asks "did only lifecycle cells change?"
// can use it the same way.
//
// PURE: the caller reads both versions (the Model `readProcess` returns for each, and a reader of each
// version's file text); this module compares them and returns data. No I/O.
//
//   boardFiles(spec, model) -> string[]
//     The files `model` was read from (each kind's table, each item's file and its own file), relative
//     to the git root, sorted.
//
//   diffBoard({ spec, before, after, files = [] }) -> { cells: Cell[], other: Other[] }
//     before, after: { model, text(file) -> string | null }   (file relative to the git root)
//     files: paths known to differ (git's list); one that is not a board file is `other`.
//     Cell  = { kind, id, field, column, file, line, from, to }   a field the reader reads differently
//     Other = { file, line?, what }                               any other difference, in words
//     Content-exact: a changed line counts as cell changes only when it holds the same item in both
//     versions (a table row, or a frontmatter key of the item's file) and every byte outside the cells
//     of its changed fields is equal. Padding inside a changed cell may move. Anything else is `other`:
//     prose, a handoff line, a line added or removed, another cell, a cell whose text changed while it
//     reads the same, a file that is not the board's.
//
//   strayChanges(spec, diff, { ids }) -> string[]
//     One line per change that is NOT a lifecycle cell (a field `lifecycle.write` names for status,
//     verdict or commit, on `lifecycle.kind`) of an item whose id is in `ids`: every `other`, and every
//     other cell. [] means the diff is exactly lifecycle cells of those items.
//
//   cellText(spec, board, { kind, id, column }) -> string | null
//     The text of item `id`'s cell under `column`, found by the id wherever its row is now: a table
//     cell trimmed (`\|` read as `|`), or a frontmatter key's value. null when `id` is not on `board`
//     once or has no such cell.
//
//   cellEdits(spec, board, cells) -> { edits, set, there, conflicts }
//     cells: [{ kind, id, column, file, from, to }], `from` and `to` as `cellText` reads them.
//     Setting each cell to `to` on `board`, at the model level: a cell that reads `from` is `set` (its
//     edit, the board writer's own `setCell` / `setKey`, is in `edits`: [{ file, edit(text) -> text }],
//     file relative to the git root); one that reads `to` already is `there`; one that reads anything
//     else is a `conflict` ({ ...cell, now }). Another row moving or changing does not matter.
import { posix } from "node:path";
import * as md from "./markdown.mjs";
import { own } from "./spec.mjs";
import { setCell, setKey } from "./write.mjs";

const LIFECYCLE_WRITES = ["status", "verdict", "commit"];
const show = (value) => JSON.stringify(value ?? null);
const excerpt = (line) => {
  const text = (line ?? "").trim();
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};
const at = (spec, file) => posix.join(spec.root ?? ".", file);
const isTable = (spec, kind) => typeof spec.kinds?.[kind]?.at?.table === "string";

/** The board files `model` was read from, relative to the git root, sorted. */
export function boardFiles(spec, model) {
  const files = new Set();
  for (const [name, kind] of Object.entries(spec.kinds ?? {})) {
    if (typeof kind.at?.table === "string") files.add(at(spec, kind.at.table));
    for (const item of own(model.kinds, name)?.items ?? []) {
      if (item.file) files.add(at(spec, item.file));
      if (item.own?.path) files.add(at(spec, item.own.path));
    }
  }
  return [...files].sort();
}

// Where an item is read from: a table row by its file and line, a one-file item by its file.
const placeOf = (spec, kind, file, line) =>
  JSON.stringify([kind, file, isTable(spec, kind) ? line : 0]);
function placed(spec, model) {
  const out = new Map();
  for (const [kind, { items }] of Object.entries(model.kinds ?? {}))
    for (const item of items)
      if (item.file) out.set(placeOf(spec, kind, at(spec, item.file), item.line), item);
  return out;
}

// The same item in both versions at one place, or null.
function sameItem(ctx, kind, file, line) {
  const key = placeOf(ctx.spec, kind, file, line);
  const [x, y] = [ctx.was.get(key), ctx.now.get(key)];
  return x && y && x.id === y.id ? y : null;
}

// The columns (or frontmatter keys) of `item`'s changed fields, and of all its fields.
function columnsOf(ctx, item) {
  const fields = Object.values(ctx.spec.kinds[item.kind].fields ?? {}).map((f) => f.column);
  const changed = ctx.cells.filter((c) => c.kind === item.kind && c.id === item.id);
  return { all: new Set(fields), changed: new Set(changed.map((c) => c.column)) };
}

// Why a differing cell (or key) under `column` is not a field change, or null when it is one.
function cellWhy(ctx, item, column) {
  const { all, changed } = columnsOf(ctx, item);
  if (changed.has(column)) return null;
  if (all.has(column))
    return `${item.id}: the "${column}" cell's text changed, but it reads the same`;
  return `${item.id}: the "${column}" cell changed, and no field reads it`;
}

// A table line split on its unescaped pipes: the text before the first, the cells, the text after.
function rowParts(line) {
  const parts = line.split(/(?<!\\)\|/);
  const closed = /(?<!\\)\|\s*$/.test(line.replace(/\r$/, ""));
  return {
    lead: parts[0],
    cells: parts.slice(1, closed ? -1 : undefined),
    tail: closed ? parts.at(-1) : "",
  };
}

// A differing row of `item`'s table: null when only its changed fields' cells differ.
function rowWhy(ctx, item, n, a, b, before) {
  const [x, y] = [rowParts(a), rowParts(b)];
  if (x.lead !== y.lead || x.tail !== y.tail) return `the ${item.id} row changed outside its cells`;
  if (x.cells.length !== y.cells.length)
    return `the ${item.id} row has a different number of cells`;
  const header = md.tables(before).find((t) => t.rows.some((r) => r.line === n))?.header ?? [];
  const whys = x.cells
    .map((cell, k) => (cell === y.cells[k] ? null : cellWhy(ctx, item, header[k] ?? `#${k + 1}`)))
    .filter(Boolean);
  return whys.length ? whys.join("; ") : null;
}

// The line that closes a file's frontmatter (1-based), or 0 when it has none.
const frontmatterEnd = (lines) =>
  lines[0]?.trim() === "---" ? lines.findIndex((l, i) => i > 0 && l.trim() === "---") + 1 : 0;
const KEY = /^([\w.-]+):(.*)$/;

// One differing line of a board file: null when it is exactly changed fields' cells, else why not.
function lineWhy(ctx, file, n, lines) {
  const [a, b] = [lines.before[n - 1], lines.after[n - 1]];
  for (const kind of Object.keys(ctx.spec.kinds ?? {})) {
    const item = sameItem(ctx, kind, file, n);
    if (!item) continue;
    if (isTable(ctx.spec, kind)) return rowWhy(ctx, item, n, a, b, lines.text);
    const end = Math.min(frontmatterEnd(lines.before), frontmatterEnd(lines.after));
    const [x, y] = [KEY.exec(a), KEY.exec(b)];
    if (n > 1 && n < end && x && y && x[1] === y[1]) return cellWhy(ctx, item, x[1]);
  }
  return `changed: "${excerpt(b)}"`;
}

// The differences of one board file present in both versions.
function fileChanges(ctx, file, a, b) {
  const lines = { before: a.split("\n"), after: b.split("\n"), text: a };
  if (lines.before.length !== lines.after.length) {
    let i = 0;
    while (lines.before[i] === lines.after[i]) i++;
    const near = excerpt(lines.after[i] ?? lines.before[i]);
    return [{ file, line: i + 1, what: `lines added or removed, from "${near}"` }];
  }
  const out = [];
  for (let i = 0; i < lines.before.length; i++) {
    if (lines.before[i] === lines.after[i]) continue;
    const why = lineWhy(ctx, file, i + 1, lines);
    if (why) out.push({ file, line: i + 1, what: why });
  }
  return out;
}

/** What changed between two versions of the board (see the header). */
export function diffBoard({ spec, before, after, files = [] }) {
  const ctx = { spec, was: placed(spec, before.model), now: placed(spec, after.model), cells: [] };
  for (const [key, item] of ctx.now) {
    const old = ctx.was.get(key);
    if (!old || old.id !== item.id) continue; // the line check below names it
    for (const [field, def] of Object.entries(spec.kinds[item.kind].fields ?? {})) {
      const [from, to] = [old.fields[field], item.fields[field]];
      if (show(from) === show(to)) continue;
      const file = at(spec, item.file);
      // A table row is the item's line; in a one-file item the cell is its own key's line.
      const keyLine = isTable(spec, item.kind)
        ? null
        : own(md.frontmatter(after.text(file) ?? "")?.lines, def.column);
      ctx.cells.push({
        kind: item.kind,
        id: item.id,
        field,
        column: def.column,
        file,
        line: keyLine ?? item.line,
        from,
        to,
      });
    }
  }
  const board = new Set([...boardFiles(spec, before.model), ...boardFiles(spec, after.model)]);
  const other = [...new Set(files)]
    .filter((file) => !board.has(file))
    .map((file) => ({ file, what: "not a board file" }));
  for (const file of [...board].sort()) {
    const [a, b] = [before.text(file), after.text(file)];
    if (a === b) continue;
    if (a === null || b === null)
      other.push({ file, what: a === null ? "a new board file" : "a board file removed" });
    else other.push(...fileChanges(ctx, file, a, b));
  }
  return { cells: ctx.cells, other };
}

/** The changes in `diff` that are not lifecycle cells of the items in `ids` (see the header). */
export function strayChanges(spec, diff, { ids }) {
  const life = spec.lifecycle;
  const write = life?.write ?? {};
  const fields = new Set(LIFECYCLE_WRITES.map((key) => own(write, key)).filter(Boolean));
  const open = new Set(ids);
  const where = (c) => `${c.file}${c.line ? `:${c.line}` : ""}`;
  const out = diff.other.map((o) => `${where(o)}: ${o.what}`);
  for (const c of diff.cells) {
    const change = `${c.kind} ${c.id} ${c.field} ${show(c.from)} → ${show(c.to)}`;
    if (c.kind !== life?.kind || !fields.has(c.field))
      out.push(`${where(c)}: ${change} is not a lifecycle cell`);
    else if (!open.has(c.id)) out.push(`${where(c)}: ${change}, but ${c.id} has no open lane`);
  }
  return out;
}

/** The text of one item's cell, found by its id (see the header). */
export function cellText(spec, board, { kind, id, column }) {
  const items = (own(board.model.kinds, kind)?.items ?? []).filter((item) => item.id === id);
  if (items.length !== 1 || !items[0].file) return null;
  const [item] = items;
  const text = board.text(at(spec, item.file));
  if (text === null) return null;
  if (isTable(spec, kind)) {
    const row = md
      .tables(text)
      .flatMap((t) => t.rows)
      .find((r) => r.line === item.line);
    return row && Object.hasOwn(row.cells, column) ? row.cells[column] : null;
  }
  const n = own(md.frontmatter(text)?.lines, column);
  return n ? KEY.exec(md.lines(text)[n - 1])[2].trim() : null;
}

// The board writer's edit that sets `cell` to its `to` text: the item's table cell, or its key.
function cellEdit(spec, { kind, id, column, to }) {
  const def = spec.kinds[kind];
  if (!isTable(spec, kind)) return (text) => setKey(text, { key: column, value: to });
  const { heading } = def.at;
  const { column: idColumn, match: idMatch } = def.id;
  return (text) => setCell(text, { heading, idColumn, idMatch, id, column, value: to });
}

/** Setting `cells` on `board` at the model level (see the header). */
export function cellEdits(spec, board, cells) {
  const out = { edits: [], set: [], there: [], conflicts: [] };
  for (const cell of cells) {
    const now = cellText(spec, board, cell);
    if (now !== null && now === cell.to) out.there.push(cell);
    else if (now === null || now !== cell.from) out.conflicts.push({ ...cell, now });
    else {
      out.set.push(cell);
      out.edits.push({ file: cell.file, edit: cellEdit(spec, cell) });
    }
  }
  return out;
}
