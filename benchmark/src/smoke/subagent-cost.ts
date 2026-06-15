/**
 * R0b — AC6 subagent-cost empirical check (T-003b).
 *
 * QUESTION (forks T-004's runner design):
 *   Does the run-level `usage` aggregate from `claude -p --output-format json`
 *   INCLUDE subagent (Task-tool) token cost, or only the top-level agent's turns?
 *
 * METHOD — ONE real `claude -p` call, no retry loop:
 *   - Define a trivial subagent inline via `--agents`.
 *   - Prompt the agent to dispatch that subagent via the Task tool for a tiny sub-task.
 *   - Stream with `--output-format stream-json --verbose` so a SINGLE call yields both:
 *       (a) per-turn telemetry + the Task dispatch evidence (proof a subagent fired), and
 *       (b) the final `type:"result"` envelope — byte-identical to what plain
 *           `--output-format json` returns (research OQ1) — carrying the run-level `usage`.
 *   - Compare the run-level token total against the final assistant turn's tokens alone.
 *
 * VERDICT:
 *   run-level >> final-turn  → subagent cost INCLUDED → plain `json` suffices for T-004.
 *   run-level ≈  final-turn  → subagent cost EXCLUDED → T-004 must use stream-json + per-turn aggregation.
 *
 * Records the finding to findings/R0b-subagent-cost.md. Does NOT retry on error.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// benchmark/src/smoke -> repo root is three levels up.
const REPO_ROOT = join(HERE, "..", "..", "..");
const WORK_DIR = join(REPO_ROOT, ".agentry", "work", "benchmark-harness");
const FINDING_PATH = join(WORK_DIR, "findings", "R0b-subagent-cost.md");
// Persist the raw stream so a parse miss can be diagnosed WITHOUT a second paid call.
const RAW_PATH = join(WORK_DIR, "findings", "R0b-raw-stream.jsonl");

/** Sum the comparable token fields of a usage object into one scalar. */
function tokenTotal(usage: any): number {
  if (!usage) return 0;
  const i = usage.input_tokens ?? 0;
  const o = usage.output_tokens ?? 0;
  const cc = usage.cache_creation_input_tokens ?? 0;
  const cr = usage.cache_read_input_tokens ?? 0;
  return i + o + cc + cr;
}

function fmt(usage: any): string {
  if (!usage) return "(none)";
  return JSON.stringify({
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  });
}

// The trivial subagent the prompt must dispatch.
const AGENTS = JSON.stringify({
  echoer: {
    description:
      "Trivial helper. When dispatched, returns a one-word answer to a tiny question.",
    prompt:
      "You are a trivial echo helper. Answer the single tiny question you are given in ONE word. Do nothing else.",
  },
});

const PROMPT =
  "You have a subagent named `echoer` available via the Task tool. " +
  "Your ONLY job: call the Task tool now with subagent_type \"echoer\" and prompt " +
  "'What color is a clear daytime sky? Answer in one word.' " +
  "Do NOT answer the question yourself under any circumstances — you must delegate it to the echoer subagent via the Task tool. " +
  "After the subagent replies, output only its one-word answer.";

const ARGS = [
  "-p",
  PROMPT,
  "--output-format",
  "stream-json",
  "--verbose",
  "--permission-mode",
  "bypassPermissions",
  "--allowedTools",
  "Task",
  "--agents",
  AGENTS,
];

console.log("[R0b] running ONE real `claude -p` subagent-cost probe (no retry)...");
console.log("[R0b] args:", ARGS.filter((a) => a !== AGENTS && a !== PROMPT).join(" "), "(+prompt +agents)");

const proc = spawnSync("claude", ARGS, {
  cwd: REPO_ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

mkdirSync(dirname(FINDING_PATH), { recursive: true });

// Persist raw stdout immediately so any later parse miss is diagnosable from the
// captured bytes — never requiring a second (paid) call to re-inspect.
if (proc.stdout) writeFileSync(RAW_PATH, proc.stdout);

function recordError(reason: string, detail: string): never {
  const md = `# R0b — AC6 subagent-cost check — INCONCLUSIVE (error)

> T-003b · ${new Date().toISOString()} · ONE \`claude -p\` call, no retry (per brief).

## Verdict
**INCONCLUSIVE** — the single \`claude -p\` call did not produce a usable result.

## Reason
${reason}

## Implication for T-004
Cannot resolve the runner-design fork from this run. T-004 should treat AC6 subagent-cost
inclusion as **still unproven** and default to the **safe** path: \`--output-format stream-json\`
with per-turn aggregation (which is correct whether or not the run-level aggregate includes
subagent cost). Re-run this spike once the blocker below is resolved to confirm.

## Detail
\`\`\`
${detail}
\`\`\`
`;
  writeFileSync(FINDING_PATH, md);
  console.error("[R0b] INCONCLUSIVE:", reason);
  console.error("[R0b] finding written to", FINDING_PATH);
  process.exit(1);
}

if (proc.error) {
  recordError(
    "Failed to spawn the `claude` CLI.",
    `spawn error: ${proc.error.message}`,
  );
}

const stdout = proc.stdout ?? "";
const stderr = proc.stderr ?? "";

if (!stdout.trim()) {
  recordError(
    "`claude` produced no stdout.",
    `exit=${proc.status} signal=${proc.signal}\nstderr:\n${stderr.slice(0, 4000)}`,
  );
}

// Parse the NDJSON stream into events.
const events: any[] = [];
for (const line of stdout.split("\n")) {
  const t = line.trim();
  if (!t) continue;
  try {
    events.push(JSON.parse(t));
  } catch {
    // tolerate non-JSON noise lines
  }
}

if (events.length === 0) {
  recordError(
    "No JSON events parsed from stdout.",
    `exit=${proc.status}\nstdout head:\n${stdout.slice(0, 4000)}`,
  );
}

const resultEvent = events.find((e) => e.type === "result");
if (!resultEvent) {
  recordError(
    "Stream contained no final `type:\"result\"` envelope.",
    `exit=${proc.status}\nlast events:\n${JSON.stringify(events.slice(-3), null, 2).slice(0, 4000)}`,
  );
}

if (resultEvent.is_error) {
  recordError(
    `The run reported is_error=true (subtype=${resultEvent.subtype}).`,
    `result.result: ${JSON.stringify(resultEvent.result)?.slice(0, 1000)}\napi_error_status: ${JSON.stringify(resultEvent.api_error_status)}`,
  );
}

// --- Prove a subagent actually fired ----------------------------------------
// Evidence 1: a Task tool_use block in the parent agent's assistant messages.
const assistantEvents = events.filter((e) => e.type === "assistant");
const taskDispatches: any[] = [];
const allToolUseNames: string[] = [];
for (const e of assistantEvents) {
  const content = e?.message?.content ?? [];
  if (!Array.isArray(content)) continue;
  for (const block of content) {
    if (block?.type === "tool_use") {
      allToolUseNames.push(String(block?.name));
      // Match Task dispatch tolerantly: name "Task" (any case) or a tool whose
      // input names a subagent_type / our echoer agent.
      const name = String(block?.name ?? "").toLowerCase();
      const inputStr = JSON.stringify(block?.input ?? {}).toLowerCase();
      if (name === "task" || inputStr.includes("subagent_type") || inputStr.includes("echoer")) {
        taskDispatches.push(block);
      }
    }
  }
}
// Evidence 2: stream-json tags sub-agent activity with a parent_tool_use_id / agent fields.
const subagentTaggedEvents = events.filter(
  (e) => e.parent_tool_use_id != null || e.subtype === "subagent" || e.agent != null,
);

const subagentFired = taskDispatches.length > 0 || subagentTaggedEvents.length > 0;

// --- Compare run-level total vs final-turn alone -----------------------------
const runLevelUsage = resultEvent.usage;
const runLevelTotal = tokenTotal(runLevelUsage);

// The final assistant turn's usage = the last assistant message that carries usage.
const assistantWithUsage = assistantEvents.filter((e) => e?.message?.usage);
const finalTurn = assistantWithUsage[assistantWithUsage.length - 1];
const finalTurnUsage = finalTurn?.message?.usage;
const finalTurnTotal = tokenTotal(finalTurnUsage);

// num_turns and modelUsage as corroboration.
const numTurns = resultEvent.num_turns;

if (!subagentFired) {
  recordError(
    "Could not confirm a subagent fired: no Task tool_use block found in the stream. " +
      "Without a confirmed subagent dispatch, the run-level-vs-final-turn delta proves nothing " +
      "(this would be the same inconclusive no-subagent probe research already hit). " +
      "Raw stream persisted at findings/R0b-raw-stream.jsonl for diagnosis (no re-call needed).",
    `assistant events: ${assistantEvents.length}\n` +
      `tool_use names observed: ${JSON.stringify(allToolUseNames)}\n` +
      `Task dispatches: ${taskDispatches.length}\n` +
      `subagent-tagged events: ${subagentTaggedEvents.length}\n` +
      `event types seen: ${JSON.stringify([...new Set(events.map((e) => e.type))])}\n` +
      `result.result: ${JSON.stringify(resultEvent.result)?.slice(0, 600)}`,
  );
}

// --- Verdict -----------------------------------------------------------------
// If the run-level total is materially larger than the final single turn, the
// aggregate is summing across turns INCLUDING the subagent's turns => INCLUDED.
// If they are ~equal, the aggregate only reflects the final turn => EXCLUDED.
const included = runLevelTotal > finalTurnTotal * 1.2 && runLevelTotal - finalTurnTotal > 50;
const verdict = included ? "YES" : "NO";

const md = `# R0b — AC6 subagent-cost check — verdict: ${verdict}

> T-003b · ${new Date().toISOString()} · ONE \`claude -p --output-format stream-json --verbose\` call (no retry).

## Question
Does the run-level \`usage\`/\`num_turns\` aggregate from \`claude -p\` include subagent
(Task-tool) token cost, or only the top-level agent's turns? (AC6: the agentry arms'
recorded cost must include conductor + all subagent usage — no hiding the tax.)

## Task used
A single \`claude -p\` run with a trivially-defined inline subagent (\`--agents '{"echoer":...}'\`),
prompted to dispatch \`echoer\` for a tiny one-word sub-task ("What color is a clear daytime sky? one word"),
run under \`--permission-mode bypassPermissions --allowedTools Task\` so the dispatch tool is allowed
non-interactively. (The dispatch tool surfaces in the stream as \`name:"Agent"\`, carrying \`input.subagent_type\`.)

Streamed as \`stream-json\` so a SINGLE call yields both the per-turn telemetry (Task dispatch
evidence) and the final \`type:"result"\` envelope — the latter is byte-identical to what plain
\`--output-format json\` returns (research OQ1).

## Proof the subagent fired
- **Dispatch tool_use blocks observed (name "Agent"/"Task" or subagent_type input): ${taskDispatches.length}** (>0 = dispatch).
- All tool_use names seen in the stream: ${JSON.stringify(allToolUseNames)}.
- Subagent-tagged stream events (parent_tool_use_id / agent fields): ${subagentTaggedEvents.length}.
- Total \`num_turns\` (run-level): **${numTurns}**.
${taskDispatches.length > 0 ? `- First dispatch input (truncated): \`${JSON.stringify(taskDispatches[0]?.input)?.slice(0, 300)}\`` : ""}

## The two numbers (summed input+output+cache_read+cache_creation tokens)
| measure | tokens | breakdown |
|---|---|---|
| **run-level** (\`result.usage\`) | **${runLevelTotal}** | ${fmt(runLevelUsage)} |
| **final turn alone** (last assistant msg \`message.usage\`) | **${finalTurnTotal}** | ${fmt(finalTurnUsage)} |
| delta (run-level − final-turn) | ${runLevelTotal - finalTurnTotal} | |

- assistant turns carrying usage in the stream: ${assistantWithUsage.length}
- \`result.modelUsage\`: \`${JSON.stringify(resultEvent.modelUsage)?.slice(0, 600)}\`

## Verdict: **${verdict}** — subagent cost is ${included ? "INCLUDED in" : "NOT reflected by"} the run-level \`usage\`.

${
  included
    ? `The run-level aggregate (${runLevelTotal}) materially exceeds the final turn alone (${finalTurnTotal}) — ` +
      `it is summing across all turns, including the dispatched subagent's. The "tax" is captured.`
    : `The run-level aggregate (${runLevelTotal}) is ≈ the final turn alone (${finalTurnTotal}) — ` +
      `the aggregate does NOT roll up the subagent's turns; relying on it would hide the subagent tax.`
}

## Resolved fork for T-004 (the Runner)
${
  included
    ? `**Plain \`--output-format json\` is SUFFICIENT.** T-004's \`live.ts\` can run \`claude -p --output-format json\`,
read the single final envelope, and record \`result.usage\` (+ \`num_turns\`, \`total_cost_usd\`) directly —
the run-level aggregate already includes conductor + all subagent usage, satisfying AC6.`
    : `**T-004's \`live.ts\` MUST use \`--output-format stream-json --verbose\` and aggregate per-turn.**
The final \`result.usage\` would hide the subagent tax. Aggregate over every \`type:"assistant"\` event's
\`message.usage\` (each turn — parent AND subagent — carries its own usage), shape roughly:

\`\`\`ts
// per-turn aggregation T-004 implements
const agg = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
let numTurns = 0;
for (const line of stdout.split("\\n")) {
  if (!line.trim()) continue;
  const ev = JSON.parse(line);
  if (ev.type === "assistant" && ev.message?.usage) {
    const u = ev.message.usage;            // includes subagent turns (tagged via parent_tool_use_id)
    agg.input_tokens += u.input_tokens ?? 0;
    agg.output_tokens += u.output_tokens ?? 0;
    agg.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    agg.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    numTurns++;
  }
  if (ev.type === "result") { /* keep total_cost_usd from the final envelope */ }
}
\`\`\`
Note: \`total_cost_usd\` on the final envelope and \`modelUsage\` should be checked — if those DO roll up
subagent cost while \`usage\` does not, T-004 may prefer \`total_cost_usd\` for the cost axis and the
per-turn sum for the token axis. Verify against the modelUsage block recorded above.`
}

## Caveats
- ONE real call (no retry, per brief). Numbers are from a single stochastic run; the **verdict**
  (included vs not) is structural, not the exact token counts.
- Token total here sums input+output+cache tokens; cache-read tokens dominate and are counted (AC6 wants the full tax).
`;

writeFileSync(FINDING_PATH, md);

console.log("[R0b] subagent fired:", subagentFired, `(Task dispatches: ${taskDispatches.length})`);
console.log("[R0b] run-level total tokens:", runLevelTotal, "|", fmt(runLevelUsage));
console.log("[R0b] final-turn total tokens:", finalTurnTotal, "|", fmt(finalTurnUsage));
console.log("[R0b] num_turns:", numTurns);
console.log("[R0b] VERDICT:", verdict, included ? "(subagent cost INCLUDED)" : "(subagent cost EXCLUDED)");
console.log("[R0b] finding written to", FINDING_PATH);
