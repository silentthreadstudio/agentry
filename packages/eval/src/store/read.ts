// The READ side of the artifact store (ADR-003 / T-E). It reconstructs analysis inputs from a STORED run with ZERO
// live API: instead of re-running the conductor, it reads the artifacts the write side (`store/write.ts`) already
// copied out of each task's sandbox under `runs/<id>/tasks/<taskId>[.r<i>]/work/<slug>/` — `rescoreRun` re-derives
// each stored task's routing shape offline, proof a persisted run is re-analyzable after the fact.
//
// SRP: read-only. It never writes a run (that is `store/write.ts`). Pure `node:fs` reads against the on-disk layout,
// plus one value import it is explicitly allowed: `extractShape` (to re-derive a stored task's routing shape
// offline). It owns no schema — it imports the store's types from `schema.ts`.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

import type { RunConfig } from "./schema.ts";
import { extractShape } from "../conduct/extract.ts";
import type { Shape } from "../conduct/shape.ts";

/**
 * Confine a USER-SUPPLIED run-id to a single child of `runsRoot` before it is joined into a path. The id reaches
 * here straight off the CLI (`replay <id>`, `report <id>`); a crafted value like `../../etc` would
 * otherwise `join` OUTSIDE `runs/` and let a reader open an arbitrary `config.json`/`spec.md`/`plan.md` off disk.
 * The guard MUST run before the `join` — once `join(runsRoot, "../../etc")` has collapsed the `..`, the traversal
 * is baked into the path and is no longer detectable. Legitimate ids are the `YYYYMMDD-HHMMSS-<rand4>` form (and
 * the `--run-id` test override); none contain a path separator, so rejecting separators / `..` / absolute paths
 * costs nothing legitimate.
 */
export function safeRunDir(runsRoot: string, runId: string): string {
  if (
    runId === "" ||
    runId === "." ||
    runId === ".." ||
    runId.includes("..") ||
    runId.includes("/") ||
    runId.includes("\\") ||
    runId.includes(sep) ||
    isAbsolute(runId)
  ) {
    throw new Error(`invalid run-id: ${JSON.stringify(runId)}`);
  }
  return join(runsRoot, runId);
}

/**
 * One stored task re-derived offline (the `rescoreRun` row): the task id (with any `.r<i>` suffix preserved so
 * multi-run repeats stay distinct) and the {@link Shape} re-extracted from its stored `work/` tree.
 */
export interface RescoredTask {
  /** The stored task-dir name — the labeled task id, plus the `.r<i>` suffix when it was a multi-run repeat. */
  taskId: string;
  /** The routing shape re-derived from the stored `work/` artifacts, with no live run. */
  shape: Shape;
}

/**
 * Read a stored run's reproducibility header back from `<runDir>/config.json` (ADR-001). The inverse of the write
 * side's `beginRun`; a pure parse, no validation beyond JSON shape (the write side is the single source of truth
 * for what a valid config is).
 */
export function readRunConfig(runsRoot: string, runId: string): RunConfig {
  const runDir = safeRunDir(runsRoot, runId);
  return JSON.parse(readFileSync(join(runDir, "config.json"), "utf8")) as RunConfig;
}

/**
 * Re-derive each stored task's routing {@link Shape} OFFLINE — proof that a persisted run can be re-analyzed with
 * no live run. For every task dir that captured a `work/` tree, it reuses the canonical {@link extractShape} over
 * the stored artifacts (the same extractor the live probe ran), so the offline re-derivation matches the original.
 *
 * Tasks with no stored `work/` are skipped: a genuine one-shot leaves no artifact, and `extractShape`'s
 * one-shot-vs-degenerate split needs the run's settle signals (which a stored run does not persist) — so the
 * offline rescore is scoped to the artifact-bearing tasks, which `extractShape` decides from the work folder alone.
 */
export function rescoreRun(runsRoot: string, runId: string): RescoredTask[] {
  const runDir = safeRunDir(runsRoot, runId);
  const rescored: RescoredTask[] = [];
  for (const taskDir of taskDirs(runDir)) {
    const workDir = join(runDir, "tasks", taskDir, "work");
    if (!dirExists(workDir)) continue; // no captured artifacts — nothing to re-extract offline.
    rescored.push({ taskId: taskDir, shape: extractShapeFromStoredWork(workDir) });
  }
  return rescored;
}

/**
 * Re-derive a shape from a stored `work/` tree by reusing {@link extractShape} verbatim. The write side flattened
 * the sandbox's `.agentry/work/` to a bare `work/` under the task dir, but `extractShape` keys off
 * `<workingDir>/.agentry/work` — so we present the stored `work/` back under that expected path via a short-lived
 * symlink in a temp dir, run the canonical extractor, and clean the view up. `producedTreeNonEmpty: true` because a
 * stored `work/` exists by construction here (the no-artifact one-shot case is filtered out before we get here).
 */
function extractShapeFromStoredWork(storedWorkDir: string): Shape {
  const viewDir = mkdtempSync(join(tmpdir(), "selfeval-rescore-"));
  try {
    mkdirSync(join(viewDir, ".agentry"), { recursive: true });
    symlinkSync(storedWorkDir, join(viewDir, ".agentry", "work"), "dir");
    return extractShape(viewDir, { resultSubtype: "success", producedTreeNonEmpty: true });
  } finally {
    rmSync(viewDir, { recursive: true, force: true });
  }
}

/** List the captured task-dir names under `<runDir>/tasks/`, sorted for a stable order; empty when absent. */
function taskDirs(runDir: string): string[] {
  const dir = join(runDir, "tasks");
  if (!dirExists(dir)) return [];
  return readdirSync(dir)
    .filter((name) => dirExists(join(dir, name)))
    .sort();
}

/** True iff `path` exists and is a directory. */
function dirExists(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}
