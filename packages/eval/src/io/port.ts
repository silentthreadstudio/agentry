// The `Runner` port: a PORT of benchmark/src/runner/port.ts, trimmed of all scoring (the
// `Cost`/`RunRecord`/`Arm` contract is dropped). `live.ts` and `replay.ts` both implement it, so the probe is
// testable against recorded streams with zero API spend. Capture is selfeval's only mode, so the
// `captureStream` opt-in flag is gone and `streamPath` is unconditional.

/**
 * The token/time/$ cost of a SETTLED run, parsed from the trailing `result` envelope of
 * `claude -p --output-format stream-json` (ADR-002). Every field is OPTIONAL because a killed/old/partial run
 * has no `result` envelope at all (⇒ `RunResult.cost` is absent) and a present envelope may omit individual
 * fields. Consumed by the outcome score step (T4); routing/moat probes never read it.
 */
export interface RunCost {
  /** `result.usage.input_tokens` (excludes cache reads/creations). */
  inputTokens?: number;
  outputTokens?: number;
  /** `result.usage.cache_read_input_tokens` — prompt tokens served from cache (cheaper). */
  cacheReadTokens?: number;
  totalCostUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

/** The minimal per-run record selfeval's extractor consumes (Plan v2 §3). */
export interface RunResult {
  /** The captured `stream.jsonl` this run wrote — kept for provenance/auditing; no longer the shape input. */
  streamPath: string;
  /** `result.subtype` when the run settled (present on one-shot / no-dispatch runs; absent on a killed run). */
  resultSubtype?: string;
  /** The OQ1 one-shot disambiguator's tree signal: did the run leave a non-empty produced tree? */
  producedTreeNonEmpty: boolean;
  /**
   * REPLAY-ONLY (offline): the work-folder artifact layout this recorded run "left behind" — a map of
   * `.agentry/work/`-relative paths → file contents (e.g. `{"work/x/plan.md": "..."}`). A LIVE run leaves
   * these on disk in `sandbox.workingDir`; a recorded run carries them here so the replay runner can
   * materialize the same layout, keeping the probe's `extractShape(workingDir, …)` call identical across
   * both runners. Absent ⇒ no work-folder artifacts (the one-shot / degenerate path).
   */
  workFolder?: Record<string, string>;
  /**
   * The settled run's token/time/$ cost (ADR-002). ABSENT when the run never settled (a killed routing/moat
   * probe forfeits its `result` envelope) — routing/moat ignore this field, so its addition is byte-for-byte
   * inert for them (AC8). Consumed by the outcome score step (T4).
   */
  cost?: RunCost;
}

/**
 * The Sandbox a run executes inside — a fresh temp working dir + two fresh, relocated memory roots, plus the
 * env that points `claude -p` at them. This port owns the TYPE so it is defined once and not duplicated
 * (CLAUDE.md); `io/sandbox.ts` owns building one. The Runner RECEIVES a prepared Sandbox; it never builds one.
 */
export interface Sandbox {
  /** Fresh temp working dir the agent runs in (its produced tree is rooted here). */
  workingDir: string;
  /** Fresh global memory root for this run (via `AGENTRY_GLOBAL_DIR`). */
  globalRoot: string;
  /** Fresh project memory root for this run (via `AGENTRY_PROJECT_DIR`). */
  projectRoot: string;
  /** Env to spawn `claude -p` with — carries the root overrides. */
  env: NodeJS.ProcessEnv;
}

/**
 * What to run, independent of WHERE it runs (the Sandbox). Model and `pluginDir` are DISCOVERED from
 * config/env by the caller and passed in — the Runner hard-codes nothing (CLAUDE.md generic constraint).
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
  permissionMode?: string;
  /**
   * CAPPED / no-kill mode (autopilot-design §3): when true the runner does NOT kill on the first `Agent`
   * dispatch — it lets the conductor run and emit its work-folder routing artifacts, terminating only at
   * process settle OR `timeoutMs`. The artifact-based extractor reads the work folder for the shape, so the
   * run must be allowed to PRODUCE those artifacts. Absent/false ⇒ the original kill-on-first-dispatch.
   */
  noKillOnDispatch?: boolean;
  /**
   * ARTIFACT-AWARE early-terminate (autopilot-design §3): when true the runner POLLS the sandbox work folder
   * (`<workingDir>/.agentry/work/*`) and kills as soon as the routing shape is DETERMINED — `plan.md`/non-empty
   * `tasks/` ⇒ decompose (kill at once); `spec.md`-only past a grace window ⇒ spec-first. A run that writes no
   * artifact and settles on its own is one-shot/degenerate (never force-killed). Terminating on the ARTIFACT
   * (not the dispatch) reads the shape more accurately AND kills earlier (never building the feature).
   * Supersedes {@link noKillOnDispatch} for live routing runs; {@link timeoutMs} remains the hard-ceiling.
   */
  terminateOnArtifact?: boolean;
  /**
   * RUN-TO-COMPLETION mode (ADR-002): when true the runner takes NEITHER early-kill path, so the build runs
   * until the agent settles on its trailing `result` envelope OR {@link timeoutMs} fires. This is the outcome
   * run's mode: the feature must actually be BUILT, so a build that dispatches many subagents must not be
   * killed on the first. Overrides both kill flags when set. Absent/false ⇒ routing behavior is UNCHANGED —
   * routing/moat probes never set this, so their behavior is byte-for-byte preserved (AC8).
   */
  runToCompletion?: boolean;
  /**
   * Per-invocation HARD CEILING (ms) — the fallback that kills the child if no dispatch/artifact/settle ends
   * the run first, so a `decompose` build cannot run unbounded. The kill-on-dispatch path settles on dispatch
   * and ignores it. Defaults to ~300s (raised so a slow stochastic roll has room to write its artifact before
   * artifact-aware termination kicks in).
   */
  timeoutMs?: number;
}

/** The port: run an invocation inside a prepared sandbox and return the captured `RunResult`. */
export interface Runner {
  run(invocation: Invocation, sandbox: Sandbox): Promise<RunResult>;
}
