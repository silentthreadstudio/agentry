// contract proof (doc 18 slice 3) — parsing the `## Contract` block a planner writes into a task body.
//
// This parser is what makes the two board signals possible, so it is tested against the SHAPES that
// actually appear in this repo's task files, not an idealised one: yaml-shaped prose, unfenced, sitting
// in markdown between other `##` sections, with keys the parser does not care about interleaved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseContract, sharedFiles } from "../src/domain/contract.js";

const REAL = `---
title: "A1 — teeth"
status: done
---

## Goal
Add a hard, ordered FIRST-action block.

## Contract
owns:
  - plugin/commands/go.md
exposes:
  - A command-level "FIRST action" block.
excludes:
  - Do NOT edit \`plugin/skills/conducting/SKILL.md\`.
deps: []
satisfies: [AC1]

Some trailing prose that is not a key.

## Acceptance
- something observable
`;

test("owns is read from the Contract block of a real task file", () => {
  assert.deepEqual(parseContract(REAL).owns, ["plugin/commands/go.md"]);
});

test("owns stops at the next key — it never swallows `exposes`", () => {
  const { owns } = parseContract(REAL);
  assert.equal(owns.length, 1);
  assert.ok(!owns.some((o) => o.includes("FIRST action")));
});

test("an empty inline list parses as empty, not as one blank entry", () => {
  assert.deepEqual(parseContract(REAL).deps, []);
});

test("an inline list is read too — planners write both forms", () => {
  const c = parseContract("## Contract\nowns: [a/b.ts, \"c/d.ts\"]\ndeps: [1, 3]\n");
  assert.deepEqual(c.owns, ["a/b.ts", "c/d.ts"]);
  assert.deepEqual(c.deps, ["1", "3"]);
});

test("a task with no Contract section yields empty lists rather than throwing", () => {
  assert.deepEqual(parseContract("## Goal\njust prose\n"), { owns: [], deps: [] });
});

test("the Contract section ends at the next ## heading", () => {
  const c = parseContract("## Contract\nowns:\n  - a.ts\n\n## Acceptance\nowns:\n  - NOT-a-contract.ts\n");
  assert.deepEqual(c.owns, ["a.ts"]);
});

test("backticked paths are unwrapped — planners quote them in prose", () => {
  assert.deepEqual(parseContract("## Contract\nowns:\n  - `src/a.ts`\n").owns, ["src/a.ts"]);
});

test("sharedFiles is the intersection, deduped", () => {
  assert.deepEqual(sharedFiles(["a.ts", "b.ts", "a.ts"], ["b.ts", "c.ts"]), ["b.ts"]);
});

test("disjoint contracts share nothing — the parallel-safe case the planner promises", () => {
  assert.deepEqual(sharedFiles(["a.ts"], ["b.ts"]), []);
});

test("whitespace differences do not hide an overlap", () => {
  assert.deepEqual(sharedFiles([" a.ts "], ["a.ts"]), ["a.ts"]);
});
