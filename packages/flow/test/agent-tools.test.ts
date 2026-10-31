// Agent family proof (AC1 — agent/assignee live-state dimension). Drives the REAL adapters via a
// capture-server stub, over the REAL JsonRunStateStore on a tmpdir, so the assertions are on observed
// behavior through the public surface: agent_state(working) → agent_roster reflects it; the roster
// round-trips through the run-state json; an out-of-enum state is rejected and NOTHING is written;
// 'blocked' is accepted as an AGENT state (ADR-004). FLOW records state — it does not dispatch.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type FlowServices, createServices } from "../src/index.js";
import { registerAgentTools } from "../src/tools/agent-tools.js";

const RUN = "agents-run-001";
const AGENT = "agentry:implementer";

// A minimal capture-server: records each registered tool's handler so a test can invoke it directly.
// We assert on the tool's MCP envelope (the public surface), not on any internal.
function captureServer() {
  const handlers = new Map<
    string,
    (args: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>
  >();
  const server = {
    registerTool(name: string, _schema: unknown, handler: (args: unknown) => Promise<never>) {
      handlers.set(name, handler as never);
    },
  };
  return { server, handlers };
}

// Decode a tool result's single text-content payload back to a structured object.
function payload(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text);
}

let cwd: string;
let ctx: FlowServices;
let call: (
  name: string,
  args: unknown,
) => Promise<{ isError?: boolean; content: { text: string }[] }>;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "flow-agents-"));
  ctx = createServices(cwd);
  const { server, handlers } = captureServer();
  registerAgentTools(server as never, ctx);
  call = (name, args) => handlers.get(name)!(args);
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// The roster carries a `since` stamp (the Workbench's elapsed timer reads it), so assertions check the
// meaningful fields rather than deep-equalling the whole entry — an additive field must not read as a
// regression.
function assertRoster(actual: unknown, expected: { agent: string; state: string }[]): void {
  const agents = (actual as { agents: { agent: string; state: string; since?: string }[] }).agents;
  assert.deepEqual(
    agents.map((a) => ({ agent: a.agent, state: a.state })),
    expected,
  );
  for (const a of agents) {
    assert.equal(typeof a.since, "string", "every roster entry records when it entered its state");
  }
}

test("registerAgentTools registers the two family tools", () => {
  const { server, handlers } = captureServer();
  registerAgentTools(server as never, ctx);
  assert.deepEqual([...handlers.keys()].sort(), ["agent_roster", "agent_state"]);
});

test("agent_state(working) then agent_roster reflects it (AC1)", async () => {
  const set = await call("agent_state", { run: RUN, agent: AGENT, state: "working" });
  assert.equal(set.isError, undefined);
  assert.deepEqual(payload(set), { agent: AGENT, state: "working" });

  const roster = await call("agent_roster", { run: RUN });
  assertRoster(payload(roster), [{ agent: AGENT, state: "working" }]);
});

test("the roster round-trips through the run-state json (a fresh service re-reads it)", async () => {
  await call("agent_state", { run: RUN, agent: AGENT, state: "working" });

  // Read the live run-state json straight off disk — the recorded state is persisted there.
  const onDisk = JSON.parse(
    readFileSync(join(cwd, ".agentry", "work", RUN, "run-state.json"), "utf8"),
  );
  assert.equal(onDisk.agents[AGENT].state, "working");

  // A brand-new services/tools instance (server killed) re-reads the same roster (AC6-style durability).
  const fresh = createServices(cwd);
  const { server, handlers } = captureServer();
  registerAgentTools(server as never, fresh);
  const roster = await handlers.get("agent_roster")!({ run: RUN });
  assertRoster(payload(roster), [{ agent: AGENT, state: "working" }]);
});

test("a re-recorded state overwrites in place (one roster entry per agent)", async () => {
  await call("agent_state", { run: RUN, agent: AGENT, state: "working" });
  await call("agent_state", { run: RUN, agent: AGENT, state: "done" });

  const roster = await call("agent_roster", { run: RUN });
  assertRoster(payload(roster), [{ agent: AGENT, state: "done" }]);
});

test("'blocked' is accepted as an AGENT state, not a task status (ADR-004)", async () => {
  const set = await call("agent_state", { run: RUN, agent: AGENT, state: "blocked" });
  assert.equal(set.isError, undefined);
  assert.deepEqual(payload(set), { agent: AGENT, state: "blocked" });

  const roster = await call("agent_roster", { run: RUN });
  assertRoster(payload(roster), [{ agent: AGENT, state: "blocked" }]);
});

test("an out-of-enum state is rejected and NOTHING is written", async () => {
  // The zod inputSchema validates `state` against the AgentState enum at the service; call the service
  // path directly with the bad value (the SDK would also reject it at the schema boundary).
  const set = await call("agent_state", { run: RUN, agent: AGENT, state: "in-progress" });
  assert.equal(set.isError, true);
  assert.equal(payload(set).error && (payload(set).error as { code: string }).code, "bad-input");

  // No run-state file was written — the rejection precedes any store touch.
  assert.equal(existsSync(join(cwd, ".agentry", "work", RUN, "run-state.json")), false);
  // And the roster is empty.
  const roster = await call("agent_roster", { run: RUN });
  assert.deepEqual(payload(roster), { agents: [] });
});

test("agent_roster on a run with no recorded agents is an empty roster, not an error", async () => {
  const roster = await call("agent_roster", { run: "untouched-run" });
  assert.equal(roster.isError, undefined);
  assert.deepEqual(payload(roster), { agents: [] });
});

test("a blank agent id is rejected (bad-input) and nothing is written", async () => {
  const set = await call("agent_state", { run: RUN, agent: "  ", state: "working" });
  assert.equal(set.isError, true);
  assert.equal((payload(set).error as { code: string }).code, "bad-input");
  assert.equal(existsSync(join(cwd, ".agentry", "work", RUN, "run-state.json")), false);
});

// ── the elapsed-timer source ───────────────────────────────────────────────────────────────────────
test("re-recording the SAME state does not reset `since` — the clock is not restarted by chatter", async () => {
  await call("agent_state", { run: RUN, agent: AGENT, state: "working" });
  const first = (
    payload(await call("agent_roster", { run: RUN })) as { agents: { since: string }[] }
  ).agents[0]?.since;

  await new Promise((r) => setTimeout(r, 5));
  await call("agent_state", { run: RUN, agent: AGENT, state: "working" });
  const second = (
    payload(await call("agent_roster", { run: RUN })) as { agents: { since: string }[] }
  ).agents[0]?.since;

  assert.equal(second, first, "same state ⇒ same start time, so 'working for 4m' stays true");
});

test("a CHANGE of state restamps `since` — the timer measures the current state, not the agent", async () => {
  await call("agent_state", { run: RUN, agent: AGENT, state: "working" });
  const working = (
    payload(await call("agent_roster", { run: RUN })) as { agents: { since: string }[] }
  ).agents[0]?.since;

  await new Promise((r) => setTimeout(r, 5));
  await call("agent_state", { run: RUN, agent: AGENT, state: "done" });
  const done = (
    payload(await call("agent_roster", { run: RUN })) as { agents: { since: string }[] }
  ).agents[0]?.since;

  assert.notEqual(done, working);
});
