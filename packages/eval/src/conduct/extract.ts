// SHARED CONDUCT INFRA (relocated by T-10 into the NEUTRAL `src/conduct/` home). `extractShape` + `extractKind` +
// `DegenerateRunError` are the canonical extractor T-03 evolved; they are consumed by the live moat probe and
// `store/read.ts` (the offline rescore) as well as the rightsizing probe, so the canonical copy lives here and
// `rightsizing/extract.ts` re-exports it — no probe (or the store) imports another probe's folder.
//
// The shape-extractor (ADR-001, moved from `routing/extract.ts` + `routing/extract-kind.ts`) — infer the routed
// `Shape` from the conductor's SETTLED WORK-FOLDER ARTIFACTS, not the subagent-dispatch pattern. The dispatch
// pattern was a proven-INVALID proxy: the conductor escalates via gates/artifacts (it writes a `spec.md` /
// `plan.md` / `tasks/`), not via which subagent it happens to dispatch. The artifact IS the routing decision made
// concrete.
//
// SETTLE-THEN-EXTRACT (ADR-001 R1): the unified conduct-and-judge probe lets the build SETTLE (it does not kill on
// the routing artifact), then this reads the FINAL settled tree. `extractShape` already reads a settled work folder
// — the call is identical to the routing read, just not preceded by a terminate-on-artifact kill.
//
// The only I/O is reading `<workingDir>/.agentry/work/*/` (the work-folder layout the conductor wrote). The
// one-shot vs degenerate split still needs the run's settle signals (`resultSubtype`, `producedTreeNonEmpty`)
// — a genuine one-shot leaves NO work-folder artifact, so it is told apart from an aborted run only by those.
// `producedTreeNonEmpty` (io/sandbox.ts) already EXCLUDES harness bookkeeping from its walk — the gotcha is
// preserved by tests that drive the REAL fs walk (io-sandbox.test.ts + the settle-then-extract real-walk case in
// outcome-probe.test.ts), never canned booleans (the original bug hid behind a canned-input test).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import type { Kind } from "@agentry/core";

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
 * Infer the routed {@link Shape} from the conductor's settled work-folder artifacts (ADR-001). The only effect is
 * reading `<workingDir>/.agentry/work/*`; the verdict is a function of the artifacts found and the `ctx` settle
 * signals.
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
 * genuine one-shot, and the probe maps that throw to the `indeterminate` terminal category (T-02). A genuine
 * one-shot settles, so its `result` envelope (hence `resultSubtype`) IS present.
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

// ── The KIND extractor (decision B: KEPT, internal-only — its output does not flow to the public report) ─────────
//
// Read the routed `Kind` from the conductor's `spec.md` FRONTMATTER — the SAME faithful mechanism `extractShape`
// uses for the shape, just reading the `kind` field's CONTENT rather than the artifact's presence. Kept callable
// per the contract (decision B); the public rightsizing report does not consume its output.

/**
 * The `---`-delimited YAML frontmatter block at the head of a markdown file, or `null` when the file has none.
 * Mirrors the conductor's `spec.md` shape: a leading `---` line, the YAML body, a closing `---` line, then prose.
 */
function frontmatterBlock(content: string): string | null {
  // Tolerate a leading BOM / blank lines, then require the opening fence on its own line.
  const match = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(content);
  return match === null ? null : match[1]!;
}

/**
 * Read the `kind` field from a `spec.md`'s frontmatter, or `null` when the file has no frontmatter, no `kind`
 * key, or a non-string `kind`. Pure read; a malformed YAML body is tolerated as "no kind" (a degenerate spec is
 * not a crash — one bad artifact must not sink the probe), mirroring how the shape path tolerates a missing tree.
 */
function readKindField(specPath: string): Kind | null {
  let parsed: unknown;
  try {
    const block = frontmatterBlock(readFileSync(specPath, "utf8"));
    if (block === null) return null;
    parsed = parseYaml(block) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const kind = (parsed as Record<string, unknown>).kind;
  // Permissive on the VALUE (mirrors `@agentry/core`'s `Kind = z.string()`): accept any non-empty string kind
  // rather than reject an unknown one, so adding a kind later can't make the extractor silently drop a label.
  return typeof kind === "string" && kind.length > 0 ? kind : null;
}

/**
 * Read the routed {@link Kind} from the conductor's work-folder `spec.md` frontmatter (decision B, internal-only).
 * The only effect is reading every `<workingDir>/.agentry/work/<slug>/spec.md`; the verdict is the first `kind`
 * field found across the work folders, or `null` when none carries one.
 *
 * Returns `null` when there is no `.agentry/work/`, no work folder holds a `spec.md`, or no `spec.md`'s
 * frontmatter carries a (non-empty string) `kind` field. `ctx` is accepted for SIGNATURE PARALLELISM with
 * `extractShape(workingDir, ctx)` but is unused: the kind is a function of the artifact CONTENT alone.
 */
export function extractKind(workingDir: string, _ctx?: ExtractContext): Kind | null {
  const workRoot = join(workingDir, ".agentry", "work");
  if (!existsSync(workRoot) || !statSync(workRoot).isDirectory()) return null;

  for (const slug of readdirSync(workRoot)) {
    const slugDir = join(workRoot, slug);
    if (!statSync(slugDir).isDirectory()) continue;
    const specPath = join(slugDir, "spec.md");
    if (!existsSync(specPath)) continue;
    const kind = readKindField(specPath);
    if (kind !== null) return kind;
  }
  return null;
}
