// Tests for `seedSandbox` (io/sandbox.ts) — the recursive copy that plants a realistic starting codebase
// into a prepared working dir BEFORE a run. Pure fs, ZERO API spend: it builds a nested fixture tree in a
// temp dir, seeds a fresh temp working dir from it, and asserts every file landed with its content intact.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { seedSandbox } from "../src/io/sandbox.ts";

/** Build a small nested seed tree on disk and return its root. */
function makeSeedTree(): string {
  const root = mkdtempSync(join(tmpdir(), "selfeval-seed-src-"));
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  writeFileSync(join(root, "package.json"), `{"name":"seed"}`, "utf8");
  writeFileSync(join(root, "src", "index.js"), "export const x = 1;\n", "utf8");
  writeFileSync(join(root, "src", "nested", "deep.js"), "export const y = 2;\n", "utf8");
  return root;
}

test("seedSandbox copies a nested fixture tree into the working dir with content intact", () => {
  const seedDir = makeSeedTree();
  const workingDir = mkdtempSync(join(tmpdir(), "selfeval-seed-work-"));

  seedSandbox(workingDir, seedDir);

  assert.equal(readFileSync(join(workingDir, "package.json"), "utf8"), `{"name":"seed"}`);
  assert.equal(readFileSync(join(workingDir, "src", "index.js"), "utf8"), "export const x = 1;\n");
  assert.equal(readFileSync(join(workingDir, "src", "nested", "deep.js"), "utf8"), "export const y = 2;\n");
});
