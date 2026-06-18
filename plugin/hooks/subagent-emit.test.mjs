// Tests for hooks/subagent-emit.mjs — the Subagent* event emitter (READ side of the seam).
// Dep-free (node builtins only), mirroring hooks/work-id-binder.test.mjs: drives the real
// script via piped stdin JSON (there is no hook-test harness in-repo).
// Run: node --test hooks/subagent-emit.test.mjs
//
// AC3's "validates against @agentry/core WorkEvent" has two layers:
//   - here, dep-free: assert the produced line parses to one object with exactly the
//     WorkEvent shape (keys + types) the contract pins;
//   - separately (see the task journal), the same line is fed to the real source schema
//     `WorkEvent.parse(line)` via tsx from packages/core, where zod resolves.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "subagent-emit.mjs");

let work; // a fresh temp dir per test, acting as <cwd> — always OUTSIDE the repo's real .agentry
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "emit-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

// Run the emitter with `payload` on stdin; returns { status, stdout, stderr }.
function run(payload) {
  return spawnSync("node", [SCRIPT], { input: JSON.stringify(payload), encoding: "utf8" });
}

const eventsPath = (cwd, id) => join(cwd, ".agentry", "work", id, "events.jsonl");
const seedWorkDir = (cwd, id) => mkdirSync(join(cwd, ".agentry", "work", id), { recursive: true });
const primePointer = (cwd, sid, workId) => {
  const dir = join(cwd, ".agentry", "run", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.json`), JSON.stringify({ workId, updatedAt: new Date().toISOString() }));
};

// Read all JSONL lines (non-empty) of a work folder's events.jsonl.
const readLines = (cwd, id) =>
  readFileSync(eventsPath(cwd, id), "utf8").split("\n").filter((l) => l.length > 0);

// The WorkEvent shape T-001 pins (keys + types). Asserts the line IS a valid WorkEvent
// without importing zod into this dep-free suite (AC3 "at minimum assert the keys").
function assertIsWorkEvent(obj) {
  const allowed = new Set(["ts", "kind", "agent", "agentId", "session", "detail"]);
  for (const k of Object.keys(obj)) assert.ok(allowed.has(k), `unexpected WorkEvent key "${k}"`);
  assert.equal(typeof obj.ts, "string");
  assert.match(obj.ts, /^\d{4}-\d{2}-\d{2}T.*Z$/); // ISO-8601
  assert.equal(typeof obj.kind, "string");
  for (const k of ["agent", "agentId", "session", "detail"]) {
    if (obj[k] !== undefined) assert.equal(typeof obj[k], "string", `${k} must be string when present`);
  }
}

test("AC3: SubagentStart appends exactly one valid WorkEvent line", () => {
  seedWorkDir(work, "feat-x");
  primePointer(work, "S1", "feat-x");
  const r = run({
    hook_event_name: "SubagentStart",
    agent_type: "architect",
    agent_id: "A1",
    session_id: "S1",
    cwd: work,
  });
  assert.equal(r.status, 0);
  const lines = readLines(work, "feat-x");
  assert.equal(lines.length, 1, "exactly one line");
  const ev = JSON.parse(lines[0]); // one object per line — no concatenation
  assertIsWorkEvent(ev);
  assert.equal(ev.kind, "agent-started");
  assert.equal(ev.agent, "architect");
  assert.equal(ev.agentId, "A1");
  assert.equal(ev.session, "S1");
});

test("kind mapping + AC2 carry: SubagentStop → agent-done with the same agentId", () => {
  seedWorkDir(work, "feat-x");
  primePointer(work, "S1", "feat-x");
  const r = run({
    hook_event_name: "SubagentStop",
    agent_type: "architect",
    agent_id: "A1",
    session_id: "S1",
    cwd: work,
  });
  assert.equal(r.status, 0);
  const ev = JSON.parse(readLines(work, "feat-x")[0]);
  assert.equal(ev.kind, "agent-done");
  assert.equal(ev.agentId, "A1");
});

test("AC2: a start then a stop share the same agentId, in order, one line each", () => {
  seedWorkDir(work, "feat-x");
  primePointer(work, "S1", "feat-x");
  const base = { agent_type: "architect", agent_id: "A1", session_id: "S1", cwd: work };
  run({ ...base, hook_event_name: "SubagentStart" });
  run({ ...base, hook_event_name: "SubagentStop" });
  const lines = readLines(work, "feat-x").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, "agent-started");
  assert.equal(lines[1].kind, "agent-done");
  assert.equal(lines[0].agentId, lines[1].agentId); // correlate start ↔ stop
  assert.equal(lines[0].agentId, "A1");
});

test("AC4: no agent_type allowlist — a third-party type is still logged", () => {
  seedWorkDir(work, "feat-x");
  primePointer(work, "S1", "feat-x");
  run({
    hook_event_name: "SubagentStart",
    agent_type: "some-third-party-agent",
    agent_id: "A9",
    session_id: "S1",
    cwd: work,
  });
  const ev = JSON.parse(readLines(work, "feat-x")[0]);
  assert.equal(ev.agent, "some-third-party-agent");
});

test("undefined fields are omitted cleanly — no agent/agentId/session keys when absent", () => {
  seedWorkDir(work, "feat-x");
  primePointer(work, "S1", "feat-x");
  // session_id is needed to find the pointer; agent_type & agent_id omitted.
  run({ hook_event_name: "SubagentStart", session_id: "S1", cwd: work });
  const raw = readLines(work, "feat-x")[0];
  assert.ok(!raw.includes("undefined"), "no literal undefined in the line");
  const ev = JSON.parse(raw);
  assert.ok(!("agent" in ev), "agent key omitted when agent_type absent");
  assert.ok(!("agentId" in ev), "agentId key omitted when agent_id absent");
  assert.deepEqual(Object.keys(ev).sort(), ["kind", "session", "ts"]);
});

test("AC5: no .agentry/ in cwd — writes nothing, silent, exit 0", () => {
  const r = run({ hook_event_name: "SubagentStart", agent_type: "x", agent_id: "A1", session_id: "S1", cwd: work });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
  assert.equal(existsSync(join(work, ".agentry")), false);
});

test("AC6: missing pointer (no sessions/S1.json) — exit 0, no events file written", () => {
  seedWorkDir(work, "feat-x"); // .agentry exists, but no pointer was primed
  const r = run({ hook_event_name: "SubagentStart", agent_type: "x", agent_id: "A1", session_id: "S1", cwd: work });
  assert.equal(r.status, 0);
  assert.equal(existsSync(eventsPath(work, "feat-x")), false);
});

test("AC6: pointer present but unparseable — exit 0, no events file written", () => {
  seedWorkDir(work, "feat-x");
  const dir = join(work, ".agentry", "run", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "S1.json"), "}{ not json");
  const r = run({ hook_event_name: "SubagentStart", agent_type: "x", agent_id: "A1", session_id: "S1", cwd: work });
  assert.equal(r.status, 0);
  assert.equal(existsSync(eventsPath(work, "feat-x")), false);
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
