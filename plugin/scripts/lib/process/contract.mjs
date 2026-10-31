// contract — an item's contract block, found by id (plan F13 §8, the old F2 lookup). Tiers, first hit
// wins: (1) the kind's `contract.blocks` files from the process file, in order (the first hit is the
// block, every later hit is `related`); (2) Agentry task files `.agentry/work/*/tasks/*.md` by
// frontmatter `id`; (3) every `TASKS.md` in the repository. Two hits in tier 2 or 3 are `ambiguous`.
//
// A block starts where its id is the first token of a heading (`### F1 · …`) or of a bold run at the
// start of a line or right after a sentence (`- **T-03** (…)`, `**A1 splits.** **A1a** …`). It ends
// before the next line that starts a block of any id, or a heading of the same or a higher level (any
// heading, for a bold start). Ids match exactly: `DS-1` never matches `DS-1a`. Reads files only.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import * as md from "./markdown.mjs";

/** A token that reads as an item id: a capital, letters, an optional dash, then a digit (`F1`, `R0-6`,
 *  `T29a`, `AB-01`). Used to tell block starts from emphasis (`**Owns:**`, `**the seam**`). */
export const ID_TOKEN = /^[A-Z][A-Za-z]*-?\d[\w.-]*$/;
const BOLD = /(?<=^\s*(?:(?:[-*+]|\d+[.)])\s+)?|(?:\*\*|[.)])\s+)\*\*(.+?)\*\*/g;
const LINE_START = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?$/;
const SKIP = new Set(["node_modules", "dist"]);

const posix = (path) => path.split(sep).join("/");
const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** The git root at or above `dir` (the nearest directory holding `.git`), or null. */
export function gitRootOf(dir) {
  for (let at = resolve(dir); ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return null;
  }
}

/** Every `*.md` under `dir` (relative paths, sorted), skipping dot-directories, `node_modules` and
 *  `dist`: the repository's own documents, not tool state or vendored copies. */
export function markdownFiles(dir) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name)) walk(path);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(path);
    }
  };
  walk("");
  return out.sort();
}

/** Every block start in a text: `{ line, id, type: "heading" | "bold", level? }` (line 1-based). */
export function blockStarts(text) {
  const out = [];
  let fenced = false;
  md.lines(text).forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) fenced = !fenced;
    if (fenced) return;
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      const id = md.leadIds(h[2])[0];
      out.push({ line: i + 1, id, type: "heading", level: h[1].length });
      return;
    }
    for (const m of raw.matchAll(BOLD)) {
      const id = md.leadIds(m[1])[0];
      const inline = !LINE_START.test(raw.slice(0, m.index));
      if (id) out.push({ line: i + 1, id, type: "bold", ...(inline ? { inline } : {}) });
    }
  });
  return out;
}

/** Every block of `id` in a text: `{ line, block }`. `lead` limits which starts may open it. */
export function blocksIn(text, id, lead = ["heading", "bold"]) {
  const all = md.lines(text);
  const starts = blockStarts(text);
  // A start inside a line opens a block but does not end the one above: blocks are whole lines.
  const isStart = (s) => !s.inline && (s.id === id || ID_TOKEN.test(s.id ?? ""));
  const out = [];
  starts.forEach((s, i) => {
    if (s.id !== id || !lead.includes(s.type)) return;
    const end = starts
      .slice(i + 1)
      .find(
        (n) =>
          n.line > s.line &&
          (isStart(n) || (n.type === "heading" && (s.type === "bold" || n.level <= s.level))),
      );
    const body = all.slice(s.line - 1, end ? end.line - 1 : all.length);
    while (body.length > 1 && body.at(-1).trim() === "") body.pop();
    if (!out.some((b) => b.line === s.line)) out.push({ line: s.line, block: body.join("\n") });
  });
  return out;
}

const hitsIn = (root, files, id, lead) =>
  files.flatMap((file) => {
    const text = read(join(root, file));
    return text === null ? [] : blocksIn(text, id, lead).map((b) => ({ file, ...b }));
  });

// Tier 2: Agentry's own task files, one task per file, by frontmatter `id`.
function agentryHits(root, id) {
  const work = join(root, ".agentry", "work");
  let runs = [];
  try {
    runs = readdirSync(work).sort();
  } catch {
    return [];
  }
  const files = runs.flatMap((run) => {
    try {
      const names = readdirSync(join(work, run, "tasks")).filter((f) => f.endsWith(".md"));
      return names.sort().map((f) => `.agentry/work/${run}/tasks/${f}`);
    } catch {
      return [];
    }
  });
  return files.flatMap((file) => {
    const text = read(join(root, file));
    return text !== null && md.frontmatter(text)?.data.id === id
      ? [{ file, line: 1, block: text.trimEnd() }]
      : [];
  });
}

const where = ({ file, line }) => ({ file, line });
const isTasks = (file) => file === "TASKS.md" || file.endsWith("/TASKS.md");

/** `findContract({ root, spec?, id, kind = "task" })` → the F2 result:
 *  `{ status: "found", id, file, line, source: "process"|"agentry"|"discovered", block, related? }` or
 *  `{ status: "not-found"|"ambiguous", id, candidates: [{ file, line }] }`. `file` is relative to `root`. */
export function findContract({ root, spec, id, kind = "task" }) {
  const contract = spec?.kinds?.[kind]?.contract;
  if (contract) {
    const base = posix(relative(root, join(root, spec.root ?? ".")));
    const files = contract.blocks.map((f) => posix(join(base, f)));
    const [first, ...rest] = hitsIn(root, files, id, contract.lead ?? ["heading", "bold"]);
    if (first) {
      const found = { status: "found", id, ...where(first), source: "process", block: first.block };
      return rest.length ? { ...found, related: rest.map(where) } : found;
    }
  }
  const tiers = [
    ["agentry", () => agentryHits(root, id)],
    ["discovered", () => hitsIn(root, markdownFiles(root).filter(isTasks), id)],
  ];
  for (const [source, hits] of tiers) {
    const found = hits();
    const [hit] = found;
    if (found.length === 1) return { status: "found", id, ...where(hit), source, block: hit.block };
    if (found.length > 1) return { status: "ambiguous", id, candidates: found.map(where) };
  }
  return { status: "not-found", id, candidates: [] };
}
