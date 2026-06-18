// Tests for the routing-fixture schema + strict loader (ADR-003 / AC1). Two halves:
//   1. the REAL as-shipped fixture (`selfeval/fixtures/routing/tasks.yaml`, the OQ3 deliverable) loads clean
//      and returns 30 well-formed `RoutingTask`s (7 original + 23 grown) — the loader must accept the product
//      set as-is, parse the optional `held_out` flag, and preserve the must-escalate / trivial spread;
//   2. synthetic MALFORMED fixtures (under test/fixtures/routing/) each throw a SPECIFIC FixtureError —
//      wrong count, missing must-escalate trap, free-text rationale, agreement:false.
// Zero API spend: pure parse/validate over YAML on disk.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { FixtureError, loadRoutingFixture } from "../src/routing/fixture.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_FIXTURE = join(HERE, "..", "fixtures", "routing", "tasks.yaml");
const MALFORMED = (name: string): string => join(HERE, "fixtures", "routing", `${name}.yaml`);

// --- 1. the real shipped fixture loads clean -----------------------------------------------------------

test("the real shipped tasks.yaml loads and returns 30 well-formed RoutingTasks", () => {
  const tasks = loadRoutingFixture(REAL_FIXTURE);

  assert.equal(tasks.length, 30, "7 original + 23 grown");
  for (const t of tasks) {
    assert.ok(t.id.length > 0, "id present");
    assert.ok(t.prompt.length > 0, "prompt present");
    assert.ok(["one-shot", "spec-first", "decompose"].includes(t.correctFloor), "correctFloor is a Shape");
    assert.equal(typeof t.heldOut, "boolean", "heldOut parsed as a boolean");
    assert.ok(t.rationale.governingSignal.length > 0, "structured rationale carries governing signal");
    assert.equal(t.labels.agreement, true, "second-labeler agreement recorded");
    assert.ok(t.labels.labelerA.length > 0 && t.labels.labelerB.length > 0, "both labelers present");
  }
});

test("the real fixture parses the optional held_out flag (some held out, the original 7 default false)", () => {
  const tasks = loadRoutingFixture(REAL_FIXTURE);

  const heldOut = tasks.filter((t) => t.heldOut);
  assert.ok(heldOut.length >= 1, "at least one task is held out");
  // The original 7 omit `held_out`, so they must default to false (the flag is optional, not required).
  const original = tasks.find((t) => t.id === "routing-format-price");
  assert.ok(original, "an original task is present");
  assert.equal(original.heldOut, false, "an original task omitting held_out defaults to false");
});

test("the real fixture carries ≥1 must-escalate trap and ≥1 trivial (the spread the probe needs)", () => {
  const tasks = loadRoutingFixture(REAL_FIXTURE);

  const escalations = tasks.filter((t) => t.trap === "must-escalate");
  assert.ok(escalations.length >= 1, "has a must-escalate trap");
  for (const t of escalations) {
    assert.notEqual(t.correctFloor, "one-shot", "an escalation floor is ≥ spec-first");
    assert.ok(t.rationale.decisionHidden !== undefined, "escalation rationale names the hidden decision");
    assert.ok(t.rationale.consequence !== undefined, "escalation rationale names the consequence");
  }

  const trivials = tasks.filter((t) => t.trap === "must-not-over-orchestrate" || t.correctFloor === "one-shot");
  assert.ok(trivials.length >= 1, "has a trivial task");
});

test("the real fixture maps snake_case YAML to the camelCase RoutingTask shape", () => {
  const tasks = loadRoutingFixture(REAL_FIXTURE);
  const dedupe = tasks.find((t) => t.id === "routing-dedupe-key");

  assert.ok(dedupe, "the dedupe-key task is present");
  assert.equal(dedupe.correctFloor, "spec-first");
  assert.equal(dedupe.trap, "must-escalate");
  assert.equal(dedupe.labels.labelerA, "spec-first");
  assert.equal(dedupe.labels.labelerB, "spec-first");
});

// --- the kind axis (ADR-005 / AC11): the real fixture covers all six kinds, orthogonal to shape -------

test("the real fixture's kind-labeled tasks cover all six known kinds", () => {
  const tasks = loadRoutingFixture(REAL_FIXTURE);

  const labeled = tasks.filter((t) => t.kind !== undefined);
  assert.ok(labeled.length >= 6, "at least six tasks carry a kind label");
  const kinds = new Set(labeled.map((t) => t.kind));
  for (const k of ["feature", "bug", "refactor", "perf", "dep-upgrade", "ci-red"]) {
    assert.ok(kinds.has(k), `kind "${k}" is covered`);
  }
});

test("the kind labels live ONLY on escalated tasks (a one-shot has no artifact-visible kind)", () => {
  const tasks = loadRoutingFixture(REAL_FIXTURE);

  for (const t of tasks.filter((t) => t.kind !== undefined)) {
    assert.notEqual(t.correctFloor, "one-shot", `kind-labeled task "${t.id}" is escalated (≥ spec-first)`);
  }
});

test("kind is orthogonal to shape: `feature` appears at TWO different complexity floors (AC4)", () => {
  const tasks = loadRoutingFixture(REAL_FIXTURE);

  const featureFloors = new Set(tasks.filter((t) => t.kind === "feature").map((t) => t.correctFloor));
  assert.ok(featureFloors.size >= 2, "the same kind (feature) is measured at ≥2 complexities — orthogonality");
});

// --- 2. malformed fixtures each throw their specific error ---------------------------------------------

test("rejects a fixture with the wrong task count (below the 6-task floor)", () => {
  assert.throws(
    () => loadRoutingFixture(MALFORMED("malformed-wrong-count")),
    (err: unknown) =>
      err instanceof FixtureError && /6.?60 tasks, got 2/.test((err as Error).message),
  );
});

test("rejects a fixture with no must-escalate trap", () => {
  assert.throws(
    () => loadRoutingFixture(MALFORMED("malformed-missing-trap")),
    (err: unknown) => err instanceof FixtureError && /must-escalate trap/.test((err as Error).message),
  );
});

test("rejects a fixture whose rationale is free text, not a structured mapping", () => {
  assert.throws(
    () => loadRoutingFixture(MALFORMED("malformed-freetext-rationale")),
    (err: unknown) => err instanceof FixtureError && /not free text/.test((err as Error).message),
  );
});

test("rejects a fixture where a task's second-labeler agreement is false", () => {
  assert.throws(
    () => loadRoutingFixture(MALFORMED("malformed-agreement-false")),
    (err: unknown) => err instanceof FixtureError && /agreement must be `true`/.test((err as Error).message),
  );
});

test("rejects a kind-labeled fixture that covers only some of the six kinds", () => {
  assert.throws(
    () => loadRoutingFixture(MALFORMED("malformed-partial-kinds")),
    (err: unknown) =>
      err instanceof FixtureError && /must cover all six kinds.*missing/s.test((err as Error).message),
  );
});
