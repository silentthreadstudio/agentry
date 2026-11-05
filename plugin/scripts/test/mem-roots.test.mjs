// resolveRoots env-override resolution: the global root is overridable via AGENTRY_GLOBAL_DIR (a base dir;
// .agentry/memory appended), symmetric with the project override, and absent => the home-directory default.
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dirFor, originForScope, resolveRoots } from "../lib/memory/resolution/roots.mjs";

test("default: global root is homedir()-based and project is null", () => {
  const roots = resolveRoots({});
  assert.equal(roots.global, join(homedir(), ".agentry", "memory"));
  assert.equal(roots.project, null);
});

test("AGENTRY_GLOBAL_DIR set: global relocates under <dir>/.agentry/memory", () => {
  const roots = resolveRoots({ AGENTRY_GLOBAL_DIR: "/tmp/x" });
  assert.equal(roots.global, join("/tmp/x", ".agentry", "memory"));
  assert.equal(roots.project, null);
});

test("CLAUDE_PROJECT_DIR -> <dir>/.agentry/memory, global default", () => {
  const roots = resolveRoots({ CLAUDE_PROJECT_DIR: "/tmp/proj" });
  assert.equal(roots.project, join("/tmp/proj", ".agentry", "memory"));
  assert.equal(roots.global, join(homedir(), ".agentry", "memory"));
});

test("AGENTRY_PROJECT_DIR is the project dir when CLAUDE_PROJECT_DIR is not set, and loses to it", () => {
  assert.equal(
    resolveRoots({ AGENTRY_PROJECT_DIR: "/tmp/a" }).project,
    join("/tmp/a", ".agentry", "memory"),
  );
  assert.equal(
    resolveRoots({ CLAUDE_PROJECT_DIR: "/tmp/c", AGENTRY_PROJECT_DIR: "/tmp/a" }).project,
    join("/tmp/c", ".agentry", "memory"),
  );
});

test("both set: each root resolves under its own base dir, independently", () => {
  const roots = resolveRoots({ AGENTRY_GLOBAL_DIR: "/tmp/g", CLAUDE_PROJECT_DIR: "/tmp/proj" });
  assert.equal(roots.global, join("/tmp/g", ".agentry", "memory"));
  assert.equal(roots.project, join("/tmp/proj", ".agentry", "memory"));
});

test("a repo scope goes to the project root when there is one; everything else is global", () => {
  const withProject = { global: "/g", project: "/p" };
  assert.equal(originForScope("repo", withProject), "p");
  assert.equal(originForScope("user", withProject), "g");
  assert.equal(originForScope("global", withProject), "g");
  assert.equal(originForScope("repo", { global: "/g", project: null }), "g");
  assert.equal(dirFor("p", withProject), "/p");
  assert.equal(dirFor("p", { global: "/g", project: null }), "/g");
});
