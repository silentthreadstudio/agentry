// The routing-fixture schema + strict loader/validator (ADR-003 / AC1). This module owns the contract between
// the OQ3 labeled task set (`fixtures/routing/tasks.yaml`) and every consumer of it (the probe scores against
// `correctFloor`; saturation reads the spread). It parses the as-shipped YAML and VALIDATES STRUCTURE — it
// bakes in NO project-specific task content (the OQ3 author filled the labels; this code only checks the set
// is well-formed). Like `benchmark/src/suite/manifest.ts`, it THROWS a specific error per violation: a
// malformed fixture is a deliverable bug to surface loudly, never to default away.
//
// The schema mirrors the SHIPPED shape exactly (do not invent a different one): top-level `version` +
// `labeling` + `tasks[]`, each task `{id, prompt, correct_floor, trap?, rationale{...}, labels{...}}`. The
// YAML's snake_case is mapped to camelCase on the `RoutingTask` interface.

import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import { KnownKind } from "@agentry/core";
import type { Kind } from "@agentry/core";

import type { Shape } from "./shape.ts";
import { SHAPES_BY_WEIGHT } from "./shape.ts";

/** The two trap kinds the fixture tags a task with (the cases the probe most wants to catch a router on). */
export type Trap = "must-escalate" | "must-not-over-orchestrate";

/**
 * The structured rationale that justifies a task's `correctFloor` — NOT free text (AC1). Every rationale
 * carries a `governingSignal` (the rubric signal that set the floor); the remaining keys are the structured
 * evidence and vary by floor:
 *   - a TRIVIAL/one-shot task carries `boundedReversible` (why one-shot is safe);
 *   - an ESCALATION task carries `decisionHidden` + `consequence` (the undecided fork and its cost);
 *   - a DECOMPOSE task carries `seams` (the module boundaries the build splits along).
 * All evidence keys are optional on the type because they vary by floor; the validator enforces that the
 * RIGHT keys are present for each task's kind (so the structure — not just a string — is checked).
 */
export interface RoutingRationale {
  governingSignal: string;
  boundedReversible?: string;
  decisionHidden?: string;
  consequence?: string;
  seams?: string;
  footprintNote?: string;
}

/** A task's recorded second-labeler provenance (AC1): two independent labelers and whether they agreed. */
export interface RoutingLabels {
  labelerA: string;
  labelerB: string;
  agreement: boolean;
}

/**
 * One labeled routing task — the ground truth for the self-eval. `correctFloor` is the process the conducting
 * rubric's INTENT prescribes; the probe compares it to what the conductor's BEHAVIOR actually dispatched.
 *
 * `heldOut` marks a task reserved for the held-out evaluation slice (default `false` when the YAML omits
 * `held_out`); it is parsed but never gates loading — the loader validates structure, the probe decides splits.
 */
export interface RoutingTask {
  id: string;
  prompt: string;
  correctFloor: Shape;
  heldOut: boolean;
  trap?: Trap;
  /**
   * The OPTIONAL routing kind label (ADR-005 / AC11) — the second routing axis, orthogonal to `correctFloor`.
   * Present only on ESCALATED tasks (where the conductor writes a `spec.md` that `extractKind` can read); a
   * one-shot's kind is not artifact-visible, so its label is omitted by design. Permissive on value (mirrors
   * `@agentry/core`'s `Kind = z.string()`) but the validator requires the labeled set to cover all six known
   * kinds. Absent when the YAML omits `kind`.
   */
  kind?: Kind;
  rationale: RoutingRationale;
  labels: RoutingLabels;
}

/** Thrown on any structural violation of the fixture — points at the offending file + the specific rule. */
export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureError";
  }
}

const SHAPES: ReadonlySet<string> = new Set<Shape>(SHAPES_BY_WEIGHT);
const TRAPS: ReadonlySet<string> = new Set<Trap>(["must-escalate", "must-not-over-orchestrate"]);

/** The six known routing kinds (ADR-005) — the coverage the kind fixture must span. From `@agentry/core`. */
const KNOWN_KINDS: readonly string[] = KnownKind.options;
const KNOWN_KINDS_SET: ReadonlySet<string> = new Set<string>(KNOWN_KINDS);

const MIN_TASKS = 6;
const MAX_TASKS = 60;

/** Floors at or above `spec-first` (i.e. NOT one-shot) — a must-escalate trap's floor must clear this bar. */
const ESCALATED_FLOORS: ReadonlySet<Shape> = new Set<Shape>(["spec-first", "decompose"]);

/**
 * Parse + validate the routing fixture at `path` into `RoutingTask[]`. THROWS a {@link FixtureError} with a
 * specific message on the first violation. The rules (AC1):
 *   1. the file parses to `{version, labeling, tasks[]}` with MIN_TASKS–MAX_TASKS tasks;
 *   2. each task has a non-empty `prompt`, a `correct_floor ∈ Shape`, and a STRUCTURED `rationale`
 *      (a mapping with a `governing_signal` plus the floor-appropriate evidence keys — never a bare string);
 *   3. ≥1 must-escalate trap (`trap: must-escalate` with `correct_floor` ≥ spec-first) AND ≥1 trivial
 *      (`trap: must-not-over-orchestrate` OR `correct_floor == one-shot`) — the spread the probe needs;
 *   4. every task records second-labeler agreement: `labels.agreement === true`, with both labelers present.
 */
export function loadRoutingFixture(path: string): RoutingTask[] {
  const raw = parseYaml(readFileSync(path, "utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FixtureError(`${path}: fixture must be a YAML mapping, got ${describe(raw)}`);
  }
  const root = raw as Record<string, unknown>;

  const tasksRaw = root.tasks;
  if (!Array.isArray(tasksRaw)) {
    throw new FixtureError(`${path}: \`tasks\` must be a list, got ${describe(tasksRaw)}`);
  }
  if (tasksRaw.length < MIN_TASKS || tasksRaw.length > MAX_TASKS) {
    throw new FixtureError(
      `${path}: expected ${MIN_TASKS}–${MAX_TASKS} tasks, got ${tasksRaw.length}`,
    );
  }

  const tasks = tasksRaw.map((t, i) => parseTask(t, i, path));

  const seenIds = new Set<string>();
  for (const t of tasks) {
    if (seenIds.has(t.id)) throw new FixtureError(`${path}: duplicate task id "${t.id}"`);
    seenIds.add(t.id);
  }

  const hasEscalationTrap = tasks.some(
    (t) => t.trap === "must-escalate" && ESCALATED_FLOORS.has(t.correctFloor),
  );
  if (!hasEscalationTrap) {
    throw new FixtureError(
      `${path}: fixture needs ≥1 must-escalate trap (trap: must-escalate with correct_floor ≥ spec-first); none found`,
    );
  }

  const hasTrivial = tasks.some(
    (t) => t.trap === "must-not-over-orchestrate" || t.correctFloor === "one-shot",
  );
  if (!hasTrivial) {
    throw new FixtureError(
      `${path}: fixture needs ≥1 trivial task (trap: must-not-over-orchestrate or correct_floor == one-shot); none found`,
    );
  }

  // The kind axis (ADR-005 / AC11): a fixture that OPTS IN to kind labels (≥1 task carries a `kind`) must cover
  // ALL SIX known kinds, so the kind probe scores every kind at least once. The label is optional per task
  // (one-shots omit it by design), and a fixture with NO kind labels is simply not a kind fixture — it is exempt
  // (the mini/synthetic fixtures other tests own carry no kinds and stay valid). But once a fixture labels any
  // kind, a missing one is a coverage bug, surfaced loudly like every other rule.
  const labeledKinds = new Set<string>();
  for (const t of tasks) {
    if (t.kind !== undefined) labeledKinds.add(t.kind);
  }
  if (labeledKinds.size > 0) {
    const missingKinds = KNOWN_KINDS.filter((k) => !labeledKinds.has(k));
    if (missingKinds.length > 0) {
      throw new FixtureError(
        `${path}: a kind-labeled fixture must cover all six kinds (${KNOWN_KINDS.join(", ")}); missing: ${missingKinds.join(", ")}`,
      );
    }
  }

  return tasks;
}

function parseTask(value: unknown, index: number, path: string): RoutingTask {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FixtureError(`${path}: tasks[${index}] must be a mapping, got ${describe(value)}`);
  }
  const obj = value as Record<string, unknown>;

  const id = requireString(obj.id, `tasks[${index}].id`, path);
  const where = `task "${id}"`;

  const prompt = requireString(obj.prompt, `${where}.prompt`, path);

  const correctFloorRaw = requireString(obj.correct_floor, `${where}.correct_floor`, path);
  if (!SHAPES.has(correctFloorRaw)) {
    throw new FixtureError(
      `${path}: ${where}.correct_floor "${correctFloorRaw}" is not one of ${SHAPES_BY_WEIGHT.join("|")}`,
    );
  }
  const correctFloor = correctFloorRaw as Shape;

  const heldOut = parseHeldOut(obj.held_out, where, path);

  let trap: Trap | undefined;
  if (obj.trap !== undefined) {
    const trapRaw = requireString(obj.trap, `${where}.trap`, path);
    if (!TRAPS.has(trapRaw)) {
      throw new FixtureError(
        `${path}: ${where}.trap "${trapRaw}" is not one of ${[...TRAPS].join("|")}`,
      );
    }
    trap = trapRaw as Trap;
  }

  const kind = parseKind(obj.kind, where, path);

  const rationale = parseRationale(obj.rationale, correctFloor, trap, where, path);
  const labels = parseLabels(obj.labels, where, path);

  const task: RoutingTask = { id, prompt, correctFloor, heldOut, rationale, labels };
  if (trap !== undefined) task.trap = trap;
  if (kind !== undefined) task.kind = kind;
  return task;
}

/**
 * Parse the OPTIONAL `kind` label (ADR-005 / AC11) — absent ⇒ unlabeled (a one-shot whose kind isn't
 * artifact-visible). Strict on type (a non-string `kind` is a fixture bug, surfaced loudly), and strict that a
 * PRESENT label is one of the six known kinds — an unknown kind in the fixture is a labeling mistake to catch at
 * load, even though the stored vocabulary is permissive elsewhere.
 */
function parseKind(value: unknown, where: string, path: string): Kind | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new FixtureError(
      `${path}: ${where}.kind must be a non-empty string when present, got ${describe(value)}`,
    );
  }
  if (!KNOWN_KINDS_SET.has(value)) {
    throw new FixtureError(
      `${path}: ${where}.kind "${value}" is not one of ${KNOWN_KINDS.join("|")}`,
    );
  }
  return value;
}

/**
 * Parse the OPTIONAL `held_out` flag — `true` marks a task for the held-out slice; absent or `false` means
 * not held out. Strict on type (a non-boolean is a fixture bug, surfaced loudly), permissive on absence.
 */
function parseHeldOut(value: unknown, where: string, path: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new FixtureError(
      `${path}: ${where}.held_out must be a boolean when present, got ${describe(value)}`,
    );
  }
  return value;
}

/** The structured-evidence keys a rationale can carry (beyond `governing_signal`) — ≥1 proves it isn't prose. */
const EVIDENCE_KEYS: readonly (keyof RoutingRationale)[] = [
  "boundedReversible",
  "decisionHidden",
  "consequence",
  "seams",
];

/**
 * Validate that `rationale` is STRUCTURED (a mapping with a `governing_signal` + ≥1 evidence key, never a bare
 * string), and that it carries the kind-appropriate evidence: a MUST-ESCALATE trap needs `decision_hidden` +
 * `consequence` (the undecided fork and its cost — the structured proof a small footprint hides a real
 * decision); a ONE-SHOT needs `bounded_reversible` (the proof it is safe to one-shot). Other tasks (decompose,
 * untrapped spec-first) need only the structured body — governing_signal + ≥1 evidence key (e.g. `seams`).
 */
function parseRationale(
  value: unknown,
  correctFloor: Shape,
  trap: Trap | undefined,
  where: string,
  path: string,
): RoutingRationale {
  if (typeof value === "string") {
    throw new FixtureError(
      `${path}: ${where}.rationale must be a STRUCTURED mapping, not free text (got a string)`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FixtureError(
      `${path}: ${where}.rationale must be a structured mapping, got ${describe(value)}`,
    );
  }
  const obj = value as Record<string, unknown>;

  const governingSignal = requireString(obj.governing_signal, `${where}.rationale.governing_signal`, path);

  const rationale: RoutingRationale = { governingSignal };
  assignOptionalString(rationale, "boundedReversible", obj.bounded_reversible);
  assignOptionalString(rationale, "decisionHidden", obj.decision_hidden);
  assignOptionalString(rationale, "consequence", obj.consequence);
  assignOptionalString(rationale, "seams", obj.seams);
  assignOptionalString(rationale, "footprintNote", obj.footprint_note);

  // Every rationale must carry ≥1 structured evidence key beyond the signal — else it is effectively free text.
  if (!EVIDENCE_KEYS.some((k) => rationale[k] !== undefined)) {
    throw new FixtureError(
      `${path}: ${where}.rationale must carry structured evidence (one of ${EVIDENCE_KEYS.join(", ")}), not just a signal`,
    );
  }

  if (trap === "must-escalate") {
    // A must-escalate trap must spell out the undecided fork AND its cost — the proof a small footprint hides
    // a real decision (so the validator checks structure, not just that some rationale is present).
    if (rationale.decisionHidden === undefined || rationale.consequence === undefined) {
      throw new FixtureError(
        `${path}: ${where}.rationale (must-escalate) must carry structured \`decision_hidden\` + \`consequence\``,
      );
    }
  } else if (correctFloor === "one-shot") {
    // A trivial must spell out why one-shot is bounded/reversible — the structured proof it is safe to one-shot.
    if (rationale.boundedReversible === undefined) {
      throw new FixtureError(
        `${path}: ${where}.rationale (one-shot) must carry a structured \`bounded_reversible\``,
      );
    }
  }

  return rationale;
}

/** Validate the recorded second-labeler provenance: both labelers present and `agreement === true` (AC1). */
function parseLabels(value: unknown, where: string, path: string): RoutingLabels {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FixtureError(`${path}: ${where}.labels must be a mapping, got ${describe(value)}`);
  }
  const obj = value as Record<string, unknown>;

  const labelerA = requireString(obj.labeler_a, `${where}.labels.labeler_a`, path);
  const labelerB = requireString(obj.labeler_b, `${where}.labels.labeler_b`, path);

  if (obj.agreement !== true) {
    throw new FixtureError(
      `${path}: ${where}.labels.agreement must be \`true\` (recorded second-labeler agreement), got ${describe(obj.agreement)}`,
    );
  }

  return { labelerA, labelerB, agreement: true };
}

function assignOptionalString<K extends keyof RoutingRationale>(
  target: RoutingRationale,
  key: K,
  value: unknown,
): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) return;
  (target[key] as string) = value;
}

function requireString(value: unknown, field: string, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FixtureError(`${path}: \`${field}\` must be a non-empty string, got ${describe(value)}`);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
