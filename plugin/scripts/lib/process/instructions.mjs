// instructions — the Agentry block in a repo's `AGENTS.md` and the `@AGENTS.md` import in its `CLAUDE.md`
// (plan R1b §3, F18). AGENTS.md is the one instruction file every host reads; Claude Code reads it next to
// a CLAUDE.md only through that import. PURE: text in, text out. The block sits between `BEGIN` and `END`,
// and nothing outside the markers is ever changed. Re-running gives the same bytes, and a file's CRLF line
// ends are kept.
//
// renderBlock(template, { prompt }) -> string       the block, markers included, LF, no final line end
// upsertBlock(text | null, block) -> { text, action, old } | { error }
//   action "create" (no file) | "append" (no block yet) | "replace" (an older or edited block) | "unchanged"
// addImport(text) -> { text, action }               action "import" | "has-import"

export const BEGIN = "<!-- agentry:begin v1 -->";
export const END = "<!-- agentry:end -->";
export const IMPORT = "@AGENTS.md";
// Any version's begin marker, so an older block is replaced rather than kept beside the new one.
const BEGIN_LINE = /^<!-- agentry:begin v\d+ -->[ \t]*\r?$/gm;
const END_LINE = /^<!-- agentry:end -->[ \t]*\r?$/gm;
// The import as Claude Code reads it: a whitespace-delimited `@AGENTS.md` or `@./AGENTS.md`.
const HAS_IMPORT = /(^|\s)@(\.\/)?AGENTS\.md(?=\s|$)/;
const BOM = "﻿";

const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const withEol = (text, eol) => text.split("\n").join(eol);

/** The block from the template: `{prompt}` is the conductor prompt's path; without one, every line
 *  naming it is left out. */
export function renderBlock(template, { prompt } = {}) {
  const body = template
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => prompt || !line.includes("{prompt}"))
    .map((line) => line.replaceAll("{prompt}", prompt ?? ""))
    .join("\n")
    .trim();
  return `${BEGIN}\n${body}\n${END}`;
}

/** `text` (null when AGENTS.md does not exist) with `block` in place of the old block, or appended after
 *  a blank line when it has none. More than one block, or markers that don't pair, is an `error`. */
export function upsertBlock(text, block) {
  if (text === null) return { text: `${block}\n`, action: "create", old: null };
  const eol = eolOf(text);
  const next = withEol(block, eol);
  const begins = [...text.matchAll(BEGIN_LINE)];
  const ends = [...text.matchAll(END_LINE)];
  if (!begins.length && !ends.length) {
    const base = text === "" || text.endsWith("\n") ? text : `${text}${eol}`;
    const gap = base.trim() ? eol : "";
    return { text: `${base}${gap}${next}${eol}`, action: "append", old: null };
  }
  if (begins.length !== 1 || ends.length !== 1 || ends[0].index < begins[0].index)
    return {
      error: `${begins.length} begin and ${ends.length} end marker(s) that don't make one block; fix them by hand`,
    };
  const start = begins[0].index;
  const stop = ends[0].index + ends[0][0].replace(/\r$/, "").length;
  const old = text.slice(start, stop);
  if (old === next) return { text, action: "unchanged", old };
  return { text: text.slice(0, start) + next + text.slice(stop), action: "replace", old };
}

/** `text` (an existing CLAUDE.md) with `@AGENTS.md` as its first line, unless it already imports it. */
export function addImport(text) {
  if (HAS_IMPORT.test(text)) return { text, action: "has-import" };
  const bom = text.startsWith(BOM) ? BOM : "";
  const rest = text.slice(bom.length);
  return { text: `${bom}${IMPORT}${eolOf(text)}${rest}`, action: "import" };
}
