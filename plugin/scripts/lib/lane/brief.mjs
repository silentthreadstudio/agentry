// brief — what an exec round's brief says, rendered from the templates in the conducting skill's
// `references/briefs/` (ADR-R3): the same brief every time, on disk, quoting the board instead of memory.
//
//   ownedFiles      the paths the contract's "owns" names (backticked, brace globs expanded, negations
//                   left out), in order; given the tree, a dotted symbol is not a path unless a file matches
//   withNew         those paths, each marked `new` when the tree has no such file; a path missing at the
//                   root is looked up among the tree's tracked files as a suffix (`merge/gating.mjs`, a bare
//                   name, a glob's folder): one hit is that path, several are all listed `ambiguous`
//   suggestBuilder  designer when an owned path is UI-shaped, else implementer (the conductor decides, #20)
//   citedDecisions  every decision of the board's decision kind the block cites by id, the rows that name
//                   the task (decided after the contract was written) and those the owner asked for with
//                   `--cite`, each row quoted
//   appendedAfter   what a brief holds after its last template section (a section the conductor added),
//                   so a rewrite of the brief can put it back
//   relatedNotes    the lines elsewhere that mention the task (amendments), read verbatim with file:line
//   notesSection    those notes as the brief's "Later notes" lines, capped
//   recalledFacts   the memory facts ranked for the owned files, only when `memory.prime` is "all": this
//                   repo's store, the user's own and cross-project (`scope: user|global`) facts,
//                   never another project's
//   renderBrief     a template filled; every `{{slot}}` must be given, so a template can't drift silently
//
// Reads the board's files and the memory store; writes nothing. Node built-ins only.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rankFacts, readFacts, readMemoryConfig } from "../memory/recall.mjs";
import { readInside } from "../process/read.mjs";
import { own } from "../process/spec.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES = join(
  HERE,
  "..",
  "..",
  "..",
  "skills",
  "conducting",
  "references",
  "briefs",
);

// The template each dispatch step renders.
const TEMPLATE_OF = {
  build: "build",
  fix: "fix",
  "needs-context": "fix",
  verify: "verify",
  recheck: "verify",
  final: "final",
};

// Where a contract's own-list ends: the next labelled part of the contract.
const OWNS = /\bowns?\b\s*[:*]*/i;
const NEXT_PART = /\b(exposes|excludes|deps|accept(?:ance)?|out of scope|goal|rules)\b\s*[:*]/i;
const TICKED = /`([^`\n]+)`/g;

// A code span is an owned path when it is made of path characters and either ends in a known file
// extension or names a folder or glob (has a `/`) whose last part is not a bare number (`KEY_1/2` is a
// string key). `Type.method()` and `a.b.c` are symbols: no known extension, or (`a.b.c`) a bare name with
// more dots than an extension and no tracked file of that name. A bare name without a dot is a path only
// when it is a well-known extensionless file or a tracked file has that name.
const PATH_CHARS = /^[\w@.~*+-]+(\/[\w@.~*+-]+)*\/?$/;
const EXTENSIONS = new Set(
  (
    "ts tsx js jsx mjs cjs json jsonc md mdx txt css scss sass less html htm vue svelte astro " +
    "py rb go rs java kt swift c h cpp hpp cs php lua gd tscn tres res import godot cfg ini toml " +
    "yaml yml xml svg png jpg jpeg gif webp wav ogg mp3 glsl shader gdshader sql sh csv lock"
  ).split(" "),
);
const PLAIN_NAMES = new Set(["Makefile", "Dockerfile", "LICENSE"]);
// The part before the extension that makes `a.test.mjs` a file name, not a symbol path.
const COMPOUND = new Set(["test", "spec", "d", "min", "config", "stories"]);
// What a span may carry after the path: `:12`, `:12-30`, `#L12`.
const LOCATION = /(?::\d+(?:[-–—]\d+)?|#L\d+(?:-L?\d+)?)+$/;
// Words before a span that say its file is NOT owned ("no line in", "but not", "never", …).
const NEGATION =
  /\b(no|not|never|none|nothing|without|except|excluding|exclude|forbidden|don'?t|doesn'?t|out of scope)\b/i;
// What may sit between two spans of one list: a comma, "and", "or".
const LIST_GAP = /^\s*(and|or|&)?\s*$/i;

// Is a tracked file named `name` (as a whole path tail)?
const hasFile = (tracked, name) =>
  tracked().some((file) => file === name || file.endsWith(`/${name}`));

function pathOf(span, tracked) {
  const path = span.trim().replace(LOCATION, "");
  if (!PATH_CHARS.test(path)) return null;
  if (path.includes("/"))
    return /^\d+$/.test(path.replace(/\/$/, "").split("/").at(-1)) ? null : path;
  const dot = path.lastIndexOf(".");
  if (dot <= 0) return PLAIN_NAMES.has(path) || hasFile(tracked, path) ? path : null;
  const parts = path.split(".");
  if (!EXTENSIONS.has(parts.at(-1).toLowerCase())) return null;
  return parts.length === 2 || COMPOUND.has(parts.at(-2).toLowerCase()) || hasFile(tracked, path)
    ? path
    : null;
}

// `a/{b,c}.md` as `a/b.md` and `a/c.md`: each group of alternatives, left to right. A span with a space
// in it is not a path list.
function braced(span) {
  const group = /\{([^{}]*)\}/.exec(span);
  if (!group || /\s/.test(span)) return [span];
  const [whole, alts] = group;
  return alts
    .split(",")
    .flatMap((alt) =>
      braced(span.slice(0, group.index) + alt + span.slice(group.index + whole.length)),
    );
}

/** The paths the block's "owns" part names in backticks, de-duplicated, in order: only spans shaped like
 *  a path, `path:lines` read as the path, a brace glob (`a/{b,c}.md`) expanded, and a span after a
 *  negation ("no line in `x`", "but not `y`") left out. `dir` is the tree whose tracked files decide a
 *  doubtful name (`a.b.c`, an extensionless name); without it only well-known names count. Empty when
 *  the block has no "owns" part or it names no path. */
export function ownedFiles(block, dir) {
  const text = String(block ?? "");
  let list;
  const tracked = () => {
    list ??= dir ? trackedFiles(dir) : [];
    return list;
  };
  const at = OWNS.exec(text);
  if (!at) return [];
  let part = text.slice(at.index + at[0].length);
  const end = NEXT_PART.exec(part);
  if (end) part = part.slice(0, end.index);
  const out = [];
  let from = 0;
  let negated = false;
  for (const m of part.matchAll(TICKED)) {
    const between = part.slice(from, m.index);
    // The words between the previous span and this one, in this clause only, a closed aside
    // ("(no new class)") left out.
    const clause = between.split(/;|\.\s|\n\s*\n|\n\s*[-*]\s/).at(-1);
    from = m.index + m[0].length;
    // A negation holds to the next comma: a span right after a comma ("not `a`, `b`") shares the
    // previous span's reading, but words after a comma ("`a`, without touching x, `b`") end it.
    const pieces = clause.replace(/\([^()]*\)/g, " ").split(",");
    const last = pieces.at(-1);
    const joined =
      pieces.length > 1 && clause === between && !clause.includes(")") && LIST_GAP.test(last);
    negated = joined ? negated : NEGATION.test(last);
    if (negated) continue;
    for (const one of braced(m[1])) {
      const path = pathOf(one, tracked);
      if (path && !out.includes(path)) out.push(path);
    }
  }
  return out;
}

const trackedFiles = (dir) => {
  try {
    return execFileSync("git", ["-C", dir, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
};

// Where `path` sits in the tracked files: the leading folders its fixed part is found under ("" when
// it is at the root). The fixed part is the whole path, or for a glob or folder the folders before the
// first `*` or `?`; a path with no fixed part (`*.md`) is found nowhere.
function leadsOf(tracked, path) {
  const wild = path.search(/[*?]/);
  const fixed = wild < 0 ? path : path.slice(0, path.lastIndexOf("/", wild) + 1);
  if (!fixed) return [];
  const folder = fixed.endsWith("/");
  const leads = new Set();
  for (const file of tracked) {
    if (folder ? file.startsWith(fixed) : file === fixed) leads.add("");
    else if (folder) {
      const at = file.indexOf(`/${fixed}`);
      if (at >= 0) leads.add(file.slice(0, at + 1));
    } else if (file.endsWith(`/${fixed}`)) leads.add(file.slice(0, file.length - fixed.length));
  }
  return [...leads].sort();
}

/** `paths` as `{ path, new }`: `new` when the path is a plain file that does not exist in `dir` (a glob
 *  or folder names what is there, so it is never new). A path missing at the root is looked up among the
 *  tracked files as the tail of a path (a bare name, `merge/gating.mjs`, a glob's folders): found at the
 *  root it stays as written; one other place is that path; several are all listed with `ambiguous: true`;
 *  none means a plain file is new and a glob or folder stays as written. */
export function withNew(dir, paths) {
  let tracked;
  return paths.flatMap((path) => {
    const open = /[*?]/.test(path) || path.endsWith("/");
    if (!open && existsSync(join(dir, path))) return [{ path, new: false }];
    tracked ??= trackedFiles(dir);
    const leads = leadsOf(tracked, path);
    if (leads.length === 0 || leads.includes(""))
      return [{ path, new: !open && leads.length === 0 }];
    const hits = leads.map((lead) => ({ path: `${lead}${path}`, new: false }));
    return hits.length === 1 ? hits : hits.map((hit) => ({ ...hit, ambiguous: true }));
  });
}

const UI_DIRS = new Set([
  "ui",
  "components",
  "screens",
  "views",
  "pages",
  "styles",
  "theme",
  "themes",
]);
// A glob under one of these names a whole front end (`web/**`), where a plain file there may be anything.
const FRONT_DIRS = new Set(["web", "app", "ui"]);
const UI_EXT = /\.(css|scss|sass|less|vue|svelte|astro|html|tscn)$/i;

/** Which builder the owned paths suggest: `{ agent, why }`. A suggestion: the conductor decides. */
export function suggestBuilder(owned) {
  const ui = owned.find((path) => {
    const parts = path.toLowerCase().split("/");
    return (
      UI_EXT.test(path) ||
      parts.some((part) => UI_DIRS.has(part)) ||
      (/[*?]/.test(path) && parts.slice(0, -1).some((part) => FRONT_DIRS.has(part)))
    );
  });
  return ui
    ? { agent: "designer", why: `${ui} is UI-shaped` }
    : { agent: "implementer", why: "no owned path is UI-shaped" };
}

/** The board's decision kind: the one `drafts.decision` names, else a kind called "decision". */
export function decisionKind(spec) {
  const named = own(own(spec?.drafts, "decision"), "kind");
  if (typeof named === "string" && own(spec?.kinds, named)) return named;
  return own(spec?.kinds, "decision") ? "decision" : null;
}

/** The text of each `related` hit (`{ file, line }`, `file` relative to `root`) as `{ at, text }`, `at`
 *  its `file:line`. A hit whose line can't be read inside the repo is left out. */
export function relatedNotes(root, related) {
  const out = [];
  for (const { file, line } of related ?? []) {
    const text = readInside(root, join(root, file))?.split(/\r?\n/)[line - 1]?.trim();
    if (text) out.push({ at: `${file}:${line}`, text });
  }
  return out;
}

export const NOTES_CAP = 8;
const NOTE_WIDTH = 400;

/** The notes as brief lines (`- file:line: text`), at most `NOTES_CAP`, each line cut at `NOTE_WIDTH`
 *  characters; a final line says how many were left out. Empty for no notes. */
export function notesSection(notes) {
  const lines = (notes ?? []).slice(0, NOTES_CAP).map(({ at, text }) => {
    const cut = text.length > NOTE_WIDTH ? `${text.slice(0, NOTE_WIDTH - 1)}… (cut)` : text;
    return `- ${at}: ${cut}`;
  });
  const more = (notes?.length ?? 0) - NOTES_CAP;
  if (more > 0)
    lines.push(
      `- (capped at ${NOTES_CAP}: ${more} more not shown; run \`board contract\` for all)`,
    );
  return lines.join("\n");
}

const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const mentions = (text, id) =>
  new RegExp(`(?<![A-Za-z0-9_-])${literal(id)}(?![A-Za-z0-9_])`).test(text);

/** Every decision to quote, as `{ id, text }`: `id` as the board writes it (the kind's display `prefix` +
 *  its id, `D12`), `text` its table row quoted from the file (or its fields for a one-file-per-item
 *  kind). A decision is in when the block cites it by id, when its row names the task `task` (a decision
 *  made after the contract was written), or when its id is in `cite` (any case). An id made of digits
 *  only is never matched in prose. */
export function citedDecisions({ root, spec, model, block, task, cite = [] }) {
  const name = decisionKind(spec);
  if (!name) return [];
  const kind = spec.kinds[name];
  const prefix = kind.id?.prefix ?? "";
  const text = String(block ?? "");
  const asked = new Set(cite.map((c) => c.toLowerCase()));
  const named = typeof task === "string" && /[A-Za-z]/.test(task);
  const out = [];
  for (const item of own(model?.kinds, name)?.items ?? []) {
    const id = `${prefix}${item.id}`;
    if (out.some((d) => d.id === id)) continue;
    const quote = () => quoteOf(root, spec, kind, item);
    const prose = /[A-Za-z]/.test(id) && mentions(text, id);
    if (prose || asked.has(id.toLowerCase())) out.push({ id, text: quote() });
    else if (named) {
      const row = quote();
      if (mentions(row, task)) out.push({ id, text: row });
    }
  }
  return out;
}

/** The decision ids in `cite` that name no decision on the board (as written, any case). */
export function unknownCites({ spec, model, cite }) {
  const name = decisionKind(spec);
  const known = new Set(
    (own(model?.kinds, name)?.items ?? []).map((i) =>
      `${spec.kinds[name].id?.prefix ?? ""}${i.id}`.toLowerCase(),
    ),
  );
  return cite.filter((c) => !known.has(c.toLowerCase()));
}

/** What `old` (a brief as it was on disk) holds after the last section of `fresh` (the same brief
 *  rendered again): a section someone appended at the end. The last section's heading is looked for in
 *  `old`, taking the place where the rendered section matches in full. Empty when there is nothing
 *  after it, or the old brief does not match the template. */
export function appendedAfter(old, fresh) {
  const headings = [...fresh.matchAll(/^## .*$/gm)];
  const last = headings.at(-1);
  if (!last) return "";
  const section = fresh.slice(last.index).trimEnd();
  for (let at = old.indexOf(last[0]); at >= 0; at = old.indexOf(last[0], at + 1))
    if (old.startsWith(section, at))
      return old.slice(at + section.length).trim() ? old.slice(at + section.length) : "";
  return "";
}

function quoteOf(root, spec, kind, item) {
  if (kind.at?.table !== undefined) {
    const file = readInside(root, join(root, spec.root ?? ".", item.file));
    const line = file?.split(/\r?\n/)[item.line - 1];
    if (line) return line.trim();
  }
  return Object.entries(item.fields ?? {})
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `${k}: ${[v].flat().join(", ")}`)
    .join(" · ");
}

// A brief may carry what this repo's store holds, plus the user's own (`scope: user`) and the
// cross-project (`scope: global`) facts from the home store. The home store also keeps facts written
// for other projects (a `repo` fact with no project store goes there) and unscoped ones: those never
// belong in this repo's brief.
export const forThisRepo = (fact) =>
  fact.source === "project" || fact.scope === "user" || fact.scope === "global";

/** How many ranked facts a prime may carry: the config's `primeLimit` when a whole number above 0, else 5. */
export const primeLimitOf = (config) =>
  Number.isInteger(config.primeLimit) && config.primeLimit > 0 ? config.primeLimit : 5;

/** The facts recalled for this contract: `{ prime, facts }`. Facts only when the repo's
 *  `memory.prime` is "all" (briefs are primed); otherwise none. */
export function recalledFacts(root, { owned, block }) {
  const config = readMemoryConfig(root);
  if (config.prime !== "all") return { prime: config.prime, facts: [] };
  const head = String(block ?? "")
    .split("\n")
    .slice(0, 2)
    .join(" ");
  const task = [...owned, head].join(" ");
  return {
    prime: config.prime,
    facts: rankFacts(readFacts(root).filter(forThisRepo), task, primeLimitOf(config)),
  };
}

/** The slots and section names a template uses, in order of first use. */
export const slotsOf = (template) => [
  ...new Set([...template.matchAll(/\{\{[#/]?(\w+)\}\}/g)].map((m) => m[1])),
];

const SECTION = /^\{\{#(\w+)\}\}\n([\s\S]*?)^\{\{\/\1\}\}\n?/gm;

/** `template` with every `{{slot}}` filled from `values`. A section `{{#name}}` … `{{/name}}` (each
 *  marker on its own line) is kept only when `values[name]` is truthy. A slot or section without a
 *  value is an error, never left blank. A line that is only a slot whose value is empty goes, with the
 *  blank line after it, so an absent part leaves no gap; the values themselves are put in as given. */
export function fill(template, values) {
  const missing = slotsOf(template).filter((s) => !Object.hasOwn(values, s));
  if (missing.length) throw new Error(`brief slots without a value: ${missing.join(", ")}`);
  const lines = template
    .replace(SECTION, (_, name, body) => (values[name] ? body : ""))
    .split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const only = /^\{\{(\w+)\}\}$/.exec(lines[i].trim());
    if (only && String(values[only[1]]) === "") {
      if (lines[i + 1]?.trim() === "") i++;
      continue;
    }
    kept.push(lines[i]);
  }
  return `${kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\{\{(\w+)\}\}/g, (_, s) => String(values[s]))
    .trimEnd()}\n`;
}

// A fix round's brief wraps the build brief, a final round's the verify brief: each rule is written once.
const WRAPS = { fix: "build", final: "verify" };
const read = (name) => readFileSync(join(TEMPLATES, `${name}.md`), "utf8");
const body = (text) => text.replace(/^# .*\n+/, "");

/** The brief for dispatch `step`, rendered from its template (with the brief it wraps as `{{inner}}`). */
export function renderBrief(step, values) {
  const name = Object.hasOwn(TEMPLATE_OF, step) ? TEMPLATE_OF[step] : null;
  if (!name) throw new Error(`no brief template for step "${step}"`);
  const inner = Object.hasOwn(WRAPS, name) ? body(fill(read(WRAPS[name]), values)) : "";
  return fill(read(name), { ...values, inner });
}

/** A list as brief lines (`- item`), or `none`. */
export const bullets = (items) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "none");

/** `text` as one POSIX shell word: single-quoted, each `'` written `'\''`. */
export const shellQuote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
