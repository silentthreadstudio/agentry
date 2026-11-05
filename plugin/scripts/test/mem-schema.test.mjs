// The Fact and Episode validators (lib/memory/domain) accept exactly what @agentry/core's zod schemas
// accept, and describe a refusal as zod did. mem-fixtures/schema-cases.json holds each case's input and
// what the zod schema made of it (its output and key order, or its error message), generated once.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Episode, Fact, MEMORY_TYPES, SCOPES, STATUSES } from "../lib/memory/domain/schema.mjs";

const cases = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "mem-fixtures", "schema-cases.json"),
    "utf8",
  ),
);
const schemas = { Fact, Episode };

for (const c of cases) {
  test(`${c.schema}: ${c.name}`, () => {
    const got = schemas[c.schema].parse(c.input);
    assert.equal(got.ok, c.ok);
    if (c.ok) {
      assert.deepEqual(got.value, c.output);
      assert.deepEqual(Object.keys(got.value), c.keys, "keys follow the schema's order");
    } else assert.equal(got.message, c.message);
  });
}

const fact = {
  id: "g:01X",
  type: "gotcha",
  scope: "global",
  text: "t",
  confidence: 0.5,
  usefulness: 1,
  status: "active",
  createdAt: "a",
  updatedAt: "b",
};

const issuesOf = (input) =>
  JSON.parse(Fact.parse(input).message).map((i) => [i.path.join("."), i.message]);

test("NaN is not a number; an infinite usefulness is", () => {
  assert.deepEqual(issuesOf({ ...fact, confidence: Number.NaN }), [
    ["confidence", "Expected number, received nan"],
  ]);
  assert.equal(Fact.parse({ ...fact, usefulness: Number.POSITIVE_INFINITY }).ok, true);
  assert.equal(Fact.parse({ ...fact, confidence: Number.POSITIVE_INFINITY }).ok, false);
});

test("an undefined optional field is absent; an undefined decay is 0", () => {
  const got = Fact.parse({ ...fact, why: undefined, decay: undefined });
  assert.equal(got.ok, true);
  assert.equal("why" in got.value, false);
  assert.equal(got.value.decay, 0);
});

test("the closed sets are the ones the store has always written", () => {
  assert.deepEqual(SCOPES, ["user", "global", "repo"]);
  assert.deepEqual(STATUSES, ["active", "superseded", "archived"]);
  assert.deepEqual(MEMORY_TYPES, [
    "gotcha",
    "decision",
    "preference",
    "repo-fact",
    "learning",
    "gap",
    "limitation",
  ]);
});
