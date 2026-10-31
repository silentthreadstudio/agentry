// The rule catalog: id -> Rule. A Rule is { id, params, check(model, params, ctx) -> Finding[] }.
//
// `params` is the single list of what a process-file entry may set besides `rule`, `label` and `note`:
// name -> { type, required?, default?, values?, of?, is? }. Types: "string", "strings" (a list of
// strings), "enum" (one of `values`), "kind" (a kind the file declares), "field" (a field of the
// entry's kind, of the type `is` names in `FIELD`: a value never reads a field the rule cannot use),
// "section" (a section of the entry's kind's own file, or `of: "parent"` of its parent kind's) and
// "except" ({ <field or "id">: [values] }). `spec.mjs` checks every entry against it; `check.mjs` fills
// the defaults, so a rule never runs with a param it did not declare.
import { rules as evidence } from "./evidence.mjs";
import { rules as flow } from "./flow.mjs";
import { rules as structure } from "./structure.mjs";

export { FIELD } from "./structure.mjs";

export const CATALOG = Object.fromEntries(
  [...structure, ...flow, ...evidence].map((r) => [r.id, r]),
);

/** The catalog rule an id names, or undefined (an id such as `toString` names none). */
export const ruleOf = (id) => (Object.hasOwn(CATALOG, id) ? CATALOG[id] : undefined);

/** An entry with its rule's declared defaults filled in for the params it leaves out. */
export function withDefaults(rule, entry) {
  const defaults = Object.entries(rule.params)
    .filter(([name, p]) => p.default !== undefined && !Object.hasOwn(entry, name))
    .map(([name, p]) => [name, structuredClone(p.default)]);
  return { ...entry, ...Object.fromEntries(defaults) };
}
