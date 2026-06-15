#!/usr/bin/env node
// Agentry — PostToolUse work-id binder (the WRITE side of the pointer seam).
// Dependency-free (node builtins only). On a Write/Edit under .agentry/work/<id>/,
// records session_id -> <id> to a per-session pointer file so the Subagent* emitter
// can resolve the work-id without mtime or a prompt-written marker (ADR-001).
// Best-effort and ALWAYS non-blocking: every path exits 0 (PostToolUse exit-2 would
// surface stderr to the agent — we must never do that).
//
// Seam (pinned — the emitter reads exactly this):
//   path:  <cwd>/.agentry/run/sessions/<session_id>.json   (one file per session)
//   shape: { "workId": "<id>", "updatedAt": "<iso8601>" }   (last-write-wins)

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0); // no/bad stdin — write nothing
}

const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const agentryDir = join(cwd, ".agentry");
if (!existsSync(agentryDir)) process.exit(0); // non-Agentry repo — silent (AC5)

const filePath = input.tool_input?.file_path || input.tool_response?.file_path;
if (!filePath) process.exit(0);

const rel = relative(join(agentryDir, "work"), resolve(cwd, filePath));
if (rel.startsWith("..") || isAbsolute(rel)) process.exit(0); // not under work/

const workId = rel.split(sep)[0];
if (!workId || workId === "run") process.exit(0); // never bind to run/ itself

const sid = input.session_id;
if (!sid) process.exit(0);

try {
  const ptrDir = join(agentryDir, "run", "sessions");
  mkdirSync(ptrDir, { recursive: true });
  const target = join(ptrDir, `${sid}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  const body = JSON.stringify({ workId, updatedAt: new Date().toISOString() });
  writeFileSync(tmp, body); // write to a sibling, then atomically swap in
  renameSync(tmp, target); // a concurrent reader never sees a half-written file
} catch {
  /* best-effort — never block the tool call */
}

process.exit(0); // AC6 — always non-blocking
