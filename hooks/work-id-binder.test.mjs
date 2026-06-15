// Tests for hooks/work-id-binder.mjs — the PostToolUse work-id binder.
// Dep-free (node builtins only). Drives the real script via a piped stdin JSON,
// matching the contract's "spawn node hooks/work-id-binder.mjs with piped stdin"
// approach (there is no hook-test harness in-repo). Run: node --test hooks/work-id-binder.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "work-id-binder.mjs");

let work; // a fresh temp dir per test, acting as <cwd>
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "binder-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

// Run the binder with `payload` on stdin; returns { status, stdout, stderr }.
function run(payload) {
  return spawnSync("node", [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}

const ptrPath = (cwd, sid) => join(cwd, ".agentry", "run", "sessions", `${sid}.json`);
const seedWorkDir = (cwd, id) => mkdirSync(join(cwd, ".agentry", "work", id), { recursive: true });

test("AC5: no .agentry/ in cwd — writes nothing, silent, exit 0", () => {
  const r = run({ cwd: work, session_id: "S1", tool_input: { file_path: join(work, "x.md") } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
  // no .agentry tree created anywhere under cwd
  assert.equal(existsSync(join(work, ".agentry")), false);
});

test("bind happy path: Write under .agentry/work/<id>/ writes the pointer", () => {
  seedWorkDir(work, "feat-x");
  const r = run({
    cwd: work,
    session_id: "S1",
    tool_input: { file_path: join(work, ".agentry", "work", "feat-x", "spec.md") },
  });
  assert.equal(r.status, 0);
  const ptr = ptrPath(work, "S1");
  assert.ok(existsSync(ptr), "pointer file should exist");
  const parsed = JSON.parse(readFileSync(ptr, "utf8"));
  assert.equal(parsed.workId, "feat-x");
  assert.match(parsed.updatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/); // ISO-8601
});

test("tool_response.file_path fallback: pointer still written", () => {
  seedWorkDir(work, "feat-x");
  const r = run({
    cwd: work,
    session_id: "S1",
    // no tool_input.file_path — only the response carries the path
    tool_response: { file_path: join(work, ".agentry", "work", "feat-x", "spec.md") },
  });
  assert.equal(r.status, 0);
  const parsed = JSON.parse(readFileSync(ptrPath(work, "S1"), "utf8"));
  assert.equal(parsed.workId, "feat-x");
});

test("not under work/: a src/ file writes no pointer", () => {
  seedWorkDir(work, "feat-x"); // .agentry exists, but the edited file is elsewhere
  const r = run({
    cwd: work,
    session_id: "S1",
    tool_input: { file_path: join(work, "src", "foo.ts") },
  });
  assert.equal(r.status, 0);
  assert.equal(existsSync(ptrPath(work, "S1")), false);
});

test("guard: a write under .agentry/run/ itself does not bind (workId === 'run')", () => {
  seedWorkDir(work, "feat-x");
  const r = run({
    cwd: work,
    session_id: "S1",
    tool_input: { file_path: join(work, ".agentry", "run", "sessions", "stray.json") },
  });
  assert.equal(r.status, 0);
  assert.equal(existsSync(ptrPath(work, "S1")), false);
});

test("AC6: missing session_id — exit 0, no pointer", () => {
  seedWorkDir(work, "feat-x");
  const r = run({
    cwd: work,
    tool_input: { file_path: join(work, ".agentry", "work", "feat-x", "spec.md") },
  });
  assert.equal(r.status, 0);
  // no sessions dir written at all
  assert.equal(existsSync(join(work, ".agentry", "run", "sessions")), false);
});

test("AC6: malformed stdin (non-JSON garbage) — exit 0, no throw", () => {
  const r = spawnSync("node", [SCRIPT], { input: "}{ not json", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
});

test("AC6: empty stdin — exit 0, no throw", () => {
  const r = spawnSync("node", [SCRIPT], { input: "", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
});

test("AC6: imports are node: builtins only", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const importFroms = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(importFroms.length > 0, "expected at least one import");
  for (const spec of importFroms) {
    assert.ok(spec.startsWith("node:"), `import "${spec}" must be a node: builtin`);
  }
});

test("last-write-wins: a second work folder re-points the session", () => {
  seedWorkDir(work, "feat-a");
  seedWorkDir(work, "feat-b");
  run({
    cwd: work,
    session_id: "S1",
    tool_input: { file_path: join(work, ".agentry", "work", "feat-a", "a.md") },
  });
  run({
    cwd: work,
    session_id: "S1",
    tool_input: { file_path: join(work, ".agentry", "work", "feat-b", "b.md") },
  });
  const parsed = JSON.parse(readFileSync(ptrPath(work, "S1"), "utf8"));
  assert.equal(parsed.workId, "feat-b");
  // exactly one pointer file for the session (not one per work folder)
  assert.equal(readdirSync(join(work, ".agentry", "run", "sessions")).length, 1);
});
