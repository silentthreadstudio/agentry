// board — the process file (`.agentry/process.json`): its schema, the board's six keys (mirrors core's
// `ProcessBoard`, `packages/core/src/process.ts`), and what only a reader can check inside it: refs
// between kinds, the paths, each rule's declared params (`rules.mjs`). PURE: never reads, never throws.
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
import { plain } from "../markdown.mjs";
import { LINK, phasesOf } from "../rules/index.mjs";
import { checkRule, fieldsOf, ruleEntry } from "./rules.mjs";
import {
  bool,
  entries,
  escapesRoot,
  has,
  isObject,
  like,
  list,
  oneOf,
  own,
  posInt,
  record,
  regex,
  repoPath,
  shape,
  str,
  strOrList,
  text,
  variant,
} from "./shape.mjs";

const PHASES = ["planned", "active", "done", "dropped", "parked"];
const TYPES = ["text", "list", "ref", "flag", "date", "commits", "evidence", "link", "mentions"];

const field = shape({
  "column!": str,
  type: oneOf(...TYPES),
  ref: strOrList,
  prefix: str,
  role: oneOf("parent", "children"),
  also: list(str),
  mark: str,
  join: like(
    /^[^0-9A-Za-z\p{Cc}]+$/u,
    'a separator with no letters, digits, line breaks or control characters (such as " " or ", ")',
  ),
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

/** The process-file `version` this plugin reads. */
export const SPEC_VERSION = 1;
/** The process file's checker; `boardSchema.keys` (and each nested shape's `keys`) lists its keys, a
 *  trailing `!` marking a required one. The format reference is bound to it. */
export const boardSchema = shape({
  "version!": oneOf(SPEC_VERSION),
  "name!": str,
  "root!": str,
  "kinds!": record(kind),
  "rules!": list(ruleEntry),
  status: shape({ now: str, note: str, prime: bool, lines: posInt, file: repoPath, next: text }),
});

/** The reader's invariants on kind `name`'s fields and status (the header): what a ref is read
 *  from, how a role links, which field a status is read from and whether a derived one can move. */
export function checkTree(kinds, name, at, bad) {
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
    if (has(def, "join") && typed && !["commits", "evidence"].includes(type))
      bad(`${here}.join`, `is read only on a "commits" or "evidence" field, and "${f}" is ${type}`);
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

// What only a reader can check inside the board: the kinds refs name, the fields status names, the paths.
function checkKinds(spec, bad) {
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
  known(spec.status?.now, "status.now");
  const note = spec.status?.note;
  if (typeof note === "string" && escapesRoot(".", note))
    bad("status.note", `"${note}" leaves the repository`);
}

/** Check a parsed process file (its board keys only): each problem goes to `bad(path, message)`. */
export function validateBoard(value, bad) {
  boardSchema(value, "", (at, message) => bad(at || "the process file", message));
  if (isObject(value)) checkKinds(value, bad);
}
