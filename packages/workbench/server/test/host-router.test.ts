// host-router proof (task 009 / task 003) — the `Host`-label PARSE (ADR-002). PURE, so tested as a plain
// function: the happy path (`<label>.localhost` → the leading label), the bare-home cases (no run), and —
// the security floor — that a poisoned label is rejected to null (never an escape past `assertSafeSegment`).
// The parse returns the LABEL (a candidate run id OR a `workSlug`); the label→full-run resolution lives in
// the composition root (http.ts/ws.ts), which holds the run list — see routes.test.ts for that resolution.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHostLabel } from "../src/transport/host-router.js";

test("a <label>.localhost host yields the leading label", () => {
  assert.equal(parseHostLabel("flow-mcp-v1.localhost"), "flow-mcp-v1");
});

test("the :port suffix is stripped before parsing", () => {
  assert.equal(parseHostLabel("flow-mcp-v1.localhost:4317"), "flow-mcp-v1");
});

test("a short workSlug label passes through as the label (resolved downstream)", () => {
  // The parse does not resolve the slug — it only hands the leading label to the composition root.
  assert.equal(parseHostLabel("build-agentry-3kf9zq.localhost:4317"), "build-agentry-3kf9zq");
});

test("bare localhost is the Works home (no run)", () => {
  assert.equal(parseHostLabel("localhost:4317"), null);
});

test("the reserved workbench.localhost is the Works home (no run)", () => {
  assert.equal(parseHostLabel("workbench.localhost:4317"), null);
});

test("a missing Host header yields no run label", () => {
  assert.equal(parseHostLabel(undefined), null);
});

test("an empty Host header yields no run label", () => {
  assert.equal(parseHostLabel(""), null);
});

test("a non-localhost host is not routed (no path/host fallback) — no run", () => {
  assert.equal(parseHostLabel("example.com:4317"), null);
  assert.equal(parseHostLabel("127.0.0.1:4317"), null);
});

test("a poisoned traversal label is rejected to no run (the security floor)", () => {
  // A `..` label and separator-bearing labels must never become a run context — assertSafeSegment guards.
  assert.equal(parseHostLabel("...localhost"), null);
  // A backslash in the leading label (would-be traversal) is rejected.
  assert.equal(parseHostLabel("a\\b.localhost"), null);
});

test("a multi-label subdomain takes the LEADING label", () => {
  // Only the first DNS label is read; deeper labels are not part of the label.
  assert.equal(parseHostLabel("run-7.team.localhost"), "run-7");
});
