// The pure-ish shape-extractor (autopilot-design §2) — infer the routed `Shape` from the conductor's WORK-FOLDER
// ARTIFACTS, not the subagent-dispatch pattern. The dispatch pattern was a proven-INVALID proxy: the conductor
// escalates via gates/artifacts (it writes a `spec.md` / `plan.md` / `tasks/`), not via which subagent it
// happens to dispatch. The artifact IS the routing decision made concrete (the OQ1 resolution, corrected).
//
// The only I/O is reading `<workingDir>/.agentry/work/*/` (the work-folder layout the conductor wrote). The
// one-shot vs degenerate split still needs the run's settle signals (`resultSubtype`, `producedTreeNonEmpty`)
// — a genuine one-shot leaves NO work-folder artifact, so it is told apart from an aborted run only by those.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Shape } from "./shape.ts";

/**
 * The settle signals the no-artifact case needs to tell a genuine `one-shot` from a degenerate/aborted run.
 * Supplied by the driver from `RunResult` (the runner already observed them):
 *   - `resultSubtype`        — `result.subtype` of the settled run; `'success'` marks a clean settle. Absent
 *                              on a killed/aborted run (no trailing `result` envelope).
 *   - `producedTreeNonEmpty` — did the run leave a non-empty produced tree (the OQ1 one-shot tree signal)?
 */
export interface ExtractContext {
  resultSubtype?: string;
  producedTreeNonEmpty: boolean;
}

/** Thrown when a no-artifact run is NOT a clean settle — an indeterminate/degenerate run, never `one-shot`. */
export class DegenerateRunError extends Error {
  constructor(workingDir: string, reason: string) {
    super(`indeterminate/degenerate run (not one-shot): ${reason} [workingDir: ${workingDir}]`);
    this.name = "DegenerateRunError";
  }
}

/** True iff `dir` exists, is a directory, and contains at least one entry. */
function dirNonEmpty(dir: string): boolean {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  return readdirSync(dir).length > 0;
}

/** The artifact evidence found across every `<workingDir>/.agentry/work/<slug>/` folder. */
interface WorkArtifacts {
  /** Any `plan.md` exists in a work folder, OR any `tasks/` dir is non-empty (⇒ a build was decomposed). */
  hasDecompose: boolean;
  /** Any `spec.md` exists in a work folder (⇒ the work was spec'd before building). */
  hasSpec: boolean;
}

/**
 * Scan `<workingDir>/.agentry/work/*` for the routing artifacts the conductor writes. Tolerates a MISSING
 * `.agentry/` (or `.agentry/work/`) — a genuine one-shot writes nothing there, so absence ⇒ no artifacts (the
 * one-shot / degenerate path). Pure fs reads; no mutation.
 */
function scanWorkArtifacts(workingDir: string): WorkArtifacts {
  const workRoot = join(workingDir, ".agentry", "work");
  if (!existsSync(workRoot) || !statSync(workRoot).isDirectory()) {
    return { hasDecompose: false, hasSpec: false };
  }
  let hasDecompose = false;
  let hasSpec = false;
  for (const slug of readdirSync(workRoot)) {
    const slugDir = join(workRoot, slug);
    if (!statSync(slugDir).isDirectory()) continue;
    if (existsSync(join(slugDir, "plan.md")) || dirNonEmpty(join(slugDir, "tasks"))) {
      hasDecompose = true;
    }
    if (existsSync(join(slugDir, "spec.md"))) {
      hasSpec = true;
    }
  }
  return { hasDecompose, hasSpec };
}

/**
 * Infer the routed {@link Shape} from the conductor's work-folder artifacts (autopilot-design §2). The only
 * effect is reading `<workingDir>/.agentry/work/*`; the verdict is a function of the artifacts found and the
 * `ctx` settle signals.
 *
 * Mapping:
 *   - any `plan.md` OR any non-empty `tasks/`                ⇒ `decompose`
 *   - else any `spec.md`                                     ⇒ `spec-first`
 *   - else (no work-folder artifacts):
 *       - `resultSubtype === 'success'` AND `producedTreeNonEmpty` ⇒ `one-shot`
 *       - otherwise                                          ⇒ throws {@link DegenerateRunError}
 *
 * The degenerate fallback is an explicit THROW, not a silent label: a no-artifact run that did not settle
 * cleanly (no `success`, or an empty produced tree — e.g. an aborted/errored run) can never be mistaken for a
 * genuine one-shot. A genuine one-shot settles, so its `result` envelope (hence `resultSubtype`) IS present.
 */
export function extractShape(workingDir: string, ctx: ExtractContext): Shape {
  const { hasDecompose, hasSpec } = scanWorkArtifacts(workingDir);

  if (hasDecompose) return "decompose";
  if (hasSpec) return "spec-first";

  // No work-folder artifacts: a genuine one-shot (clean settle + produced output) vs a degenerate run.
  if (ctx.resultSubtype === "success" && ctx.producedTreeNonEmpty) return "one-shot";
  const reason =
    ctx.resultSubtype === undefined
      ? "no work-folder artifacts and no settled result (run aborted/killed before settling)"
      : `no work-folder artifacts but resultSubtype=${JSON.stringify(ctx.resultSubtype)}, producedTreeNonEmpty=${ctx.producedTreeNonEmpty}`;
  throw new DegenerateRunError(workingDir, reason);
}
