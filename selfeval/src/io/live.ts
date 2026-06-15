// The LIVE Runner — invokes the real `claude -p --output-format stream-json --verbose` under a prepared
// sandbox/env, tees the event stream to `stream.jsonl`, and kills the child on the first `Agent` dispatch
// (early-terminate, ADR-002/005). This is the only module that spends API; it is written here but NOT executed
// by the tests (zero API spend — the fake child drives the capture path, `replay.ts` covers the offline path).
//
// PORT of benchmark/src/runner/live.ts's CAPTURE half: `spawnClaudeStreaming`, `isAgentDispatch`, `buildArgs`,
// `StreamChild`, `SpawnFn`, `runCaptured` (→ exported via `liveRunner.run`). DROPPED (all scoring): the
// `--output-format json` branch, `mapResultToCost`, `ClaudeResult`, `ModelUsage`, `collectProducedTree` (now
// a boolean walk in io/sandbox.ts). `buildArgs` here is UNCONDITIONAL stream-json — capture is selfeval's only
// mode (no opt-in `captureStream` flag, no scoring path to preserve).

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream } from "node:fs";

import type { Invocation, RunResult, Runner, Sandbox } from "./port.ts";
import { producedTreeNonEmpty } from "./sandbox.ts";

/**
 * Build the `claude -p` argv from an invocation. UNCONDITIONAL stream-json: capture is selfeval's only mode,
 * so the runner always emits `--output-format stream-json --verbose` (the single-result `json` scoring path
 * does not exist here). `pluginDir` absent ⇒ no `--plugin-dir`.
 */
export function buildArgs(invocation: Invocation): string[] {
  const args = [
    "-p",
    invocation.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    invocation.model,
  ];
  if (invocation.pluginDir) args.push("--plugin-dir", invocation.pluginDir);
  if (invocation.permissionMode) args.push("--permission-mode", invocation.permissionMode);
  if (invocation.allowedTools && invocation.allowedTools.length > 0) {
    args.push("--allowedTools", invocation.allowedTools.join(","));
  }
  return args;
}

/**
 * True iff a parsed stream-json event is an `assistant` message carrying a `tool_use` block whose tool is
 * `Agent` — i.e. the conductor has dispatched a subagent (the early-terminate trigger, ADR-002/OQ2). Reads
 * the `--output-format stream-json` shape: `{type:"assistant", message:{content:[{type:"tool_use",
 * name:"Agent", ...}]}}`. Returns false for any non-matching or malformed line (a partial/garbled tail must
 * never be mistaken for a dispatch).
 */
function isAgentDispatch(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const ev = event as { type?: unknown; message?: { content?: unknown } };
  if (ev.type !== "assistant") return false;
  const content = ev.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "tool_use" &&
      (block as { name?: unknown }).name === "Agent",
  );
}

/** The `result.subtype` of a settled run, if this event is the final `result` envelope; else undefined. */
function resultSubtypeOf(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const ev = event as { type?: unknown; subtype?: unknown };
  if (ev.type !== "result") return undefined;
  return typeof ev.subtype === "string" ? ev.subtype : undefined;
}

/** The minimal child surface the streaming capture drives — `spawn`'s real child satisfies it; tests fake it. */
export type StreamChild = Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr" | "kill" | "on">;

/** Spawn function shape, injectable so the streaming branch is unit-testable with a fake child (no API spend). */
export type SpawnFn = (args: string[], sandbox: Sandbox) => StreamChild;

/** The production spawn: a real `claude -p` child in the sandbox (default for {@link spawnClaudeStreaming}). */
const realSpawn: SpawnFn = (args, sandbox) =>
  spawn("claude", args, { cwd: sandbox.workingDir, env: sandbox.env });

/**
 * Stream-capture spawn (ADR-002/005): run `claude -p --output-format stream-json --verbose`, tee stdout
 * line-by-line to `streamPath`, and `proc.kill()` the moment the first `tool_use name:"Agent"` event is seen
 * (dispatch observed — OQ2 early-terminate). A no-dispatch run is never killed; the process closes normally
 * and its trailing `result` envelope is observed (so `resultSubtype` is set on one-shot / no-dispatch runs).
 * The partial stream after a kill lacks the trailing `result` envelope — expected; `resultSubtype` is then
 * undefined. Resolves with the observed `result.subtype` (or undefined) once the child closes.
 *
 * `spawnFn` is injected only in tests (a fake child driving a synthetic NDJSON stream); production uses the
 * real `claude` spawn.
 */
function spawnClaudeStreaming(
  args: string[],
  sandbox: Sandbox,
  streamPath: string,
  spawnFn: SpawnFn = realSpawn,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const proc = spawnFn(args, sandbox);
    const file = createWriteStream(streamPath);
    let buffer = "";
    let killed = false;
    let resultSubtype: string | undefined;

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      if (killed) return;
      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return; // a partial/garbled line is not a dispatch — keep streaming
      }
      const subtype = resultSubtypeOf(event);
      if (subtype !== undefined) resultSubtype = subtype;
      if (isAgentDispatch(event)) {
        killed = true;
        proc.kill();
      }
    };

    proc.stdout.on("data", (d: Buffer | string) => {
      const chunk = d.toString();
      file.write(chunk);
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line);
      }
    });
    proc.stderr.on("data", () => {}); // drain; a captured run forfeits nothing readable here, so stderr is advisory
    proc.on("error", (err: Error) => {
      file.end();
      reject(err);
    });
    proc.on("close", () => {
      handleLine(buffer); // flush any final unterminated line
      buffer = "";
      file.end(() => resolve(resultSubtype));
    });
  });
}

/**
 * Run one captured invocation (ADR-002/005): stream `claude -p --output-format stream-json --verbose`, tee to
 * `invocation.streamPath`, kill on the first `Agent` dispatch, and return the MINIMAL `RunResult` the extractor
 * needs — `streamPath` (the captured `stream.jsonl`), `resultSubtype` (the settled run's `result.subtype`, or
 * undefined on a killed run), and `producedTreeNonEmpty` (the OQ1 one-shot disambiguator's tree boolean).
 *
 * `spawnFn` is injected only in tests (a fake child driving a synthetic NDJSON stream); production passes the
 * real `claude` spawn through {@link spawnClaudeStreaming}'s default.
 */
export async function runCaptured(
  invocation: Invocation,
  sandbox: Sandbox,
  spawnFn?: SpawnFn,
): Promise<RunResult> {
  if (!invocation.streamPath) {
    throw new Error("runCaptured: no streamPath to tee the event stream to");
  }
  const args = buildArgs(invocation);
  const resultSubtype = await spawnClaudeStreaming(args, sandbox, invocation.streamPath, spawnFn);
  const result: RunResult = {
    streamPath: invocation.streamPath,
    producedTreeNonEmpty: producedTreeNonEmpty(sandbox.workingDir),
  };
  if (resultSubtype !== undefined) result.resultSubtype = resultSubtype;
  return result;
}

/**
 * The live Runner: spawn `claude -p --output-format stream-json --verbose` in the prepared sandbox, tee the
 * events to `invocation.streamPath`, kill the child on the first `Agent` dispatch, and return the captured
 * `RunResult`. Discovers nothing on its own — model and `pluginDir` come in on the Invocation; roots come in on
 * the Sandbox env (`prepareSandbox`).
 */
export const liveRunner: Runner = {
  run(invocation: Invocation, sandbox: Sandbox): Promise<RunResult> {
    return runCaptured(invocation, sandbox);
  },
};
