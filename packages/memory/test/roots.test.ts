// resolveRoots env-override resolution (ADR-002 Fork C). Asserts the public behavior:
// the global root is overridable via AGENTRY_GLOBAL_DIR (a base dir; .agentry/memory appended),
// symmetric with the existing project override, and absent => homedir()-based default unchanged.
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveRoots } from "../src/resolution/roots.js";

test("default: global root is homedir()-based and project is null (backward-compat)", () => {
  const roots = resolveRoots({});
  assert.equal(roots.global, join(homedir(), ".agentry", "memory"));
  assert.equal(roots.project, null);
});

test("AGENTRY_GLOBAL_DIR set: global relocates under <dir>/.agentry/memory", () => {
  const roots = resolveRoots({ AGENTRY_GLOBAL_DIR: "/tmp/x" });
  assert.equal(roots.global, join("/tmp/x", ".agentry", "memory"));
  assert.notEqual(roots.global, join(homedir(), ".agentry", "memory"));
  assert.equal(roots.project, null);
});

test("project override still honored: CLAUDE_PROJECT_DIR -> <dir>/.agentry/memory, global default", () => {
  const roots = resolveRoots({ CLAUDE_PROJECT_DIR: "/tmp/proj" });
  assert.equal(roots.project, join("/tmp/proj", ".agentry", "memory"));
  assert.equal(roots.global, join(homedir(), ".agentry", "memory"));
});

test("both set: each root resolves under its own base dir, independently", () => {
  const roots = resolveRoots({ AGENTRY_GLOBAL_DIR: "/tmp/g", CLAUDE_PROJECT_DIR: "/tmp/proj" });
  assert.equal(roots.global, join("/tmp/g", ".agentry", "memory"));
  assert.equal(roots.project, join("/tmp/proj", ".agentry", "memory"));
});
