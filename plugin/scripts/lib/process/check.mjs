// Model x enabled rules -> Finding[]. Pure; the only outside reach is ctx.hasCommit, used by evidence rules.
import { ruleOf, withDefaults } from "./rules/index.mjs";
import { refKinds, withId } from "./rules/structure.mjs";

// What an item holds under an `except` key or a `names` entry: its id, its parent, or a field's value.
const holds = (item, key) => {
  if (key === "id") return [item.id];
  if (key === "parent") return [item.parent];
  return [Object.hasOwn(item.fields, key) ? item.fields[key] : undefined].flat();
};

// The process file's field behind `key` in `kind`: its parent field for "parent", none for "id".
function fieldOf(spec, kind, key) {
  const fields = spec.kinds[kind].fields ?? {};
  if (key === "parent") return Object.values(fields).find((f) => f.role === "parent");
  return key !== "id" && Object.hasOwn(fields, key) ? fields[key] : undefined;
}

// A value names something when an item of the kinds holds it, or its field could: an `also` literal,
// or an item of a kind the field refs. Undefined (not judged) when one of those kinds was not read.
function named(model, kinds, key, value) {
  const defs = kinds.map((k) => fieldOf(model.spec, k, key));
  const read = [...kinds, ...defs.flatMap(refKinds)].every((k) => model.kinds[k]?.located);
  if (!read) return undefined;
  const items = kinds.flatMap((k) => model.kinds[k].items);
  if (items.some((item) => holds(item, key).includes(value))) return true;
  return defs.some(
    (def) =>
      def?.also?.includes(value) ||
      withId(model, value).some((item) => refKinds(def).includes(item.kind)),
  );
}

// The `except` and `names` values of entry `i` that name nothing on the board: a typo there would
// only shift what the rule checks, so it is a finding of its own.
function strays(model, rule, entry, i) {
  const kinds = (rule.kinds ? rule.kinds(model.spec.kinds, entry) : [entry.kind]).filter((k) =>
    Object.hasOwn(model.spec.kinds, k),
  );
  const asked = Object.entries(rule.params).flatMap(([p, def]) => {
    if (!Object.hasOwn(entry, p)) return [];
    if (def.type === "except")
      return Object.entries(entry[p]).map(([key, values]) => [`${p}.${key}`, [key], values]);
    return def.names ? [[p, def.names, entry[p]]] : [];
  });
  return asked.flatMap(([at, keys, values]) =>
    values
      .filter((v) => keys.every((key) => named(model, kinds, key, v) === false))
      .map((v) => ({
        rule: entry.rule,
        kind: entry.kind,
        message: `rules[${i}].${at} names no item "${v}"`,
      })),
  );
}

// `entries` are the process file's rules ({ rule, label?, kind?, ...params }); `ctx` is { hasCommit(sha) }.
// A rule that cannot run (unknown id, missing param) becomes a finding, never a throw. The process
// file's own check (`spec.mjs`) has already refused an entry its rule does not declare.
export function check(model, entries, ctx) {
  return entries.flatMap((entry, i) => {
    let found;
    try {
      const rule = ruleOf(entry.rule);
      if (!rule) throw new Error("unknown rule");
      found = [
        ...strays(model, rule, entry, i),
        ...rule.check(model, withDefaults(rule, entry, model.spec.kinds), ctx),
      ];
    } catch (error) {
      found = [
        { rule: entry.rule, kind: entry.kind, message: `rule cannot run: ${error.message}` },
      ];
    }
    return entry.label ? found.map((f) => ({ ...f, label: entry.label })) : found;
  });
}
