// The reporter's READ side (doc 08 §6) — reconstructs a {@link PageData} view-model from a STORED run with ZERO
// live API. It reads the three artifacts a run persists — `summary.json` (routing aggregates), `events.jsonl`
// (per-task shapes + timings), `decision-quality.json` (quality scores) — narrows them into the wire shape the
// dashboard template consumes, and folds in the curated corrections log + the run-history index.
//
// SRP: parse + assemble only. No rendering (that's `render.ts`), no writing (that's `emit.ts`). It reuses the
// store's `safeRunDir`/`readRunConfig` path-confinement rather than re-implementing it, and the sibling adapters
// `corrections.ts` / `history.ts` for the two non-run-scoped sections — so this module stays focused on turning
// ONE run's stored files into the run-scoped projection.
//
// Defensive by design: a pure-routing run (no `decision-quality.json`) yields an empty quality view rather than an
// error; a one-shot task with no judged artifact gets `quality: null`. The store keeps the raw artifact `unknown`
// (store/schema.ts), so the local raw shapes below narrow it field-by-field.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { safeRunDir, readRunConfig } from "../store/read.ts";
import type { RunSummary } from "../store/schema.ts";
import type {
  Correction,
  HistoryRow,
  PageData,
  QualityData,
  RoutingData,
  TaskData,
} from "./model.ts";
import { loadCorrections } from "./corrections.ts";
import { loadHistory } from "./history.ts";
import { loadMoat } from "./moat.ts";

/** Canonical shape vocabulary in escalation order — the confusion matrix rows/cols. */
const FLOORS = ["one-shot", "spec-first", "decompose"];

/** Rubric key → display label (the order the radar + bars present). */
const DIM_LABELS: Record<string, string> = {
  forkSurfacing: "Fork surfacing",
  decisionSoundness: "Decision soundness",
  accountability: "Accountability",
  scope: "Scope discipline",
  coherence: "Coherence",
};

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
  const quality = readQuality(join(runDir, "decision-quality.json"));

  const moat = loadMoat(runsRoot); // the latest scored moat run (its own run kind), surfaced beside routing/quality

  return {
    meta: {
      runId: summary.runId,
      fixture: config.fixtureDir ? basename(config.fixtureDir) : "—",
      repeats: config.runs ?? 1,
      generatedAt: opts.generatedAt,
    },
    routing: narrowRouting(routingRaw),
    quality: quality.view,
    tasks: buildTasks(routingRaw, perTaskRuns, quality.perTask),
    corrections: loadCorrections(opts.correctionsPath),
    history: loadHistory(runsRoot, summary.runId),
    ...(moat !== undefined ? { moat } : {}),
  };
}

// --- routing -----------------------------------------------------------------------------------------------------

interface RawConfusionCell { labeledFloor: string; dispatched: string; count: number }
interface RawStabilityRow { taskId: string; labeledFloor: string; modalShape: string; stability: number }
interface RawRoutingArtifact {
  accuracy?: number;
  confusionMatrix?: RawConfusionCell[];
  stabilityTable?: RawStabilityRow[];
  noisyTasks?: string[];
  overRoutes?: Array<{ taskId?: string }>;
  underRoutes?: Array<{ taskId?: string }>;
  accuracyDistribution?: { perRunAccuracy?: number[]; accuracyMean?: number; accuracyStd?: number };
}

/** Narrow the stored routing artifact into the {@link RoutingData} wire shape (confusion → keyed map). */
function narrowRouting(a: RawRoutingArtifact): RoutingData {
  const confusion: Record<string, number> = {};
  for (const c of a.confusionMatrix ?? []) confusion[`${c.labeledFloor}|${c.dispatched}`] = c.count;
  const dist = a.accuracyDistribution ?? {};
  const acc = a.accuracy ?? 0;
  return {
    perRun: dist.perRunAccuracy ?? [acc],
    mean: dist.accuracyMean ?? acc,
    std: dist.accuracyStd ?? 0,
    floors: FLOORS,
    confusion,
    noisy: a.noisyTasks ?? [],
    overRoutes: (a.overRoutes ?? []).map((r) => r.taskId ?? "?"),
    underRoutes: (a.underRoutes ?? []).map((r) => r.taskId ?? "?"),
  };
}

// --- tasks (events.jsonl + stability + quality) ------------------------------------------------------------------

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

interface RawQualityFile {
  scores?: Array<{ taskId: string; score: { dimensions: Record<string, number>; overall: number } }>;
  overallMean?: number;
  controls?: { aaStdev?: number; goldOverall?: number; poorOverall?: number };
}

/** Read `decision-quality.json` (optional) into the {@link QualityData} view + a per-task overall map for the tasks. */
function readQuality(qualityPath: string): { view: QualityData; perTask: Map<string, number[]> } {
  const empty: QualityData = { overall: 0, dims: {}, controls: { gold: 0, poor: 0, aa: 0 } };
  const perTask = new Map<string, number[]>();
  if (!existsSync(qualityPath)) return { view: empty, perTask };

  const raw = JSON.parse(readFileSync(qualityPath, "utf8")) as RawQualityFile;
  const scores = raw.scores ?? [];
  if (scores.length === 0) return { view: empty, perTask };

  // per-dimension means (display-labeled) + per-task overall list (in stored order)
  const dims: Record<string, number> = {};
  for (const [key, label] of Object.entries(DIM_LABELS)) {
    dims[label] = mean(scores.map((s) => s.score.dimensions[key] ?? 0));
  }
  for (const s of scores) {
    if (!perTask.has(s.taskId)) perTask.set(s.taskId, []);
    perTask.get(s.taskId)!.push(s.score.overall);
  }

  const view: QualityData = {
    overall: raw.overallMean ?? mean(scores.map((s) => s.score.overall)),
    dims,
    controls: {
      gold: raw.controls?.goldOverall ?? 0,
      poor: raw.controls?.poorOverall ?? 0,
      aa: raw.controls?.aaStdev ?? 0,
    },
  };
  return { view, perTask };
}

/** Arithmetic mean of a non-empty list. */
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Re-export the two folded-in section types so consumers can import the whole contract from one place if they wish.
export type { Correction, HistoryRow };
