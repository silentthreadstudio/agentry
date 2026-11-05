// Tests for lib/process/glob.mjs's flat name dialect and the worktrees.keep match built on it.
// Run: node --test plugin/scripts/test/glob.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { globMatch, wildcardSource } from "../lib/process/glob.mjs";
import { isKept } from "../lib/process/keep.mjs";

const flat = (pattern, name) => new RegExp(`^${wildcardSource(pattern)}$`).test(name);

test("wildcardSource: * crosses a slash, ? is one character, the rest is literal", () => {
  assert.equal(flat("agentry/*", "agentry/T-1/more"), true);
  assert.equal(flat("wip-?", "wip-a"), true);
  assert.equal(flat("wip-?", "wip-ab"), false);
  assert.equal(flat("a.b", "axb"), false);
  assert.equal(flat("a{1}", "a{1}"), true);
});

test("the path dialect keeps * inside a folder where the name dialect does not", () => {
  assert.equal(globMatch(["agentry/*"], "agentry/T-1/more"), false);
  assert.equal(flat("agentry/*", "agentry/T-1/more"), true);
});

test("isKept matches a worktree's branch or its directory name", () => {
  const spec = { worktrees: { keep: ["agentry/*", "scratch-?"] } };
  assert.equal(isKept(spec, { path: "/x/y", branch: "agentry/T-1" }), true);
  assert.equal(isKept(spec, { path: "/x/scratch-1", branch: null }), true);
  assert.equal(isKept(spec, { path: "/x/other", branch: "main" }), false);
  assert.equal(isKept({}, { path: "/x/y", branch: "main" }), false);
});
