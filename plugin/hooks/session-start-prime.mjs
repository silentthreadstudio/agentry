#!/usr/bin/env node
// Agentry — SessionStart memory primer.
// Dependency-free (node builtins only). Injects the warm set so recall is reliable by
// construction (doc 02 §2, doc 07 §3). Reads the text-as-truth file store directly — no MCP,
// no DB. Primes the CONDUCTOR (main session) only; workers are skipped.
//
// Iteration 1: emits counts + the front-door note + cold/warm state. Full recency×relevance
// ranking of the warm set lands with the @agentry/memory implementation.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  /* no/!json stdin — proceed with defaults */
}

// Prime the conductor only. A worker subagent carries an agent_type — skip it.
if (input.agent_type) process.exit(0);

const projectDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const roots = [
  { label: "project", dir: join(projectDir, ".agentry", "memory") },
  { label: "global", dir: join(homedir(), ".agentry", "memory") },
];

const countRecords = (dir) => {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md") || f.endsWith(".json")).length;
  } catch {
    return 0;
  }
};

const lines = [
  "Agentry is active. Front door: `/agentry:go <task>` — routes a task to the least process that wins (one-shot → spec-first → decompose+verify).",
];

let warm = false;
for (const r of roots) {
  const facts = countRecords(join(r.dir, "facts"));
  const episodes = countRecords(join(r.dir, "episodes"));
  if (facts || episodes) {
    warm = true;
    lines.push(`Memory (${r.label}): ${facts} facts, ${episodes} episodes.`);
  }
}
if (!warm) {
  lines.push(
    "Memory store is cold (empty). It warms as you work — run `/agentry:reflect` after a task to compound.",
  );
}
lines.push("Recall precedent + gotchas before routing; cite `used_memories`.");

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: lines.join("\n"),
    },
  }),
);
