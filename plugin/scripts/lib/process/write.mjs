// write — the only way the kit changes a user's board file (plan F13 §4.5, §6). Mechanical fields
// only, written directly so they show in the user's diff.
//
// The edits are PURE text → text: they change one cell, one line or one inserted row/block and leave
// every other byte as it was (a table is never reflowed or realigned). `apply` / `applyAll` are the
// only I/O, with a re-read guard: if a file changed between the read and the write, nothing is written.
// A refusal is a `WriteError`; the CLIs turn it into a message and exit 2.
import { readFileSync, writeFileSync } from "node:fs";
import * as md from "./markdown.mjs";

export class WriteError extends Error {}

const refuse = (message) => {
  throw new WriteError(message);
};
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
// Raw lines keep their `\r`; lines made here end the same way as the file's.
const rawLines = (text) => text.split("\n");
const isItem = (line) => /^\s*[-*+]\s/.test(line);
const escapeCell = (value) => {
  const s = String(value ?? "");
  if (/[\r\n]/.test(s)) refuse("a cell cannot hold a line break");
  return s.replace(/(?<!\\)\|/g, "\\|");
};

/** The table under `heading` (the first one in the section), or a refusal that says what is missing. */
function tableUnder(text, heading) {
  const sec = md.section(text, heading);
  if (!sec) return refuse(`no heading "${heading}"`);
  return md.tableIn(text, sec) ?? refuse(`no table under "${heading}"`);
}

/** Offsets `[start, end)` of each cell's raw text (between unescaped pipes) in one table line. */
function cellSpans(raw) {
  const end = raw.trimEnd().length;
  const pipes = [];
  for (let i = 0; i < end; i++) if (raw[i] === "|" && raw[i - 1] !== "\\") pipes.push(i);
  const closed = pipes.at(-1) === end - 1;
  return pipes.map((p, i) => [p + 1, pipes[i + 1] ?? end]).slice(0, closed ? -1 : undefined);
}

/** Replace a cell's text, keeping its padding: a shorter value leaves the cell the same width. */
function recell(raw, value) {
  const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
  const [head, tail] = body ? [lead, trail] : [" ", raw.slice(1)];
  const room = Math.max(tail ? 1 : 0, tail.length - (value.length - body.length));
  return head + value + " ".repeat(room);
}

/** Set one table cell: the row whose `idColumn` is `id` (read as the reader does: plain, then the
 *  optional `idMatch` regex), the cell under `column`. Zero or several matching rows are refused. */
export function setCell(text, { heading, idColumn, id, column, value, idMatch }) {
  const table = tableUnder(text, heading);
  for (const name of [idColumn, column])
    if (!table.header.includes(name)) refuse(`the "${heading}" table has no column "${name}"`);
  const idOf = (cell) => (idMatch ? md.applyMatch(md.plain(cell), idMatch) : md.plain(cell));
  const hits = table.rows.filter((r) => idOf(r.cells[idColumn]) === id);
  if (hits.length === 0) refuse(`no row "${id}" under "${heading}"`);
  if (hits.length > 1) refuse(`"${id}" is on ${hits.length} rows under "${heading}"; not guessing`);
  const out = rawLines(text);
  const at = hits[0].line - 1;
  const span = cellSpans(out[at])[table.header.indexOf(column)];
  if (!span) refuse(`the "${id}" row has no "${column}" cell`);
  const [start, end] = span;
  out[at] =
    out[at].slice(0, start) +
    recell(out[at].slice(start, end), escapeCell(value)) +
    out[at].slice(end);
  return out.join("\n");
}

/** Set an existing frontmatter key's value (flat `key: value`), keeping the rest of the line. */
export function setKey(text, { key, value }) {
  const fm = md.frontmatter(text);
  if (!fm || !Object.hasOwn(fm.lines, key)) return refuse(`no frontmatter key "${key}"`);
  if (/[\r\n]/.test(value)) refuse("a frontmatter value cannot hold a line break");
  const out = rawLines(text);
  const at = fm.lines[key] - 1;
  const cr = out[at].endsWith("\r") ? "\r" : "";
  out[at] = out[at].replace(/^([\w.-]+:\s*).*$/, (_, head) => head + value) + cr;
  return out.join("\n");
}

/** Insert a row into the table under `heading`. `cells` maps header name → text (headers it omits
 *  stay empty; names the table lacks are refused). `at` is "end", or "after-last:<column>": after
 *  the last row whose cell in that column equals the new row's, else at the end. Neighbours are
 *  untouched. */
export function insertRow(text, { heading, cells, at = "end" }) {
  const table = tableUnder(text, heading);
  const unknown = Object.keys(cells).filter((name) => !table.header.includes(name));
  if (unknown.length) refuse(`the "${heading}" table has no column "${unknown.join('", "')}"`);
  const row = `| ${table.header.map((name) => escapeCell(cells[name])).join(" | ")} |`;
  let after = table.rows.at(-1)?.line ?? table.line + 1; // the separator when the table is empty
  const column = at.startsWith("after-last:") ? at.slice("after-last:".length) : null;
  if (column !== null) {
    if (!table.header.includes(column) || !Object.hasOwn(cells, column))
      refuse(`after-last:${column} needs the column in the table and in the new row`);
    const same = table.rows.filter((r) => md.plain(r.cells[column]) === md.plain(cells[column]));
    if (same.length) after = same.at(-1).line;
  } else if (at !== "end") refuse(`unknown position "${at}"`);
  const out = rawLines(text);
  const cr = out[after - 1]?.endsWith("\r") ? "\r" : "";
  out.splice(after, 0, row + cr);
  return out.join("\n");
}

// Insert `added` lines at the end of a section's body (after its last non-blank line); the
// section's trailing blank lines stay where they were. `joined` = no blank line between.
function insertInSection(text, heading, added, joined) {
  const sec = md.section(text, heading);
  if (!sec) return refuse(`no heading "${heading}"`);
  const out = rawLines(text);
  const cr = eolOf(text) === "\r\n" ? "\r" : "";
  let last = sec.end;
  while (last > sec.line && out[last - 1].trim() === "") last--;
  const empty = last === sec.line; // nothing under the heading yet
  const keep = joined || (!empty && isItem(out[last - 1]) && isItem(added[0]));
  const lines = [...(empty || !keep ? [cr] : []), ...added.map((l) => l + cr)];
  out.splice(last, 0, ...lines);
  return out.join("\n");
}

const splitBlock = (block) => block.replace(/\r?\n$/, "").split(/\r?\n/);

/** Append a block (one or more lines) at the end of the section under heading `under`: a blank
 *  line before it, unless it continues a list. */
export function appendBlock(text, { under, block }) {
  return insertInSection(text, under, splitBlock(block), false);
}

/** Append one line at the end of the section under `heading`, directly after its last line. */
export function appendLine(text, { heading, line }) {
  if (/[\r\n]/.test(line)) refuse("a line cannot contain a line break");
  return insertInSection(text, heading, [line], true);
}

/** Apply edits `[{ file, edit }]` (`edit`: text → text, may throw `WriteError`) as one step: read
 *  every file and compute every edit first, re-read to check nothing changed meanwhile, then write.
 *  Any refusal or changed file → nothing is written. Several edits on one file compose in order. */
export function applyAll(edits) {
  const seen = new Map(); // file → { before, after }
  for (const { file, edit } of edits) {
    const state = seen.get(file) ?? { before: readFileSync(file, "utf8") };
    seen.set(file, { before: state.before, after: edit(state.after ?? state.before) });
  }
  for (const [file, { before }] of seen)
    if (readFileSync(file, "utf8") !== before)
      refuse(`${file} changed while it was being edited; nothing written`);
  for (const [file, { after }] of seen) writeFileSync(file, after);
  return [...seen.keys()];
}

/** One file: `applyAll` for a single edit. */
export const apply = (file, edit) => applyAll([{ file, edit }]);
