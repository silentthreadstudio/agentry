// The rule catalog: id -> Rule. A Rule is { id, params, kinds?, check(model, params, ctx) -> Finding[] },
// where `kinds(specKinds, params) -> names` gives the kinds it checks when that is not `params.kind`.
//
// `params` is the single list of what a process-file entry may set besides `rule`, `label` and `note`:
// name -> { type, required?, default?, values?, of?, is?, pick?, only? }. Types: "string", "strings"
// (a list of strings), "enum" (one of `values`), "kind" (a kind the file declares), "field" (a field
// of the entry's kind, of the type `is` names in `FIELD`: a value never reads a field the rule cannot
// use), "section" (a section of the entry's kind's own file, or `of: "parent"` of its parent kind's),
// "parent" (a value the kind's parent field can hold: an item of the kind it refs, or an `also`
// value; the board decides, `checkOnBoard`) and "except" ({ <field or "id">: [values] }). `pick`: left out, a field param takes the first field
// of the kind that fits. `only`: { <param>: [values] }, the param is used only while that one holds
// one of them. `spec.mjs` checks every entry against it; `check.mjs` fills the defaults, so a rule
// never runs with a param it did not declare.
import { rules as evidence } from "./evidence.mjs";
import { rules as flow } from "./flow.mjs";
import { FIELD, rules as structure } from "./structure.mjs";

export { FIELD };

export const CATALOG = Object.fromEntries(
  [...structure, ...flow, ...evidence].map((r) => [r.id, r]),
);

/** The catalog rule an id names, or undefined (an id such as `toString` names none). */
export const ruleOf = (id) => (Object.hasOwn(CATALOG, id) ? CATALOG[id] : undefined);

const paramValue = (rule, entry, name) =>
  Object.hasOwn(entry, name) ? entry[name] : rule.params[name]?.default;

/** Whether param `def` is used by `entry`: always, or (`only`) while each param it names holds one of
 *  the values listed (given or by default). */
export const applies = (rule, def, entry) =>
  Object.entries(def.only ?? {}).every(([name, values]) =>
    values.includes(paramValue(rule, entry, name)),
  );

/** The field a `pick` param defaults to: the first of `fields` that fits its type, or undefined. */
export const pickField = (fields, def, kind) =>
  Object.entries(fields ?? {}).find(([, f]) => FIELD[def.is].fits(f, kind))?.[0];

/** An entry with its rule's declared defaults filled in for the params it leaves out and uses; a
 *  `pick` param takes its field from `kinds` (the process file's). */
export function withDefaults(rule, entry, kinds = {}) {
  const kind = Object.hasOwn(kinds, entry.kind) ? kinds[entry.kind] : undefined;
  const defaults = Object.entries(rule.params)
    .filter(([name, p]) => !Object.hasOwn(entry, name) && applies(rule, p, entry))
    .map(([name, p]) => [
      name,
      p.pick ? pickField(kind?.fields, p, entry.kind) : structuredClone(p.default),
    ])
    .filter(([, value]) => value !== undefined);
  return { ...entry, ...Object.fromEntries(defaults) };
}
