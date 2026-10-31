// The rule catalog: id -> Rule. A Rule is { id, check(model, params, ctx) -> Finding[] }.
import { rules as evidence } from "./evidence.mjs";
import { rules as flow } from "./flow.mjs";
import { rules as structure } from "./structure.mjs";

export const CATALOG = Object.fromEntries(
  [...structure, ...flow, ...evidence].map((r) => [r.id, r]),
);
