// The validation helpers both fixture loaders share (`bench/fixture.ts`, `conduct/fixture.ts`). Each loader keeps
// its own error class and field labels; what is common is the checks themselves — including the load-bearing
// safety rule that `seed/` and `oracle/` are disjoint, so a held-out oracle can never be agent-visible.

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Throws the calling loader's own error class with `message` (so each loader's errors stay distinguishable). */
export type Fail = (message: string) => never;

/** The oracle ceiling when `fixture.yaml` omits `oracle.timeoutMs` — conservative; a real suite is sub-minute. */
export const DEFAULT_ORACLE_TIMEOUT_MS = 60_000;

/** A short type name for an error message: `null`, `array`, or the `typeof`. */
export function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** `value` as a non-empty string, or `fail` naming `field`. */
export function requireString(value: unknown, field: string, path: string, fail: Fail): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${path}: ${field} must be a non-empty string, got ${describe(value)}`);
  }
  return value as string;
}

/**
 * Parse the `oracle` mapping: a required non-empty `cmd` and an optional positive-integer `timeoutMs`. `label` is
 * how the loader names the mapping in messages (e.g. `oracle`, or `fixture "x".oracle`).
 */
export function parseOracle(
  value: unknown,
  label: string,
  path: string,
  fail: Fail,
): { oracleCmd: string; oracleTimeoutMs: number } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path}: ${label} must be a mapping, got ${describe(value)}`);
  }
  const obj = value as Record<string, unknown>;
  const oracleCmd = requireString(obj.cmd, `${label}.cmd`, path, fail);

  let oracleTimeoutMs = DEFAULT_ORACLE_TIMEOUT_MS;
  if (obj.timeoutMs !== undefined) {
    if (
      typeof obj.timeoutMs !== "number" ||
      !Number.isInteger(obj.timeoutMs) ||
      obj.timeoutMs <= 0
    ) {
      fail(
        `${path}: ${label}.timeoutMs must be a positive integer when present, got ${describe(obj.timeoutMs)}`,
      );
    }
    oracleTimeoutMs = obj.timeoutMs as number;
  }
  return { oracleCmd, oracleTimeoutMs };
}

/** Recursively list every FILE under `dir`, as paths relative to `dir` (posix-style, dirs not listed). */
export function relativeFiles(dir: string): string[] {
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

/**
 * Assert `seedDir` and `oracleDir` are disjoint subtrees: no relative path present under one is also present under
 * the other. Fails naming the first overlapping path — the oracle-hiding guarantee, enforced at load.
 */
export function assertSeedOracleDisjoint(
  seedDir: string,
  oracleDir: string,
  fixtureDir: string,
  fail: Fail,
): void {
  const seedPaths = new Set(relativeFiles(seedDir));
  for (const oraclePath of relativeFiles(oracleDir)) {
    if (seedPaths.has(oraclePath)) {
      fail(
        `${fixtureDir}: seed/ and oracle/ overlap on "${oraclePath}" — the oracle would be agent-visible`,
      );
    }
  }
}
