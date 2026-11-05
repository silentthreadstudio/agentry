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

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { KnownKind, RoutedShape } from "@agentry/core";
import type { Kind } from "@agentry/core";

import {
  type Fail,
  assertSeedOracleDisjoint,
  describe,
  parseOracle,
  requireString,
} from "../fixture-common.ts";

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
  shape: RoutedShape;
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

const KNOWN_KINDS: readonly string[] = KnownKind.options;
const KNOWN_KINDS_SET: ReadonlySet<string> = new Set<string>(KNOWN_KINDS);

/** The four subtrees every fixture must ship (ADR-003) — each is a required directory under the fixture root. */
const REQUIRED_SUBTREES = ["seed", "oracle", "golden", "broken"] as const;

const fail: Fail = (message) => {
  throw new OutcomeFixtureError(message);
};

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
  const requireSubtree = (name: string): string => {
    const dir = subtrees[name];
    if (dir === undefined)
      throw new OutcomeFixtureError(`${fixtureDir}: missing \`${name}/\` subtree`);
    return dir;
  };

  const raw = parseYaml(readFileSync(yamlPath, "utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new OutcomeFixtureError(
      `${yamlPath}: fixture.yaml must be a YAML mapping, got ${describe(raw)}`,
    );
  }
  const root = raw as Record<string, unknown>;

  const id = requireString(root.id, "id", yamlPath, fail);
  const prompt = requireString(root.prompt, "prompt", yamlPath, fail);

  const shapeRaw = requireString(root.shape, "shape", yamlPath, fail);
  const shapeParsed = RoutedShape.safeParse(shapeRaw);
  if (!shapeParsed.success) {
    throw new OutcomeFixtureError(
      `${yamlPath}: \`shape\` "${shapeRaw}" is not one of ${RoutedShape.options.join("|")}`,
    );
  }
  const shape = shapeParsed.data;

  const kind = requireString(root.kind, "kind", yamlPath, fail);
  if (!KNOWN_KINDS_SET.has(kind)) {
    throw new OutcomeFixtureError(
      `${yamlPath}: \`kind\` "${kind}" is not one of ${KNOWN_KINDS.join("|")}`,
    );
  }

  const { oracleCmd, oracleTimeoutMs } = parseOracle(root.oracle, "oracle", yamlPath, fail);

  // THE SAFETY RULE (AC5): the agent-visible seed must not contain ANY oracle file. Enforced structurally by
  // asserting the two subtrees share no relative path — obscurity (rename / gitignore) is rejected by ADR-001,
  // only disjointness counts.
  const seedDir = requireSubtree("seed");
  const oracleDir = requireSubtree("oracle");
  assertSeedOracleDisjoint(seedDir, oracleDir, fixtureDir, fail);

  return {
    id,
    prompt,
    shape,
    kind,
    oracleCmd,
    oracleTimeoutMs,
    seedDir,
    oracleDir,
    goldenDir: requireSubtree("golden"),
    brokenDir: requireSubtree("broken"),
  };
}
