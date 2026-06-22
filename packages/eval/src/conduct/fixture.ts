// SHARED CONDUCT INFRA (relocated by T-10 from `outcome/fixture.ts`). The `OutcomeFixture` shape is the structural
// VIEW the live rightsizing probe's `runCell` + `summarizeProducedResult` read (the rightsizing fixture is projected
// onto it), so it survived the deletion of `outcome/` and now lives in the NEUTRAL `src/conduct/` home — no probe
// imports another probe's old folder.
//
// The outcome-fixture schema + strict loader/validator (ADR-003 / AC1). A planted seed-repo fixture carries,
// on disk, the five parts the outcome instrument needs: the agent-visible `seed/` tree, the task `prompt`, the
// HIDDEN held-out `oracle/` tests, a known-correct `golden/` overlay, and a planted-wrong `broken/` overlay.
// This module owns the contract between `fixtures/outcome/<id>/` and every consumer (the runner seeds from
// `seedDir`; the harness injects `oracleDir`; the control overlays `golden`/`broken`). Like `routing/fixture.ts`,
// it parses the as-shipped YAML and VALIDATES STRUCTURE, THROWING a specific error per violation — a malformed
// fixture is a deliverable bug to surface loudly, never to default away.
//
// THE LOAD-BEARING SAFETY RULE (ADR-001 / AC5): it asserts the `seed/` and `oracle/` subtrees are DISJOINT — no
// path present under `seed/` may also be present under `oracle/`. An overlapping fixture would leak its oracle
// into the agent-visible tree, which the Spec calls invalid; the loader makes that impossible to ship.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { parse as parseYaml } from "yaml";

import { KnownKind } from "@agentry/core";
import type { Kind } from "@agentry/core";

/** The labeled routing shapes a fixture's planted task can carry (mirrors `routing/shape.ts`'s vocabulary). */
export type FixtureShape = "one-shot" | "spec-first" | "decompose";

/**
 * One loaded outcome fixture — the parsed `fixture.yaml` PLUS the resolved absolute paths to its four subtrees.
 * The runner seeds the sandbox from `seedDir`; the harness injects `oracleDir` post-run and runs `oracleCmd`;
 * the control overlays `goldenDir` / `brokenDir` onto a fresh seed. `shape` is the expected routing shape and
 * `kind` the task kind (feature/bug/…) — labels carried for T6/T7, validated but not consumed by this slice.
 */
export interface OutcomeFixture {
  /** The fixture id (also the `fixtures/outcome/<id>/` directory name). */
  id: string;
  /** The task prompt handed to the agent (non-empty). */
  prompt: string;
  /** The expected routing shape the planted task should provoke. */
  shape: FixtureShape;
  /** The task kind (feature/bug/refactor/perf/dep-upgrade/ci-red). */
  kind: Kind;
  /** The command run INSIDE the injected sandbox to execute the held-out oracle (e.g. `node --test oracle/`). */
  oracleCmd: string;
  /** Hard ceiling (ms) for the oracle command so a hanging test cannot wedge the batch. */
  oracleTimeoutMs: number;
  /** Absolute path to `seed/` — the ONLY tree copied into the sandbox (agent-visible). */
  seedDir: string;
  /** Absolute path to `oracle/` — the held-out tests, injected POST-RUN (never agent-visible). */
  oracleDir: string;
  /** Absolute path to `golden/` — a known-correct overlay; seed+golden PASSES the oracle (control). */
  goldenDir: string;
  /** Absolute path to `broken/` — a planted-wrong overlay; seed+broken FAILS the oracle (control). */
  brokenDir: string;
}

/** Thrown on any structural violation of an outcome fixture — points at the offending dir + the specific rule. */
export class OutcomeFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutcomeFixtureError";
  }
}

const SHAPES: ReadonlySet<string> = new Set<FixtureShape>(["one-shot", "spec-first", "decompose"]);
const KNOWN_KINDS: readonly string[] = KnownKind.options;
const KNOWN_KINDS_SET: ReadonlySet<string> = new Set<string>(KNOWN_KINDS);

/** The four subtrees every fixture must ship (ADR-003) — each is a required directory under the fixture root. */
const REQUIRED_SUBTREES = ["seed", "oracle", "golden", "broken"] as const;

/** Default oracle ceiling when `fixture.yaml` omits `oracle.timeoutMs` — conservative; a real suite is sub-minute. */
const DEFAULT_ORACLE_TIMEOUT_MS = 60_000;

/**
 * Parse + validate the outcome fixture rooted at `fixtureDir` into an {@link OutcomeFixture}. THROWS an
 * {@link OutcomeFixtureError} with a specific message on the first violation. The rules (AC1/AC5):
 *   1. the dir holds `fixture.yaml` + all four subtrees (`seed/ oracle/ golden/ broken/`);
 *   2. `fixture.yaml` parses to a mapping with a non-empty `prompt`, a `shape ∈ {one-shot,spec-first,decompose}`,
 *      a `kind ∈` the six known kinds, and a non-empty `oracle.cmd` (with an optional numeric `oracle.timeoutMs`);
 *   3. THE SAFETY RULE — `seed/` and `oracle/` are DISJOINT subtrees: no relative path exists under both, so the
 *      agent-visible seed can never contain a held-out oracle file.
 */
export function loadOutcomeFixture(fixtureDir: string): OutcomeFixture {
  const yamlPath = join(fixtureDir, "fixture.yaml");
  if (!existsSync(yamlPath)) {
    throw new OutcomeFixtureError(`${fixtureDir}: missing fixture.yaml`);
  }

  const subtrees: Record<string, string> = {};
  for (const name of REQUIRED_SUBTREES) {
    const dir = join(fixtureDir, name);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new OutcomeFixtureError(`${fixtureDir}: missing required \`${name}/\` subtree`);
    }
    subtrees[name] = dir;
  }

  const raw = parseYaml(readFileSync(yamlPath, "utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new OutcomeFixtureError(`${yamlPath}: fixture.yaml must be a YAML mapping, got ${describe(raw)}`);
  }
  const root = raw as Record<string, unknown>;

  const id = requireString(root.id, "id", yamlPath);
  const prompt = requireString(root.prompt, "prompt", yamlPath);

  const shapeRaw = requireString(root.shape, "shape", yamlPath);
  if (!SHAPES.has(shapeRaw)) {
    throw new OutcomeFixtureError(`${yamlPath}: \`shape\` "${shapeRaw}" is not one of ${[...SHAPES].join("|")}`);
  }
  const shape = shapeRaw as FixtureShape;

  const kind = requireString(root.kind, "kind", yamlPath);
  if (!KNOWN_KINDS_SET.has(kind)) {
    throw new OutcomeFixtureError(`${yamlPath}: \`kind\` "${kind}" is not one of ${KNOWN_KINDS.join("|")}`);
  }

  const { oracleCmd, oracleTimeoutMs } = parseOracle(root.oracle, yamlPath);

  // THE SAFETY RULE (AC5): the agent-visible seed must not contain ANY oracle file. Enforced structurally by
  // asserting the two subtrees share no relative path — obscurity (rename / gitignore) is rejected by ADR-001,
  // only disjointness counts.
  assertSeedOracleDisjoint(subtrees.seed!, subtrees.oracle!, fixtureDir);

  return {
    id,
    prompt,
    shape,
    kind,
    oracleCmd,
    oracleTimeoutMs,
    seedDir: subtrees.seed!,
    oracleDir: subtrees.oracle!,
    goldenDir: subtrees.golden!,
    brokenDir: subtrees.broken!,
  };
}

/** Parse the `oracle` mapping: a required non-empty `cmd` and an optional positive-integer `timeoutMs`. */
function parseOracle(value: unknown, yamlPath: string): { oracleCmd: string; oracleTimeoutMs: number } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OutcomeFixtureError(`${yamlPath}: \`oracle\` must be a mapping, got ${describe(value)}`);
  }
  const obj = value as Record<string, unknown>;
  const oracleCmd = requireString(obj.cmd, "oracle.cmd", yamlPath);

  let oracleTimeoutMs = DEFAULT_ORACLE_TIMEOUT_MS;
  if (obj.timeoutMs !== undefined) {
    if (typeof obj.timeoutMs !== "number" || !Number.isInteger(obj.timeoutMs) || obj.timeoutMs <= 0) {
      throw new OutcomeFixtureError(
        `${yamlPath}: \`oracle.timeoutMs\` must be a positive integer when present, got ${describe(obj.timeoutMs)}`,
      );
    }
    oracleTimeoutMs = obj.timeoutMs;
  }
  return { oracleCmd, oracleTimeoutMs };
}

/**
 * Assert `seedDir` and `oracleDir` are disjoint subtrees: no relative path present under one is also present
 * under the other. THROWS naming the first overlapping path. This is the AC5 oracle-hiding guarantee enforced
 * at load — a careless fixture that co-locates an oracle file under `seed/` fails to load, not at review.
 */
function assertSeedOracleDisjoint(seedDir: string, oracleDir: string, fixtureDir: string): void {
  const seedPaths = new Set(relativeFiles(seedDir));
  for (const oraclePath of relativeFiles(oracleDir)) {
    if (seedPaths.has(oraclePath)) {
      throw new OutcomeFixtureError(
        `${fixtureDir}: seed/ and oracle/ overlap on "${oraclePath}" — the oracle would be agent-visible (ADR-001/AC5)`,
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
    throw new OutcomeFixtureError(`${path}: \`${field}\` must be a non-empty string, got ${describe(value)}`);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
