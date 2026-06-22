// The hidden-oracle injection seam, a LOOSE FUNCTIONAL FLOOR (ADR-001, moved from `outcome/oracle.ts`). After the
// conduct-and-judge run settles AND the agent-visible tree has been captured (ADR-001: capture-before-inject),
// `injectOracle` copies the held-out `oracle/` subtree into the SAME sandbox working dir, then `runOracle` executes
// the fixture's `oracle.cmd` inside it and parses `{passed, total, pass}` from the test runner's output. One
// concern: copy + spawn + parse. The capture-before-inject ORDER is enforced by the caller (the probe), not here.
//
// MEANING (ADR-001): the result is a LOOSE FUNCTIONAL FLOOR — "did the produced code run / not crash on the obvious
// case" — NOT the score and NOT a byte-exact verdict. The JUDGE (T-01) is the verdict; `pass` is only ever consumed
// as an OPTIONAL, subordinate tie-breaker beside the judged score (read it via {@link functionalFloor}). A
// partial-credit tree can score high on the judge rubric while the floor is false — that is the point.

import { spawnSync } from "node:child_process";
import { cpSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The loose functional-floor reading of the held-out suite — counts plus the raw output for provenance. NOT a
 * verdict: `pass` is the floor signal ("did it run / not crash"), demoted from the old oracle-as-score (ADR-001).
 */
export interface OracleResult {
  /** Number of held-out tests that passed. */
  passed: number;
  /** Total number of held-out tests run. */
  total: number;
  /**
   * The FLOOR signal: true iff every counted test passed and at least one ran (`passed === total && total > 0`).
   * Consume it ONLY as an optional `functionalFloor` ("did the produced code run / not crash") — never as the
   * score or a byte-exact verdict (ADR-001). Use {@link functionalFloor} to read it with the floor meaning explicit.
   */
  pass: boolean;
  /** The captured stdout+stderr of the oracle command (for the floor readout / debugging). */
  output: string;
}

/**
 * Read an {@link OracleResult} as its loose FUNCTIONAL FLOOR (ADR-001): `true` = the produced code ran without
 * crashing on the obvious case. This is the named, floor-meaning accessor for `result.pass` — callers that want a
 * floor signal should go through here so the demotion is explicit at every read; it is NEVER a score or a verdict.
 */
export function functionalFloor(result: OracleResult): boolean {
  return result.pass;
}

/**
 * Inject the held-out `oracleDir` into a finished sandbox working dir (ADR-001). Recursively copies the oracle tree
 * INTO `sandboxDir` so the `oracle.cmd` can reference it (e.g. `node --test oracle/`). MUST be called only AFTER the
 * agent-visible tree has been captured — this module trusts the caller for that order; the oracle-hiding guarantee
 * that the captured tree is oracle-free is proven by the probe/test, not enforced here.
 */
export function injectOracle(sandboxDir: string, oracleDir: string): void {
  // Copy the oracle subtree under `<sandboxDir>/oracle/` (a named subdir, not merged into the root) so the
  // injected tests are addressable by `oracle.cmd` and never collide with the agent's own files.
  cpSync(oracleDir, join(sandboxDir, "oracle"), { recursive: true });
}

/**
 * Run the held-out oracle command inside `sandboxDir` and parse an objective `{passed, total, pass}` from its
 * output. `cmd` is split on whitespace and spawned with `sandboxDir` as cwd (the injected `oracle/` tree is now
 * present); `timeoutMs` caps it so a hanging test cannot wedge the batch. The counts come from the node:test
 * TAP-ish summary lines (`# pass N` / `# tests N` / `# fail N`); a non-zero exit OR any failed test ⇒ `pass`
 * false. Throws nothing for a test failure (a FAIL is a valid floor outcome, not an error) — it only surfaces
 * the counts. The returned `pass` is a LOOSE FLOOR signal ("did it run / not crash"), not a score (ADR-001).
 */
export function runOracle(sandboxDir: string, cmd: string, timeoutMs: number): OracleResult {
  const parts = cmd.trim().split(/\s+/);
  const bin = parts[0]!;
  const args = parts.slice(1);

  const proc = spawnSync(bin, args, {
    cwd: sandboxDir,
    timeout: timeoutMs,
    encoding: "utf8",
    env: oracleEnv(),
  });
  const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;

  const counts = parseTapCounts(output);
  // A timeout / spawn error / non-zero exit with no parseable counts is a floor FAIL, not a throw — the floor's
  // job is to report "did it run / not crash", and "the suite did not cleanly run" is exactly a floor fail.
  if (counts === null) {
    return { passed: 0, total: 0, pass: false, output };
  }
  const { passed, total } = counts;
  const pass = passed === total && total > 0 && proc.status === 0;
  return { passed, total, pass, output };
}

/**
 * The env the oracle subprocess runs under. It inherits the parent env EXCEPT `NODE_TEST_CONTEXT` — when the
 * batch itself runs under `node --test` (the zero-API test suite), a child `node --test` would otherwise detect
 * the inherited context and SKIP (reporting zero tests), making every oracle verdict vacuously empty. Stripping
 * it lets the oracle's held-out suite run as an independent process, exactly as it does in a real (non-test) run.
 */
function oracleEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/**
 * Parse node:test's TAP-ish summary from the runner output: `# tests N`, `# pass N`, `# fail N`. Returns the
 * passed/total counts, or `null` when no summary is present (an output we cannot objectively score). `total`
 * prefers `# tests`; if absent it derives from `# pass + # fail`. Tolerant of surrounding noise — scans for the
 * summary lines anywhere in the output.
 */
function parseTapCounts(output: string): { passed: number; total: number } | null {
  const pass = matchCount(output, /^#\s*pass\s+(\d+)/m);
  const fail = matchCount(output, /^#\s*fail\s+(\d+)/m);
  const tests = matchCount(output, /^#\s*tests\s+(\d+)/m);

  if (pass === null && tests === null) return null;

  const passed = pass ?? 0;
  const total = tests ?? (pass !== null && fail !== null ? pass + fail : null);
  if (total === null) return null;
  return { passed, total };
}

/** Extract the first integer captured by `re` from `output`, or `null` when it does not match. */
function matchCount(output: string, re: RegExp): number | null {
  const m = output.match(re);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

/**
 * List every FILE under `dir` as a path relative to `dir` (posix-style). Used by callers/tests to assert the
 * captured agent-visible tree contains NONE of the oracle's files (the oracle-hiding proof) — exported so the
 * probe and tests share one definition of "what's in this tree."
 */
export function relativeFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const abs = join(current, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
      } else {
        out.push(relative(dir, abs).split(/[\\/]/).join("/"));
      }
    }
  };
  walk(dir);
  return out;
}
