// The REPLAY Runner — the zero-API-spend implementation of the Runner port. It reads a recorded `RunResult`
// fixture from disk, MATERIALIZES its recorded work-folder artifacts into the sandbox working dir (so the
// artifact-based extractor — autopilot-design §2 — reads the same `.agentry/work/*` layout a live run would
// have left), and returns the record. Same `Runner` interface as `live.ts` → callers swap impls with no change.
//
// PORT of benchmark/src/runner/replay.ts, retyped `RunRecord` → `RunResult`; extended with the work-folder
// materialization the artifact extractor needs (a live run leaves the artifacts on disk; a replay plants them).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Invocation, RunResult, Runner, Sandbox } from "./port.ts";

/** Read and parse a recorded `RunResult` fixture (pure; throws on missing file / bad JSON). */
export function loadRunResult(fixturePath: string): RunResult {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as RunResult;
}

/**
 * Plant a recorded `RunResult.workFolder` layout under `<sandbox.workingDir>/.agentry/`, so the artifact
 * extractor reads the same `.agentry/work/*` layout a live run would have written. Keys are `.agentry/`-relative
 * (e.g. `work/x/plan.md`); a record with no `workFolder` plants nothing (the one-shot / degenerate path).
 */
function materializeWorkFolder(sandbox: Sandbox, result: RunResult): void {
  if (result.workFolder === undefined) return;
  for (const [relPath, content] of Object.entries(result.workFolder)) {
    const abs = join(sandbox.workingDir, ".agentry", relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

/**
 * A Runner that always returns the `RunResult` recorded at `fixturePath` (the run already happened — this is a
 * replay), planting its recorded work-folder artifacts into the sandbox first. Makes ZERO API calls. Use one
 * per run fixture, or wrap a list for a multi-run probe.
 */
export function replayRunner(fixturePath: string): Runner {
  return {
    run(_invocation: Invocation, sandbox: Sandbox): Promise<RunResult> {
      const result = loadRunResult(fixturePath);
      materializeWorkFolder(sandbox, result);
      return Promise.resolve(result);
    },
  };
}

/**
 * A Runner that replays a SEQUENCE of recorded fixtures in order — one per `run()` call — for driving an
 * N-run probe offline, planting each record's work-folder artifacts into the sandbox of that call. Throws if
 * called more times than fixtures provided (a wrong-N replay is a test bug, not a silent reuse).
 */
export function replaySequenceRunner(fixturePaths: readonly string[]): Runner {
  let i = 0;
  return {
    run(_invocation: Invocation, sandbox: Sandbox): Promise<RunResult> {
      const path = fixturePaths[i];
      if (path === undefined) {
        return Promise.reject(
          new Error(`replaySequenceRunner exhausted: ${fixturePaths.length} fixture(s), call #${i + 1}`),
        );
      }
      i++;
      const result = loadRunResult(path);
      materializeWorkFolder(sandbox, result);
      return Promise.resolve(result);
    },
  };
}
