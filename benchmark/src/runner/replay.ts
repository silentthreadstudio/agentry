// The REPLAY Runner — the zero-API-spend implementation of the Runner port. It reads a recorded RunRecord
// fixture from disk and returns it, so T-006 (grader), T-008 (stats), and T-009 (scoreboard) can build and
// test entirely offline, and AC13's FORCED honest-null dataset (equivalent cold/warm arms) can be replayed
// without spending a cent. Same `Runner` interface as `live.ts` → callers swap impls with no change.

import { readFileSync } from "node:fs";

import type { RunRecord } from "../types.ts";
import type { Invocation, Runner, Sandbox } from "./port.ts";

/** Read and parse a recorded RunRecord fixture (pure; throws on missing file / bad JSON). */
export function loadRunRecord(fixturePath: string): RunRecord {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as RunRecord;
}

/**
 * A Runner that always returns the RunRecord recorded at `fixturePath`, ignoring the invocation and sandbox
 * (the run already happened — this is a replay). Makes ZERO API calls. Use one per cell-run fixture, or wrap
 * a list for a multi-run cell.
 */
export function replayRunner(fixturePath: string): Runner {
  return {
    run(_invocation: Invocation, _sandbox: Sandbox): Promise<RunRecord> {
      return Promise.resolve(loadRunRecord(fixturePath));
    },
  };
}

/**
 * A Runner that replays a SEQUENCE of recorded fixtures in order — one per `run()` call — for driving an
 * N-run cell offline. Throws if called more times than fixtures provided (a wrong-N replay is a test bug,
 * not a silent reuse).
 */
export function replaySequenceRunner(fixturePaths: readonly string[]): Runner {
  let i = 0;
  return {
    run(_invocation: Invocation, _sandbox: Sandbox): Promise<RunRecord> {
      const path = fixturePaths[i];
      if (path === undefined) {
        return Promise.reject(
          new Error(`replaySequenceRunner exhausted: ${fixturePaths.length} fixture(s), call #${i + 1}`),
        );
      }
      i++;
      return Promise.resolve(loadRunRecord(path));
    },
  };
}
