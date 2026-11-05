// read — process file (+ its sibling workflow file) + board files → the Model: items per kind with header-named
// fields, the tree, phases (own or derived from children), ranks, each item's own file and sections.
// It reads the process file and the board's files; the run state under `.agentry/run` and the repo's other
// documents are read by their own modules (`ledger`, `drafts`, `contract`, …), git by `git.mjs`. A missing
// file, heading or column is a `problems`
// entry (rule "read"), never a throw. Item `file` and `own.path` are relative to the spec's `root`.
// Every read stays inside the repository once symlinks are resolved (`staysInside`).
import { globSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import * as md from "./markdown.mjs";
import { CLOSED, STARTED } from "./phases.mjs";
import { parseSpec } from "./spec.mjs";
import { escapesRoot, own } from "./spec/shape.mjs";

const noColumn = (file, head, col) => `${file}: the "${head}" table has no column "${col}"`;

/** True when `path` (absolute) stays inside the repository at `root` once every symlink is
 *  resolved. A path that does not exist is judged as written: reading it fails on its own. */
export function staysInside(root, path) {
  let rel;
  try {
    rel = relative(realpathSync(root), realpathSync(path));
  } catch {
    return true;
  }
  return !isAbsolute(rel) && !escapesRoot(".", rel.split(sep).join("/") || ".");
}

/** A file's text, or null when it cannot be read or a symlink takes it out of the repository. */
export function readInside(root, path) {
  try {
    return staysInside(root, path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

// The two files' own paths that a symlink takes out of the repository: problems of the file that holds
// the key, as a path written with `../` out is. Globs are checked file by file as they are read.
function linkedOut(root, spec, files) {
  const base = join(root, spec.root);
  const paths = [
    ["root", root, spec.root, files.board],
    ["status.note", root, spec.status?.note, files.board],
    ["conductor.prompt", root, spec.conductor?.prompt, files.workflow],
  ];
  for (const [name, k] of Object.entries(spec.kinds)) {
    const at = `kinds.${name}`;
    paths.push([`${at}.at.table`, base, k.at.table, files.board]);
    (k.contract?.blocks ?? []).forEach((p, i) =>
      paths.push([`${at}.contract.blocks[${i}]`, base, p, files.board]),
    );
    (k.create?.blocks ?? []).forEach((b, i) =>
      paths.push([`${at}.create.blocks[${i}]`, base, b.file, files.board]),
    );
  }
  return paths
    .filter(([, from, path]) => typeof path === "string" && !staysInside(root, join(from, path)))
    .map(([at, , path, file]) => ({
      rule: "spec",
      message: `${at} "${path}" leaves the repository through a symlink`,
      file,
    }));
}

/** The workflow file that goes with the process file at `path`: its sibling `workflow.json`. */
export const workflowPathOf = (path) => join(dirname(path), "workflow.json");

/** Read and validate a process file and its workflow file (`workflowPathOf`), merged into one spec. A
 *  missing or unreadable process file is a problem, not a throw; a missing workflow file is no problem
 *  (every workflow key absent), an unreadable one is. A process file named `workflow.json` is refused
 *  (its sibling would be itself). Given the repository `root`, either file, or a path inside them, that
 *  a symlink takes out of it is a problem too, and a file that does is never read. Each problem's
 *  `file` is the file it is about; the one about the process file's own name has none. */
export function loadSpec(path, { root } = {}) {
  const files = { board: path, workflow: workflowPathOf(path) };
  if (basename(path).toLowerCase() === "workflow.json") {
    const message =
      "the process file cannot be named workflow.json (its sibling workflow file would be itself) → use .agentry/process.json";
    return { spec: null, problems: [{ rule: "spec", message }] };
  }
  const linked = Object.values(files)
    .filter((file) => root !== undefined && !staysInside(root, file))
    .map((file) => ({
      rule: "spec",
      message: `${basename(file)} leaves the repository through a symlink`,
      file,
    }));
  if (linked.length) return { spec: null, problems: linked };
  const read = (file, what) => {
    try {
      return { text: readFileSync(file, "utf8") };
    } catch (e) {
      if (what === "workflow" && e.code === "ENOENT") return { text: undefined };
      const message = `cannot read the ${what} file (${e.code ?? e.message})`;
      return { problem: { rule: "spec", message, file } };
    }
  };
  const board = read(files.board, "process");
  const workflow = read(files.workflow, "workflow");
  const unread = [board.problem, workflow.problem].filter(Boolean);
  if (unread.length) return { spec: null, problems: unread };
  const loaded = parseSpec({ board: board.text, workflow: workflow.text }, { files });
  if (root === undefined || !loaded.spec || loaded.problems.length) return loaded;
  return { spec: loaded.spec, problems: linkedOut(root, loaded.spec, files) };
}

/** An item from one row or file; `get(column)` is the raw value, undefined when there is none. */
function makeItem(ctx, rawId, get, where) {
  const { name, kind } = ctx;
  let id = md.plain(rawId ?? "");
  if (id && kind.id?.match) id = md.applyMatch(id, kind.id.match) ?? "";
  if (!id)
    return ctx.problem({ kind: name, message: `${where.file}: a ${name} without an id`, ...where });
  const fields = {};
  for (const [f, def] of Object.entries(kind.fields ?? {})) {
    const raw = get(def.column);
    fields[f] = raw === undefined ? null : md.cellValue(raw, def);
  }
  const item = { kind: name, id, fields, children: [], ...where };
  if (kind.status?.field) {
    item.status = String(fields[kind.status.field] ?? "");
    const phase = own(kind.status.values, item.status);
    if (phase) item.phase = phase;
  }
  return item;
}

function readTable(ctx) {
  const { name, kind, io, problem } = ctx;
  const { table: file, heading } = kind.at;
  const miss = (message, line) => {
    problem({ kind: name, message: `${file}: ${message}`, file, ...(line ? { line } : {}) });
    return { items: [], located: false };
  };
  if (!io.inside(file)) return miss("outside the repository; not read");
  const text = io.read(file);
  if (text === null) return miss("file not found");
  const sec = md.section(text, heading);
  if (!sec) return miss(`no heading "${heading}"`);
  const table = md.tableIn(text, sec);
  if (!table) return miss(`no table under "${heading}"`, sec.line);
  const has = (column) => table.header.includes(column);
  const columns = [kind.id.column, ...Object.values(kind.fields ?? {}).map((f) => f.column)];
  for (const column of new Set(columns))
    if (!has(column))
      problem({ kind: name, message: noColumn(file, heading, column), file, line: table.line });
  if (!has(kind.id.column)) return { items: [], located: true };
  const items = table.rows.map((row) => {
    const get = (column) => (has(column) ? row.cells[column] : undefined);
    return makeItem(ctx, row.cells[kind.id.column], get, { file, line: row.line });
  });
  return { items: items.filter(Boolean), located: true };
}

function readFiles(ctx) {
  const { files: glob, id: idFrom } = ctx.kind.at;
  const paths = ctx.io.glob(glob);
  const key = idFrom.startsWith("frontmatter:") ? idFrom.slice("frontmatter:".length) : null;
  const byName = key ? null : md.filenameId(idFrom.slice("filename:".length));
  const items = [];
  for (const file of paths) {
    const text = ctx.io.read(file);
    if (text === null) continue;
    const fm = md.frontmatter(text);
    const rawId = key ? own(fm?.data, key) : byName.exec(basename(file))?.[1];
    const where = { file, line: (key && own(fm?.lines, key)) || 1 };
    const item = makeItem(ctx, rawId, (column) => own(fm?.data, column), where);
    if (item) items.push(item);
  }
  if (paths.length === 0) ctx.problem({ kind: ctx.name, message: `no files match "${glob}"` });
  return { items, located: paths.length > 0 };
}

const escapeGlob = (s) => s.replace(/[*?[\]{}()!\\]/g, "\\$&");
const plainRow = (row) =>
  Object.fromEntries(Object.entries(row.cells).map(([k, v]) => [k, md.plain(v)]));

/** Each item's own file (`file.glob` with its id; `except` ids skipped) and its named sections. */
function readOwn(ctx, items) {
  const { name, kind, io, problem } = ctx;
  const except = new Set(kind.file.except ?? []);
  for (const item of items.filter((i) => !except.has(i.id))) {
    const matches = io.glob(kind.file.glob.replaceAll("{id}", escapeGlob(item.id)));
    if (matches.length === 0) continue;
    const path = matches[0];
    const text = io.read(path) ?? "";
    const sections = {};
    for (const [s, def] of Object.entries(kind.file.sections ?? {})) {
      const at = { kind: name, id: item.id, file: path };
      const sec = md.section(text, def.heading);
      if (!sec) {
        problem({ ...at, message: `${path}: no heading "${def.heading}"` });
      } else if (def.as === "bold-lead") {
        sections[s] = { leads: md.boldLeads(text, sec) };
      } else {
        const table = md.tableIn(text, sec);
        if (table && !table.header.includes(def.column))
          problem({ ...at, message: noColumn(path, def.heading, def.column), line: table.line });
        sections[s] = { rows: (table?.rows ?? []).map(plainRow) };
      }
    }
    item.own = { path, matches, sections };
  }
}

/** Parents, children, derived phases and ranks, across kinds. */
function linkTree(spec, kinds) {
  const byId = {};
  for (const [name, { items }] of Object.entries(kinds))
    byId[name] = new Map(items.toReversed().map((item) => [item.id, item])); // first row wins
  const find = (id, refs) => byId[[refs ?? []].flat().find((k) => byId[k]?.has(id))]?.get(id);
  const childrenOf = new Map();
  const parentsOf = new Map();
  const adopt = (parent, child) => {
    if (!parent.children.includes(child.id)) parent.children.push(child.id);
    child.parent ??= parent.id;
    childrenOf.set(parent, (childrenOf.get(parent) ?? new Set()).add(child));
    parentsOf.set(child, (parentsOf.get(child) ?? new Set()).add(parent));
  };
  // Every walk below goes by kind name, field name and row, never by the order `process.json` declares
  // the kinds in, so nothing the reader derives depends on it.
  const byName = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
  const kindDefs = Object.entries(spec.kinds ?? {}).sort(byName);
  const orderKinds = new Set();
  for (const [name, kind] of kindDefs) {
    for (const [f, def] of Object.entries(kind?.fields ?? {}).sort(byName)) {
      if (def?.role === "parent") for (const k of [def.ref].flat()) orderKinds.add(k);
      for (const item of kinds[name]?.items ?? []) {
        const value = item.fields[f];
        if (def?.role === "parent" && typeof value === "string" && value) {
          item.parent = value;
          const parent = find(value, def.ref);
          if (parent) adopt(parent, item);
        } else if (def?.role === "children" && Array.isArray(value)) {
          for (const id of value) {
            if (!item.children.includes(id)) item.children.push(id);
            const child = find(id, def.ref);
            if (child) adopt(item, child);
          }
        }
      }
    }
  }
  // `derived: children`: all children closed → done; any started → active; else (or none) planned.
  const derive = (item, seen) => {
    const derived = spec.kinds?.[item.kind]?.status?.derived === "children";
    if (!derived || item.phase || seen.has(item)) return item.phase;
    seen.add(item);
    const phases = [...(childrenOf.get(item) ?? [])].map((c) => derive(c, seen));
    if (phases.length && phases.every((p) => CLOSED.has(p))) item.phase = "done";
    else item.phase = phases.some((p) => STARTED.has(p)) ? "active" : "planned";
    return item.phase;
  };
  const all = Object.entries(kinds)
    .sort(byName)
    .flatMap(([, k]) => k.items);
  for (const item of all) derive(item, new Set());
  rank(all, orderKinds, kinds, parentsOf, childrenOf);
}

/**
 * Rank, the one number the order rules compare. The kinds a parent field refs (sprint) rank by row
 * order. Any other item takes the LOWEST rank among its parents (a task with a sprint and an epic is
 * as early as the earliest); one no parent ranks takes the HIGHEST among its children (a milestone is
 * as late as its last sprint); one neither reaches has none. Each step runs in rounds where every item
 * reads the previous round, until nothing moves: the result is the same whatever order the items and
 * kinds are walked in, and a cycle ends once its ranks stop moving.
 */
function rank(all, orderKinds, kinds, parentsOf, childrenOf) {
  for (const k of orderKinds)
    for (const [i, item] of (kinds[k]?.items ?? []).entries()) item.rank = i;
  const settle = (items, related, pick) => {
    for (let moved = true; moved; ) {
      const next = items.flatMap((item) => {
        const ranks = [...(related.get(item) ?? [])].map((x) => x.rank).filter(Number.isInteger);
        return ranks.length && pick(...ranks) !== item.rank ? [[item, pick(...ranks)]] : [];
      });
      for (const [item, r] of next) item.rank = r;
      moved = next.length > 0;
    }
  };
  settle(
    all.filter((i) => !orderKinds.has(i.kind)),
    parentsOf,
    Math.min,
  );
  settle(
    all.filter((i) => i.rank === undefined),
    childrenOf,
    Math.max,
  );
}

/** The pinned seam: `readProcess({ root, spec }) -> Model`, where `root` is the git root. */
export function readProcess({ root, spec }) {
  const problems = [];
  const problem = (p) => {
    problems.push({ rule: "read", ...p });
  };
  const specRoot = typeof spec?.root === "string" ? spec.root : ".";
  const base = join(root, specRoot);
  // A path that leaves the repository, as written or through a symlink, is never opened.
  const inside = (rel) => !escapesRoot(specRoot, rel) && staysInside(root, join(base, rel));
  const cache = new Map();
  // Missing, a directory or outside: null, and the caller reports it in its own words.
  const load = (rel) => (inside(rel) ? readInside(root, join(base, rel)) : null);
  const read = (rel) => (cache.has(rel) ? cache.get(rel) : cache.set(rel, load(rel)).get(rel));
  const glob = (p) => {
    if (!inside(p)) return [];
    const matches = globSync(p, { cwd: base }).sort();
    for (const file of matches.filter((m) => !inside(m)))
      problem({ message: `${file}: a symlink out of the repository; not read`, file });
    return matches.filter(inside);
  };
  const kinds = {};
  for (const [name, kind] of Object.entries(spec?.kinds ?? {})) {
    const ctx = { name, kind, problem, io: { inside, read, glob } };
    kinds[name] = { items: [], located: false };
    try {
      if (typeof kind.at?.files === "string") kinds[name] = readFiles(ctx);
      else if (typeof kind.at?.table === "string") kinds[name] = readTable(ctx);
      if (typeof kind.file?.glob === "string") readOwn(ctx, kinds[name].items);
    } catch (e) {
      problem({ kind: name, message: `could not read the ${name} kind: ${e.message}` });
    }
  }
  linkTree(spec ?? {}, kinds);
  // Built from entries, so an id such as `__proto__` is held as a plain key like any other.
  const byItemId = new Map();
  for (const item of Object.values(kinds).flatMap((k) => k.items))
    byItemId.set(item.id, [...(byItemId.get(item.id) ?? []), item]);
  return { spec, root, kinds, index: Object.fromEntries(byItemId), problems };
}
