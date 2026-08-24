// Tests for hooks/agent-presence.mjs — presence recorded by the harness, not reported by the model.
// Dep-free (node builtins only), mirroring hooks/subagent-emit.test.mjs: drives the real script via
// piped stdin JSON against a temp project root.
// Run: node --test hooks/agent-presence.test.mjs
//
// What matters here is the SHARED-FILE SEAM. This hook writes a file FLOW's AgentService owns, so the
// shape is pinned by that service and these tests exist to stop it drifting — in particular that a
// presence write MERGES (an assignment written by the Task family must survive) and that `since` is
// only restamped on a real state change, because it is the elapsed timer's only source.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "agent-presence.mjs");
const SESSION = "sess-1";
const RUN = "r-1";
let root;

function run(input) {
  const res = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(res.status, 0, "the hook must always exit 0 — presence may never disrupt a subagent");
  return res;
}

const fire = (event, agent = "agentry:implementer", session = SESSION) =>
  run({ hook_event_name: event, cwd: root, session_id: session, agent_type: agent });

const roster = () => {
  const file = join(root, ".agentry", "work", RUN, "run-state.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentry-presence-"));
  mkdirSync(join(root, ".agentry", "run", "sessions"), { recursive: true });
  writeFileSync(
    join(root, ".agentry", "run", "sessions", `${SESSION}.json`),
    JSON.stringify({ workId: RUN, updatedAt: new Date().toISOString() }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("SubagentStart records the agent as working, with a start time", () => {
  fire("SubagentStart");
  const entry = roster()?.agents["agentry:implementer"];
  assert.equal(entry?.state, "working");
  assert.equal(typeof entry?.since, "string");
});

test("SubagentStop marks it done — an agent cannot forget to LEAVE either", () => {
  fire("SubagentStart");
  fire("SubagentStop");
  assert.equal(roster()?.agents["agentry:implementer"].state, "done");
});

test("a presence write MERGES — an assignment written by the Task family survives it", () => {
  mkdirSync(join(root, ".agentry", "work", RUN), { recursive: true });
  writeFileSync(
    join(root, ".agentry", "work", RUN, "run-state.json"),
    JSON.stringify({ agents: { "agentry:implementer": { state: "working", assignedTask: "004" } } }),
  );

  fire("SubagentStop");
  const entry = roster()?.agents["agentry:implementer"];
  assert.equal(entry.assignedTask, "004", "dispatching must never silently unassign the task");
  assert.equal(entry.state, "done");
});

test("re-firing the SAME state does not restamp `since` — the elapsed timer is not reset by chatter", () => {
  fire("SubagentStart");
  const first = roster()?.agents["agentry:implementer"].since;
  fire("SubagentStart");
  assert.equal(roster()?.agents["agentry:implementer"].since, first);
});

test("a state CHANGE restamps `since` — the timer measures the current state", () => {
  fire("SubagentStart");
  const working = roster()?.agents["agentry:implementer"].since;
  fire("SubagentStop");
  assert.notEqual(roster()?.agents["agentry:implementer"].since, working);
});

test("two agents on one run coexist rather than overwriting each other", () => {
  fire("SubagentStart", "agentry:implementer");
  fire("SubagentStart", "agentry:verifier");
  assert.deepEqual(Object.keys(roster()?.agents ?? {}).sort(), ["agentry:implementer", "agentry:verifier"]);
});

test("other agents' entries survive one agent's write", () => {
  fire("SubagentStart", "agentry:implementer");
  fire("SubagentStart", "agentry:verifier");
  fire("SubagentStop", "agentry:verifier");
  assert.equal(roster()?.agents["agentry:implementer"].state, "working");
});

test("no session pointer ⇒ nothing written, silently (a one-shot has no run)", () => {
  fire("SubagentStart", "agentry:implementer", "unknown-session");
  assert.equal(roster(), undefined);
});

test("a poisoned pointer can never escape .agentry/work/", () => {
  writeFileSync(
    join(root, ".agentry", "run", "sessions", `${SESSION}.json`),
    JSON.stringify({ workId: "../../../etc" }),
  );
  fire("SubagentStart");
  assert.equal(existsSync(join(root, ".agentry", "work")), false);
});

test("a non-Agentry repo, a missing agent type, and a corrupt roster are all survived", () => {
  const bare = mkdtempSync(join(tmpdir(), "agentry-bare-"));
  run({ hook_event_name: "SubagentStart", cwd: bare, session_id: SESSION, agent_type: "x" });
  rmSync(bare, { recursive: true, force: true });

  run({ hook_event_name: "SubagentStart", cwd: root, session_id: SESSION }); // no agent_type
  assert.equal(roster(), undefined);

  mkdirSync(join(root, ".agentry", "work", RUN), { recursive: true });
  writeFileSync(join(root, ".agentry", "work", RUN, "run-state.json"), "{ not json");
  fire("SubagentStart");
  assert.equal(roster()?.agents["agentry:implementer"].state, "working", "a corrupt roster starts fresh");
});
