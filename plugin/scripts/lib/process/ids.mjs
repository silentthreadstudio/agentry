// Ids. The next free id of a kind, from its `create.id` pattern (plan F13 §2.4): `{n}` is one above the
// highest number in use, `{n:02}` the same, zero-padded. Shared by `next-id` and `add`. And an id as a
// person types it, read the board's way (A39): case-insensitive, and a kind's cited form (`D281` for a
// decision the board numbers `281`, where the kind's `id.prefix` is `D`) as its id.
//
// nextId(name, kind, model) -> { id } | { error }   error = the kind asks for its ids ("ask"), or the
// pattern needs more than a number.
// boardId(spec, model, typed, kind?) -> string      the board's spelling of `typed` (of `kind` when
// given); `typed` itself when the board has no item it names, or more than one.
// runId(spec, model, typed) -> { id, kind } | { error }   the item exec and merge run: `boardId` over
// each kind they run (`runKinds`); the kind that holds it, else the lifecycle's (`task` with none). Two
// kinds holding it is the error.
// kindOf(ledger, spec) -> string     a lane's kind: its ledger's `kind`, the lifecycle's for a ledger with
// none (`task` with no lifecycle).
import { runKinds } from "./spec/workflow.mjs";

const NUMBER = /\{n(?::0(\d+))?\}/;
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function boardId(spec, model, typed, kind) {
  if (typeof typed !== "string") return typed;
  const kinds = kind ? [kind] : Object.keys(spec.kinds);
  const ids = kinds.flatMap((k) => (Object.hasOwn(model.kinds, k) ? model.kinds[k].items : []));
  const all = new Set(ids.map((i) => i.id));
  if (all.has(typed)) return typed;
  const only = (found) => (found.size === 1 ? [...found][0] : null);
  const fold = typed.toLowerCase();
  const same = only(new Set([...all].filter((id) => id.toLowerCase() === fold)));
  if (same) return same;
  // The cited form: the kind's display prefix before a plain number the board writes bare.
  const cited = new Set();
  for (const k of kinds) {
    const prefix = spec.kinds[k]?.id?.prefix;
    const n = prefix && new RegExp(`^${literal(prefix)}(\\d+)$`, "i").exec(typed)?.[1];
    if (!n) continue;
    for (const i of model.kinds[k]?.items ?? []) if (i.id === n) cited.add(i.id);
  }
  return only(cited) ?? typed;
}

export function runId(spec, model, typed) {
  const held = runKinds(spec).flatMap((kind) => {
    const id = boardId(spec, model, typed, kind);
    return model.kinds[kind]?.items.some((i) => i.id === id) ? [{ id, kind }] : [];
  });
  if (held.length === 1) return held[0];
  if (held.length > 1)
    return { error: `"${typed}" names ${held.map((h) => `a ${h.kind}`).join(" and ")}` };
  const kind = spec.lifecycle?.kind ?? "task";
  return { id: boardId(spec, model, typed, kind), kind };
}

export const kindOf = (ledger, spec) => ledger.kind ?? spec.lifecycle?.kind ?? "task";

export function nextId(name, kind, model) {
  const pattern = kind.create?.id;
  if (!pattern || pattern === "ask")
    return { error: `${name} ids are chosen by hand (create.id is "${pattern ?? "unset"}")` };
  const [token, width] = NUMBER.exec(pattern) ?? [];
  const [before, after] = token ? pattern.split(token) : [];
  if (!token || /[{}]/.test(before + after))
    return { error: `${name}: create.id "${pattern}" needs more than a number` };
  const ours = new RegExp(`^${literal(before)}(\\d+)${literal(after)}$`);
  const used = model.kinds[name].items
    .map((i) => ours.exec(i.id)?.[1])
    .filter(Boolean)
    .map(Number);
  const next = String(Math.max(0, ...used) + 1).padStart(Number(width ?? 0), "0");
  return { id: `${before}${next}${after}` };
}
