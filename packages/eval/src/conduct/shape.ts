// The routing shape vocabulary — one name list, owned by `@agentry/core` (`RoutedShape`).
//
// A `Shape` is the process the conductor chose to route a task through, the thing the self-eval measures against
// the labeled floor. `extract.ts` infers it from the conductor's WORK-FOLDER ARTIFACTS (`spec.md` / `plan.md` /
// `tasks/`), not from which subagent it dispatched (that mapping was a proven-invalid proxy).

import type { RoutedShape } from "@agentry/core";

/**
 * `one-shot` (no work-folder artifact), `spec-first` (a `spec.md` but no build breakdown) or `decompose` (a
 * `plan.md` and/or non-empty `tasks/`) — in ascending order of process weight.
 */
export type Shape = RoutedShape;
