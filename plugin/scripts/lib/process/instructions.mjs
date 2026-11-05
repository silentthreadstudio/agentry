// instructions — the Agentry block in a repo's `AGENTS.md` and the `@AGENTS.md` import in its `CLAUDE.md`
// (plan R1b §3, F18). AGENTS.md is the one instruction file every host reads; Claude Code reads it next to
// a CLAUDE.md only through that import. PURE: text in, text out. The block sits between `BEGIN` and `END`,
// and nothing outside the markers is ever changed. Re-running gives the same bytes, and a file's CRLF line
// ends are kept. Markers inside a fenced code block are examples, not the block; likewise an import inside
// a fenced code block, an HTML comment or an inline code span is not an import.
//
// renderBlock(template, { prompt }) -> string       the block, markers included, LF, no final line end
// upsertBlock(text | null, block) -> { text, action, old } | { error }
//   action "create" (no file) | "append" (no block yet) | "replace" (an older or edited block) | "unchanged"
// addImport(text, ref?) -> { text, action }         action "import" | "has-import"; `ref` is `@AGENTS.md`
//   (a root CLAUDE.md, the default) or `@../AGENTS.md` (the one in `.claude/`)
// hasBlock(text) -> boolean                         a marker outside a fenced code block
// removeBlock(text) -> { text, action, old } | { error }   the exact inverse of `upsertBlock`'s append:
//   the marker range, its line end and the one blank line before it; action "remove" | "none"
// maskFences(text), maskBlocks(masked)              the text with fences / Agentry blocks blanked out
import { maskFences } from "./markdown.mjs";

// The kit's one fence rule is markdown.mjs's; the lint takes it from here.
export { maskFences };

export const BEGIN = "<!-- agentry:begin v1 -->";
export const END = "<!-- agentry:end -->";
export const IMPORT = "@AGENTS.md";
export const CLAUDE_DIR_IMPORT = "@../AGENTS.md";
// Any version's begin marker, so an older block is replaced rather than kept beside the new one.
const BEGIN_LINE = /^<!-- agentry:begin v\d+ -->[ \t]*\r?$/gm;
const END_LINE = /^<!-- agentry:end -->[ \t]*\r?$/gm;
const BOM = "﻿";
// One line against a marker pattern (the patterns are global, so `.test` would carry state).
const matches = (re, line) => new RegExp(re.source).test(line);

const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const withEol = (text, eol) => text.split("\n").join(eol);
// The same text with every character but the line ends turned into a space: offsets stay valid.
const blank = (text) => text.replace(/[^\r\n]/g, " ");

// The import as Claude Code reads it: whitespace-delimited, with an optional leading `./`.
const importPattern = (ref) =>
  new RegExp(`(^|\\s)@(\\./)?${ref.slice(1).replace(/[.\\/]/g, "\\$&")}(?=\\s|$)`);

/** The block from the template: `{prompt}` is the conductor prompt's path; without one, every line
 *  naming it is left out. */
export function renderBlock(template, { prompt } = {}) {
  const body = template
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => prompt || !line.includes("{prompt}"))
    // A function, so `$&` or `$1` in a path stays as written.
    .map((line) => line.replaceAll("{prompt}", () => prompt ?? ""))
    .join("\n")
    .trim();
  return `${BEGIN}\n${body}\n${END}`;
}

/** `text` (null when AGENTS.md does not exist) with `block` in place of the old block, or appended after
 *  a blank line when it has none. More than one block, or markers that don't pair, is an `error`. */
export function upsertBlock(text, block) {
  if (text === null) return { text: `${block}\n`, action: "create", old: null };
  // A byte-order mark in front of line 1 must not hide a marker on it.
  if (!text.startsWith(BOM)) return upsert(text, block);
  const res = upsert(text.slice(BOM.length), block);
  return res.error ? res : { ...res, text: BOM + res.text };
}

// The marker range [start, stop) of the one block in `masked` (fences blanked), null when it has none, or
// an `error` when the markers don't make one block.
function blockRange(masked) {
  const begins = [...masked.matchAll(BEGIN_LINE)];
  const ends = [...masked.matchAll(END_LINE)];
  if (!begins.length && !ends.length) return null;
  if (begins.length !== 1 || ends.length !== 1 || ends[0].index < begins[0].index)
    return {
      error: `${begins.length} begin and ${ends.length} end marker(s) that don't make one block; fix them by hand`,
    };
  return { start: begins[0].index, stop: ends[0].index + ends[0][0].replace(/\r$/, "").length };
}

function upsert(text, block) {
  const eol = eolOf(text);
  const next = withEol(block, eol);
  const range = blockRange(maskFences(text));
  if (!range) {
    const base = text === "" || text.endsWith("\n") ? text : `${text}${eol}`;
    const gap = base.trim() ? eol : "";
    return { text: `${base}${gap}${next}${eol}`, action: "append", old: null };
  }
  if (range.error) return range;
  const { start, stop } = range;
  const old = text.slice(start, stop);
  if (old === next) return { text, action: "unchanged", old };
  return { text: text.slice(0, start) + next + text.slice(stop), action: "replace", old };
}

/** True when `text` has an Agentry marker line outside a fenced code block (whole block or not). */
export function hasBlock(text) {
  const masked = maskFences(text.startsWith(BOM) ? text.slice(BOM.length) : text);
  return [BEGIN_LINE, END_LINE].some((re) => masked.search(re) >= 0);
}

/** `text` with the block taken out: its marker range, the line end after it and the one blank line
 *  before it (what an append added); every other byte stays, a byte-order mark and CRLF included. A file
 *  that held only the block comes back empty. No block is `action: "none"`; markers that don't make
 *  one block is an `error`. */
export function removeBlock(text) {
  const bom = text.startsWith(BOM) ? BOM : "";
  const rest = text.slice(bom.length);
  const range = blockRange(maskFences(rest));
  if (!range) return { text, action: "none", old: null };
  if (range.error) return range;
  const { start, stop } = range;
  let before = rest.slice(0, start);
  const gap = /\r?\n$/.exec(before);
  if (gap) {
    const kept = before.slice(0, gap.index);
    if (/\n$/.test(kept) && kept.trim()) before = kept;
  }
  const after = rest.slice(stop).replace(/^\r?\n/, "");
  return { text: bom + before + after, action: "remove", old: rest.slice(start, stop) };
}

/** `masked` (fences already blanked) with every Agentry block, markers included, blanked out; a block
 *  with no end marker runs to the end. */
export function maskBlocks(masked) {
  let inside = false;
  return masked
    .split(/(?<=\n)/)
    .map((line) => {
      const bare = line.replace(/\r?\n$/, "");
      const begins = !inside && matches(BEGIN_LINE, bare);
      const ends = inside && matches(END_LINE, bare);
      const hide = inside || begins;
      if (begins) inside = true;
      if (ends) inside = false;
      return hide ? blank(line) : line;
    })
    .join("");
}

/** `text` (an existing CLAUDE.md) with `ref` as its first line, unless it already imports it. */
export function addImport(text, ref = IMPORT) {
  const bom = text.startsWith(BOM) ? BOM : "";
  const rest = text.slice(bom.length);
  const live = maskFences(rest)
    .replace(/<!--[\s\S]*?(-->|$)/g, blank)
    .replace(/`[^`\n]*`/g, blank);
  if (importPattern(ref).test(live)) return { text, action: "has-import" };
  return { text: `${bom}${ref}${eolOf(text)}${rest}`, action: "import" };
}
