// TokenReader — the Tokens page data (plan §6). Folds a run's Claude Code transcript samples (from the
// `TranscriptSource` adapter) into the chart-friendly `TokenSeries`: per-day buckets, cumulative across
// the run. PURE of HTTP/ws (ADR-001): it depends only on the `TranscriptSource` port, so it is
// unit-testable against a fake source with no real transcript tree.
//
// ── Graceful degrade (plan §7.3) ─────────────────────────────────────────────────────────────────────
// The transcript source is the least-pinned contract; the `TranscriptReader` adapter already degrades to
// zero samples when the on-disk shape is absent. This service simply folds whatever samples it is handed —
// no samples ⇒ a clean empty `TokenSeries` ({ timestamps: [], tokens: [] }), the acceptable V1 empty state.
import type { TokenSeries } from "@agentry/workbench-shared";
import type { TokenSample, TranscriptSource } from "../domain/ports.js";

export class TokenReader {
  constructor(private readonly transcripts: TranscriptSource) {}

  // The token series for one run: token usage bucketed by calendar day (UTC), accumulated so each point is
  // the running total through that day — the shape the usage chart plots. Days are sorted ascending; a run
  // with no samples returns a clean empty series (the graceful-degrade empty state).
  series(run: string): TokenSeries {
    const perDay = this.bucketByDay(this.transcripts.read(run));
    const days = [...perDay.keys()].sort();

    const timestamps: string[] = [];
    const tokens: number[] = [];
    let cumulative = 0;
    for (const day of days) {
      cumulative += perDay.get(day) ?? 0;
      timestamps.push(day);
      tokens.push(cumulative);
    }
    return { timestamps, tokens };
  }

  // Sum the samples into per-day totals keyed by the sample's UTC calendar day (the `YYYY-MM-DD` prefix of
  // its ISO timestamp). A sample whose timestamp has no parseable day prefix is dropped (it can't be placed
  // on the day axis) rather than corrupting a bucket.
  private bucketByDay(samples: TokenSample[]): Map<string, number> {
    const perDay = new Map<string, number>();
    for (const { timestamp, tokens } of samples) {
      const day = dayOf(timestamp);
      if (day === null) continue;
      perDay.set(day, (perDay.get(day) ?? 0) + tokens);
    }
    return perDay;
  }
}

// The UTC calendar day for an ISO timestamp — the `YYYY-MM-DD` prefix. Returns null when the string isn't a
// parseable date (so a malformed sample is dropped, never mis-bucketed).
function dayOf(timestamp: string): string | null {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}
