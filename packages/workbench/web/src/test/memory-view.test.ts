// memory-view — the Memory page's pure view-model derived client-side from /api/memory (Task 004). Covers
// toMemRow (the loose-frontmatter → display shape: type fallback, title-from-body, tags/why/provenance,
// numeric confidence/usefulness), metricsFor (the six tiles' counts), and applyFilters (kind segment × type
// chip × origin segment), with the real edges: an episode with no `type`, a record with no body, a
// non-scalar field, the origin/type narrowing, and the "all" pass-throughs.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemReadRecord } from "../api/index.js";
import { applyFilters, metricsFor, toMemRow } from "../routes/memory-view.js";

function rec(over: Partial<MemReadRecord> & { fields: Record<string, unknown> }): MemReadRecord {
  return {
    id: over.id ?? "p:01ABC",
    kind: over.kind ?? "facts",
    origin: over.origin ?? "project",
    fields: over.fields,
  };
}

test("toMemRow maps a fact's loose frontmatter to the display shape", () => {
  const row = toMemRow(
    rec({
      id: "p:01ABC",
      kind: "facts",
      origin: "project",
      fields: {
        type: "gotcha",
        text: "First line is the title. Second sentence is body.",
        tags: ["md", "round-trip"],
        why: "it matters",
        provenance: ["p:01XYZ"],
        confidence: 0.9,
        usefulness: 2,
        createdAt: "2026-06-20T03:01:39.325Z",
      },
    }),
  );
  assert.equal(row.type, "gotcha");
  assert.equal(row.title, "First line is the title.");
  assert.deepEqual(row.tags, ["md", "round-trip"]);
  assert.equal(row.why, "it matters");
  assert.deepEqual(row.provenance, ["p:01XYZ"]);
  assert.equal(row.confidence, 0.9);
  assert.equal(row.usefulness, 2);
  assert.equal(row.createdAt, "2026-06-20"); // sliced to the date
});

test("toMemRow falls back to 'episode' type when the record is an episode with no type field", () => {
  const row = toMemRow(rec({ kind: "episodes", fields: { task: "Build the workbench" } }));
  assert.equal(row.type, "episode");
  assert.equal(row.title, "Build the workbench");
});

test("toMemRow tolerates a missing body and non-array fields", () => {
  const row = toMemRow(rec({ kind: "facts", fields: { type: "decision", tags: "single-tag", why: { x: 1 } } }));
  assert.equal(row.title, "(no title)");
  assert.deepEqual(row.tags, ["single-tag"]); // a lone string coerces to a one-tag list
  assert.equal(row.why, ""); // a non-scalar why (object) is dropped
  assert.equal(row.confidence, undefined); // a missing confidence stays absent
});

test("metricsFor counts total, facts/episodes by kind, and gotcha/repo-fact/decision by type", () => {
  const records: MemReadRecord[] = [
    rec({ kind: "facts", fields: { type: "gotcha", text: "g1" } }),
    rec({ kind: "facts", fields: { type: "gotcha", text: "g2" } }),
    rec({ kind: "facts", fields: { type: "repo-fact", text: "r1" } }),
    rec({ kind: "facts", fields: { type: "decision", text: "d1" } }),
    rec({ kind: "episodes", fields: { task: "e1" } }),
  ];
  const m = Object.fromEntries(metricsFor(records).map((x) => [x.k, x.v]));
  assert.equal(m.Total, 5);
  assert.equal(m.Facts, 4);
  assert.equal(m.Episodes, 1);
  assert.equal(m.Gotchas, 2);
  assert.equal(m["Repo-facts"], 1);
  assert.equal(m.Decisions, 1);
});

test("applyFilters narrows by kind, type, and origin; 'all' passes everything through", () => {
  const rows = [
    rec({ kind: "facts", origin: "project", fields: { type: "gotcha", text: "g" } }),
    rec({ kind: "facts", origin: "global", fields: { type: "decision", text: "d" } }),
    rec({ kind: "episodes", origin: "project", fields: { task: "e" } }),
  ].map(toMemRow);

  assert.equal(applyFilters(rows, "all", "all", "all").length, 3);
  assert.equal(applyFilters(rows, "facts", "all", "all").length, 2);
  assert.equal(applyFilters(rows, "all", "gotcha", "all").length, 1);
  assert.equal(applyFilters(rows, "all", "all", "global").length, 1);
  assert.equal(applyFilters(rows, "facts", "decision", "global").length, 1);
  assert.equal(applyFilters(rows, "episodes", "all", "global").length, 0);
});
