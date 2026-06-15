// The one hexagonal seam (Plan v2 §2): the `Runner` port wraps the volatile `claude -p` I/O so the routing
// probe (extract/control/probe) is testable against recorded streams with ZERO API spend. `live.ts` (real
// CLI, stream-json capture) and `replay.ts` (recorded RunResult) both implement this interface, so swapping
// them needs no caller change — DIP at the real seam only.
//
// PORT of benchmark/src/runner/port.ts, trimmed of all scoring: the whole `Cost`/`RunRecord`/`Arm` contract
// is dropped. selfeval's record is the MINIMAL `RunResult` — exactly what the extractor's one-shot
// disambiguator needs, nothing more. Capture is selfeval's ONLY mode (no scoring path to preserve), so the
// `captureStream` opt-in flag is gone and `streamPath` is unconditional.

/**
 * The minimal per-run record selfeval's extractor consumes (Plan v2 §3). Far smaller than benchmark's
 * `RunRecord` — no cost, no grade, no raw envelope, no produced-tree list:
 *   - `streamPath` is the captured `stream.jsonl` this run wrote (the extractor's only file input);
 *   - `resultSubtype` is `result.subtype` when the run settled (present on one-shot / no-dispatch runs);
 *   - `producedTreeNonEmpty` is the one-shot disambiguator's tree signal (OQ1) — a boolean, not a tree.
 */
export interface RunResult {
  /** The captured `stream.jsonl` this run wrote — the extractor's only file input. */
  streamPath: string;
  /** `result.subtype` when the run settled (present on one-shot / no-dispatch runs; absent on a killed run). */
  resultSubtype?: string;
  /** The OQ1 one-shot disambiguator's tree signal: did the run leave a non-empty produced tree? */
  producedTreeNonEmpty: boolean;
}

/**
 * The Sandbox a run executes inside — a fresh temp working dir + two fresh, relocated memory roots, plus the
 * env that points `claude -p` at them. PINNED to match `prepareSandbox`'s output (`io/sandbox.ts` owns
 * BUILDING a Sandbox; this port owns the TYPE so it is defined once and not duplicated — CLAUDE.md). The
 * Runner RECEIVES a prepared Sandbox; it never builds one. Ported verbatim from benchmark.
 */
export interface Sandbox {
  /** Fresh temp working dir the agent runs in (its produced tree is rooted here). */
  workingDir: string;
  /** Resolved fresh global memory root for this run (via `AGENTRY_GLOBAL_DIR`). */
  globalRoot: string;
  /** Resolved fresh project memory root for this run (via `AGENTRY_PROJECT_DIR`). */
  projectRoot: string;
  /** Env to spawn `claude -p` with — carries the root overrides; passed through verbatim. */
  env: NodeJS.ProcessEnv;
}

/**
 * What to run, independent of WHERE it runs (the Sandbox). The probe assembles this: the prompt, the model to
 * pin, and the (optional) plugin layer. Model and `pluginDir` are DISCOVERED from config/env by the caller and
 * passed in — the Runner hard-codes nothing (CLAUDE.md generic constraint).
 *
 * Trimmed vs benchmark's `Invocation`: the `captureStream` opt-in flag is GONE (capture is selfeval's only
 * mode), and `streamPath` is REQUIRED, not optional (every run tees its stream).
 */
export interface Invocation {
  /** The full prompt handed to `claude -p` (the routing task). */
  prompt: string;
  /** The model id to pin for the run (e.g. `"claude-opus-4-8[1m]"`). */
  model: string;
  /**
   * Where the captured event stream is teed, one per run. Named `stream.jsonl` (NOT `events.jsonl` — the
   * primer hook owns that name in the work dir; ADR-002/005). Surfaces on the resulting `RunResult.streamPath`.
   */
  streamPath: string;
  /** Repo root to load the Agentry plugin from (`--plugin-dir`). Absent ⇒ no Agentry layer. */
  pluginDir?: string;
  /** Tools to allow non-interactively (e.g. `["Task"]`); defaults handled by the impl if omitted. */
  allowedTools?: string[];
  /** Permission mode for the headless run (e.g. `"bypassPermissions"`). */
  permissionMode?: string;
}

/** The port: run an invocation inside a prepared sandbox and return the captured `RunResult`. */
export interface Runner {
  run(invocation: Invocation, sandbox: Sandbox): Promise<RunResult>;
}
