#!/usr/bin/env node
// Agentry — agent presence, recorded by the harness rather than reported by the model.
//
// THE PROBLEM. The Workbench shows who is working on each run, read from FLOW's roster in
// `.agentry/work/<run>/run-state.json`. That roster is only populated if an agent calls `agent_state`.
// Prose-following is stochastic, so in practice the board said "nobody working" while four agents were
// mid-flight — the display was honest about the file and the file was wrong about the world.
//
// THE FIX is the same one memory priming took: stop describing the behavior and let the harness
// guarantee it. `SubagentStart`/`SubagentStop` fire whatever the model does, so presence is recorded
// there. An agent cannot forget to appear, and cannot forget to leave.
//
// ── The shared-file seam (harden BOTH ends) ────────────────────────────────────────────────────────
// This writes a file FLOW's `AgentService` owns and reads. The shape is pinned by that service and
// mirrored exactly here:
//     { "agents": { "<agent>": { "state": "working"|"blocked"|"done", "assignedTask"?: string,
//                                "since": "<iso8601>" } } }
// Two rules follow, and both are load-bearing:
//   • MERGE, never replace — `assignedTask` is written by the Task family and must survive a presence
//     write, or dispatching an agent would silently unassign its task.
//   • `since` is stamped only when the state CHANGES, because it is the source of the elapsed timer the
//     board shows; restamping on every write would make every agent look like it just started.
//
// Dependency-free (node builtins only) and ALWAYS non-blocking: every path exits 0. Presence is a
// readout; it must never be able to disrupt a subagent.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const agentryDir = join(cwd, ".agentry");
if (!existsSync(agentryDir)) process.exit(0); // non-Agentry repo — silent

// The run this subagent belongs to, from the pointer the work-id-binder writes. Same seam and same
// traversal guard as `subagent-emit` — a poisoned pointer must never escape `.agentry/work/`.
let workId;
try {
  workId = JSON.parse(
    readFileSync(join(agentryDir, "run", "sessions", `${input.session_id}.json`), "utf8"),
  )?.workId;
} catch {
  process.exit(0);
}
if (!workId || workId.includes("..") || workId.includes("/") || workId.includes("\\")) process.exit(0);

// The roster keys by agent name — the dispatched agent type, which is what the UI shows as the role.
const agent = input.agent_type;
if (typeof agent !== "string" || agent.length === 0) process.exit(0);

const state = input.hook_event_name === "SubagentStop" ? "done" : "working";
const now = new Date().toISOString();

try {
  const runDir = join(agentryDir, "work", workId);
  mkdirSync(runDir, { recursive: true });
  const file = join(runDir, "run-state.json");

  // Read-merge-write. A corrupt or absent file starts an empty roster rather than throwing: presence is
  // worth less than the run, and a bad read must not stop the agent.
  let roster = {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && typeof parsed.agents === "object" && parsed.agents !== null) {
      roster = parsed;
    }
  } catch {
    /* absent or unreadable — start fresh */
  }
  const agents = roster.agents ?? {};
  const existing = agents[agent] ?? {};

  agents[agent] = {
    ...existing, // keeps `assignedTask`, which the Task family owns
    state,
    since: existing.state === state && typeof existing.since === "string" ? existing.since : now,
  };
  roster.agents = agents;

  // tmp-then-rename, the same atomicity the pidfile and the session pointer use: a reader sees either
  // the old roster or the complete new one, never a half-written file.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(roster, null, 2)}\n`);
  renameSync(tmp, file);
} catch {
  /* best-effort — never block the subagent */
}

process.exit(0);
