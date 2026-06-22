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
import { createWriteStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Invocation, RunCost, RunResult, Runner, Sandbox } from "./port.ts";
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

/** A finite number passes through; anything else (string, null, NaN, absent) ⇒ undefined — never coerce. */
function numOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * The token/time/$ cost of a settled run, if this event is the final `result` envelope; else undefined
 * (ADR-002). Reads the SAME envelope `resultSubtypeOf` reads, normalizing the CLI's snake_case
 * (`usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `total_cost_usd`,
 * `duration_ms`, `num_turns`) into {@link RunCost}'s camelCase. Field names PINNED against a real captured
 * `claude -p --output-format stream-json` `result` event. Tolerant of any missing/non-numeric field (a
 * partial or future envelope yields a `RunCost` with only the fields it actually carried); returns a `RunCost`
 * whenever the event IS a `result` (even if every field is absent — the run settled, so cost is "known empty").
 */
function costOf(event: unknown): RunCost | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const ev = event as {
    type?: unknown;
    total_cost_usd?: unknown;
    duration_ms?: unknown;
    num_turns?: unknown;
    usage?: unknown;
  };
  if (ev.type !== "result") return undefined;
  const usage =
    typeof ev.usage === "object" && ev.usage !== null
      ? (ev.usage as {
          input_tokens?: unknown;
          output_tokens?: unknown;
          cache_read_input_tokens?: unknown;
        })
      : {};
  const cost: RunCost = {};
  const inputTokens = numOrUndefined(usage.input_tokens);
  const outputTokens = numOrUndefined(usage.output_tokens);
  const cacheReadTokens = numOrUndefined(usage.cache_read_input_tokens);
  const totalCostUsd = numOrUndefined(ev.total_cost_usd);
  const durationMs = numOrUndefined(ev.duration_ms);
  const numTurns = numOrUndefined(ev.num_turns);
  if (inputTokens !== undefined) cost.inputTokens = inputTokens;
  if (outputTokens !== undefined) cost.outputTokens = outputTokens;
  if (cacheReadTokens !== undefined) cost.cacheReadTokens = cacheReadTokens;
  if (totalCostUsd !== undefined) cost.totalCostUsd = totalCostUsd;
  if (durationMs !== undefined) cost.durationMs = durationMs;
  if (numTurns !== undefined) cost.numTurns = numTurns;
  return cost;
}

/** The minimal child surface the streaming capture drives — `spawn`'s real child satisfies it; tests fake it. */
export type StreamChild = Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr" | "kill" | "on">;

/** Spawn function shape, injectable so the streaming branch is unit-testable with a fake child (no API spend). */
export type SpawnFn = (args: string[], sandbox: Sandbox) => StreamChild;

/** The production spawn: a real `claude -p` child in the sandbox (default for {@link spawnClaudeStreaming}). */
const realSpawn: SpawnFn = (args, sandbox) =>
  spawn("claude", args, { cwd: sandbox.workingDir, env: sandbox.env });

/** Options governing how a captured stream terminates. */
export interface CaptureOptions {
  /**
   * CAPPED / no-kill mode (autopilot-design §3): when true the run is NOT killed on the first `Agent`
   * dispatch — it runs to settle (its trailing `result` envelope) or until {@link timeoutMs}, so the
   * conductor can emit its work-folder routing artifacts. Default false ⇒ kill-on-first-dispatch.
   */
  noKillOnDispatch?: boolean;
  /**
   * ARTIFACT-AWARE early-terminate (autopilot-design §3): when true, poll the sandbox work folder while the
   * child runs and kill it as soon as the routing SHAPE is DETERMINED (plan/tasks ⇒ decompose; spec-only
   * past a grace ⇒ spec-first). Supersedes {@link noKillOnDispatch} for live routing runs — it terminates on
   * the artifact, not the dispatch, so it both reads more accurately AND kills earlier/cheaper. {@link timeoutMs}
   * stays the hard ceiling fallback. Default false ⇒ behavior is governed by {@link noKillOnDispatch}.
   */
  terminateOnArtifact?: boolean;
  /**
   * RUN-TO-COMPLETION mode (ADR-002): when true, take NEITHER early-kill path (not kill-on-dispatch, not
   * {@link terminateOnArtifact}) — let the headless build run until it settles on its trailing `result`
   * envelope or {@link timeoutMs} fires. Overrides both kill flags. Default false ⇒ routing behavior unchanged.
   */
  runToCompletion?: boolean;
  /** Hard ceiling (ms): the child is killed at this cap regardless of mode if it has not settled/terminated. */
  timeoutMs?: number;
  /** Polling interval (ms) for the artifact watch; defaults to {@link DEFAULT_POLL_MS}. Test-injectable. */
  pollMs?: number;
  /** Grace window (ms) after spec.md-only appears, awaiting plan/tasks before settling on spec-first. */
  graceMs?: number;
}

/** Default hard ceiling for a capped/artifact-aware run — the fallback when no artifact ever determines a shape. */
export const DEFAULT_CAP_MS = 300_000;

/** Default poll interval for the artifact watch (autopilot-design §3: every few seconds). */
export const DEFAULT_POLL_MS = 4_000;

/** Default grace window after spec.md-only before concluding spec-first (autopilot-design §3: ~45s). */
export const DEFAULT_GRACE_MS = 45_000;

/** True iff `dir` exists, is a directory, and holds at least one entry (mirrors extract.ts's `dirNonEmpty`). */
function dirNonEmpty(dir: string): boolean {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  return readdirSync(dir).length > 0;
}

/** The routing artifact evidence the poll watches for under `<workingDir>/.agentry/work/*`. */
interface WorkArtifacts {
  /** Any `plan.md` exists, OR any `tasks/` dir is non-empty (⇒ the run decomposed) — the DETERMINED signal. */
  hasDecompose: boolean;
  /** Any `spec.md` exists (⇒ the work was spec'd) — opens the grace window unless decompose already fired. */
  hasSpec: boolean;
}

/**
 * Scan `<workingDir>/.agentry/work/*` for the routing artifacts the conductor writes — MIRRORS the mapping
 * `extract.ts` reads after the run, so the live kill-when-determined matches the post-run shape verdict. Only
 * `spec.md` / `plan.md` / `tasks/` count; the primer hook's own `events.jsonl` log shares the folder (a known
 * naming collision) and is IGNORED here, exactly as the extractor ignores it. Tolerates a missing work root
 * (a not-yet-written / one-shot run scans clean). Pure fs reads.
 */
function scanWorkArtifacts(workingDir: string): WorkArtifacts {
  const workRoot = join(workingDir, ".agentry", "work");
  if (!existsSync(workRoot) || !statSync(workRoot).isDirectory()) {
    return { hasDecompose: false, hasSpec: false };
  }
  let hasDecompose = false;
  let hasSpec = false;
  for (const slug of readdirSync(workRoot)) {
    const slugDir = join(workRoot, slug);
    if (!statSync(slugDir).isDirectory()) continue;
    // events.jsonl is the primer hook's log, not a routing artifact — never counted (only plan/tasks/spec are).
    if (existsSync(join(slugDir, "plan.md")) || dirNonEmpty(join(slugDir, "tasks"))) hasDecompose = true;
    if (existsSync(join(slugDir, "spec.md"))) hasSpec = true;
  }
  return { hasDecompose, hasSpec };
}

/**
 * Stream-capture spawn (ADR-002/005): run `claude -p --output-format stream-json --verbose`, tee stdout
 * line-by-line to `streamPath`, and observe the trailing `result` envelope when the run settles — its
 * `subtype` and its token/time/$ {@link RunCost} (both absent on a killed run, which forfeits that envelope).
 *
 * Termination modes:
 *   - RUN-TO-COMPLETION ({@link CaptureOptions.runToCompletion}): take NEITHER early-kill path — no
 *     kill-on-dispatch, no artifact poll — so the full headless build runs to its trailing `result` envelope
 *     or `timeoutMs`. Overrides both kill flags; this is the outcome run's mode (ADR-002).
 *   - DEFAULT (kill-on-dispatch): `proc.kill()` the moment the first `tool_use name:"Agent"` event is seen
 *     (OQ2 early-terminate). A no-dispatch run is never killed; it closes normally and its `result` envelope
 *     is observed. A killed run's partial stream lacks the trailing `result`, so `resultSubtype` is undefined.
 *   - CAPPED ({@link CaptureOptions.noKillOnDispatch}): never kill on dispatch — let the conductor run and
 *     emit its work-folder artifacts; terminate at process settle OR at `timeoutMs` (kill the child at the
 *     cap if it has not closed).
 *   - ARTIFACT-AWARE ({@link CaptureOptions.terminateOnArtifact}): poll the sandbox work folder while the
 *     child runs and kill as soon as the routing shape is DETERMINED — `plan.md`/non-empty `tasks/` ⇒
 *     decompose (kill at once); `spec.md`-only ⇒ open a grace window, killing on spec-first if plan/tasks
 *     never appear within it (or earlier on decompose if they do). A run that writes no artifact and settles
 *     on its own is one-shot/degenerate (the natural close, never force-killed). `timeoutMs` is the hard
 *     ceiling fallback. This supersedes `noKillOnDispatch` for live routing runs (autopilot-design §3).
 *
 * Resolves with the observed `result.subtype` (or undefined) once the child closes. The settled run's
 * {@link RunCost} (ADR-002) is surfaced through the optional `onCost` side channel — parsed from the SAME
 * `result` envelope `result.subtype` is read from, so the resolved value (and every existing caller) is
 * unchanged. `onCost` fires once, when the trailing `result` envelope is seen; a killed run never fires it.
 *
 * `spawnFn` is injected only in tests (a fake child driving a synthetic NDJSON stream); production uses the
 * real `claude` spawn. `onCost` is supplied only by {@link runCaptured} (to land cost on `RunResult`).
 */
export function spawnClaudeStreaming(
  args: string[],
  sandbox: Sandbox,
  streamPath: string,
  options: CaptureOptions = {},
  spawnFn: SpawnFn = realSpawn,
  onCost?: (cost: RunCost) => void,
): Promise<string | undefined> {
  // RUN-TO-COMPLETION (ADR-002) suppresses BOTH early-kill paths: no artifact poll, no kill-on-dispatch — the
  // build runs to its trailing `result` envelope or the `timeoutMs` cap. Otherwise routing behavior is unchanged.
  const toCompletion = options.runToCompletion === true;
  const onArtifact = !toCompletion && options.terminateOnArtifact === true;
  // never kill on dispatch in artifact, capped, OR run-to-completion mode (only the cap/settle ends those runs).
  const noKill = toCompletion || onArtifact || options.noKillOnDispatch === true;
  const capMs = options.timeoutMs ?? DEFAULT_CAP_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  return new Promise((resolve, reject) => {
    const proc = spawnFn(args, sandbox);
    const file = createWriteStream(streamPath);
    let buffer = "";
    let terminated = false; // we have killed the child (dispatch / artifact / cap) — stop classifying lines
    let resultSubtype: string | undefined;
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let graceArmed = false; // a spec.md-only sighting has opened the grace window awaiting plan/tasks

    const clearTimers = (): void => {
      if (capTimer !== undefined) clearTimeout(capTimer);
      if (pollTimer !== undefined) clearInterval(pollTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      capTimer = pollTimer = graceTimer = undefined;
    };

    /** Kill the child once and latch `terminated` so no further line/poll re-classifies a settling run. */
    const killOnce = (): void => {
      if (terminated) return;
      terminated = true;
      clearTimers();
      proc.kill();
    };

    // CAPPED / ARTIFACT mode: a hard ceiling so a build cannot run unbounded; kill the child if it overruns.
    if (noKill) {
      capTimer = setTimeout(killOnce, capMs);
      (capTimer as { unref?: () => void }).unref?.(); // don't keep the loop alive solely for the ceiling
    }

    // ARTIFACT-AWARE mode: poll the work folder; kill when the routing shape is DETERMINED.
    if (onArtifact) {
      const poll = (): void => {
        if (terminated) return;
        const { hasDecompose, hasSpec } = scanWorkArtifacts(sandbox.workingDir);
        if (hasDecompose) {
          killOnce(); // plan.md / non-empty tasks/ ⇒ decompose is determined — kill immediately.
          return;
        }
        if (hasSpec && !graceArmed) {
          // spec.md only so far ⇒ start the grace window; if plan/tasks appear within it the poll fires
          // decompose above, otherwise the grace expiry settles spec-first.
          graceArmed = true;
          graceTimer = setTimeout(killOnce, graceMs);
          (graceTimer as { unref?: () => void }).unref?.();
        }
      };
      pollTimer = setInterval(poll, pollMs);
      (pollTimer as { unref?: () => void }).unref?.();
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
      // The trailing `result` envelope also carries the run's cost (ADR-002); parse it where we already read
      // subtype and hand it to the optional side channel — the resolved value stays subtype-only (AC8: existing
      // callers unchanged). A non-`result` event yields undefined and never fires the sink.
      if (onCost !== undefined) {
        const parsedCost = costOf(event);
        if (parsedCost !== undefined) onCost(parsedCost);
      }
      // Kill-on-dispatch ONLY in the default mode; capped/artifact modes let the conductor run on to emit artifacts.
      if (!noKill && isAgentDispatch(event)) {
        killOnce();
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
      clearTimers();
      file.end();
      reject(err);
    });
    proc.on("close", () => {
      clearTimers();
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
    ...(invocation.terminateOnArtifact !== undefined ? { terminateOnArtifact: invocation.terminateOnArtifact } : {}),
    ...(invocation.runToCompletion !== undefined ? { runToCompletion: invocation.runToCompletion } : {}),
    ...(invocation.timeoutMs !== undefined ? { timeoutMs: invocation.timeoutMs } : {}),
  };
  // Cost (ADR-002) is captured via the side channel: `spawnClaudeStreaming` resolves the subtype only (so its
  // existing routing callers are unchanged), and hands the parsed `RunCost` here when the run settles.
  let cost: RunCost | undefined;
  const resultSubtype = await spawnClaudeStreaming(
    args,
    sandbox,
    invocation.streamPath,
    captureOptions,
    spawnFn,
    (parsed) => {
      cost = parsed;
    },
  );
  const result: RunResult = {
    streamPath: invocation.streamPath,
    producedTreeNonEmpty: producedTreeNonEmpty(sandbox.workingDir),
  };
  if (resultSubtype !== undefined) result.resultSubtype = resultSubtype;
  if (cost !== undefined) result.cost = cost;
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
