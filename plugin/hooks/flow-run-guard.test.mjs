// Tests for hooks/flow-run-guard.mjs — the PostToolUse Flow-run guard (mint-or-flag, teeth #2).
// Dep-free (node builtins only). Drives the real script via a piped stdin JSON, mirroring
// work-id-binder.test.mjs (there is no hook-test harness in-repo). Run: node --test hooks/flow-run-guard.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "flow-run-guard.mjs");

let work; // a fresh temp dir per test, acting as <cwd>
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "flowguard-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

// Run the guard with `payload` on stdin; returns { status, stdout, stderr }.
function run(payload) {
  return spawnSync("node", [SCRIPT], { input: JSON.stringify(payload), encoding: "utf8" });
}

const runDir = (cwd, id) => join(cwd, ".agentry", "work", id);
const eventsPath = (cwd, id) => join(runDir(cwd, id), "events.jsonl");
const seedWorkDir = (cwd, id) => mkdirSync(runDir(cwd, id), { recursive: true });
const gatePath = (cwd, id, ...rest) => join(runDir(cwd, id), ...rest);

// Read the flow-skipped markers (loose `kind` lines, no `type`) from a run's events.jsonl.
function markers(cwd, id) {
  const p = eventsPath(cwd, id);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind === "flow-skipped");
}

test("gate write (spec) + no run ⇒ one flow-skipped marker appended", () => {
  seedWorkDir(work, "feat-x");
  const r = run({ cwd: work, tool_input: { file_path: gatePath(work, "feat-x", "spec.md") } });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  const m = markers(work, "feat-x");
  assert.equal(m.length, 1, "exactly one marker");
  assert.equal(m[0].kind, "flow-skipped");
  assert.equal(m[0].artifact, "spec");
  assert.equal(m[0].path, "feat-x/spec.md");
  assert.match(m[0].ts, /^\d{4}-\d{2}-\d{2}T.*Z$/); // ISO-8601, never a FLOW `type` line
  assert.equal(m[0].type, undefined, "marker must NOT carry a FLOW `type` field");
});

test("gate write (plan) + no run ⇒ marker with artifact=plan", () => {
  seedWorkDir(work, "feat-x");
  const r = run({ cwd: work, tool_input: { file_path: gatePath(work, "feat-x", "plan.md") } });
  assert.equal(r.status, 0);
  const m = markers(work, "feat-x");
  assert.equal(m.length, 1);
  assert.equal(m[0].artifact, "plan");
});

test("gate write (tasks/NNN-*.md) + no run ⇒ marker with artifact=task", () => {
  seedWorkDir(work, "feat-x");
  const r = run({ cwd: work, tool_input: { file_path: gatePath(work, "feat-x", "tasks", "006-b1.md") } });
  assert.equal(r.status, 0);
  const m = markers(work, "feat-x");
  assert.equal(m.length, 1);
  assert.equal(m[0].artifact, "task");
  assert.equal(m[0].path, join("feat-x", "tasks", "006-b1.md"));
});

test("run present via run-state.json ⇒ no marker", () => {
  seedWorkDir(work, "feat-x");
  writeFileSync(join(runDir(work, "feat-x"), "run-state.json"), JSON.stringify({ agents: {} }));
  const r = run({ cwd: work, tool_input: { file_path: gatePath(work, "feat-x", "spec.md") } });
  assert.equal(r.status, 0);
  assert.equal(markers(work, "feat-x").length, 0, "a Flow run owns this work — no flag");
});

test("run present via a FLOW line in events.jsonl ⇒ no marker", () => {
  seedWorkDir(work, "feat-x");
  // A real FLOW line carries `type` (the closed conductor vocabulary).
  writeFileSync(
    eventsPath(work, "feat-x"),
    `${JSON.stringify({ ts: "2026-06-20T00:00:00.000Z", type: "node-enter", node: "spec" })}\n`,
  );
  const r = run({ cwd: work, tool_input: { file_path: gatePath(work, "feat-x", "plan.md") } });
  assert.equal(r.status, 0);
  assert.equal(markers(work, "feat-x").length, 0);
});

test("backstop-only events.jsonl (hook `kind`, no `type`) is NOT a run ⇒ marker appended", () => {
  seedWorkDir(work, "feat-x");
  // A subagent-emit backstop line uses `kind`, no `type` — that alone is not a Flow run.
  writeFileSync(
    eventsPath(work, "feat-x"),
    `${JSON.stringify({ ts: "2026-06-20T00:00:00.000Z", kind: "agent-started", agent: "implementer" })}\n`,
  );
  const r = run({ cwd: work, tool_input: { file_path: gatePath(work, "feat-x", "spec.md") } });
  assert.equal(r.status, 0);
  assert.equal(markers(work, "feat-x").length, 1, "no FLOW line yet → above-floor work is flagged");
});

test("non-gate write under work/ ⇒ no-op (no marker, no events.jsonl created)", () => {
  seedWorkDir(work, "feat-x");
  const r = run({ cwd: work, tool_input: { file_path: gatePath(work, "feat-x", "notes.md") } });
  assert.equal(r.status, 0);
  assert.equal(existsSync(eventsPath(work, "feat-x")), false, "no events.jsonl for a non-gate write");
});

test("a file at the work-id root that isn't spec/plan ⇒ no-op", () => {
  seedWorkDir(work, "feat-x");
  const r = run({ cwd: work, tool_input: { file_path: gatePath(work, "feat-x", "readme.md") } });
  assert.equal(r.status, 0);
  assert.equal(markers(work, "feat-x").length, 0);
});

test("a non-digit-prefixed file under tasks/ ⇒ no-op (not a task gate artifact)", () => {
  seedWorkDir(work, "feat-x");
  const r = run({ cwd: work, tool_input: { file_path: gatePath(work, "feat-x", "tasks", "index.md") } });
  assert.equal(r.status, 0);
  assert.equal(existsSync(eventsPath(work, "feat-x")), false);
});

test("a write OUTSIDE .agentry/work/ (a src file) ⇒ no-op", () => {
  seedWorkDir(work, "feat-x");
  const r = run({ cwd: work, tool_input: { file_path: join(work, "src", "spec.md") } });
  assert.equal(r.status, 0);
  assert.equal(markers(work, "feat-x").length, 0);
});

test("non-Agentry repo (no .agentry/) ⇒ silent, exit 0, nothing written", () => {
  // No seedWorkDir — there is no .agentry tree at all.
  const r = run({ cwd: work, tool_input: { file_path: join(work, ".agentry", "work", "feat-x", "spec.md") } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
  assert.equal(existsSync(join(work, ".agentry")), false);
});

test("traversal-poisoned path (.. escaping work/) ⇒ rejected, no marker", () => {
  seedWorkDir(work, "feat-x");
  // A path that resolves OUTSIDE .agentry/work/ via `..` must be rejected by the relative guard.
  const poisoned = join(work, ".agentry", "work", "..", "..", "etc", "spec.md");
  const r = run({ cwd: work, tool_input: { file_path: poisoned } });
  assert.equal(r.status, 0);
  assert.equal(markers(work, "feat-x").length, 0);
});

test("guard: a write under .agentry/run/ itself does not flag (workId === 'run')", () => {
  seedWorkDir(work, "feat-x");
  const r = run({ cwd: work, tool_input: { file_path: join(work, ".agentry", "run", "spec.md") } });
  assert.equal(r.status, 0);
  assert.equal(existsSync(join(work, ".agentry", "run", "events.jsonl")), false);
});

test("tool_response.file_path fallback path triggers the same marker", () => {
  seedWorkDir(work, "feat-x");
  const r = run({ cwd: work, tool_response: { file_path: gatePath(work, "feat-x", "spec.md") } });
  assert.equal(r.status, 0);
  assert.equal(markers(work, "feat-x").length, 1);
});

test("missing file_path ⇒ no-op, exit 0", () => {
  seedWorkDir(work, "feat-x");
  const r = run({ cwd: work });
  assert.equal(r.status, 0);
  assert.equal(existsSync(eventsPath(work, "feat-x")), false);
});

test("malformed stdin (non-JSON garbage) ⇒ exit 0, no throw", () => {
  const r = spawnSync("node", [SCRIPT], { input: "}{ not json", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
});

test("empty stdin ⇒ exit 0, no throw", () => {
  const r = spawnSync("node", [SCRIPT], { input: "", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
});

test("imports are node: builtins only (dep-free)", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const importFroms = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(importFroms.length > 0, "expected at least one import");
  for (const spec of importFroms) {
    assert.ok(spec.startsWith("node:"), `import "${spec}" must be a node: builtin`);
  }
});
