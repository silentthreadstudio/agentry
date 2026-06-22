// The moat-fixture schema + loader. A moat task carries everything a memory-compounding measurement needs: the
// task prompt, its COLD floor (the shape it routes to with empty memory — the baseline to beat), a RELEVANT
// fork-resolving fact (expected to make it route lighter), and an irrelevant DECOY fact (the discrimination
// control — expected NOT to change the shape). The codebase to seed comes from `<fixtureDir>/seeds/<id>` exactly
// as the routing probe seeds its tasks.
//
// SRP: parse + validate structure. It throws a specific error per violation (a malformed fixture is a loud bug),
// mirroring the routing loader. It bakes in NO task content — the fixture authors the facts; this only checks shape.

import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import type { Shape } from "../conduct/shape.ts";
import { SHAPES_BY_WEIGHT } from "../conduct/shape.ts";
import type { FactSeed } from "./seed.ts";

/** One moat task — the prompt + its cold floor + the relevant/decoy facts + an optional surfaced-signature phrase. */
export interface MoatTask {
  id: string;
  prompt: string;
  /** The shape this task routes to with EMPTY memory (the baseline a recalled decision must beat to "compound"). */
  coldFloor: Shape;
  /** A short distinctive phrase from the relevant fact, used to confirm it SURFACED in recall (optional). */
  factSignature?: string;
  /** The fork-resolving fact seeded for the relevant warm run. */
  relevant: FactSeed;
  /** An irrelevant fact seeded for the decoy warm run (the control). */
  decoy: FactSeed;
}

/** Thrown on any structural violation of the moat fixture. */
export class MoatFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoatFixtureError";
  }
}

const SHAPES: ReadonlySet<string> = new Set<Shape>(SHAPES_BY_WEIGHT);
const TYPES: ReadonlySet<string> = new Set([
  "gotcha", "decision", "preference", "repo-fact", "learning", "gap", "limitation",
]);
const SCOPES: ReadonlySet<string> = new Set(["user", "global", "repo"]);

/** Parse + validate the moat fixture at `path` into `MoatTask[]`. THROWS {@link MoatFixtureError} on any violation. */
export function loadMoatFixture(path: string): MoatTask[] {
  const raw = parseYaml(readFileSync(path, "utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MoatFixtureError(`${path}: fixture must be a YAML mapping`);
  }
  const tasksRaw = (raw as Record<string, unknown>).tasks;
  if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) {
    throw new MoatFixtureError(`${path}: \`tasks\` must be a non-empty list`);
  }
  const tasks = tasksRaw.map((t, i) => parseTask(t, i, path));

  const seen = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.id)) throw new MoatFixtureError(`${path}: duplicate task id "${t.id}"`);
    seen.add(t.id);
  }
  return tasks;
}

function parseTask(value: unknown, index: number, path: string): MoatTask {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MoatFixtureError(`${path}: tasks[${index}] must be a mapping`);
  }
  const obj = value as Record<string, unknown>;
  const id = str(obj.id, `tasks[${index}].id`, path);
  const where = `task "${id}"`;

  const prompt = str(obj.prompt, `${where}.prompt`, path);
  const coldFloorRaw = str(obj.cold_floor, `${where}.cold_floor`, path);
  if (!SHAPES.has(coldFloorRaw)) {
    throw new MoatFixtureError(`${path}: ${where}.cold_floor "${coldFloorRaw}" not one of ${SHAPES_BY_WEIGHT.join("|")}`);
  }

  const task: MoatTask = {
    id,
    prompt,
    coldFloor: coldFloorRaw as Shape,
    relevant: parseFact(obj.relevant, `${where}.relevant`, path),
    decoy: parseFact(obj.decoy, `${where}.decoy`, path),
  };
  if (typeof obj.fact_signature === "string" && obj.fact_signature.length > 0) {
    task.factSignature = obj.fact_signature;
  }
  return task;
}

/** Parse + validate a `FactSeed` (type/scope enums, non-empty text, optional why/tags/provenance/subject). */
function parseFact(value: unknown, where: string, path: string): FactSeed {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MoatFixtureError(`${path}: ${where} must be a mapping`);
  }
  const obj = value as Record<string, unknown>;

  const type = str(obj.type, `${where}.type`, path);
  if (!TYPES.has(type)) throw new MoatFixtureError(`${path}: ${where}.type "${type}" is not a valid memory type`);
  const scope = str(obj.scope, `${where}.scope`, path);
  if (!SCOPES.has(scope)) throw new MoatFixtureError(`${path}: ${where}.scope "${scope}" not one of user|global|repo`);

  const fact: FactSeed = {
    type: type as FactSeed["type"],
    scope: scope as FactSeed["scope"],
    text: str(obj.text, `${where}.text`, path),
  };
  if (typeof obj.why === "string") fact.why = obj.why;
  if (typeof obj.subject === "string") fact.subject = obj.subject;
  if (Array.isArray(obj.tags)) fact.tags = obj.tags.filter((t): t is string => typeof t === "string");
  if (Array.isArray(obj.provenance)) fact.provenance = obj.provenance.filter((p): p is string => typeof p === "string");
  return fact;
}

function str(value: unknown, field: string, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MoatFixtureError(`${path}: \`${field}\` must be a non-empty string`);
  }
  return value;
}
