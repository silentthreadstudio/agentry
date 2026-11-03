// rules — a `rules[]` entry of the process file against the params its catalog rule declares
// (`checkRule`, by type: `PARAM`), what only the board can tell of them (`checkOnBoard`), and the reads of
// a kind's fields and sections the checks share. PURE: never reads, never throws.
import { CATALOG, FIELD, applies, lacks, pickField, ruleOf } from "../rules/index.mjs";
import { has, isObject, join, like, list, oneOf, own, quote, shape, str } from "./shape.mjs";

export const fieldsOf = (kind) => (isObject(kind?.fields) ? kind.fields : {});
export const sectionsOf = (kind) => (isObject(kind?.file?.sections) ? kind.file.sections : {});
/** A kind's field with role "parent", as [name, field]. */
export const parentOf = (kind) =>
  Object.entries(fieldsOf(kind)).find(([, f]) => f?.role === "parent");
/** The kinds a field refs. */
export const refsOf = (field) => [field?.ref ?? []].flat().filter((k) => typeof k === "string");

/** A field as a problem names it: `the list field "blocks" with no ref`, `the commits field "commit"`. */
export function describe(field, name) {
  const type = typeof field?.type === "string" ? field.type : "text";
  const refs = refsOf(field);
  const to = refs.length
    ? ` of ${refs.join(" or ")}`
    : ["list", "ref"].includes(type)
      ? " with no ref"
      : "";
  return `the ${type} field "${name}"${to}`;
}

// The keys every rule entry may carry; the rest are its rule's params, checked by `checkRule`.
const ENTRY = ["rule", "label", "note"];
/** A rules[] entry's shape: a rule id, its label and note, then any params. */
export const ruleEntry = shape(
  { "rule!": like(/\S/, "a rule id"), label: str, note: str },
  { open: true },
);

const both = (xs) => xs.join(" and ");
const named = (test) => (v, at, bad, ctx, p) => {
  if (typeof v !== "string") return bad(at, "should be a string");
  const problem = test(v, ctx, p);
  if (problem) bad(at, ctx.given ? problem : `defaults to "${v}", which ${problem}`);
};
// One param value against its declared type (`rules/index.mjs`). `ctx` is { kinds, kind, name, given,
// rule, targets }: `kind` is the entry's kind spec when it names a declared kind, `name` that kind's
// name, `targets` the names of the kinds the rule checks.
export const PARAM = {
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

/** A rules[] entry against the params its catalog rule declares: an unknown rule or param, a missing
 *  one, a wrong type, or a kind, field or section the process file does not declare. The defaults are
 *  checked too, so a rule never runs on a field its kind lacks. */
export function checkRule(entry, at, kinds, bad) {
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
