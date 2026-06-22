// The UNIFIED rightsizing-fixture schema + strict loader/validator (ADR-004). A `RightsizingFixture` is the
// SUPERSET of the two former fixture shapes: it carries BOTH the routing label axis (a defended `correctFloor`
// with a structured `rationale` + second-labeler `labels`, an optional `trap`/`kind`) AND a judgeable result
// oracle (the four `seed/ oracle/ golden/ broken/` subtrees + an `oracleCmd`). One task = one conduct = both
// axes, made a LOAD-TIME invariant — a fixture that is missing either half fails to load.
//
// This validator is a COMPOSITION, not a rewrite (ADR-004 §reconciliation rules): it reuses
//   - `routing/fixture.ts`'s rationale/label/kind/trap structural rules (must-escalate ⇒ `decision_hidden` +
//     `consequence`; one-shot ⇒ `bounded_reversible`; `labels.agreement === true`; an opted-in kind set covers
//     all six known kinds), AND
//   - `outcome/fixture.ts`'s subtree-presence + the LOAD-BEARING seed/oracle-DISJOINT safety rule (no path under
//     `seed/` may also appear under `oracle/`, so the held-out oracle can never leak into the agent-visible tree).
// Both error vocabularies are preserved: it THROWS a specific error per violation pointing at the file + rule —
// a malformed fixture is a deliverable bug surfaced loudly, never defaulted away.
//
// Layout: `fixtures/rightsizing/<id>/` holds `fixture.yaml` (the routing fields, snake_case) PLUS the four
// subtrees. `loadRightsizingFixture(dir)` walks that directory, loads every `<id>/` child, and asserts the
// CORPUS-level spread the controls need (≥1 must-escalate trap, ≥1 trivial one-shot).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { parse as parseYaml } from "yaml";

import { KnownKind } from "@agentry/core";
import type { Kind } from "@agentry/core";

// The shape vocabulary is the canonical routing one (`routing/shape.ts`) — a pure, dependency-free type that
// `routing/extract.ts` already sources and T-03's moved `rightsizing/extract.ts` continues to consume. Imported
// read-only here; no `rightsizing/shape.ts` is owned by this task, and `routing/` is untouched (T-10 owns its
// eventual deletion).
import type { Shape } from "../conduct/shape.ts";
import { SHAPES_BY_WEIGHT } from "../conduct/shape.ts";

/** The two trap kinds a fixture tags a task with (the cases the probe most wants to catch a router on). */
export type Trap = "must-escalate" | "must-not-over-orchestrate";

/**
 * The structured rationale that justifies a fixture's `correctFloor` — NOT free text (ADR-004, inherited from
 * the routing rule set). Every rationale carries a `governingSignal`; the remaining keys are structured evidence
 * that vary by floor: a one-shot carries `boundedReversible`; a must-escalate carries `decisionHidden` +
 * `consequence`; a decompose carries `seams`. The validator enforces the RIGHT keys per floor/trap.
 */
export interface RightsizingRationale {
  governingSignal: string;
  boundedReversible?: string;
  decisionHidden?: string;
  consequence?: string;
  seams?: string;
  footprintNote?: string;
}

/** A fixture's recorded second-labeler provenance: two independent labelers and whether they agreed. */
export interface RightsizingLabels {
  labelerA: string;
  labelerB: string;
  agreement: boolean;
}

/**
 * One loaded unified fixture — the parsed `fixture.yaml` (the routing axis) PLUS the resolved absolute paths to
 * its four result subtrees and the oracle command. The probe (T-03) conducts the `prompt` over a sandbox seeded
 * from `seedDir`, scores its route against `correctFloor`, and judges its result with the oracle; the controls
 * overlay `goldenDir` (must pass) / `brokenDir` (must fail) onto a fresh seed to measure the judge's gap.
 */
export interface RightsizingFixture {
  /** The fixture id (also the `fixtures/rightsizing/<id>/` directory name). */
  id: string;
  /** The task prompt handed to the conductor (non-empty). */
  prompt: string;
  /** The defended ground-truth floor: the process the conducting rubric's INTENT prescribes for this task. */
  correctFloor: Shape;
  /** Reserved-for-held-out-slice marker (default `false`); parsed but never gates loading. */
  heldOut: boolean;
  /** The trap this task probes for, when it is one (`must-escalate` / `must-not-over-orchestrate`). */
  trap?: Trap;
  /** The OPTIONAL routing kind label; permissive on value, but an opted-in set must cover all six known kinds. */
  kind?: Kind;
  /** The structured, floor-appropriate rationale defending `correctFloor` (never free text). */
  rationale: RightsizingRationale;
  /** The recorded second-labeler agreement (must be `true`). */
  labels: RightsizingLabels;
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

/** Thrown on any structural violation of a unified fixture — points at the offending file/dir + the rule. */
export class RightsizingFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RightsizingFixtureError";
  }
}

const SHAPES: ReadonlySet<string> = new Set<Shape>(SHAPES_BY_WEIGHT);
const TRAPS: ReadonlySet<string> = new Set<Trap>(["must-escalate", "must-not-over-orchestrate"]);

const KNOWN_KINDS: readonly string[] = KnownKind.options;
const KNOWN_KINDS_SET: ReadonlySet<string> = new Set<string>(KNOWN_KINDS);

/** The four subtrees every fixture must ship (inherited from the outcome shape) — each a required directory. */
const REQUIRED_SUBTREES = ["seed", "oracle", "golden", "broken"] as const;

/** Default oracle ceiling when `fixture.yaml` omits `oracle.timeoutMs` — conservative; a real suite is sub-minute. */
const DEFAULT_ORACLE_TIMEOUT_MS = 60_000;

/** Owner decision A (ADR-004): validate-small-first — the first run ships ≥8 fully-dual fixtures (target 8–10). */
const MIN_FIXTURES = 8;

/** Floors at or above `spec-first` (i.e. NOT one-shot) — a must-escalate trap's floor must clear this bar. */
const ESCALATED_FLOORS: ReadonlySet<Shape> = new Set<Shape>(["spec-first", "decompose"]);

/**
 * Load + validate EVERY unified fixture under `dir` (each a `<id>/` subdirectory). THROWS a
 * {@link RightsizingFixtureError} on the first violation. Corpus rules (ADR-004):
 *   1. ≥{@link MIN_FIXTURES} fixtures load (owner decision A — validate-small-first);
 *   2. ids are unique;
 *   3. the set spans the spread: ≥1 must-escalate trap (floor ≥ spec-first) AND ≥1 trivial (one-shot or
 *      must-not-over-orchestrate) — the saturation the controls need;
 *   4. an opted-in kind set (≥1 fixture carries a `kind`) covers all six known kinds.
 * Each fixture is loaded by {@link loadRightsizingFixtureDir}, which enforces the per-fixture structure.
 */
export function loadRightsizingFixture(dir: string): RightsizingFixture[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new RightsizingFixtureError(`${dir}: not a fixture directory`);
  }

  const ids = readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();

  const fixtures = ids.map((id) => loadRightsizingFixtureDir(join(dir, id), id));

  if (fixtures.length < MIN_FIXTURES) {
    throw new RightsizingFixtureError(
      `${dir}: expected ≥${MIN_FIXTURES} fully-dual fixtures (owner decision A), got ${fixtures.length}`,
    );
  }

  const seen = new Set<string>();
  for (const fx of fixtures) {
    if (seen.has(fx.id)) throw new RightsizingFixtureError(`${dir}: duplicate fixture id "${fx.id}"`);
    seen.add(fx.id);
  }

  const hasEscalationTrap = fixtures.some(
    (fx) => fx.trap === "must-escalate" && ESCALATED_FLOORS.has(fx.correctFloor),
  );
  if (!hasEscalationTrap) {
    throw new RightsizingFixtureError(
      `${dir}: spread needs ≥1 must-escalate trap (trap: must-escalate with correct_floor ≥ spec-first); none found`,
    );
  }

  const hasTrivial = fixtures.some(
    (fx) => fx.trap === "must-not-over-orchestrate" || fx.correctFloor === "one-shot",
  );
  if (!hasTrivial) {
    throw new RightsizingFixtureError(
      `${dir}: spread needs ≥1 trivial fixture (trap: must-not-over-orchestrate or correct_floor == one-shot); none found`,
    );
  }

  const labeledKinds = new Set<string>();
  for (const fx of fixtures) {
    if (fx.kind !== undefined) labeledKinds.add(fx.kind);
  }
  if (labeledKinds.size > 0) {
    const missing = KNOWN_KINDS.filter((k) => !labeledKinds.has(k));
    if (missing.length > 0) {
      throw new RightsizingFixtureError(
        `${dir}: a kind-labeled corpus must cover all six kinds (${KNOWN_KINDS.join(", ")}); missing: ${missing.join(", ")}`,
      );
    }
  }

  return fixtures;
}

/**
 * Parse + validate the SINGLE unified fixture rooted at `fixtureDir` into a {@link RightsizingFixture}. THROWS a
 * {@link RightsizingFixtureError} on the first violation. The composed per-fixture rules (ADR-004):
 *   1. the dir holds `fixture.yaml` + all four subtrees (`seed/ oracle/ golden/ broken/`) — outcome's rule;
 *   2. `fixture.yaml` parses to a mapping with: a non-empty `prompt`; a `correct_floor ∈ Shape`; an optional
 *      `trap`/`kind`/`held_out`; a STRUCTURED floor-appropriate `rationale`; and `labels.agreement === true`
 *      with both labelers present — routing's rules;
 *   3. a non-empty `oracle.cmd` (optional positive-integer `oracle.timeoutMs`) — outcome's rule;
 *   4. THE SAFETY RULE — `seed/` and `oracle/` are DISJOINT subtrees, so the held-out oracle is never
 *      agent-visible — outcome's load-bearing rule.
 * `id` defaults to the directory name; if `fixture.yaml` carries an `id`, it MUST match the directory name.
 */
export function loadRightsizingFixtureDir(fixtureDir: string, dirId: string): RightsizingFixture {
  const yamlPath = join(fixtureDir, "fixture.yaml");
  if (!existsSync(yamlPath)) {
    throw new RightsizingFixtureError(`${fixtureDir}: missing fixture.yaml`);
  }

  const subtrees: Record<string, string> = {};
  for (const name of REQUIRED_SUBTREES) {
    const sub = join(fixtureDir, name);
    if (!existsSync(sub) || !statSync(sub).isDirectory()) {
      throw new RightsizingFixtureError(`${fixtureDir}: missing required \`${name}/\` subtree`);
    }
    subtrees[name] = sub;
  }

  const raw = parseYaml(readFileSync(yamlPath, "utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RightsizingFixtureError(`${yamlPath}: fixture.yaml must be a YAML mapping, got ${describe(raw)}`);
  }
  const root = raw as Record<string, unknown>;
  const where = `fixture "${dirId}"`;

  if (root.id !== undefined) {
    const declaredId = requireString(root.id, `${where}.id`, yamlPath);
    if (declaredId !== dirId) {
      throw new RightsizingFixtureError(
        `${yamlPath}: \`id\` "${declaredId}" must match the directory name "${dirId}"`,
      );
    }
  }

  const prompt = requireString(root.prompt, `${where}.prompt`, yamlPath);

  const correctFloorRaw = requireString(root.correct_floor, `${where}.correct_floor`, yamlPath);
  if (!SHAPES.has(correctFloorRaw)) {
    throw new RightsizingFixtureError(
      `${yamlPath}: ${where}.correct_floor "${correctFloorRaw}" is not one of ${SHAPES_BY_WEIGHT.join("|")}`,
    );
  }
  const correctFloor = correctFloorRaw as Shape;

  const heldOut = parseHeldOut(root.held_out, where, yamlPath);
  const trap = parseTrap(root.trap, where, yamlPath);
  const kind = parseKind(root.kind, where, yamlPath);
  const rationale = parseRationale(root.rationale, correctFloor, trap, where, yamlPath);
  const labels = parseLabels(root.labels, where, yamlPath);
  const { oracleCmd, oracleTimeoutMs } = parseOracle(root.oracle, where, yamlPath);

  // THE SAFETY RULE: the agent-visible seed must not contain ANY oracle file (inherited from outcome/fixture.ts).
  assertSeedOracleDisjoint(subtrees.seed!, subtrees.oracle!, fixtureDir);

  const fixture: RightsizingFixture = {
    id: dirId,
    prompt,
    correctFloor,
    heldOut,
    rationale,
    labels,
    oracleCmd,
    oracleTimeoutMs,
    seedDir: subtrees.seed!,
    oracleDir: subtrees.oracle!,
    goldenDir: subtrees.golden!,
    brokenDir: subtrees.broken!,
  };
  if (trap !== undefined) fixture.trap = trap;
  if (kind !== undefined) fixture.kind = kind;
  return fixture;
}

/** Parse the optional `trap`, strict on value when present (inherited from routing). */
function parseTrap(value: unknown, where: string, path: string): Trap | undefined {
  if (value === undefined) return undefined;
  const trapRaw = requireString(value, `${where}.trap`, path);
  if (!TRAPS.has(trapRaw)) {
    throw new RightsizingFixtureError(`${path}: ${where}.trap "${trapRaw}" is not one of ${[...TRAPS].join("|")}`);
  }
  return trapRaw as Trap;
}

/** Parse the optional `kind` — strict that a PRESENT label is one of the six known kinds (inherited from routing). */
function parseKind(value: unknown, where: string, path: string): Kind | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new RightsizingFixtureError(
      `${path}: ${where}.kind must be a non-empty string when present, got ${describe(value)}`,
    );
  }
  if (!KNOWN_KINDS_SET.has(value)) {
    throw new RightsizingFixtureError(`${path}: ${where}.kind "${value}" is not one of ${KNOWN_KINDS.join("|")}`);
  }
  return value;
}

/** Parse the optional `held_out` flag — strict on type, permissive on absence (inherited from routing). */
function parseHeldOut(value: unknown, where: string, path: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new RightsizingFixtureError(
      `${path}: ${where}.held_out must be a boolean when present, got ${describe(value)}`,
    );
  }
  return value;
}

/** The structured-evidence keys a rationale can carry (beyond `governing_signal`) — ≥1 proves it isn't prose. */
const EVIDENCE_KEYS: readonly (keyof RightsizingRationale)[] = [
  "boundedReversible",
  "decisionHidden",
  "consequence",
  "seams",
];

/**
 * Validate that `rationale` is STRUCTURED (a mapping with `governing_signal` + ≥1 evidence key, never a bare
 * string) and carries the floor-appropriate evidence (inherited verbatim from routing/fixture.ts): a
 * MUST-ESCALATE trap needs `decision_hidden` + `consequence`; a ONE-SHOT needs `bounded_reversible`.
 */
function parseRationale(
  value: unknown,
  correctFloor: Shape,
  trap: Trap | undefined,
  where: string,
  path: string,
): RightsizingRationale {
  if (typeof value === "string") {
    throw new RightsizingFixtureError(
      `${path}: ${where}.rationale must be a STRUCTURED mapping, not free text (got a string)`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RightsizingFixtureError(
      `${path}: ${where}.rationale must be a structured mapping, got ${describe(value)}`,
    );
  }
  const obj = value as Record<string, unknown>;

  const governingSignal = requireString(obj.governing_signal, `${where}.rationale.governing_signal`, path);

  const rationale: RightsizingRationale = { governingSignal };
  assignOptionalString(rationale, "boundedReversible", obj.bounded_reversible);
  assignOptionalString(rationale, "decisionHidden", obj.decision_hidden);
  assignOptionalString(rationale, "consequence", obj.consequence);
  assignOptionalString(rationale, "seams", obj.seams);
  assignOptionalString(rationale, "footprintNote", obj.footprint_note);

  if (!EVIDENCE_KEYS.some((k) => rationale[k] !== undefined)) {
    throw new RightsizingFixtureError(
      `${path}: ${where}.rationale must carry structured evidence (one of ${EVIDENCE_KEYS.join(", ")}), not just a signal`,
    );
  }

  if (trap === "must-escalate") {
    if (rationale.decisionHidden === undefined || rationale.consequence === undefined) {
      throw new RightsizingFixtureError(
        `${path}: ${where}.rationale (must-escalate) must carry structured \`decision_hidden\` + \`consequence\``,
      );
    }
  } else if (correctFloor === "one-shot") {
    if (rationale.boundedReversible === undefined) {
      throw new RightsizingFixtureError(
        `${path}: ${where}.rationale (one-shot) must carry a structured \`bounded_reversible\``,
      );
    }
  }

  return rationale;
}

/** Validate the recorded second-labeler provenance: both labelers present and `agreement === true`. */
function parseLabels(value: unknown, where: string, path: string): RightsizingLabels {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RightsizingFixtureError(`${path}: ${where}.labels must be a mapping, got ${describe(value)}`);
  }
  const obj = value as Record<string, unknown>;

  const labelerA = requireString(obj.labeler_a, `${where}.labels.labeler_a`, path);
  const labelerB = requireString(obj.labeler_b, `${where}.labels.labeler_b`, path);

  if (obj.agreement !== true) {
    throw new RightsizingFixtureError(
      `${path}: ${where}.labels.agreement must be \`true\` (recorded second-labeler agreement), got ${describe(obj.agreement)}`,
    );
  }

  return { labelerA, labelerB, agreement: true };
}

/** Parse the `oracle` mapping: a required non-empty `cmd` and an optional positive-integer `timeoutMs`. */
function parseOracle(
  value: unknown,
  where: string,
  path: string,
): { oracleCmd: string; oracleTimeoutMs: number } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RightsizingFixtureError(`${path}: ${where}.oracle must be a mapping, got ${describe(value)}`);
  }
  const obj = value as Record<string, unknown>;
  const oracleCmd = requireString(obj.cmd, `${where}.oracle.cmd`, path);

  let oracleTimeoutMs = DEFAULT_ORACLE_TIMEOUT_MS;
  if (obj.timeoutMs !== undefined) {
    if (typeof obj.timeoutMs !== "number" || !Number.isInteger(obj.timeoutMs) || obj.timeoutMs <= 0) {
      throw new RightsizingFixtureError(
        `${path}: ${where}.oracle.timeoutMs must be a positive integer when present, got ${describe(obj.timeoutMs)}`,
      );
    }
    oracleTimeoutMs = obj.timeoutMs;
  }
  return { oracleCmd, oracleTimeoutMs };
}

/**
 * Assert `seedDir` and `oracleDir` are disjoint subtrees: no relative path under one is also under the other.
 * THROWS naming the first overlapping path — the oracle-hiding guarantee enforced at load (inherited verbatim
 * from outcome/fixture.ts).
 */
function assertSeedOracleDisjoint(seedDir: string, oracleDir: string, fixtureDir: string): void {
  const seedPaths = new Set(relativeFiles(seedDir));
  for (const oraclePath of relativeFiles(oracleDir)) {
    if (seedPaths.has(oraclePath)) {
      throw new RightsizingFixtureError(
        `${fixtureDir}: seed/ and oracle/ overlap on "${oraclePath}" — the oracle would be agent-visible (ADR-004 safety rule)`,
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

function assignOptionalString<K extends keyof RightsizingRationale>(
  target: RightsizingRationale,
  key: K,
  value: unknown,
): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) return;
  (target[key] as string) = value;
}

function requireString(value: unknown, field: string, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RightsizingFixtureError(`${path}: \`${field}\` must be a non-empty string, got ${describe(value)}`);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
