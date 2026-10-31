#!/usr/bin/env node
// Agentry — memory priming. Injects the few durable facts that actually bear on the task at hand into
// the context of whoever is about to work: the CONDUCTOR (on UserPromptSubmit) and, when configured,
// every dispatched SUBAGENT (on SubagentStart).
//
// THE BUG THIS FIXES. Every specialist's prompt says "You are primed with recalled gotchas … use them;
// recall further only for the specific symbol you're touching." Nothing primed them. The SessionStart
// primer exits immediately for workers (`agent_type` set) and injected only COUNTS for the conductor.
// So each agent believed recall had already happened, was told not to repeat it, and the memory MCP went
// unused — the store grew and never paid out.
//
// WHY NOT AT SessionStart. Recall is TASK-SPECIFIC. Dumping a warm set at session start is the thing
// Agentry deliberately doesn't do: at that moment there is no task to rank against, so anything injected
// is noise competing with the real context. `UserPromptSubmit` is the first moment a task exists.
//
// Gated by `memory.prime` in `.agentry/config.json`:
//   off        — nobody (recall stays something an agent asks for)
//   conductor  — the main session only (the default)
//   all        — the conductor AND every subagent
//
// Dependency-free (node builtins only) and ALWAYS non-blocking: every path exits 0. Priming is a nudge;
// it must never be able to break a prompt or a subagent launch.
import { readFileSync } from "node:fs";
import { rankFacts, readFacts, readMemoryConfig, renderFacts } from "./lib/memory-recall.mjs";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0); // no/bad stdin — prime nothing
}

const event = input.hook_event_name ?? "";
const projectDir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const config = readMemoryConfig(projectDir);
if (config.prime === "off") process.exit(0);

// The task to rank against, per event. A subagent's brief (`agent_prompt`) is richer than a user prompt —
// it usually names the files it owns — which is exactly the signal the ranker weighs highest.
let task = "";
if (event === "UserPromptSubmit") {
  task = input.prompt ?? "";
} else if (event === "SubagentStart") {
  if (config.prime !== "all") process.exit(0); // workers are opt-in
  task = [input.agent_prompt ?? "", input.description ?? ""].join(" ");
} else {
  process.exit(0);
}

if (task.trim().length === 0) process.exit(0);

let context = "";
try {
  const limit = Number(config.primeLimit) > 0 ? Math.min(10, Number(config.primeLimit)) : 5;
  const facts = rankFacts(readFacts(projectDir), task, limit);
  context = renderFacts(
    facts,
    "## Recalled from Agentry memory (ranked for this task — not a dump)",
  );
} catch {
  process.exit(0); // any failure reading/ranking the store is silent: prime nothing, break nothing
}

if (context.length === 0) process.exit(0); // nothing scored — say nothing rather than pad the context

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }),
);
