// Tests for the Phase-4 secondary pages' PURE view-model helpers (the exported, React-free functions each
// route file factors its rendering logic into). We test the data→view mapping — the behavior the pages
// promise — not the JSX (the repo's web tests are logic tests; there is no component-render harness, and a
// view-model bug is where the real regressions live: a mislabeled event, a wrong jump URL, a bad chart Y).
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentView, EventView, TokenSeries } from "@agentry/workbench-shared";
import { clockOf, dayLabel, formatDuration, groupByDay, toRow } from "../routes/work/Activity.js";
import { rollUp } from "../routes/Agents.js";
import { gateHref, toGateRow } from "../routes/Gates.js";
import { chartGeometry, formatTokens } from "../routes/Tokens.js";
import { toMemRow } from "../routes/Memory.js";
import type { OpenGateItem, MemReadRecord } from "../api/client.js";

// ── Activity ─────────────────────────────────────────────────────────────────────────────────────────
const ev = (id: string, event: EventView["event"]): EventView => ({ id, event });

test("toRow labels each FlowEvent type with its headline + detail", () => {
  assert.deepEqual(
    toRow(ev("1", { ts: "2026-06-19T20:24:00Z", type: "routing-decision", shape: "decompose+verify", kind: "feature" })),
    { id: "1", ts: "2026-06-19T20:24:00Z", clock: clockOf("2026-06-19T20:24:00Z"), glyph: "◆", headline: "routing-decision", detail: "decompose+verify · feature" },
  );
  const gate = toRow(ev("2", { ts: "2026-06-19T20:24:00Z", type: "gate", gate: "spec", outcome: "approved" }));
  assert.equal(gate.headline, "gate · spec");
  assert.equal(gate.detail, "approved");

  const enter = toRow(ev("3", { ts: "2026-06-19T20:25:00Z", type: "node-enter", node: "T03", agent: "implementer" }));
  assert.equal(enter.headline, "node-enter · T03");
  assert.equal(enter.detail, "dispatched implementer");
});

test("toRow renders a node-done's duration as 'spent <human>'", () => {
  assert.equal(toRow(ev("4", { ts: "2026-06-19T20:30:00Z", type: "node-done", node: "T03", durationMs: 3400 })).detail, "spent 3.4s");
});

test("formatDuration scales ms / s / m and rejects bad input", () => {
  assert.equal(formatDuration(420), "420ms");
  assert.equal(formatDuration(3400), "3.4s");
  assert.equal(formatDuration(125_000), "2m 05s");
  assert.equal(formatDuration(-1), "");
});

test("clockOf returns HH:MM and '' for an unparseable timestamp", () => {
  assert.match(clockOf("2026-06-19T07:05:00"), /^\d{2}:\d{2}$/);
  assert.equal(clockOf("not-a-date"), "");
});

test("dayLabel buckets Today / Yesterday / a date", () => {
  const now = new Date("2026-06-19T12:00:00");
  assert.equal(dayLabel("2026-06-19T09:00:00", now), "Today");
  assert.equal(dayLabel("2026-06-18T23:00:00", now), "Yesterday");
  assert.equal(dayLabel("2026-06-10T09:00:00", now), "Jun 10");
});

test("groupByDay keeps contiguous same-day rows in one ordered bucket", () => {
  const now = new Date("2026-06-19T12:00:00");
  const rows = [
    toRow(ev("a", { ts: "2026-06-19T09:00:00", type: "gate", gate: "spec", outcome: "reached" })),
    toRow(ev("b", { ts: "2026-06-19T10:00:00", type: "gate", gate: "plan", outcome: "reached" })),
    toRow(ev("c", { ts: "2026-06-18T10:00:00", type: "gate", gate: "ship", outcome: "reached" })),
  ];
  const groups = groupByDay(rows, now);
  assert.deepEqual(groups.map((g) => g.day), ["Today", "Yesterday"]);
  assert.equal(groups[0]!.rows.length, 2);
});

// ── Agents ───────────────────────────────────────────────────────────────────────────────────────────
const agent = (run: string, role: string, state: AgentView["state"], task: string | null = null): AgentView => ({
  id: `${run}/${role}`,
  role,
  state,
  task,
});

test("rollUp folds a role across runs into one card with distinct runs-touched", () => {
  const cards = rollUp([
    agent("r1", "implementer", "done", "T01"),
    agent("r2", "implementer", "working", "T03"),
    agent("r1", "architect", "done"),
  ]);
  const impl = cards.find((c) => c.role === "implementer")!;
  assert.equal(impl.runsTouched, 2);
  // most-live state wins (working beats done), and its task surfaces as the recent line.
  assert.equal(impl.state, "working");
  assert.equal(impl.recent, "T03");
});

test("rollUp sorts the bottleneck (blocked) first", () => {
  const cards = rollUp([agent("r1", "a", "done"), agent("r1", "b", "blocked"), agent("r1", "c", "working")]);
  assert.deepEqual(cards.map((c) => c.role), ["b", "c", "a"]);
});

test("rollUp on an empty roster yields no cards", () => {
  assert.deepEqual(rollUp([]), []);
});

// ── Gates ────────────────────────────────────────────────────────────────────────────────────────────
const LOC = { protocol: "http:", hostname: "localhost", port: "4317" };

test("gateHref deep-links to the run's work host with the doc encoded", () => {
  assert.equal(gateHref({ run: "flow-mcp-v1", docId: "plan" }, LOC), "http://flow-mcp-v1.localhost:4317/?doc=plan");
});

test("gateHref strips an existing run subdomain so it always targets <run>.localhost", () => {
  assert.equal(
    gateHref({ run: "other", docId: "spec" }, { protocol: "http:", hostname: "current.localhost", port: "4317" }),
    "http://other.localhost:4317/?doc=spec",
  );
});

test("toGateRow summarizes the open comments with a preview", () => {
  const item: OpenGateItem = {
    run: "flow-mcp-v1",
    gate: "plan",
    docId: "plan",
    decision: null,
    comments: [
      { id: "c1", anchor: { originalText: "x", headingAnchor: "h", startLine: 1 }, decision: "changes", body: "Confirm the enum.", resolved: false },
    ],
  };
  const row = toGateRow(item, LOC);
  assert.equal(row.headline, "plan gate · flow-mcp-v1");
  assert.equal(row.detail, "1 comment awaiting — “Confirm the enum.”");
  assert.equal(row.href, "http://flow-mcp-v1.localhost:4317/?doc=plan");
});

// ── Tokens ───────────────────────────────────────────────────────────────────────────────────────────
test("chartGeometry returns null for an empty series (the degraded state)", () => {
  assert.equal(chartGeometry({ timestamps: [], tokens: [] }, 100, 50), null);
});

test("chartGeometry scales Y to the series max (peak at the top padding, zero at the baseline)", () => {
  const series: TokenSeries = { timestamps: ["a", "b", "c"], tokens: [0, 50, 100] };
  const geo = chartGeometry(series, 120, 100, 10)!;
  assert.equal(geo.max, 100);
  assert.equal(geo.points.length, 3);
  // zero sits on the baseline (h - pad = 90); the max sits at the top padding (10).
  assert.equal(geo.points[0]!.y, 90);
  assert.equal(geo.points[2]!.y, 10);
  // x spans the inner width end to end.
  assert.equal(geo.points[0]!.x, 10);
  assert.equal(geo.points[2]!.x, 110);
});

test("chartGeometry centers a single sample", () => {
  const geo = chartGeometry({ timestamps: ["a"], tokens: [42] }, 120, 100, 10)!;
  assert.equal(geo.points[0]!.x, 60);
});

test("formatTokens renders M / k / raw", () => {
  assert.equal(formatTokens(1_460_000), "1.46M");
  assert.equal(formatTokens(42_000), "42.0k");
  assert.equal(formatTokens(980), "980");
});

// ── Memory ───────────────────────────────────────────────────────────────────────────────────────────
test("toMemRow surfaces a fact's text body, kind, origin, and provenance", () => {
  const rec: MemReadRecord = {
    id: "01ABC",
    kind: "facts",
    origin: "project",
    fields: { text: "  Dist-lockstep is content-hash based.  ", source: "35d893a" },
  };
  assert.deepEqual(toMemRow(rec), {
    id: "01ABC",
    kind: "fact",
    origin: "project",
    body: "Dist-lockstep is content-hash based.",
    provenance: "01ABC · 35d893a",
  });
});

test("toMemRow reads an episode's body from the `task` field and falls back when no body", () => {
  assert.equal(toMemRow({ id: "x", kind: "episodes", origin: "global", fields: { task: "Built FLOW MCP." } }).body, "Built FLOW MCP.");
  assert.equal(toMemRow({ id: "y", kind: "facts", origin: "global", fields: {} }).body, "(no body)");
});
