// The READ side of the artifact store (ADR-003 / T-E) — and the AC3 token-bleed fix. It reconstructs a quality
// gate's input from a STORED routing run with ZERO live API: instead of re-running the conductor to regenerate
// `spec.md`/`plan.md`, it reads the artifacts the write side (`store/write.ts`) already copied out of each task's
// sandbox under `runs/<id>/tasks/<taskId>[.r<i>]/work/<slug>/`. The reconstructed `QualityInput[]` is handed
// straight to `runQualityProbe` — no conductor re-run, no spend.
//
// SRP: read-only. It never writes a run (that is `store/write.ts`) and never judges (that is `quality/probe.ts`);
// it only reads back what was persisted. Pure `node:fs` reads against the on-disk layout, plus two value imports
// it is explicitly allowed: the fixture loader (to recover each task's prompt) and `extractShape` (to re-derive a
// stored task's routing shape offline). It owns no schema — it imports the store's types from `schema.ts`.

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
import type { QualityInput } from "../quality/probe.ts";
import { loadRoutingFixture } from "../routing/fixture.ts";
import { extractShape } from "../routing/extract.ts";
import type { Shape } from "../routing/shape.ts";

/** The separator the quality gate used to splice a task's `spec.md` and `plan.md` into one artifact text. */
const SPEC_PLAN_SEPARATOR = "\n\n--- PLAN ---\n\n";

/**
 * Confine a USER-SUPPLIED run-id to a single child of `runsRoot` before it is joined into a path. The id reaches
 * here straight off the CLI (`replay <id>`, `run quality --from-run <id>`); a crafted value like `../../etc` would
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
 * Reconstruct a quality-gate input set from a STORED routing run with ZERO live API (ADR-003 — THE AC3 FIX).
 *
 * For each captured task dir under `<runDir>/tasks/<taskId>[.r<i>]/`:
 *   - read its stored `work/<slug>/spec.md` (and `plan.md` if present), concatenated exactly as the quality gate
 *     fed them — `spec` alone, or `spec` + {@link SPEC_PLAN_SEPARATOR} + `plan` when both exist — into `artifactText`;
 *   - recover the task's `taskPrompt` from the labeled fixture named in the run's config (the `.r<i>` suffix is
 *     stripped to resolve the underlying labeled task id);
 *   - emit the EXISTING `{taskId, taskPrompt, artifactText}` `QualityInput` shape, ready to hand straight to
 *     `runQualityProbe`.
 *
 * A task that captured NO `work/` artifact (a genuine one-shot produced nothing to judge) is SKIPPED — there is no
 * artifact text to score. The returned list is therefore exactly the stored, judgeable artifacts; building it
 * touches only the filesystem (no conductor re-run, no spend).
 */
export function readRunInputs(runsRoot: string, runId: string): QualityInput[] {
  const runDir = safeRunDir(runsRoot, runId);
  const config = readRunConfig(runsRoot, runId);
  // Recover each labeled task's prompt from the SAME fixture the run was parameterized with (config.fixtureDir is
  // routing-only; ADR-003 reconstructs a routing run's artifacts into quality inputs).
  const fixtureDir = config.fixtureDir;
  if (fixtureDir === undefined) {
    throw new Error(
      `readRunInputs: run ${config.runId} has no fixtureDir in config.json (not a routing run); cannot recover task prompts`,
    );
  }
  const promptById = loadPrompts(join(fixtureDir, "tasks.yaml"));

  const inputs: QualityInput[] = [];
  for (const taskDir of taskDirs(runDir)) {
    const artifactText = readArtifactText(join(runDir, "tasks", taskDir));
    if (artifactText === null) continue; // one-shot / no captured work — nothing to judge.

    // Strip the `.r<i>` multi-run suffix to resolve the labeled task id → its fixture prompt.
    const taskId = baseTaskId(taskDir);
    const taskPrompt = promptById.get(taskId);
    if (taskPrompt === undefined) {
      throw new Error(
        `readRunInputs: stored task "${taskDir}" has no matching task "${taskId}" in ${join(fixtureDir, "tasks.yaml")}`,
      );
    }
    inputs.push({ taskId, taskPrompt, artifactText });
  }
  return inputs;
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

/** Read a stored task dir's `work/<slug>/spec.md` (+ `plan.md`) into the quality gate's `artifactText`, or `null`
 *  when the task captured no judgeable artifact (no `work/`, or a `work/` with no `spec.md`). */
function readArtifactText(taskDir: string): string | null {
  const workDir = join(taskDir, "work");
  if (!dirExists(workDir)) return null;

  // The work tree nests one level deep: `work/<slug>/{spec.md, plan.md}`. Read the first slug carrying a spec.md —
  // a routing task's captured artifact is a single conductor work folder (one slug).
  for (const slug of readdirSync(workDir)) {
    const slugDir = join(workDir, slug);
    if (!dirExists(slugDir)) continue;
    const specPath = join(slugDir, "spec.md");
    if (!existsSync(specPath)) continue;

    const spec = readFileSync(specPath, "utf8");
    const planPath = join(slugDir, "plan.md");
    if (existsSync(planPath)) {
      return spec + SPEC_PLAN_SEPARATOR + readFileSync(planPath, "utf8");
    }
    return spec;
  }
  return null;
}

/** Load the fixture's `id → prompt` map (the only thing `readRunInputs` needs back from the labeled set). */
function loadPrompts(tasksYamlPath: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const task of loadRoutingFixture(tasksYamlPath)) {
    map.set(task.id, task.prompt);
  }
  return map;
}

/** List the captured task-dir names under `<runDir>/tasks/`, sorted for a stable order; empty when absent. */
function taskDirs(runDir: string): string[] {
  const dir = join(runDir, "tasks");
  if (!dirExists(dir)) return [];
  return readdirSync(dir)
    .filter((name) => dirExists(join(dir, name)))
    .sort();
}

/** Strip a `.r<i>` multi-run suffix to recover the underlying labeled task id (`t1.r2` → `t1`, `t1` → `t1`). */
function baseTaskId(taskDir: string): string {
  return taskDir.replace(/\.r\d+$/, "");
}

/** True iff `path` exists and is a directory. */
function dirExists(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}
