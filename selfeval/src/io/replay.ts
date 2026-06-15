// The REPLAY Runner — the zero-API-spend implementation of the Runner port. It reads a recorded `RunResult`
// fixture from disk and returns it, so the routing probe (extract/control/probe) builds and tests entirely
// offline. Same `Runner` interface as `live.ts` → callers swap impls with no change.
//
// PORT of benchmark/src/runner/replay.ts, retyped `RunRecord` → `RunResult` (and `loadRunRecord` →
// `loadRunResult`); otherwise verbatim.

import { readFileSync } from "node:fs";

import type { Invocation, RunResult, Runner, Sandbox } from "./port.ts";

/** Read and parse a recorded `RunResult` fixture (pure; throws on missing file / bad JSON). */
export function loadRunResult(fixturePath: string): RunResult {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as RunResult;
}

/**
 * A Runner that always returns the `RunResult` recorded at `fixturePath`, ignoring the invocation and sandbox
 * (the run already happened — this is a replay). Makes ZERO API calls. Use one per run fixture, or wrap a list
 * for a multi-run probe.
 */
export function replayRunner(fixturePath: string): Runner {
  return {
    run(_invocation: Invocation, _sandbox: Sandbox): Promise<RunResult> {
      return Promise.resolve(loadRunResult(fixturePath));
    },
  };
}

/**
 * A Runner that replays a SEQUENCE of recorded fixtures in order — one per `run()` call — for driving an
 * N-run probe offline. Throws if called more times than fixtures provided (a wrong-N replay is a test bug,
 * not a silent reuse).
 */
export function replaySequenceRunner(fixturePaths: readonly string[]): Runner {
  let i = 0;
  return {
    run(_invocation: Invocation, _sandbox: Sandbox): Promise<RunResult> {
      const path = fixturePaths[i];
      if (path === undefined) {
        return Promise.reject(
          new Error(`replaySequenceRunner exhausted: ${fixturePaths.length} fixture(s), call #${i + 1}`),
        );
      }
      i++;
      return Promise.resolve(loadRunResult(path));
    },
  };
}
