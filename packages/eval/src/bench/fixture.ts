// The BENCH-fixture schema + strict loader/validator (the reshape plan §Phase 2). A bench fixture is the realistic
// task the value bench conducts ONCE and then derives all four axis signals from. On disk it carries the SAME four
// subtrees the conduct instrument needs — the agent-visible `seed/`, the held-out `oracle/`, and the `golden/`
// (known-correct) / `broken/` (planted-wrong) control overlays — plus a small `fixture.yaml`.
//
// This is a DELIBERATE SIMPLIFICATION of `rightsizing/fixture.ts`: the value bench drops the routing label axis
// entirely (no `correct_floor`, no structured `rationale`, no second-labeler `labels`, no trap). What it keeps is
// the result-judging contract: the prompt, the four subtrees, the oracle command, and two new fields the four axes
// need — `fork` (a short description of the hidden decision the task carries, evidence for the Axis-A showcase) and
// `bugProne` (whether the obvious solution has a subtle bug the oracle catches — the Axis-D escaped-defect set).
//
// THE LOAD-BEARING SAFETY RULE is reused verbatim from `conduct/fixture.ts`: `seed/` and `oracle/` must be DISJOINT
// subtrees, so the held-out oracle can never leak into the agent-visible tree. The validator THROWS a specific
// `BenchFixtureError` per violation — a malformed fixture is a deliverable bug surfaced loudly, never defaulted away.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { parse as parseYaml } from "yaml";

/**
 * One loaded bench fixture — the parsed `fixture.yaml` PLUS the resolved absolute paths to its four subtrees. The
 * probe conducts `prompt` over a sandbox seeded from `seedDir`, judges the produced tree (Axis B) + decision trail
 * (Axis A), and runs the held-out `oracleDir` for correctness. The controls overlay `goldenDir` (must score HIGH)
 * / `brokenDir` (must score LOW) onto a fresh seed to gate the code judge.
 */
export interface BenchFixture {
  /** The fixture id (also the `<dir>/<id>/` directory name). */
  id: string;
  /** The task prompt handed to the conductor (non-empty). */
  prompt: string;
  /** A short description of the hidden DECISION/fork this task carries (evidence for the Axis-A showcase); optional. */
  fork?: string;
  /** Whether the obvious solution has a subtle bug the oracle catches — the Axis-D escaped-defect set (default false). */
  bugProne: boolean;
  /** The command run INSIDE the injected sandbox to execute the held-out oracle (e.g. `node --test oracle/`). */
  oracleCmd: string;
  /** Hard ceiling (ms) for the oracle command so a hanging test cannot wedge the batch. */
  oracleTimeoutMs: number;
  /** Absolute path to `seed/` — the ONLY tree copied into the sandbox (agent-visible). */
  seedDir: string;
  /** Absolute path to `oracle/` — the held-out tests, injected POST-RUN (never agent-visible). */
  oracleDir: string;
  /** Absolute path to `golden/` — a known-correct overlay; seed+golden scores HIGH (Axis-B control). */
  goldenDir: string;
  /** Absolute path to `broken/` — a planted-wrong overlay; seed+broken scores LOW (Axis-B control). */
  brokenDir: string;
}

/** Thrown on any structural violation of a bench fixture — points at the offending file/dir + the specific rule. */
export class BenchFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchFixtureError";
  }
}

/** The four subtrees every fixture must ship — each a required directory under the fixture root. */
const REQUIRED_SUBTREES = ["seed", "oracle", "golden", "broken"] as const;

/** Default oracle ceiling when `fixture.yaml` omits `oracle.timeoutMs` — conservative; a real suite is sub-minute. */
const DEFAULT_ORACLE_TIMEOUT_MS = 60_000;

/**
 * The reserved child directory under a bench corpus that holds the SHARED Axis-A decision controls
 * (`decision-gold.md` / `decision-poor.md`), NOT a fixture. `loadBenchFixtures` skips it so the planted controls
 * never load as a (malformed) fixture.
 */
export const CONTROLS_DIR = "_controls";

/**
 * Load + validate EVERY bench fixture under `dir` (each a `<id>/` subdirectory), skipping the reserved
 * {@link CONTROLS_DIR}. THROWS a {@link BenchFixtureError} on the first violation. Loads at least one fixture (an
 * empty corpus is a typo, not a silently-empty $0 run); ids are unique by directory name.
 */
export function loadBenchFixtures(dir: string): BenchFixture[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new BenchFixtureError(`${dir}: not a fixture directory`);
  }

  const ids = readdirSync(dir)
    .filter((name) => name !== CONTROLS_DIR && statSync(join(dir, name)).isDirectory())
    .sort();

  if (ids.length === 0) {
    throw new BenchFixtureError(`${dir}: no bench fixtures found (expected ≥1 \`<id>/\` subdirectory)`);
  }

  const fixtures = ids.map((id) => loadBenchFixture(join(dir, id)));

  const seen = new Set<string>();
  for (const fx of fixtures) {
    if (seen.has(fx.id)) throw new BenchFixtureError(`${dir}: duplicate fixture id "${fx.id}"`);
    seen.add(fx.id);
  }

  return fixtures;
}

/**
 * Parse + validate the SINGLE bench fixture rooted at `fixtureDir` into a {@link BenchFixture}. THROWS a
 * {@link BenchFixtureError} on the first violation. The rules:
 *   1. the dir holds `fixture.yaml` + all four subtrees (`seed/ oracle/ golden/ broken/`);
 *   2. `fixture.yaml` parses to a mapping with a non-empty `prompt`, an optional `fork` string, an optional boolean
 *      `bugProne` (default false), and a non-empty `oracle.cmd` (with an optional positive-integer `oracle.timeoutMs`);
 *   3. THE SAFETY RULE — `seed/` and `oracle/` are DISJOINT subtrees, so the held-out oracle is never agent-visible.
 * `id` defaults to the directory name; if `fixture.yaml` carries an `id`, it MUST match the directory name.
 */
export function loadBenchFixture(fixtureDir: string): BenchFixture {
  const dirId = relative(join(fixtureDir, ".."), fixtureDir);
  const yamlPath = join(fixtureDir, "fixture.yaml");
  if (!existsSync(yamlPath)) {
    throw new BenchFixtureError(`${fixtureDir}: missing fixture.yaml`);
  }

  const subtrees: Record<string, string> = {};
  for (const name of REQUIRED_SUBTREES) {
    const sub = join(fixtureDir, name);
    if (!existsSync(sub) || !statSync(sub).isDirectory()) {
      throw new BenchFixtureError(`${fixtureDir}: missing required \`${name}/\` subtree`);
    }
    subtrees[name] = sub;
  }

  const raw = parseYaml(readFileSync(yamlPath, "utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BenchFixtureError(`${yamlPath}: fixture.yaml must be a YAML mapping, got ${describe(raw)}`);
  }
  const root = raw as Record<string, unknown>;
  const where = `fixture "${dirId}"`;

  if (root.id !== undefined) {
    const declaredId = requireString(root.id, `${where}.id`, yamlPath);
    if (declaredId !== dirId) {
      throw new BenchFixtureError(`${yamlPath}: \`id\` "${declaredId}" must match the directory name "${dirId}"`);
    }
  }

  const prompt = requireString(root.prompt, `${where}.prompt`, yamlPath);
  const fork = parseFork(root.fork, where, yamlPath);
  const bugProne = parseBugProne(root.bugProne, where, yamlPath);
  const { oracleCmd, oracleTimeoutMs } = parseOracle(root.oracle, where, yamlPath);

  // THE SAFETY RULE: the agent-visible seed must not contain ANY oracle file (reused from conduct/fixture.ts).
  assertSeedOracleDisjoint(subtrees.seed!, subtrees.oracle!, fixtureDir);

  const fixture: BenchFixture = {
    id: dirId,
    prompt,
    bugProne,
    oracleCmd,
    oracleTimeoutMs,
    seedDir: subtrees.seed!,
    oracleDir: subtrees.oracle!,
    goldenDir: subtrees.golden!,
    brokenDir: subtrees.broken!,
  };
  if (fork !== undefined) fixture.fork = fork;
  return fixture;
}

/** Parse the optional `fork` — a non-empty string when present (a short description of the hidden decision). */
function parseFork(value: unknown, where: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, `${where}.fork`, path);
}

/** Parse the optional `bugProne` flag — strict on type, defaulting to `false` when absent. */
function parseBugProne(value: unknown, where: string, path: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new BenchFixtureError(`${path}: ${where}.bugProne must be a boolean when present, got ${describe(value)}`);
  }
  return value;
}

/** Parse the `oracle` mapping: a required non-empty `cmd` and an optional positive-integer `timeoutMs`. */
function parseOracle(value: unknown, where: string, path: string): { oracleCmd: string; oracleTimeoutMs: number } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BenchFixtureError(`${path}: ${where}.oracle must be a mapping, got ${describe(value)}`);
  }
  const obj = value as Record<string, unknown>;
  const oracleCmd = requireString(obj.cmd, `${where}.oracle.cmd`, path);

  let oracleTimeoutMs = DEFAULT_ORACLE_TIMEOUT_MS;
  if (obj.timeoutMs !== undefined) {
    if (typeof obj.timeoutMs !== "number" || !Number.isInteger(obj.timeoutMs) || obj.timeoutMs <= 0) {
      throw new BenchFixtureError(
        `${path}: ${where}.oracle.timeoutMs must be a positive integer when present, got ${describe(obj.timeoutMs)}`,
      );
    }
    oracleTimeoutMs = obj.timeoutMs;
  }
  return { oracleCmd, oracleTimeoutMs };
}

/**
 * Assert `seedDir` and `oracleDir` are disjoint subtrees: no relative path present under one is also present under
 * the other. THROWS naming the first overlapping path — the oracle-hiding guarantee enforced at load (reused
 * verbatim from conduct/fixture.ts).
 */
function assertSeedOracleDisjoint(seedDir: string, oracleDir: string, fixtureDir: string): void {
  const seedPaths = new Set(relativeFiles(seedDir));
  for (const oraclePath of relativeFiles(oracleDir)) {
    if (seedPaths.has(oraclePath)) {
      throw new BenchFixtureError(
        `${fixtureDir}: seed/ and oracle/ overlap on "${oraclePath}" — the oracle would be agent-visible`,
      );
    }
  }
}

/** Recursively list every FILE under `dir`, as paths relative to `dir` (posix-style, dirs not listed). */
function relativeFiles(dir: string): string[] {
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

function requireString(value: unknown, field: string, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BenchFixtureError(`${path}: \`${field}\` must be a non-empty string, got ${describe(value)}`);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
