// The WRITE side of the artifact store (ADR-001 / T-B). It materializes one self-eval run as the on-disk tree
// `runs/<runId>/{config.json, summary.json, tasks/<taskId>[.r<i>]/{stream.jsonl, shape.json, timing.json, work/…}}`
// — capturing each task's `stream.jsonl` + `.agentry/work/` tree out of its sandbox BEFORE the sandbox is
// discarded (the keystone ordering; AC3 later reads the copied `work/`).
//
// SRP: write-only. Reading a stored run is T-E's `store/read.ts`; this module never reads back what it wrote.
// Pure `node:fs` writes against the schema — no `@agentry/core`, no probe imports.

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunConfig, RunSummary, TaskCaptureSrc } from "./schema.ts";

/**
 * The write-side port for one run, bound to a fixed `runs/<runId>/` directory. The three methods follow a run's
 * lifecycle: `beginRun` once at the start, `captureTask` per completed task (before its sandbox is gone), and
 * `finishRun` once at the end. T-D's probe seam drives `captureTask` through `EvalObserver.onTaskComplete`.
 */
export interface RunStore {
  /** Create `runs/<runId>/` and write the reproducibility header `config.json`. */
  beginRun(config: RunConfig): void;
  /** Capture one task out of its sandbox: `stream.jsonl`, the `.agentry/work/` tree, `shape.json`, `timing.json`. */
  captureTask(src: TaskCaptureSrc): void;
  /** Write the run-level `summary.json` (the probe's returned artifact stored verbatim inside it). */
  finishRun(summary: RunSummary): void;
}

/** Serialize a value as pretty JSON with a trailing newline (the repo's on-disk JSON convention). */
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Build the write-side store rooted at `runsRoot/runId/`.
 *
 * @param runsRoot The `runs/` parent directory (e.g. `selfeval/runs`); the run lives at `runsRoot/runId/`.
 * @param runId    The run id (also the run-directory name) — from `newRunId()` or a `--run-id` override.
 */
export function createRunStore(runsRoot: string, runId: string): RunStore {
  const runDir = join(runsRoot, runId);
  const tasksDir = join(runDir, "tasks");

  return {
    beginRun(config: RunConfig): void {
      mkdirSync(runDir, { recursive: true });
      writeJson(join(runDir, "config.json"), config);
    },

    captureTask(src: TaskCaptureSrc): void {
      // `.r<i>` suffix ONLY when runIndex is defined — single-run tasks keep a bare `<taskId>/` dir, multi-run
      // (`--runs k`) tasks get distinct `<taskId>.r0/`, `<taskId>.r1/`… so the repeats don't collide.
      const dirName = src.runIndex === undefined ? src.taskId : `${src.taskId}.r${src.runIndex}`;
      const taskDir = join(tasksDir, dirName);
      mkdirSync(taskDir, { recursive: true });

      // Copy the per-task event stream out of the sandbox. Tolerate its absence the same way the `work/` copy
      // below does: a replay-driven capture (or any runner that doesn't tee a stream) has no `stream.jsonl` —
      // skip the copy, no error.
      if (existsSync(src.streamPath)) {
        cpSync(src.streamPath, join(taskDir, "stream.jsonl"));
      }

      // Copy the `.agentry/work/` artifact tree (the keystone AC3 reads). Tolerate its absence: a one-shot task
      // produces no work folder — copy nothing, no error.
      const workSrc = join(src.sandboxDir, ".agentry", "work");
      if (existsSync(workSrc)) {
        cpSync(workSrc, join(taskDir, "work"), { recursive: true });
      }

      writeJson(join(taskDir, "shape.json"), { shape: src.shape });
      writeJson(join(taskDir, "timing.json"), { timingMs: src.timingMs });
    },

    finishRun(summary: RunSummary): void {
      writeJson(join(runDir, "summary.json"), summary);
    },
  };
}
