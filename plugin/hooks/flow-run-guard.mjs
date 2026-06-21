#!/usr/bin/env node
// Agentry — PostToolUse Flow-run guard (teeth #2 — the mint-or-FLAG seam, ADR-001).
//
// ROLE: assert that above-floor work runs UNDER a Flow run, and FLAG it when it doesn't —
// never block, never mint, never call the Flow MCP. A genuine one-shot writes no gate
// artifact under `.agentry/work/`, so the trigger never fires (the one-shot floor is
// preserved STRUCTURALLY, not by a decision in this hook). When a gate artifact
// (`spec.md` / `plan.md` / `tasks/NNN-*.md`) IS written under `.agentry/work/<id>/` and
// NO Flow run exists for `<id>`, this appends ONE `flow-skipped` marker to that run's
// `events.jsonl` so FLOW's reader (and the eval) can detect the bypass.
//
// Dependency-free (node builtins only). Best-effort and ALWAYS non-blocking: every path
// exits 0 (a PostToolUse exit-2 would surface stderr to the agent — we must never do that).
//
// "Run exists" (reusing the seam the rest of the harness relies on):
//   - `.agentry/work/<id>/run-state.json` present (the run-state file Flow's run_start lays down), OR
//   - `.agentry/work/<id>/events.jsonl` carries at least one FLOW line — a line with a `type` field
//     (the closed conductor vocabulary). Hook backstop lines (a loose `kind`, no `type`) do NOT count
//     as a run — otherwise a one-shot with subagent activity would falsely read as Flow-managed.
//
// Marker line shape (matches subagent-emit's loose `{ ts, kind, … }` — NO `type`, so it is never
// mistaken for a FLOW line):
//   { "ts": "<iso8601>", "kind": "flow-skipped", "artifact": "spec"|"plan"|"task", "path": "<rel-to-<id>>" }

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0); // no/bad stdin — flag nothing
}

const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const agentryDir = join(cwd, ".agentry");
if (!existsSync(agentryDir)) process.exit(0); // non-Agentry repo — silent

const filePath = input.tool_input?.file_path || input.tool_response?.file_path;
if (!filePath) process.exit(0);

// Path-parsing + traversal guard — mirror work-id-binder.mjs exactly: relative to `.agentry/work`,
// reject `..`/absolute, first segment is the workId, never the `run/` sibling.
const workRoot = join(agentryDir, "work");
const rel = relative(workRoot, resolve(cwd, filePath));
if (rel.startsWith("..") || isAbsolute(rel)) process.exit(0); // not under work/

const segments = rel.split(sep);
const workId = segments[0];
if (!workId || workId === "run") process.exit(0); // never bind to run/ itself
// Containment: a single clean segment only — reject a traversal-poisoned workId.
if (workId.includes("..") || workId.includes("/") || workId.includes("\\")) process.exit(0);

// Is this a GATE artifact? Only `<id>/spec.md`, `<id>/plan.md`, or `<id>/tasks/NNN-*.md` trigger.
const artifact = gateArtifact(segments.slice(1));
if (!artifact) process.exit(0); // non-gate write — no-op

const runDir = join(workRoot, workId);
if (runExists(runDir)) process.exit(0); // a Flow run owns this work — silent

// No run for above-floor work: append ONE flag marker (never mint, never block).
try {
  mkdirSync(runDir, { recursive: true });
  const marker = { ts: new Date().toISOString(), kind: "flow-skipped", artifact, path: rel };
  appendFileSync(join(runDir, "events.jsonl"), `${JSON.stringify(marker)}\n`);
} catch {
  /* best-effort — never block the tool call */
}

process.exit(0); // always non-blocking

// Classify the path BELOW the workId as a gate artifact, or null. `tail` is the segments after <id>.
function gateArtifact(tail) {
  if (tail.length === 1) {
    if (tail[0] === "spec.md") return "spec";
    if (tail[0] === "plan.md") return "plan";
    return null;
  }
  // `tasks/NNN-*.md` — exactly one level under `tasks/`, a digit-prefixed `.md` task file.
  if (tail.length === 2 && tail[0] === "tasks" && /^\d+.*\.md$/.test(tail[1])) return "task";
  return null;
}

// A Flow run exists for this run dir iff run-state.json is present OR events.jsonl carries a FLOW line
// (one with a `type` field). Reads are best-effort: a missing/corrupt file reads as "no run".
function runExists(dir) {
  if (existsSync(join(dir, "run-state.json"))) return true;
  let raw = "";
  try {
    raw = readFileSync(join(dir, "events.jsonl"), "utf8");
  } catch {
    return false; // no events.jsonl yet → no run
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      if (JSON.parse(trimmed).type !== undefined) return true; // a FLOW line → a real run
    } catch {
      /* tolerate a malformed line — never throw */
    }
  }
  return false;
}
