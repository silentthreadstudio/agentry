// The reporter's READ side (doc 08 §6) — reconstructs a {@link PageData} view-model from a STORED run with ZERO
// live API. The PUBLIC report LEADS with the value-axis BENCH plus the Tasks explorer. It reads the run's
// `summary.json` (for the per-task labels), `events.jsonl` (per-task shapes + timings), and the optional
// `decision-quality.json` (ONLY the per-task overalls the Tasks drawer shows) — then folds in the bench loader,
// the curated corrections log, and the run-history index.
//
// SRP: parse + assemble only. No rendering (that's `render.ts`), no writing (that's `emit.ts`). It reuses the
// store's `safeRunDir`/`readRunConfig` path-confinement rather than re-implementing it, and the sibling adapters
// `corrections.ts` / `history.ts` for the two non-run-scoped sections — so this module stays focused on turning
// ONE run's stored files into the run-scoped projection.
//
// Defensive by design: a run without `decision-quality.json` yields no per-task quality (a one-shot task with no
// judged artifact gets `quality: null`); a run without a public-probe run in the store yields a page whose
// public sections degrade to empty states. The store keeps the raw artifact `unknown` (store/schema.ts), so the
// local raw shapes below narrow it field-by-field.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { safeRunDir, readRunConfig } from "../store/read.ts";
import type { RunSummary } from "../store/schema.ts";
import type {
  Correction,
  HistoryRow,
  PageData,
  TaskData,
} from "./model.ts";
import { loadCorrections } from "./corrections.ts";
import { loadHistory } from "./history.ts";
import { loadBench } from "./load-bench.ts";

/** Options for {@link buildPageData}: where the curated corrections file lives, and a stamped generation time. */
export interface BuildOptions {
  /** Path to the curated corrections JSON; absent/missing → an empty corrections log (degrades gracefully). */
  correctionsPath?: string;
  /** ISO timestamp to stamp as `meta.generatedAt` (injected, not wall-clock-read here, so callers control it). */
  generatedAt: string;
}

/**
 * Assemble the full {@link PageData} for one stored run. Reads the run's `summary.json` (required) plus the optional
 * `events.jsonl` and `decision-quality.json`, then folds in the curated corrections log and the run-history index.
 * Throws loudly if the run dir / `summary.json` is absent; a bad run-id is rejected by `safeRunDir`.
 */
export function buildPageData(runsRoot: string, runId: string, opts: BuildOptions): PageData {
  const runDir = safeRunDir(runsRoot, runId);
  const config = readRunConfig(runsRoot, runId);

  const summaryPath = join(runDir, "summary.json");
  if (!existsSync(summaryPath)) throw new Error(`buildPageData: run ${runId} has no summary.json`);
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as RunSummary;
  const routingRaw = summary.artifact as RawRoutingArtifact;

  const perTaskRuns = parseEvents(join(runDir, "events.jsonl")); // taskId → ordered {shape, ms}[]
  const perTaskQuality = readPerTaskQuality(join(runDir, "decision-quality.json")); // taskId → per-repeat overall

  // The PUBLIC LEAD — the BENCH (the value-axis quality bench, its own `kind:"bench"` run), surfaced as the LATEST
  // in the store. The bench SUBSUMES the earlier rightsizing + honesty probes (Axis B ≈ rightsizing result-quality,
  // Axis C ≈ honesty/overclaim), so the public page leads with it and no longer attaches rightsizing/honesty (their
  // loaders are kept for a later cleanup, just not on the public lead). Zero live API in the loader.
  const bench = loadBench(runsRoot); // the latest bench run (four absolute value axes + the showcase strip)

  return {
    meta: {
      runId: summary.runId,
      fixture: config.fixtureDir ? basename(config.fixtureDir) : "—",
      repeats: config.runs ?? 1,
      // De-Sonnet (ADR-003): the model label flows from the run's `--model` flag, never a hardcoded "Sonnet".
      model: config.model ?? "—",
      generatedAt: opts.generatedAt,
    },
    ...(bench !== undefined ? { bench } : {}),
    // rightsizing/honesty are SUBSUMED by the bench and no longer attached on the public lead; routing/quality stay
    // PARKED off the public path (ADR-002/ADR-003). The raw routing artifact is still read LOCALLY to label the
    // per-task rows; it just never becomes a public page section.
    tasks: buildTasks(routingRaw, perTaskRuns, perTaskQuality),
    corrections: loadCorrections(opts.correctionsPath),
    history: loadHistory(runsRoot, summary.runId),
  };
}

// --- tasks (events.jsonl + stability + quality) ------------------------------------------------------------------
// The stored routing artifact is read ONLY to label the per-task rows (its stability table carries each task's
// labeled floor + the noisy set). The routing label-match VIEW (confusion/accuracy) is retired off the public
// path (ADR-002/ADR-003), so this raw shape narrows just the two fields `buildTasks` consumes — nothing more.

interface RawStabilityRow { taskId: string; labeledFloor: string; modalShape: string; stability: number }
interface RawRoutingArtifact {
  stabilityTable?: RawStabilityRow[];
  noisyTasks?: string[];
}

interface TaskRun { shape: string; ms: number }

/** Parse `events.jsonl` task-done lines into `taskId → ordered {shape, ms}[]` (the per-repeat dispatch record). */
function parseEvents(eventsPath: string): Map<string, TaskRun[]> {
  const out = new Map<string, TaskRun[]>();
  if (!existsSync(eventsPath)) return out;
  // detail looks like: "1/6 routing-format-price → one-shot (42046ms)"
  const re = /^\d+\/\d+\s+(\S+)\s+→\s+(\S+)\s+\((\d+)ms\)/;
  for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: { kind?: string; detail?: string };
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.kind !== "task-done" || !ev.detail) continue;
    const m = re.exec(ev.detail);
    if (!m) continue;
    const [, taskId, shape, ms] = m;
    if (!out.has(taskId!)) out.set(taskId!, []);
    out.get(taskId!)!.push({ shape: shape!, ms: Number(ms) });
  }
  return out;
}

/** Build the per-task rows from the routing artifact's labels + the events' per-repeat dispatches + quality scores. */
function buildTasks(
  a: RawRoutingArtifact,
  perTaskRuns: Map<string, TaskRun[]>,
  perTaskQuality: Map<string, number[]>,
): TaskData[] {
  const floorOf = new Map<string, string>();
  for (const row of a.stabilityTable ?? []) floorOf.set(row.taskId, row.labeledFloor);
  const noisy = new Set(a.noisyTasks ?? []);

  const tasks: TaskData[] = [];
  // Drive off the stability table when present (carries the labeled floor); else off the events keys.
  const ids = (a.stabilityTable ?? []).map((r) => r.taskId);
  if (ids.length === 0) ids.push(...perTaskRuns.keys());

  for (const id of ids) {
    const runs = perTaskRuns.get(id) ?? [];
    const q = perTaskQuality.get(id);
    tasks.push({
      id,
      floor: floorOf.get(id) ?? runs[0]?.shape ?? "?",
      shapes: runs.map((r) => r.shape),
      t: runs.map((r) => Math.round(r.ms / 100) / 10), // ms → seconds, 1 decimal
      fork: "", // not captured in the store yet — the drawer shows the dispatched shapes + quality instead
      quality: q && q.length > 0 ? q : null,
      noisy: noisy.has(id),
    });
  }
  return tasks;
}

// --- quality -----------------------------------------------------------------------------------------------------
// Decision-quality is PARKED off the public path (ADR-002): no quality VIEW (overall/dims/controls) ships on the
// public report. The stored `decision-quality.json` is read ONLY for the per-task overall scores the Tasks explorer
// drawer still shows — never the aggregate quality section, which is retired.

interface RawQualityFile {
  scores?: Array<{ taskId: string; score: { overall: number } }>;
}

/** Read `decision-quality.json` (optional) into a `taskId → per-repeat overall[]` map for the Tasks explorer rows. */
function readPerTaskQuality(qualityPath: string): Map<string, number[]> {
  const perTask = new Map<string, number[]>();
  if (!existsSync(qualityPath)) return perTask;

  const raw = JSON.parse(readFileSync(qualityPath, "utf8")) as RawQualityFile;
  for (const s of raw.scores ?? []) {
    if (!perTask.has(s.taskId)) perTask.set(s.taskId, []);
    perTask.get(s.taskId)!.push(s.score.overall);
  }
  return perTask;
}

// Re-export the two folded-in section types so consumers can import the whole contract from one place if they wish.
export type { Correction, HistoryRow };
