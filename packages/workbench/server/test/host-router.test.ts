// host-router proof (task 009) — the `Host`-label → run-context parse (ADR-002). PURE, so tested as a
// plain function: the happy path (`<id>.localhost` → run), the bare-home cases (no run), and — the
// security floor — that a poisoned label is rejected to no run (never an escape past `assertSafeSegment`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRunContext } from "../src/transport/host-router.js";

test("a <id>.localhost host resolves the leading label as the run id", () => {
  assert.deepEqual(resolveRunContext("flow-mcp-v1.localhost"), { run: "flow-mcp-v1" });
});

test("the :port suffix is stripped before parsing", () => {
  assert.deepEqual(resolveRunContext("flow-mcp-v1.localhost:4317"), { run: "flow-mcp-v1" });
});

test("bare localhost is the Works home (no run)", () => {
  assert.deepEqual(resolveRunContext("localhost:4317"), { run: null });
});

test("the reserved workbench.localhost is the Works home (no run)", () => {
  assert.deepEqual(resolveRunContext("workbench.localhost:4317"), { run: null });
});

test("a missing Host header yields no run context", () => {
  assert.deepEqual(resolveRunContext(undefined), { run: null });
});

test("an empty Host header yields no run context", () => {
  assert.deepEqual(resolveRunContext(""), { run: null });
});

test("a non-localhost host is not routed (no path/host fallback) — no run", () => {
  assert.deepEqual(resolveRunContext("example.com:4317"), { run: null });
  assert.deepEqual(resolveRunContext("127.0.0.1:4317"), { run: null });
});

test("a poisoned traversal label is rejected to no run (the security floor)", () => {
  // A `..` label and separator-bearing labels must never become a run context — assertSafeSegment guards.
  assert.deepEqual(resolveRunContext("...localhost"), { run: null });
  // A backslash in the leading label (would-be traversal) is rejected.
  assert.deepEqual(resolveRunContext("a\\b.localhost"), { run: null });
});

test("a multi-label subdomain takes the LEADING label as the run id", () => {
  // Only the first DNS label is the run id; deeper labels are not part of the id.
  assert.deepEqual(resolveRunContext("run-7.team.localhost"), { run: "run-7" });
});
