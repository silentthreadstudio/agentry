// spec — parse and validate the process file (`.agentry/process.json`, plan F13 §3.1) by hand: it
// mirrors core's zod schema (`packages/core/src/process.ts`; the plugin ships no dependency) and adds
// what only a reader can check (refs between kinds, paths, regexes, each rule's declared params).
// Every name the file supplies is looked up as an own property, never reaching a built-in such as
// `constructor`. PURE: never reads, never throws.
//
// The reader's invariants: what `read.mjs`, the rules and `rules/capabilities.mjs` take for granted
// of a kind, each refused here (exit 2 naming the key), so an option never silently changes what a
// rule checks. `format.md` ("What the reader assumes") words the same list.
// - ids: a table kind names its id `column`; a files kind takes its id from frontmatter or a filename
//   pattern with `{id}`; `match` is a valid regex.
// - types: a cell reads as its `type` (markdown.mjs `cellValue`); `ref` is read only from a `ref` or
//   `list` field, and names at least one declared kind; `case` is read only on a text field.
// - roles: a kind has at most one `parent` field, of type `ref` (the reader links a parent by one
//   id); a `children` field is of type `list`; a role field refs at least one kind.
// - status: phases are the five fixed words; `status.field` names a text field of the kind, and with
//   `case: "upper"` every status word is upper case, and every word equals what the reader makes of
//   a cell (`plain`: trimmed, `**` and backticks stripped), else none could match; `derived: "children"`
//   needs a child kind with a status (else every item is "planned").
// - sections: `as: "table"` names its id `column`; a section a rule reads leads by bold
//   (`done-has-handoff`) is a `bold-lead` one.
// - rule params: each against its declared type and the capabilities its kind `needs` (`checkRule`).
// - lifecycle: what the writer (`lifecycle.mjs`) puts where a rule reads it (`checkLifecycle`), and a
//   handoff template the enabled `done-has-handoff` rule accepts (`checkHandoff`).
// - harness keys (`gate`, `extensions`, `conductor`): no empty string or list, no unknown key, paths
//   inside the repository, skill names unique. Core's zod gives the same verdict on each (the shared
//   table, `test/key-cases.mjs`).
import { posix } from "node:path";
import { boldLeads, plain } from "./markdown.mjs";
import {
  CATALOG,
  FIELD,
  LINK,
  applies,
  lacks,
  phasesOf,
  pickField,
  ruleOf,
  withDefaults,
} from "./rules/index.mjs";

const PHASES = ["planned", "active", "done", "dropped", "parked"];
const TYPES = ["text", "list", "ref", "flag", "date", "commits", "evidence", "link", "mentions"];
const quote = (xs) => xs.map((x) => `"${x}"`).join(", ");
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (obj, key) => isObject(obj) && Object.hasOwn(obj, key);
/** `obj[key]` when `obj` holds `key` itself: a name from the process file or the board (`toString`,
 *  `constructor`) never reads a built-in. */
export const own = (obj, key) => (has(obj, key) ? obj[key] : undefined);
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
// A map of names; `__proto__` is refused, as no reader could hold it as a plain name.
const record = (item) => (v, at, bad) => {
  if (!isObject(v)) return bad(at, "should be an object");
  for (const [k, x] of Object.entries(v)) {
    if (k === "__proto__") bad(join(at, k), "is a reserved name");
    else item(x, join(at, k), bad);
  }
};
const strOrList = (v, at, bad) => (Array.isArray(v) ? list(str) : str)(v, at, bad);
// An object with known keys; a key written `name!` is required. `open` lets unknown keys through;
// `full` names a missing key by its own path (`gate.quick.only is required`), as the harness keys do.
// The checker carries its `keys`, so the format reference can be bound to them (format-doc test).
const shape = (keys, { open = false, full = false } = {}) =>
  Object.assign(
    (v, at, bad) => {
      if (!isObject(v)) return bad(at, "should be an object");
      const names = Object.keys(keys).map((k) => k.replace(/!$/, ""));
      for (const k of names)
        if (has(keys, `${k}!`) && !has(v, k))
          full ? bad(join(at, k), "is required") : bad(at, `is missing "${k}"`);
      for (const [k, x] of Object.entries(v)) {
        const check = own(keys, k) ?? own(keys, `${k}!`);
        if (check) check(x, join(at, k), bad);
        else if (!open) bad(join(at, k), `is not a known key (expected ${quote(names)})`);
      }
    },
    { keys },
  );
const FULL = { full: true };
// The harness keys' values: a string is never empty, a list never empty, a path stays inside the
// repository (relative to its git root), so a typo refuses instead of quietly checking less.
const text = is((v) => typeof v === "string" && v.length > 0, "should be a non-empty string");
const repoPath = (v, at, bad) =>
  typeof v === "string" && v.length > 0
    ? escapesRoot(".", v) && bad(at, `"${v}" leaves the repository`)
    : text(v, at, bad);
const filled = (item) => (v, at, bad) =>
  Array.isArray(v) && v.length === 0 ? bad(at, "should not be empty") : list(item)(v, at, bad);
// A list without repeats; empty is allowed (`merge.checks: []` names no repo check, as format.md says).
const distinct = (item) => (v, at, bad) => {
  list(item)(v, at, bad);
  if (Array.isArray(v))
    v.forEach((x, i) => v.indexOf(x) < i && bad(`${at}[${i}]`, `repeats ${JSON.stringify(x)}`));
};
// One of several shapes, picked by the key that tells them apart (`table` vs `files`).
const variant = (shapes, hint) => (v, at, bad) => {
  const key = isObject(v) && Object.keys(shapes).find((k) => has(v, k));
  return key ? shapes[key](v, at, bad) : bad(at, `should be ${hint}`);
};

const field = shape({
  "column!": str,
  type: oneOf(...TYPES),
  ref: strOrList,
  prefix: str,
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
// The keys every rule entry may carry; the rest are its rule's params, checked by `checkRule`.
const rule = shape({ "rule!": like(/\S/, "a rule id"), label: str, note: str }, { open: true });
const ENTRY = ["rule", "label", "note"];
const lifecycle = shape({
  "kind!": str,
  "on!": shape({ dispatched: str, built: str, failed: str, merged: str }),
  write: shape({
    status: str,
    verdict: str,
    commit: str,
    handoff: like(/^parent\.file:.+$/, '"parent.file:<section>"'),
  }),
  handoff: str,
});
// The repo's gate (argv, no shell), its quick tier and the files it may leave changed; the repo
// skills merge runs as checks; the repo's conductor prompt (plan R1b §2, §3.1).
const argv = filled(text);
const globs = filled(repoPath);
const gate = shape(
  {
    "command!": argv,
    quick: shape({ "command!": argv, "only!": globs }, FULL),
    after: globs,
    concurrency: posInt,
    flaky: filled(text),
    note: text,
  },
  FULL,
);
const skill = like(/^[a-z0-9][a-z0-9-]*$/, "a skill name (lower-case letters, digits and -)");
const extensions = shape({ "merge!": shape({ "checks!": distinct(skill) }, FULL) }, FULL);
const conductor = shape({ "prompt!": repoPath, rules: text }, FULL);
/** The process-file `version` this plugin reads. */
export const SPEC_VERSION = 1;
const processFile = shape({
  "version!": oneOf(SPEC_VERSION),
  "name!": str,
  "root!": str,
  "kinds!": record(kind),
  "rules!": list(rule),
  lifecycle,
  drafts: record(shape({ "kind!": str, "map!": record(str) })),
  status: shape({ now: str, note: str, prime: bool, lines: posInt, file: repoPath, next: text }),
  worktrees: shape({ "keep!": filled(text) }, FULL),
  gate,
  extensions,
  conductor,
  guard: shape({ "allow!": globs }, FULL),
});
/** The process file's checker; `schema.keys` (and each nested shape's `keys`) lists its keys, a
 *  trailing `!` marking a required one. The format reference is bound to it. */
export const schema = processFile;

/** The repo's gate with its defaults filled (`after: []`, `concurrency: 1`, `flaky: []`, no quick tier), or null when the process
 *  file has none. A copy: changing it never changes the spec. */
export function gateOf(spec) {
  const g = own(spec, "gate");
  if (!isObject(g)) return null;
  return structuredClone({
    command: g.command,
    quick: g.quick ?? null,
    after: g.after ?? [],
    concurrency: g.concurrency ?? 1,
    flaky: g.flaky ?? [],
    note: g.note ?? null,
  });
}

// The values a handoff template fills: `{id}`, `{sha}` (the first commit) and `{summary}`.
const SLOTS = ["id", "sha", "summary"];
const SLOT = /\{(\w+)\}/g;
/** A handoff template filled: each value on one line (runs of white space become one space); any
 *  other `{name}` is left as written (the process file check refuses it). `lifecycle.mjs`'s
 *  `renderHandoff` is this on the spec's template. */
export const fillHandoff = (template, values) =>
  template.replace(SLOT, (all, name) =>
    SLOTS.includes(name)
      ? String(own(values, name) ?? "")
          .replace(/\s+/g, " ")
          .trim()
      : all,
  );

/** True when `path` (relative to `root`, itself relative to the repository) leaves the repository. */
export function escapesRoot(root, path) {
  if (posix.isAbsolute(root) || posix.isAbsolute(path)) return true;
  const full = posix.normalize(posix.join(root, path));
  return full === ".." || full.startsWith("../");
}

const entries = (v) => (isObject(v) ? Object.entries(v) : []);

// A field as a problem names it: `the list field "blocks" with no ref`, `the commits field "commit"`.
function describe(field, name) {
  const type = typeof field?.type === "string" ? field.type : "text";
  const refs = [field?.ref ?? []].flat().filter((k) => typeof k === "string");
  const to = refs.length
    ? ` of ${refs.join(" or ")}`
    : ["list", "ref"].includes(type)
      ? " with no ref"
      : "";
  return `the ${type} field "${name}"${to}`;
}

// One param value against its declared type (`rules/index.mjs`). `ctx` is { kinds, kind, name, given,
// rule, targets }: `kind` is the entry's kind spec when it names a declared kind, `name` that kind's
// name, `targets` the names of the kinds the rule checks.
const fieldsOf = (kind) => (isObject(kind?.fields) ? kind.fields : {});
const sectionsOf = (kind) => (isObject(kind?.file?.sections) ? kind.file.sections : {});
// A kind's field with role "parent", as [name, field], and the kinds it refs.
const parentOf = (kind) => Object.entries(fieldsOf(kind)).find(([, f]) => f?.role === "parent");
const refsOf = (field) => [field?.ref ?? []].flat().filter((k) => typeof k === "string");
const both = (xs) => xs.join(" and ");
const named = (test) => (v, at, bad, ctx, p) => {
  if (typeof v !== "string") return bad(at, "should be a string");
  const problem = test(v, ctx, p);
  if (problem) bad(at, ctx.given ? problem : `defaults to "${v}", which ${problem}`);
};
const PARAM = {
  string: str,
  strings: list(str),
  enum: (v, at, bad, _ctx, p) => oneOf(...p.values)(v, at, bad),
  // A declared kind that lacks what the rule `needs` of it, judged once the entry's own kind is known.
  kind: named((v, { kinds, name, rule }, p) => {
    if (!has(kinds, v)) return `names an unknown kind "${v}"`;
    const missing = name ? lacks(kinds, v, p.needs, name) : [];
    return missing.length > 0 && `names "${v}", which lacks ${both(missing)}; ${rule} needs it`;
  }),
  // A field of the type `is` names, and with `needs`, one that refs a kind that has them.
  field: named((v, { kinds, kind, name, rule }, p) => {
    if (!kind) return false;
    if (!has(fieldsOf(kind), v)) return `names no ${name} field "${v}"`;
    const field = fieldsOf(kind)[v];
    if (!FIELD[p.is].fits(field, name))
      return `names ${describe(field, v)}; ${rule} needs ${FIELD[p.is].says(`"${name}"`)}`;
    const refs = refsOf(field);
    if (!p.needs || refs.some((k) => lacks(kinds, k, p.needs).length === 0)) return false;
    const missing = both(lacks(kinds, refs[0], p.needs));
    return `names ${describe(field, v)}, and no kind it refs has ${missing}; ${rule} needs one`;
  }),
  // A section of the parent's file is judged once the kind has a parent (its `needs` says so).
  // With `as`, a section read that way (`bold-lead`).
  section: named((v, { kinds, kind, name }, p) => {
    if (!kind) return false;
    const fits = (k) => has(sectionsOf(k), v) && (!p.as || sectionsOf(k)[v]?.as === p.as);
    const what = `${p.as ? `${p.as} ` : ""}section "${v}"`;
    if (p.of === "kind") return !fits(kind) && `names no ${what} of the ${name} file`;
    const refs = refsOf(parentOf(kind)?.[1]);
    return (
      refs.length > 0 &&
      !refs.some((k) => fits(own(kinds, k))) &&
      `names no ${what} of the ${refs.join(" or ")} file`
    );
  }),
  // That the kind has a parent is its `needs`; which parent values exist, the board's to say:
  // `checkOnBoard`.
  parent: named(() => false),
  except: (v, at, bad, { kinds, targets }) => {
    if (!isObject(v)) return bad(at, "should be an object");
    for (const [k, x] of Object.entries(v)) {
      list(str)(x, join(at, k), bad);
      for (const t of k === "id" ? [] : targets)
        if (!has(fieldsOf(kinds[t]), k)) bad(join(at, k), `names no ${t} field (or "id")`);
    }
  },
};

const onlyWhen = (only) =>
  Object.entries(only)
    .map(([p, values]) => `${p} is ${values.map((v) => `"${v}"`).join(" or ")}`)
    .join(" and ");

// A rules[] entry against the params its catalog rule declares: an unknown rule or param, a missing
// one, a wrong type, or a kind, field or section the process file does not declare. The defaults are
// checked too, so a rule never runs on a field its kind lacks.
function checkRule(entry, at, kinds, bad) {
  if (!isObject(entry) || typeof entry.rule !== "string") return; // the shape check reports it
  const rule = ruleOf(entry.rule);
  if (!rule)
    return bad(
      `${at}.rule`,
      `names an unknown rule "${entry.rule}" (${quote(Object.keys(CATALOG))})`,
    );
  const declared = Object.keys(rule.params);
  const takes = declared.length ? `its params: ${quote(declared)}` : "it takes none";
  for (const k of Object.keys(entry))
    if (!ENTRY.includes(k) && !has(rule.params, k))
      bad(join(at, k), `is not a param of ${entry.rule} (${takes})`);
  const name = typeof entry.kind === "string" && has(kinds, entry.kind) ? entry.kind : null;
  const kind = name && isObject(kinds[name]) ? kinds[name] : null;
  // The kinds the rule checks (its `kinds`, else the entry's own): what `except` keys name.
  const targets = (rule.kinds ? rule.kinds(kinds, entry) : [name]).filter(
    (k) => typeof k === "string" && has(kinds, k),
  );
  if (rule.kinds && !has(entry, "kind") && targets.length === 0)
    bad(
      at,
      has(rule.params, "kind")
        ? `is missing "kind", and ${rule.none}: ${entry.rule} would check nothing`
        : `${rule.none}: ${entry.rule} would check nothing`,
    );
  for (const [p, def] of Object.entries(rule.params)) {
    const given = has(entry, p);
    if (!applies(rule, def, entry)) {
      if (given) bad(join(at, p), `is used only when ${onlyWhen(def.only)}`);
      continue;
    }
    if (!given && def.required) bad(at, `is missing "${p}" (${entry.rule} needs it)`);
    if (!given && def.pick) {
      if (kind && !pickField(fieldsOf(kind), def, name)) {
        const needs = `${entry.rule} needs ${FIELD[def.is].says(`"${name}"`)}`;
        bad(at, `is missing "${p}", and no ${name} field fits (${needs})`);
      }
      continue;
    }
    const value = given ? entry[p] : def.default;
    if (value !== undefined)
      PARAM[def.type](
        value,
        join(at, p),
        bad,
        { kinds, kind, name, given, rule: entry.rule, targets },
        def,
      );
  }
}

// The reader's invariants on kind `name`'s fields and status (the header): what a ref is read
// from, how a role links, which field a status is read from and whether a derived one can move.
function checkTree(kinds, name, at, bad) {
  const k = kinds[name];
  const fields = fieldsOf(k);
  let parent;
  for (const [f, def] of Object.entries(fields)) {
    if (!isObject(def)) continue;
    const here = `${at}.fields.${f}`;
    const type = def.type ?? "text";
    const typed = TYPES.includes(type); // a wrong type is the shape check's to report
    if (Array.isArray(def.ref) && def.ref.length === 0)
      bad(`${here}.ref`, "should name at least one kind");
    if (has(def, "ref") && typed && !["ref", "list", "mentions"].includes(type))
      bad(
        `${here}.ref`,
        `is read only from a "ref", "list" or "mentions" field, and "${f}" is ${type}`,
      );
    if (has(def, "prefix") && typed && type !== "mentions")
      bad(`${here}.prefix`, `is read only on a "mentions" field, and "${f}" is ${type}`);
    if (type === "mentions") {
      if (!has(def, "ref"))
        bad(here, `is a "mentions" field and needs a "ref" (the kind it cites)`);
      if (!has(def, "prefix"))
        bad(here, `is a "mentions" field and needs a "prefix" (such as "D")`);
    }
    // On a ref it would upper-case the id before the tree links it, so a mixed-case id never links.
    if (has(def, "case") && typed && type !== "text")
      bad(`${here}.case`, `is read only on a text field, and "${f}" is ${type}`);
    if (!has(LINK, def.role)) continue;
    if (!def.ref) bad(here, `has role "${def.role}" but no "ref"`);
    else if (typed && type !== LINK[def.role])
      bad(here, `has role "${def.role}", which needs type "${LINK[def.role]}", not "${type}"`);
    if (def.role !== "parent") continue;
    if (parent) bad(`${here}.role`, `is "parent" as "${parent}" is; a kind has one parent field`);
    parent ??= f;
  }
  const status = isObject(k.status) ? k.status : {};
  const field = typeof status.field === "string" ? own(fields, status.field) : undefined;
  if (isObject(field)) {
    const type = field.type ?? "text";
    if (type !== "text")
      bad(
        `${at}.status.field`,
        `names the ${type} field "${status.field}"; a status is one word, read from a text field`,
      );
    if (field.case === "upper")
      for (const word of Object.keys(isObject(status.values) ? status.values : {}))
        if (word !== word.toUpperCase())
          bad(
            `${at}.status.values.${word}`,
            `can never match: "${status.field}" reads upper case ("case": "upper")`,
          );
  }
  // A status is looked up as the reader makes it of a cell; a word that differs from that is never found.
  for (const word of Object.keys(isObject(status.values) ? status.values : {}))
    if (word !== plain(word) || /[\r\n]/.test(word))
      bad(
        `${at}.status.values.${word}`,
        `can never match: the reader trims every cell and strips "**" and backticks (a cell is one line), so it never reads ${JSON.stringify(word)}`,
      );
  if (status.derived === "children" && phasesOf(kinds, name).length === 0)
    bad(
      `${at}.status.derived`,
      `needs children with a status (a kind whose parent field refs ${name}, or a children list of ${name}, to a kind with a status); without, every ${name} is "planned"`,
    );
}

// What only a reader can check: the kinds refs name, the fields status names, the paths.
function crossCheck(spec, bad) {
  const kinds = isObject(spec.kinds) ? spec.kinds : {};
  if (isObject(spec.kinds) && Object.keys(kinds).length === 0)
    bad("kinds", "should name at least one kind");
  const known = (name, at) =>
    typeof name !== "string" || has(kinds, name) || bad(at, `names an unknown kind "${name}"`);
  const root = typeof spec.root === "string" ? spec.root : ".";
  if (escapesRoot(".", root)) bad("root", `"${root}" leaves the repository`);
  const inside = (path, at) =>
    typeof path !== "string" ||
    !escapesRoot(root, path) ||
    bad(at, `"${path}" leaves the repository`);
  for (const [name, k] of entries(kinds)) {
    if (!isObject(k)) continue; // reported by the shape check
    const at = `kinds.${name}`;
    const fields = isObject(k.fields) ? k.fields : {};
    for (const [f, def] of Object.entries(fields))
      for (const ref of [def?.ref ?? []].flat()) known(ref, `${at}.fields.${f}.ref`);
    checkTree(kinds, name, at, bad);
    if (has(k.at, "table") && !k.id?.column) bad(`${at}.id`, 'needs a "column"');
    if (typeof k.status?.field === "string" && !has(fields, k.status.field))
      bad(`${at}.status.field`, `names no field "${k.status.field}"`);
    for (const [s, def] of entries(k.file?.sections))
      if (def?.as === "table" && !def.column) bad(`${at}.file.sections.${s}`, 'needs a "column"');
    inside(k.at?.table, `${at}.at.table`);
    inside(k.at?.files, `${at}.at.files`);
    inside(k.file?.glob, `${at}.file.glob`);
    [k.contract?.blocks ?? []].flat().forEach((p, i) => inside(p, `${at}.contract.blocks[${i}]`));
    [k.create?.blocks ?? []].flat().forEach((b, i) => inside(b?.file, `${at}.create.blocks[${i}]`));
  }
  if (Array.isArray(spec.rules))
    spec.rules.forEach((r, i) => checkRule(r, `rules[${i}]`, kinds, bad));
  known(spec.lifecycle?.kind, "lifecycle.kind");
  known(spec.status?.now, "status.now");
  const note = spec.status?.note;
  if (typeof note === "string" && escapesRoot(".", note))
    bad("status.note", `"${note}" leaves the repository`);
  for (const [d, def] of entries(spec.drafts)) known(def?.kind, `drafts.${d}.kind`);
  checkLifecycle(spec, bad);
}

// What the lifecycle writer (`lifecycle.mjs`) takes for granted: each `on` word is a status of the
// kind, the status goes to its status field, the verdict to a text field, the commits to a commits
// field, the handoff line to a bold-lead section of the parent's file, from a one-line template that
// fills only {id}, {sha} and {summary}. Otherwise a write would land where no rule reads it.
function checkLifecycle(spec, bad) {
  const life = spec.lifecycle;
  if (!isObject(life) || typeof life.kind !== "string" || !has(spec.kinds, life.kind)) return;
  const name = life.kind;
  const kind = isObject(spec.kinds[name]) ? spec.kinds[name] : {};
  const fields = fieldsOf(kind);
  const status = isObject(kind.status) ? kind.status : {};
  const words = isObject(status.values) ? status.values : null;
  for (const [event, word] of entries(life.on))
    if (typeof word === "string" && !has(words, word))
      bad(
        `lifecycle.on.${event}`,
        words
          ? `"${word}" is not a ${name} status (${quote(Object.keys(words))})`
          : `names a status, but ${name} has no status field`,
      );
  const write = isObject(life.write) ? life.write : {};
  if (typeof write.status === "string" && write.status !== status.field)
    bad(
      "lifecycle.write.status",
      `is "${write.status}", but ${name}'s status is read from ${typeof status.field === "string" ? `"${status.field}"` : "its children"}`,
    );
  for (const [key, is] of [
    ["verdict", "text"],
    ["commit", "commits"],
  ]) {
    const f = write[key];
    if (typeof f !== "string") continue;
    if (!has(fields, f)) bad(`lifecycle.write.${key}`, `names no ${name} field "${f}"`);
    else if (!FIELD[is].fits(fields[f], name))
      bad(
        `lifecycle.write.${key}`,
        `names ${describe(fields[f], f)}; it needs ${FIELD[is].says()}`,
      );
  }
  const target = typeof write.handoff === "string" && /^parent\.file:.+$/.test(write.handoff);
  if (target) {
    const section = write.handoff.slice("parent.file:".length);
    const refs = refsOf(parentOf(kind)?.[1]);
    const fits = (k) => own(sectionsOf(own(spec.kinds, k)), section)?.as === "bold-lead";
    if (refs.length === 0) bad("lifecycle.write.handoff", `needs a parent field on ${name}`);
    else if (!refs.some(fits))
      bad(
        "lifecycle.write.handoff",
        `names no bold-lead section "${section}" of the ${refs.join(" or ")} file`,
      );
    if (!has(life, "handoff"))
      bad("lifecycle.write.handoff", 'needs the line it writes: a "handoff" template');
  }
  if (typeof life.handoff !== "string") return;
  if (/[\r\n]/.test(life.handoff)) bad("lifecycle.handoff", "should be one line");
  for (const [, slot] of life.handoff.matchAll(SLOT))
    if (!SLOTS.includes(slot))
      bad(
        "lifecycle.handoff",
        `fills no {${slot}} (it fills ${SLOTS.map((s) => `{${s}}`).join(", ")})`,
      );
}

// The ids and values a handoff template is tried with (`checkHandoff`).
const PROBE = { id: "X1", parent: "P1", sha: "0a1b2c3", summary: "a summary" };

// The `done-has-handoff` entries of the process file that judge the lifecycle's kind: [index, entry].
const handoffRules = (spec) =>
  spec.rules.flatMap((entry, i) =>
    entry.rule === "done-has-handoff" && entry.kind === spec.lifecycle.kind ? [[i, entry]] : [],
  );

/** The first message of the `done-has-handoff` rules (those on the lifecycle's kind) rejecting `line`
 *  as the handoff of item `id`, whose first commit is `sha`, written under a parent `parent`; null
 *  when they all accept it. The same check the board runs, on a board of just that item, so the
 *  writer can ask it of the very line it is about to write. */
export function handoffRejection(spec, line, { id, sha, parent }) {
  const rule = ruleOf("done-has-handoff");
  for (const [i, entry] of handoffRules(spec)) {
    const params = withDefaults(rule, entry, spec.kinds);
    const model = probeBoard(spec, params, line, { id, sha, parent });
    let found;
    try {
      found = model ? rule.check(model, params, { hasCommit: () => true }) : [];
    } catch (error) {
      found = [{ message: error.message }];
    }
    if (found.length) return `rules[${i}] (done-has-handoff) rejects: ${found[0].message}`;
  }
  return null;
}

// Only `merged` may finish a task (A23: done = on main), and when it does it must write everything the
// "done" rules on the lifecycle's kind read: a `done-has-evidence` field gets the commits, a
// `done-signoff` date is never written by the lifecycle (so that rule can't sit on its kind). Otherwise
// an event the writer applies would leave a done task the checker rejects.
function checkDone(spec, bad) {
  const life = spec.lifecycle;
  if (!isObject(life) || !has(spec.kinds, life.kind)) return;
  const values = spec.kinds[life.kind]?.status?.values;
  const phaseOf = (word) => (isObject(values) && has(values, word) ? values[word] : undefined);
  let finishes = false;
  for (const [event, word] of entries(life.on)) {
    if (phaseOf(word) !== "done") continue;
    if (event !== "merged")
      bad(
        `lifecycle.on.${event}`,
        `sets "${word}", a done status; only "merged" may finish a task`,
      );
    else finishes = true;
  }
  if (!finishes) return;
  const write = isObject(life.write) ? life.write : {};
  spec.rules.forEach((entry, i) => {
    if (!isObject(entry) || entry.kind !== life.kind) return;
    if (entry.rule === "done-has-evidence" && write.commit !== entry.field)
      bad(
        "lifecycle.write.commit",
        `is ${write.commit === undefined ? "missing" : JSON.stringify(write.commit)}, but rules[${i}] (done-has-evidence) reads the commits of a done ${life.kind} from "${entry.field}"`,
      );
    if (entry.rule === "done-signoff")
      bad(
        `rules[${i}]`,
        `(done-signoff) needs a dated sign-off on a done ${life.kind}, which "merged" never writes`,
      );
  });
}

// Load-time self-consistency (plan R1b §2.6): with a `done-has-handoff` rule on the lifecycle's kind,
// the line the writer would append, filled with a fake SHA, goes through that rule's own check on a
// one-item board. A template the rule rejects (no bold lead, the SHA not right after `(` with
// `commit: "first"`), a handoff written to another section than the rule reads, or no handoff
// written at all, is a spec error: the writer can never produce a line the checker rejects. Run on an
// otherwise valid file only. (The id and SHAs of a real event are checked again when it is applied.)
function checkHandoff(spec, bad) {
  const life = spec.lifecycle;
  if (!isObject(life)) return;
  const rules = handoffRules(spec);
  if (rules.length && typeof life.write?.handoff !== "string")
    return bad(
      "lifecycle.write.handoff",
      `is missing, but rules[${rules[0][0]}] (done-has-handoff) reads the ${life.kind} handoff line it would write`,
    );
  if (typeof life.handoff !== "string") return;
  const line = fillHandoff(life.handoff, PROBE);
  const section = /^parent\.file:(.+)$/.exec(life.write?.handoff ?? "")?.[1];
  for (const [i, entry] of rules)
    if (section !== undefined && section !== entry.section)
      return bad(
        "lifecycle.write.handoff",
        `writes to section "${section}", but rules[${i}] (done-has-handoff) reads "${entry.section}"`,
      );
  const found = handoffRejection(spec, line, PROBE);
  if (found) bad("lifecycle.handoff", `renders ${JSON.stringify(line)}, which ${found}`);
}

// A board of one done item (`id`, its commits field holding `sha`) and its parent, whose
// handoff section holds `line` alone. Null when no kind the parent field refs has that section.
function probeBoard(spec, params, line, { id, sha, parent: parentId }) {
  const name = spec.lifecycle.kind;
  const refs = refsOf(parentOf(spec.kinds[name])?.[1]);
  const parentKind = refs.find((k) => has(sectionsOf(own(spec.kinds, k)), params.section));
  if (!parentKind) return null;
  const item = {
    kind: name,
    id: id,
    fields: params.field ? { [params.field]: [sha] } : {},
    phase: "done",
    parent: parentId,
    children: [],
    file: "probe",
    line: 1,
  };
  const leads = boldLeads(line);
  const parent = {
    kind: parentKind,
    id: parentId,
    fields: {},
    children: [id],
    file: "probe",
    line: 1,
    own: { path: `its ${params.section} section`, sections: { [params.section]: { leads } } },
  };
  const kinds = Object.fromEntries(Object.keys(spec.kinds).map((k) => [k, { items: [] }]));
  kinds[parentKind].items.push(parent);
  kinds[name].items.push(item);
  const index = { [id]: [item], [parentId]: [parent] };
  return { spec, kinds, index, problems: [] };
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
  if (problems.length === 0) {
    checkHandoff(value, bad);
    checkDone(value, bad);
  }
  return { spec: value, problems };
}

/** What only the board can tell of a valid process file's rules: a "parent" param (parked.parking)
 *  names an `also` value of its kind's parent field or an item of a kind that field refs. Problems as
 *  `validateSpec` gives them; a parent kind the reader did not find is not judged. */
export function checkOnBoard(spec, model, { file } = {}) {
  const problems = [];
  spec.rules.forEach((entry, i) => {
    for (const [p, def] of Object.entries(ruleOf(entry.rule)?.params ?? {})) {
      if (def.type !== "parent" || !has(entry, p)) continue;
      const value = entry[p];
      const [name, field] = parentOf(own(spec.kinds, entry.kind)) ?? [];
      const refs = refsOf(field);
      if (!field || field.also?.includes(value)) continue;
      if (refs.some((k) => !own(model.kinds, k)?.located)) continue;
      if ((own(model.index, value) ?? []).some((item) => refs.includes(item.kind))) continue;
      const what = `neither a ${refs.join(" or ")} on the board nor an "also" value of ${entry.kind}.${name}`;
      const message = `rules[${i}].${p} names "${value}", ${what}`;
      problems.push({ rule: "spec", message, ...(file ? { file } : {}) });
    }
  });
  return problems;
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
