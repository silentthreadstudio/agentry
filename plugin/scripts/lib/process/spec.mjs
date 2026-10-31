// spec — parse and validate the process file (`.agentry/process.json`, plan F13 §3.1) by hand: it
// mirrors core's zod schema (`packages/core/src/process.ts`; the plugin ships no dependency) and adds
// what only a reader can check (refs between kinds, paths, regexes). PURE: never reads, never throws.
import { posix } from "node:path";

const PHASES = ["planned", "active", "done", "dropped", "parked"];
const TYPES = ["text", "list", "ref", "flag", "date", "commits", "evidence", "link"];
const quote = (xs) => xs.map((x) => `"${x}"`).join(", ");
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const join = (at, key) => (at ? `${at}.${key}` : key);
const validRegex = (v) => {
  try {
    return typeof v === "string" && new RegExp(v) instanceof RegExp;
  } catch {
    return false;
  }
};

// A checker is (value, path, bad) => void, where `bad(path, message)` records a problem.
const is = (test, message) => (v, at, bad) => test(v) || bad(at, message);
const str = is((v) => typeof v === "string", "should be a string");
const bool = is((v) => typeof v === "boolean", "should be true or false");
const posInt = is((v) => Number.isInteger(v) && v > 0, "should be a whole number above 0");
const regex = is(validRegex, "should be a valid regular expression");
const oneOf = (...xs) => is((v) => xs.includes(v), `should be one of ${quote(xs)}`);
const like = (re, hint) => is((v) => typeof v === "string" && re.test(v), `should be ${hint}`);
const list = (item) => (v, at, bad) =>
  Array.isArray(v) ? v.forEach((x, i) => item(x, `${at}[${i}]`, bad)) : bad(at, "should be a list");
const record = (item) => (v, at, bad) => {
  if (!isObject(v)) return bad(at, "should be an object");
  for (const [k, x] of Object.entries(v)) item(x, join(at, k), bad);
};
const strOrList = (v, at, bad) => (Array.isArray(v) ? list(str) : str)(v, at, bad);
// An object with known keys; a key written `name!` is required. `open` lets unknown keys through.
const shape =
  (keys, open = false) =>
  (v, at, bad) => {
    if (!isObject(v)) return bad(at, "should be an object");
    const names = Object.keys(keys).map((k) => k.replace(/!$/, ""));
    for (const k of names) if (`${k}!` in keys && !(k in v)) bad(at, `is missing "${k}"`);
    for (const [k, x] of Object.entries(v)) {
      const check = keys[k] ?? keys[`${k}!`];
      if (check) check(x, join(at, k), bad);
      else if (!open) bad(join(at, k), `is not a known key (expected ${quote(names)})`);
    }
  };
// One of several shapes, picked by the key that tells them apart (`table` vs `files`).
const variant = (shapes, hint) => (v, at, bad) => {
  const key = isObject(v) && Object.keys(shapes).find((k) => k in v);
  return key ? shapes[key](v, at, bad) : bad(at, `should be ${hint}`);
};

const field = shape({
  "column!": str,
  type: oneOf(...TYPES),
  ref: strOrList,
  role: oneOf("parent", "children"),
  also: list(str),
  mark: str,
  match: regex,
  case: oneOf("upper"),
});
const ID_FROM = /^(frontmatter:.+|filename:.*\{id\}.*)$/;
const idFrom = like(ID_FROM, '"frontmatter:<key>" or "filename:<pattern with {id}>"');
const tableAt = shape({ "table!": str, "heading!": str });
const filesAt = shape({ "files!": str, "id!": idFrom });
const location = variant({ table: tableAt, files: filesAt }, '"table" or "files"');
const statusField = shape({ "field!": str, "values!": record(oneOf(...PHASES)) });
const derived = shape({ "derived!": oneOf("children") });
const status = variant({ field: statusField, derived }, '"field" + "values" or "derived"');
const ownFile = shape({
  "glob!": like(/\{id\}/, "a pattern with {id}"),
  required: bool,
  except: list(str),
  sections: record(shape({ "heading!": str, "as!": oneOf("table", "bold-lead"), column: str })),
});
const row = shape({
  "in!": like(/^(self|parent\.file:.+)$/, '"self" or "parent.file:<section>"'),
  "at!": like(/^(end|after-last:.+)$/, '"end" or "after-last:<field>"'),
  "cells!": record(str),
});
const block = shape({ "file!": str, "under!": str, "text!": str });
const kind = shape({
  "label!": str,
  note: str,
  "at!": location,
  id: shape({ column: str, match: regex, prefix: str }),
  fields: record(field),
  status,
  file: ownFile,
  contract: shape({ "blocks!": list(str), lead: list(oneOf("heading", "bold")) }),
  create: shape({ ask: list(str), "id!": str, rows: list(row), blocks: list(block) }),
});
const rule = shape(
  { "rule!": like(/\S/, "a rule id"), label: str, kind: str, except: record(list(str)) },
  true,
);
const lifecycle = shape({
  "kind!": str,
  "on!": shape({ dispatched: str, built: str, failed: str, merged: str }),
  write: record(str),
  handoff: str,
});
const processFile = shape({
  "version!": oneOf(1),
  "name!": str,
  "root!": str,
  "kinds!": record(kind),
  "rules!": list(rule),
  lifecycle,
  drafts: record(shape({ "kind!": str, "map!": record(str) })),
  status: shape({ now: str, note: str, prime: bool, lines: posInt }),
});

/** True when `path` (relative to `root`, itself relative to the repository) leaves the repository. */
export function escapesRoot(root, path) {
  if (posix.isAbsolute(root) || posix.isAbsolute(path)) return true;
  const full = posix.normalize(posix.join(root, path));
  return full === ".." || full.startsWith("../");
}

const entries = (v) => (isObject(v) ? Object.entries(v) : []);

// What only a reader can check: the kinds refs name, the fields status names, the paths.
function crossCheck(spec, bad) {
  const kinds = isObject(spec.kinds) ? spec.kinds : {};
  if (isObject(spec.kinds) && Object.keys(kinds).length === 0)
    bad("kinds", "should name at least one kind");
  const known = (name, at) =>
    typeof name !== "string" || name in kinds || bad(at, `names an unknown kind "${name}"`);
  const root = typeof spec.root === "string" ? spec.root : ".";
  if (escapesRoot(".", root)) bad("root", `"${root}" leaves the repository`);
  const inside = (path, at) =>
    typeof path !== "string" ||
    !escapesRoot(root, path) ||
    bad(at, `"${path}" leaves the repository`);
  for (const [name, k] of entries(kinds)) {
    const at = `kinds.${name}`;
    for (const [f, def] of entries(k.fields)) {
      for (const ref of [def?.ref ?? []].flat()) known(ref, `${at}.fields.${f}.ref`);
      if (def?.role && !def.ref) bad(`${at}.fields.${f}`, `has role "${def.role}" but no "ref"`);
    }
    if (isObject(k.at) && "table" in k.at && !k.id?.column) bad(`${at}.id`, 'needs a "column"');
    if (typeof k.status?.field === "string" && !(k.status.field in (k.fields ?? {})))
      bad(`${at}.status.field`, `names no field "${k.status.field}"`);
    for (const [s, def] of entries(k.file?.sections))
      if (def?.as === "table" && !def.column) bad(`${at}.file.sections.${s}`, 'needs a "column"');
    inside(k.at?.table, `${at}.at.table`);
    inside(k.at?.files, `${at}.at.files`);
    inside(k.file?.glob, `${at}.file.glob`);
    [k.contract?.blocks ?? []].flat().forEach((p, i) => inside(p, `${at}.contract.blocks[${i}]`));
    [k.create?.blocks ?? []].flat().forEach((b, i) => inside(b?.file, `${at}.create.blocks[${i}]`));
  }
  [spec.rules ?? []].flat().forEach((r, i) => known(r?.kind, `rules[${i}].kind`));
  known(spec.lifecycle?.kind, "lifecycle.kind");
  for (const [d, def] of entries(spec.drafts)) known(def?.kind, `drafts.${d}.kind`);
}

/** Validate a parsed process file: `{ spec, problems }`, each problem a Finding with rule "spec".
 *  `spec` is the value even when it has problems, so a reader can use what is sound. */
export function validateSpec(value, { file } = {}) {
  const problems = [];
  const where = file ? { file } : {};
  const bad = (at, message) =>
    problems.push({ rule: "spec", message: `${at} ${message}`, ...where });
  processFile(value, "", (at, message) => bad(at || "the process file", message));
  if (!isObject(value)) return { spec: null, problems };
  crossCheck(value, bad);
  return { spec: value, problems };
}

/** Parse the process file's text, then validate it. */
export function parseSpec(text, { file } = {}) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    const problem = { rule: "spec", message: `not valid JSON (${e.message})` };
    return { spec: null, problems: [file ? { ...problem, file } : problem] };
  }
  return validateSpec(value, { file });
}
