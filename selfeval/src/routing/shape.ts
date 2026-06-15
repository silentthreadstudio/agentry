// The routing shape vocabulary + the single home of the dispatch-pattern → Shape rule (Plan v2 §2).
//
// A `Shape` is the process the conductor chose to route a task through — the thing the self-eval measures
// against the labeled floor. `extract.ts` infers it from a captured event stream; `control.ts` and (later)
// `probe.ts` consume the same vocabulary. The MAPPING lives here so the rule has one owner: the role-family
// of the dispatched subagents (plus, for the no-dispatch case, the settle signals) decides the shape, and
// every consumer reads that decision from this module rather than re-deriving it.

/**
 * The three process shapes the conductor can route a task through, in ascending order of process weight:
 *   - `one-shot`   — the conductor did the work itself; no subagent dispatched (it settled directly).
 *   - `spec-first` — specialists dispatched to define/design (e.g. product-owner, architect), but no build
 *                    decomposition (no implementer) — the "shape it before building" route.
 *   - `decompose`  — the work was broken into a build, i.e. at least one implementer was dispatched.
 */
export type Shape = "one-shot" | "spec-first" | "decompose";

/** Shapes ordered by process weight — `under-route` / `over-route` and saturation spread read this order. */
export const SHAPES_BY_WEIGHT: readonly Shape[] = ["one-shot", "spec-first", "decompose"] as const;

/**
 * The ROLE FAMILIES a dispatched `subagent_type` can name. Discovered from the dispatch by name — NEVER a
 * hard-coded project agent roster (CLAUDE.md generic constraint). A roster of any naming can be mapped by
 * matching the family token its `subagent_type` carries (`...architect`, `...implementer`, etc.).
 *   - `product-owner` / `architect` — the SPEC-FIRST families (define / design before building).
 *   - `implementer`                 — the DECOMPOSE family (a build was dispatched).
 *   - `other`                       — any other specialist (researcher, explorer, verifier, …); not on its
 *                                     own a build, so it does not force `decompose`.
 */
export type RoleFamily = "product-owner" | "architect" | "implementer" | "other";

/**
 * The dispatch-pattern → Shape mapping table (the single home of the rule). It is a TOTAL function of the set
 * of dispatched role families: given which families were dispatched (possibly none), it yields the Shape —
 * with the sole exception that the no-dispatch case needs the run's settle signals to tell a genuine
 * `one-shot` apart from a degenerate/aborted run, so that disambiguation lives in `extract.ts` and this table
 * speaks only to the WITH-dispatch cases.
 *
 * | dispatched role families            | Shape        |
 * | :---------------------------------- | :----------- |
 * | includes `implementer`              | `decompose`  |
 * | non-empty, no `implementer`         | `spec-first` |  (product-owner / architect / other specialists)
 * | empty (no dispatch)                 | → settle-signal disambiguation in extract.ts (one-shot vs degenerate) |
 *
 * Rationale for the "non-empty, no implementer ⇒ spec-first" catch-all: any dispatch at all means the
 * conductor did NOT one-shot it, and without a build (implementer) it did NOT decompose — it routed through
 * specialists to shape the work first. A lone researcher/architect/product-owner all land here.
 */
export function shapeForDispatch(families: ReadonlySet<RoleFamily>): Shape {
  if (families.has("implementer")) return "decompose";
  if (families.size > 0) return "spec-first";
  // Empty set: the no-dispatch case — extract.ts disambiguates one-shot vs degenerate from ctx signals.
  // Callers that hold no families must not reach here for a verdict; see extract.ts.
  throw new Error("shapeForDispatch: no dispatch — disambiguate one-shot vs degenerate in extract.ts");
}

/**
 * Classify a raw `subagent_type` string into its {@link RoleFamily} by the family token it names — roster
 * agnostic. Matches on substring so any project's naming (`product-owner`, `po`, `architect`, `impl`, …) maps
 * without a fixed roster. Unknown specialists fall to `other` (they do not force a build).
 */
export function roleFamilyOf(subagentType: string): RoleFamily {
  const name = subagentType.toLowerCase();
  // Implementer first: a build dispatch dominates the shape (decompose), so it must win the classification.
  if (name.includes("implement") || name.includes("impl") || name.includes("build") || name.includes("coder")) {
    return "implementer";
  }
  if (name.includes("product-owner") || name.includes("product_owner") || name.includes("product owner") ||
      name === "po" || name.includes("owner") || name.includes("spec")) {
    return "product-owner";
  }
  if (name.includes("architect") || name.includes("design") || name.includes("planner") || name.includes("plan")) {
    return "architect";
  }
  return "other";
}
