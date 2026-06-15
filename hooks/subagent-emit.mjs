#!/usr/bin/env node
// Agentry — Subagent* event emitter (the READ side of the pointer seam).
// Dependency-free (node builtins only). Invoked for BOTH SubagentStart and
// SubagentStop (the kind is read from hook_event_name). Resolves this session's
// work-id from the pointer the binder wrote, builds a WorkEvent, and appends one
// JSONL line to .agentry/work/<id>/events.jsonl. Unresolved work-id → silent skip
// (the documented best-effort fallback; never guess a folder — ADR-001).
// Best-effort and ALWAYS non-blocking: every path exits 0 (we must never disrupt
// the subagent — AC6).
//
// Seam (pinned — the binder writes exactly this):
//   path:  <cwd>/.agentry/run/sessions/<session_id>.json   (one file per session)
//   shape: { "workId": "<id>", "updatedAt": "<iso8601>" }   (last-write-wins)

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0); // no/bad stdin — emit nothing (AC6)
}

const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const agentryDir = join(cwd, ".agentry");
if (!existsSync(agentryDir)) process.exit(0); // non-Agentry repo — silent (AC5)

const sid = input.session_id;
let ptr = null;
try {
  ptr = JSON.parse(readFileSync(join(agentryDir, "run", "sessions", `${sid}.json`), "utf8"));
} catch {
  /* missing/unparseable pointer — treat as null */
}
const workId = ptr?.workId;
if (!workId) process.exit(0); // graceful fallback — one-shot / pre-work-dir → skip silently
// Containment: never let a poisoned pointer escape .agentry/work/ — mirror the binder's guard.
// workId must be a single clean segment (the binder only ever writes one); reject traversal.
if (workId.includes("..") || workId.includes("/") || workId.includes("\\")) process.exit(0);

const kind = input.hook_event_name === "SubagentStop" ? "agent-done" : "agent-started";

// Build the event, omitting undefined fields cleanly (never emit "agent":undefined).
const event = { ts: new Date().toISOString(), kind };
if (input.agent_type !== undefined) event.agent = input.agent_type;
if (input.agent_id !== undefined) event.agentId = input.agent_id;
if (input.session_id !== undefined) event.session = input.session_id;

try {
  const logDir = join(agentryDir, "work", workId);
  mkdirSync(logDir, { recursive: true });
  appendFileSync(join(logDir, "events.jsonl"), `${JSON.stringify(event)}\n`); // one object per line (AC3)
} catch {
  /* best-effort — never block the subagent */
}

process.exit(0); // AC6 — always non-blocking
