// The routing shape vocabulary (autopilot-design §2).
//
// SHARED CONDUCT INFRA (relocated by T-10 from `routing/shape.ts`). The `Shape` vocabulary is consumed by the live
// rightsizing + moat probes and `store/read.ts`, so it survived the deletion of `routing/` and now lives in the
// NEUTRAL `src/conduct/` home — no probe imports another probe's old folder.
//
// A `Shape` is the process the conductor chose to route a task through — the thing the self-eval measures
// against the labeled floor. `extract.ts` infers it from the conductor's WORK-FOLDER ARTIFACTS (the faithful
// mechanism: `spec.md` / `plan.md` / `tasks/`); `control.ts`, `artifact.ts`, and `probe.ts` consume the same
// vocabulary. (The former dispatch-pattern → Shape mapping lived here too; it was a proven-INVALID proxy —
// the conductor escalates via artifacts, not via which subagent it dispatches — so the mapping now lives in
// `extract.ts` over the work folder, and this module is left as the pure shape vocabulary.)

/**
 * The three process shapes the conductor can route a task through, in ascending order of process weight:
 *   - `one-shot`   — the conductor did the work itself; no work-folder artifact written (it settled directly).
 *   - `spec-first` — the work was spec'd before building (a `spec.md` exists) but not decomposed into a build.
 *   - `decompose`  — the work was broken into a build (a `plan.md` and/or non-empty `tasks/` exists).
 */
export type Shape = "one-shot" | "spec-first" | "decompose";

/** Shapes ordered by process weight — `under-route` / `over-route` and saturation spread read this order. */
export const SHAPES_BY_WEIGHT: readonly Shape[] = ["one-shot", "spec-first", "decompose"] as const;
