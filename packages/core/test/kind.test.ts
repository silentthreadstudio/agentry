import assert from "node:assert/strict";
import { test } from "node:test";
import { SpecFrontmatter } from "../src/artifacts.js";
import { Kind, KnownKind } from "../src/enums.js";

test("KnownKind set is closed — the six routing kinds parse", () => {
  for (const kind of ["feature", "bug", "refactor", "perf", "dep-upgrade", "ci-red"]) {
    assert.equal(KnownKind.parse(kind), kind);
  }
});

test("KnownKind rejects a non-member", () => {
  assert.throws(() => KnownKind.parse("chore"));
});

test("Kind is permissive — accepts an unknown kind rather than rejecting it", () => {
  // Mirrors Shape: a kind recorded later that isn't in the known set must not throw on old records.
  assert.equal(Kind.parse("chore"), "chore");
});

test("SpecFrontmatter.kind is optional — a spec may omit it", () => {
  const spec = { id: "S1", title: "A spec", status: "draft" as const };
  assert.equal(SpecFrontmatter.parse(spec).kind, undefined);
});

test("SpecFrontmatter records kind when present, independent of any shape field", () => {
  const spec = { id: "S1", title: "A spec", status: "approved" as const, kind: "bug" };
  assert.equal(SpecFrontmatter.parse(spec).kind, "bug");
});
