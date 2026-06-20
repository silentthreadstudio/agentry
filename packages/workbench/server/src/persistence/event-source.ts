// FsEventSource — the fs adapter behind the `EventSource` port (ADR-001). The ONLY reader of a run's two
// run-level event files: `events.jsonl` (the timeline source) and `run-state.json` (the roster source).
// It owns the bytes; `EventStore` (application) owns the parse/fold policy — this adapter never interprets
// a line, it only reads the file and hands the application loose data.
//
// `cwd` (the project root) is injected and threaded on every path via FLOW's traversal-safe `runDir` — no
// ambient cwd, mirroring FsWorkRepository. An absent file is not an error: `eventLines` reads as `[]` and
// `runState` as `undefined`, so a fresh run (no events / no roster yet) folds to empty rather than throwing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "@agentry/flow/resolution/run-pointer";
import type { EventSource } from "../domain/ports.js";

export class FsEventSource implements EventSource {
  constructor(private readonly cwd: string) {}

  // `events.jsonl` split into lines, or `[]` when absent. The application indexes the lines (the feed key)
  // and runs FLOW's `parseLogLine` over each — this adapter does no line interpretation.
  eventLines(run: string): string[] {
    const log = join(runDir(this.cwd, run), "events.jsonl");
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8").split("\n");
  }

  // `run-state.json` parsed to loose data, or `undefined` when absent/unparseable. A corrupt file reads as
  // `undefined` (the application surfaces it as an empty roster) rather than throwing.
  runState(run: string): unknown {
    const path = join(runDir(this.cwd, run), "run-state.json");
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  }
}
