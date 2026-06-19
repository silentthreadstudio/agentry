// computeVersion — determinism + sensitivity (pre-proof for AC4/AC5: the tool stamps a content-hash
// the caller never supplies; a body edit yields a different version).
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeVersion } from "../src/domain/version.js";

test("computeVersion is deterministic for the same body+frontmatter", () => {
  const front = { status: "todo", lockedBy: "agentry:implementer" };
  const a = computeVersion("the task body", front);
  const b = computeVersion("the task body", front);
  assert.equal(a, b);
});

test("computeVersion is insensitive to frontmatter key order", () => {
  const a = computeVersion("body", { status: "todo", lockedBy: "x" });
  const b = computeVersion("body", { lockedBy: "x", status: "todo" });
  assert.equal(a, b);
});

test("computeVersion changes when the body changes", () => {
  const front = { status: "todo" };
  const before = computeVersion("original body", front);
  const after = computeVersion("edited body", front);
  assert.notEqual(before, after);
});

test("computeVersion changes when a frontmatter field changes", () => {
  const before = computeVersion("body", { status: "todo" });
  const after = computeVersion("body", { status: "done" });
  assert.notEqual(before, after);
});
