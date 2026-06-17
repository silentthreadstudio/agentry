// Builds the run-history table by scanning the runs root (doc 08 §6 — the dashboard's "Run history" view). Every
// captured run persists a `summary.json`; this module reads each one, summarizes it into a {@link HistoryRow}, and
// sorts newest-first. The "capture-once, analyze-many" payoff made visible: past runs become browsable rows with no
// re-run.
//
// SRP: directory scan + per-run summarization only. It tolerates non-run entries in the runs root (e.g. a `_mockup`
// folder, stray files) by skipping anything without a readable `summary.json`. Dates are formatted from the stored
// ISO strings — no wall-clock read here, so the output is a pure function of what's on disk.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { RunSummary } from "../store/schema.ts";
import type { HistoryRow } from "./model.ts";

/**
 * Scan `runsRoot` for run directories and summarize each into a {@link HistoryRow}, newest-first. `currentId` marks
 * the row this report is about (`cur: true`). Entries without a parseable `summary.json` are skipped (not every
 * child of the runs root is a run). Quality is read from the optional sibling `decision-quality.json`.
 */
export function loadHistory(runsRoot: string, currentId: string): HistoryRow[] {
  if (!existsSync(runsRoot)) return [];

  const rows: Array<HistoryRow & { _started: string }> = [];
  for (const name of readdirSync(runsRoot)) {
    const dir = join(runsRoot, name);
    if (!isDir(dir)) continue;
    const summaryPath = join(dir, "summary.json");
    if (!existsSync(summaryPath)) continue;

    let s: RunSummary;
    try {
      s = JSON.parse(readFileSync(summaryPath, "utf8")) as RunSummary;
    } catch {
      continue;
    }
    const cfg = s.config;
    const routing = (s.artifact as { accuracyDistribution?: { accuracyMean?: number }; accuracy?: number }) ?? {};
    const rt = routing.accuracyDistribution?.accuracyMean ?? routing.accuracy ?? 0;

    rows.push({
      id: s.runId,
      fixture: cfg.fixtureDir ? cfg.fixtureDir.split("/").pop()! : "—",
      n: s.taskCount,
      k: cfg.runs ?? 1,
      when: fmtWhen(cfg.startedAt),
      dur: fmtDur(cfg.startedAt, s.finishedAt),
      rt,
      qa: readQualityMean(join(dir, "decision-quality.json")),
      cur: s.runId === currentId,
      _started: cfg.startedAt,
    });
  }

  rows.sort((a, b) => b._started.localeCompare(a._started));
  return rows.map(({ _started, ...row }) => row);
}

/** Read just the `overallMean` out of an optional `decision-quality.json` (null when the run had no quality pass). */
function readQualityMean(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const q = JSON.parse(readFileSync(path, "utf8")) as { overallMean?: number };
    return q.overallMean ?? null;
  } catch {
    return null;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Format an ISO timestamp as "Jun 17 · 11:58" (UTC fields off the stored string — stable, no locale drift). */
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} · ${hh}:${mm}`;
}

/** Format the elapsed time between two ISO timestamps as "29m" or "1h12m". */
function fmtDur(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const mins = Math.round(ms / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}`;
}

/** True iff `path` is a directory. */
function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
