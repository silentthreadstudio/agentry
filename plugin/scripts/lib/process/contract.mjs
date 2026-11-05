// contract — an item's contract block, found by id in any case (plan F13 §8, the old F2 lookup). Tiers,
// the first with a hit answers: (1) with a process file, the files the item's own rows link as its
// contract (`[contract](path#anchor)` on the board or in its parent's file), then the kind's
// `contract.blocks`; a titled or owning block beats an acceptance-only line, which beats a bare one
// (an amendment, a deps note), every other hit is `related`, and two titled or owning blocks are
// `ambiguous` unless the item's link names one; (2) Agentry task files `.agentry/work/*/tasks/*.md` by
// frontmatter `id`; (3) every git-tracked `TASKS.md` in the repository (every one on disk when git
// cannot answer). Two hits in tier 2 or 3 are `ambiguous`.
//
// A block starts where its id is the first token of a heading (`### F1 · …`), of a bold run at the
// start of a line or right after a sentence (`- **T-03** (…)`, `**A1 splits.** **A1a** …`), or of a
// table row (`| T-03 | … |`, the row alone). Ids match exactly apart from case: `DS-1` never matches
// `DS-1a`. Reads files; asks git only which files are tracked.
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { trackedFiles } from "./git.mjs";
import * as md from "./markdown.mjs";
import { readInside, readProcess } from "./read.mjs";
import { own } from "./spec/shape.mjs";
import { stepsOf } from "./steps.mjs";

/** A token that reads as an item id: a capital, letters, an optional dash, then a digit (`F1`, `R0-6`,
 *  `T29a`, `AB-01`). Used to tell block starts from emphasis (`**Owns:**`, `**the seam**`). */
export const ID_TOKEN = /^[A-Z][A-Za-z]*-?\d[\w.-]*$/;
const BOLD = /(?<=^\s*(?:(?:[-*+]|\d+[.)])\s+)?|(?:\*\*|[.)])\s+)\*\*(.+?)\*\*/g;
const LINE_START = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?$/;
const SKIP = new Set(["node_modules", "dist"]);

const posix = (path) => path.split(sep).join("/");

/** The git root at or above `dir` (the nearest directory holding `.git`), or null. */
export function gitRootOf(dir) {
  for (let at = resolve(dir); ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return null;
  }
}

/** Every `*.md` under `dir` on disk (relative paths, sorted), skipping dot-directories, `node_modules`
 *  and `dist`: the stand-in for the repository's own documents when git cannot list them. */
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

/** The repository's markdown matching a glob pathspec: the git-tracked files, or, only when git
 *  cannot answer, the disk walk (`markdownFiles`) filtered by `keep`. */
export function repoMarkdown(root, pattern, keep = () => true) {
  return trackedFiles(root, pattern) ?? markdownFiles(root).filter(keep);
}

/** Every block start in a text: `{ line, col, id, type: "heading" | "bold" | "row", lead, level?,
 *  inline? }` (line 1-based, col 0-based; `lead` is the heading or bold text). A row is a table row
 *  whose first cell is an id token; a table's first line is also a `{ line, col, type: "table" }`. */
export function blockStarts(text) {
  const out = [];
  const all = md.lines(md.maskFences(text));
  all.forEach((raw, i) => {
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      const id = md.leadIds(h[2])[0];
      out.push({ line: i + 1, col: 0, id, type: "heading", lead: h[2], level: h[1].length });
      return;
    }
    if (raw.trim().startsWith("|")) {
      if (!all[i - 1]?.trim().startsWith("|")) out.push({ line: i + 1, col: 0, type: "table" });
      const id = md.plain(md.splitRow(raw)[0]);
      if (ID_TOKEN.test(id)) out.push({ line: i + 1, col: 0, id, type: "row", lead: id });
      return;
    }
    for (const m of raw.matchAll(BOLD)) {
      const id = md.leadIds(m[1])[0];
      const inline = !LINE_START.test(raw.slice(0, m.index));
      const at = { line: i + 1, col: m.index, id, type: "bold", lead: m[1] };
      if (id) out.push(inline ? { ...at, inline } : at);
    }
  });
  return out;
}

const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();

// The leads a bold-lead line declares: every `**<id> · …**` before its first colon outside the bold
// text (`**A1 · x** ⚑, **A2 · y** (S3a): owns …` is one block for A1 and A2), as `{ id, lead }`.
function leadsOf(line) {
  const leads = [];
  for (const m of line.matchAll(/\*\*(.+?)\*\*|:/g)) {
    if (m[0] === ":") break;
    const id = md.leadIds(m[1])[0];
    if (ID_TOKEN.test(id ?? "")) leads.push({ id, lead: m[1] });
  }
  return leads;
}

// A lead that titles its id: `T4 · Door`, `T4: Door`, `T4 — Door`.
const titles = (lead, id) => {
  const text = md.plain(lead);
  return (
    same(text.slice(0, id.length), id) && /^\s*(?:[·:—–]|-\s)\s*\S/.test(text.slice(id.length))
  );
};

/** Every block of `id` in a text, any case: `{ line, block, title }`, `title` true when its lead
 *  titles it. `lead` limits which heading or bold starts may open one; a table row whose first cell is
 *  the id always does, and is its own block. A bold block at the start of a line is also the block of
 *  every other id its first sentence leads with. A block starts at its lead (a lead inside a line
 *  leaves the text before it out) and ends before the next id lead, even one inside a line, or a
 *  heading of the same or a higher level (for a bold start: any heading, or a table). */
export function blocksIn(text, id, lead = ["heading", "bold"]) {
  const all = md.lines(text);
  const starts = blockStarts(text);
  const out = [];
  starts.forEach((s, i) => {
    if (s.type !== "row" && !lead.includes(s.type)) return;
    // Leads that open no start of their own on this line share this block.
    const opens = (l) => starts.some((n) => n.line === s.line && n.inline && same(n.id, l.id));
    const shared =
      s.type === "bold" && !s.inline ? leadsOf(all[s.line - 1]).filter((l) => !opens(l)) : [];
    const named = same(s.id, id) ? s : shared.find((l) => same(l.id, id));
    if (!named || out.some((b) => b.line === s.line)) return;
    const title = titles(named.lead, id);
    if (s.type === "row") {
      out.push({ line: s.line, block: all[s.line - 1].trimEnd(), title });
      return;
    }
    const end = starts.slice(i + 1).find((n) => {
      if (n.type === "heading") return s.type === "bold" || n.level <= s.level;
      if (n.type === "table") return s.type === "bold";
      return ID_TOKEN.test(n.id ?? "") || same(n.id, id);
    });
    // Whole lines up to the end, cut at a lead inside a line on either side.
    const stop = end ? (end.inline ? end.line : end.line - 1) : all.length;
    const body = all.slice(s.line - 1, stop);
    if (end?.inline) body[body.length - 1] = body.at(-1).slice(0, end.col);
    if (s.inline) body[0] = body[0].slice(s.col);
    body[body.length - 1] = body.at(-1).trimEnd();
    while (body.length > 1 && body.at(-1).trim() === "") body.pop();
    out.push({ line: s.line, block: body.join("\n"), title });
  });
  return out;
}

const hitsIn = (root, files, id, lead) =>
  files.flatMap((file) => {
    const text = readInside(root, join(root, file));
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
    const text = readInside(root, join(root, file));
    return text !== null && same(md.frontmatter(text)?.data.id, id)
      ? [{ file, line: 1, block: text.trimEnd() }]
      : [];
  });
}

const where = ({ file, line }) => ({ file, line });
const isTasks = (file) => file === "TASKS.md" || file.endsWith("/TASKS.md");
const LINK = /\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g;

// The files an item's own rows link as its contract (`[contract](path#anchor)`): its row on the
// board and the row its id leads in its parent's file. Relative to `root`; the anchor is dropped.
function contractLinks(root, base, model, item) {
  const parent = Object.values(model.kinds)
    .flatMap((k) => k.items)
    .find((p) => p.id === item.parent && p.own);
  const linesOf = (file) => md.lines(readInside(root, join(root, base, file)) ?? "");
  const rows = item.line ? [{ file: item.file, text: linesOf(item.file)[item.line - 1] }] : [];
  if (parent)
    for (const text of linesOf(parent.own.path))
      if (text.trim().startsWith("|") && same(md.plain(md.splitRow(text)[0]), item.id))
        rows.push({ file: parent.own.path, text });
  return rows.flatMap(({ file, text = "" }) =>
    [...text.matchAll(LINK)].flatMap(([, label, href]) => {
      if (!same(md.plain(label), "contract") || /^([a-z][\w+.-]*:|\/)/i.test(href)) return [];
      const to = posix(join(base, dirname(file), href.split("#")[0] || basename(file)));
      return to.startsWith("../") ? [] : [to];
    }),
  );
}

// How much a hit reads as a contract: 2 titled or owning something, 1 only an acceptance, 0 a bare
// line (an amendment, a deps note).
const weight = (hit) =>
  hit.title || /\bowns\b/i.test(hit.block) ? 2 : /\baccept/i.test(hit.block) ? 1 : 0;

// The heaviest hit is the block, every other hit is `related`. Two real contracts (weight 2) are
// `ambiguous`, unless the item's own link names exactly one of them.
function processHit(hits, linked, id) {
  const real = hits.filter((h) => weight(h) === 2);
  const named = real.filter((h) => linked.includes(h.file));
  const top = named.length ? named : real;
  if (top.length > 1) return { status: "ambiguous", id, candidates: top.map(where) };
  const first = top[0] ?? hits.toSorted((a, b) => weight(b) - weight(a))[0];
  const rest = hits.filter((h) => h !== first);
  const found = { status: "found", id, ...where(first), source: "process", block: first.block };
  return rest.length ? { ...found, related: rest.map(where) } : found;
}

// A found result with its block's steps (`steps.mjs`) when the block has a Steps part, and the problem
// with them when there is one; any other result as it is.
function withSteps(result) {
  if (result.status !== "found") return result;
  const { steps, problem } = stepsOf(result.block);
  if (!steps.length && !problem) return result;
  return { ...result, steps, ...(problem && { stepsProblem: problem }) };
}

/** `findContract({ root, spec?, id, kind = "task", model? })` → the F2 result:
 *  `{ status: "found", id, file, line, source: "process"|"agentry"|"discovered", block, related?,
 *  steps?, stepsProblem? }` or `{ status: "not-found"|"ambiguous", id, candidates: [{ file, line }] }`.
 *  `file` is relative to `root`; `id` is spelled as the board spells it. `model` is read from `spec`
 *  when not given. `steps` comes only with a block that has a Steps part. */
export function findContract({ root, spec, id: asked, kind = "task", model }) {
  let id = asked;
  if (spec) {
    const contract = own(spec.kinds, kind)?.contract;
    const board = model ?? readProcess({ root, spec });
    const item = own(board.kinds, kind)?.items.find((i) => same(i.id, asked));
    id = item?.id ?? asked;
    const base = posix(relative(root, join(root, spec.root ?? ".")));
    const linked = item ? contractLinks(root, base, board, item) : [];
    const blocks = (contract?.blocks ?? []).map((f) => posix(join(base, f)));
    const hits = hitsIn(root, [...new Set([...linked, ...blocks])], id, contract?.lead);
    if (hits.length) return withSteps(processHit(hits, linked, id));
  }
  const tiers = [
    ["agentry", () => agentryHits(root, id)],
    ["discovered", () => hitsIn(root, repoMarkdown(root, "**/TASKS.md", isTasks), id)],
  ];
  for (const [source, hits] of tiers) {
    const found = hits();
    const [hit] = found;
    if (found.length === 1)
      return withSteps({ status: "found", id, ...where(hit), source, block: hit.block });
    if (found.length > 1) return { status: "ambiguous", id, candidates: found.map(where) };
  }
  return { status: "not-found", id, candidates: [] };
}
