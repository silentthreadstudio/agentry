// Tests for lib/process/shown-path.mjs.
// Run: node --test plugin/scripts/test/shown-path.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { shownPath } from "../lib/process/shown-path.mjs";

test("shownPath: relative inside the root, as given outside it or for the root itself", () => {
  assert.equal(shownPath("/repo", "/repo/docs/a.md"), "docs/a.md");
  assert.equal(shownPath("/repo", "/elsewhere/a.md"), "/elsewhere/a.md");
  assert.equal(shownPath("/repo", "/repo"), "/repo");
});
