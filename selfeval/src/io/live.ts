// The LIVE Runner — invokes the real `claude -p --output-format stream-json --verbose` under a prepared
// sandbox/env and tees the event stream to `stream.jsonl`. It has TWO termination modes (ADR-002/005 +
// autopilot-design §3): the default kill-on-first-`Agent`-dispatch early-terminate, and an opt-in CAPPED /
// no-kill mode (`Invocation.noKillOnDispatch`) that lets the conductor run on and emit its work-folder
// routing artifacts, terminating at settle or a time cap. This is the only module that spends API; it is
// written here but NOT executed by the tests (zero API spend — the fake child drives the capture path,
// `replay.ts` covers the offline path).
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

/** Options governing how a captured stream terminates. */
interface CaptureOptions {
  /**
   * CAPPED / no-kill mode (autopilot-design §3): when true the run is NOT killed on the first `Agent`
   * dispatch — it runs to settle (its trailing `result` envelope) or until {@link timeoutMs}, so the
   * conductor can emit its work-folder routing artifacts. Default false ⇒ kill-on-first-dispatch.
   */
  noKillOnDispatch?: boolean;
  /** Hard time cap (ms) for the capped run; the child is killed at the cap if it has not settled. */
  timeoutMs?: number;
}

/** Default per-invocation time cap for the capped/no-kill run (autopilot-design §3: ~180–210s). */
export const DEFAULT_CAP_MS = 180_000;

/**
 * Stream-capture spawn (ADR-002/005): run `claude -p --output-format stream-json --verbose`, tee stdout
 * line-by-line to `streamPath`, and observe the trailing `result.subtype` when the run settles.
 *
 * Two termination modes:
 *   - DEFAULT (kill-on-dispatch): `proc.kill()` the moment the first `tool_use name:"Agent"` event is seen
 *     (OQ2 early-terminate). A no-dispatch run is never killed; it closes normally and its `result` envelope
 *     is observed. A killed run's partial stream lacks the trailing `result`, so `resultSubtype` is undefined.
 *   - CAPPED ({@link CaptureOptions.noKillOnDispatch}): never kill on dispatch — let the conductor run and
 *     emit its work-folder artifacts; terminate at process settle OR at `timeoutMs` (kill the child at the
 *     cap if it has not closed). This is the mode the routing probe uses (autopilot-design §3).
 *
 * Resolves with the observed `result.subtype` (or undefined) once the child closes.
 *
 * `spawnFn` is injected only in tests (a fake child driving a synthetic NDJSON stream); production uses the
 * real `claude` spawn.
 */
function spawnClaudeStreaming(
  args: string[],
  sandbox: Sandbox,
  streamPath: string,
  options: CaptureOptions = {},
  spawnFn: SpawnFn = realSpawn,
): Promise<string | undefined> {
  const noKill = options.noKillOnDispatch === true;
  const capMs = options.timeoutMs ?? DEFAULT_CAP_MS;
  return new Promise((resolve, reject) => {
    const proc = spawnFn(args, sandbox);
    const file = createWriteStream(streamPath);
    let buffer = "";
    let terminated = false; // we have killed the child (dispatch or cap) — stop classifying further lines
    let resultSubtype: string | undefined;
    let capTimer: ReturnType<typeof setTimeout> | undefined;

    const clearCap = (): void => {
      if (capTimer !== undefined) {
        clearTimeout(capTimer);
        capTimer = undefined;
      }
    };

    // CAPPED mode: arm a hard cap so a decompose build cannot run unbounded; kill the child if it overruns.
    if (noKill) {
      capTimer = setTimeout(() => {
        terminated = true;
        proc.kill();
      }, capMs);
      // Don't keep the event loop alive solely for the cap timer (Node child already does that).
      (capTimer as { unref?: () => void }).unref?.();
    }

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      if (terminated) return;
      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return; // a partial/garbled line is not a dispatch — keep streaming
      }
      const subtype = resultSubtypeOf(event);
      if (subtype !== undefined) resultSubtype = subtype;
      // Kill-on-dispatch ONLY in the default mode; capped mode lets the conductor run on to emit artifacts.
      if (!noKill && isAgentDispatch(event)) {
        terminated = true;
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
      clearCap();
      file.end();
      reject(err);
    });
    proc.on("close", () => {
      clearCap();
      handleLine(buffer); // flush any final unterminated line
      buffer = "";
      file.end(() => resolve(resultSubtype));
    });
  });
}

/**
 * Run one captured invocation (ADR-002/005): stream `claude -p --output-format stream-json --verbose`, tee to
 * `invocation.streamPath`, and return the MINIMAL `RunResult` the extractor needs — `streamPath` (the captured
 * `stream.jsonl`), `resultSubtype` (the settled run's `result.subtype`, or undefined on a killed run), and
 * `producedTreeNonEmpty` (the OQ1 one-shot disambiguator's tree boolean).
 *
 * Termination follows the invocation: `noKillOnDispatch` ⇒ CAPPED mode (run to settle or `timeoutMs`, so the
 * conductor emits its work-folder artifacts — autopilot-design §3); otherwise the original kill-on-first-
 * dispatch early-terminate. The shape itself is read by the extractor from the work folder, not from here.
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
  const captureOptions: CaptureOptions = {
    ...(invocation.noKillOnDispatch !== undefined ? { noKillOnDispatch: invocation.noKillOnDispatch } : {}),
    ...(invocation.timeoutMs !== undefined ? { timeoutMs: invocation.timeoutMs } : {}),
  };
  const resultSubtype = await spawnClaudeStreaming(
    args,
    sandbox,
    invocation.streamPath,
    captureOptions,
    spawnFn,
  );
  const result: RunResult = {
    streamPath: invocation.streamPath,
    producedTreeNonEmpty: producedTreeNonEmpty(sandbox.workingDir),
  };
  if (resultSubtype !== undefined) result.resultSubtype = resultSubtype;
  return result;
}

/**
 * The live Runner: spawn `claude -p --output-format stream-json --verbose` in the prepared sandbox, tee the
 * events to `invocation.streamPath`, terminate per the invocation (kill-on-dispatch by default; capped/no-kill
 * when `noKillOnDispatch` is set), and return the captured `RunResult`. Discovers nothing on its own — model
 * and `pluginDir` come in on the Invocation; roots come in on the Sandbox env (`prepareSandbox`).
 */
export const liveRunner: Runner = {
  run(invocation: Invocation, sandbox: Sandbox): Promise<RunResult> {
    return runCaptured(invocation, sandbox);
  },
};
