// The LIVE Runner — invokes the real `claude -p --output-format json` under a prepared sandbox/env and maps
// the result envelope into a RunRecord. This is the only module that spends API; it is written here but NOT
// executed by T-004's tests (zero API spend — `replay.ts` covers the offline path). The pure mapping
// (`mapResultToCost`) is unit-tested against a captured real sample, so the field mapping is proven without
// a paid call.

import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { Cost, RunRecord, TreePath } from "../types.ts";
import type { Invocation, Runner, Sandbox } from "./port.ts";

/**
 * The token-bearing block under `result.modelUsage[<modelId>]`. Field names are CAMELCASE here
 * (distinct from the snake_case in `result.usage.*`) — confirmed against R0b-raw-stream.jsonl.
 */
interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** The `claude -p --output-format json` final result envelope — only the fields the runner maps. */
interface ClaudeResult {
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  /** Keyed by model id; can hold MULTIPLE models — the token axis sums across ALL keys (R0b note). */
  modelUsage?: Record<string, ModelUsage>;
}

/**
 * Map a `claude -p` result envelope to the Cost contract.
 *
 * CRITICAL (R0b — `.agentry/work/benchmark-harness/findings/R0b-subagent-cost.md`, verifier-corrected):
 * the token axis is taken from `modelUsage[<model>].{inputTokens,outputTokens,cacheReadInputTokens,
 * cacheCreationInputTokens}` SUMMED ACROSS ALL MODEL KEYS — NOT from `usage.*`, which is PARENT-ONLY and
 * undercounts the dispatched-subagent tax (~18% in the spike). `modelUsage` + `total_cost_usd` are the only
 * figures that roll up the conductor + every subagent (AC6: no hiding the tax). Cost → `total_cost_usd`
 * (already cross-model, authoritative). Turns → `num_turns`. Duration → `duration_ms` (and the live runner
 * wraps the call in its own wall-clock timer as insurance — see `wallClockMs` below).
 *
 * Pure and side-effect-free so it can be unit-tested against a captured sample with zero API spend.
 * `wallClockMs`, when provided, overrides the envelope's `duration_ms` (the runner's own measurement).
 */
export function mapResultToCost(result: ClaudeResult, wallClockMs?: number): Cost {
  const models = Object.values(result.modelUsage ?? {});
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  for (const m of models) {
    inputTokens += m.inputTokens ?? 0;
    outputTokens += m.outputTokens ?? 0;
    cacheReadInputTokens += m.cacheReadInputTokens ?? 0;
    cacheCreationInputTokens += m.cacheCreationInputTokens ?? 0;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    numTurns: result.num_turns ?? 0,
    totalCostUsd: result.total_cost_usd ?? 0,
    durationMs: wallClockMs ?? result.duration_ms ?? 0,
  };
}

/** Walk the sandbox working tree and return every file as a path relative to `workingDir`. */
function collectProducedTree(workingDir: string): TreePath[] {
  const out: TreePath[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push(relative(workingDir, abs).split(sep).join("/"));
    }
  };
  walk(workingDir);
  return out.sort();
}

/** Build the `claude -p` argv from an invocation. `pluginDir` absent ⇒ arm A (no `--plugin-dir`). */
function buildArgs(invocation: Invocation): string[] {
  const args = ["-p", invocation.prompt, "--output-format", "json", "--model", invocation.model];
  if (invocation.pluginDir) args.push("--plugin-dir", invocation.pluginDir);
  if (invocation.permissionMode) args.push("--permission-mode", invocation.permissionMode);
  if (invocation.allowedTools && invocation.allowedTools.length > 0) {
    args.push("--allowedTools", invocation.allowedTools.join(","));
  }
  return args;
}

/** Spawn `claude -p` and resolve its stdout (rejects on spawn error / non-zero exit / empty output). */
function spawnClaude(args: string[], sandbox: Sandbox): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", args, {
      cwd: sandbox.workingDir,
      env: sandbox.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 2000)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * The live Runner: spawn `claude -p --output-format json` in the prepared sandbox, parse the single result
 * envelope, and map it to a RunRecord. Discovers nothing on its own — model and `pluginDir` come in on the
 * Invocation (caller resolves them from config/env); roots come in on the Sandbox env (T-005).
 */
export const liveRunner: Runner = {
  async run(invocation: Invocation, sandbox: Sandbox): Promise<RunRecord> {
    const args = buildArgs(invocation);
    const start = Date.now();
    const stdout = await spawnClaude(args, sandbox);
    const wallClockMs = Date.now() - start; // own timer as insurance against a missing duration_ms

    let result: ClaudeResult;
    try {
      result = JSON.parse(stdout) as ClaudeResult;
    } catch (cause) {
      throw new Error(`claude -p produced unparseable JSON: ${String(cause)}\n${stdout.slice(0, 2000)}`);
    }
    if (result.is_error) {
      throw new Error(`claude -p reported is_error=true: ${stdout.slice(0, 2000)}`);
    }

    const cost = mapResultToCost(result, wallClockMs);
    const producedTree = collectProducedTree(sandbox.workingDir);

    return {
      cost,
      producedTree,
      usedMemories: [], // M5 (grader) derives the lesson-reuse signal; the live runner records none directly.
      raw: result,
    };
  },
};
