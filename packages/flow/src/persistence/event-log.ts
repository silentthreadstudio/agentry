// Event log — the append-only `.agentry/work/<run>/events.jsonl` (ADR-002, AC8). One of the state
// holders (AC6: the stream survives a server kill). `append` validates the FLOW event through the
// closed union before writing one JSON line; `tail` streams the file back, optionally filtered to
// lines at/after `since` (an ISO timestamp), leaving classification to the reader's `parseLogLine`.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FlowEvent } from "../domain/events.js";
import type { EventLog as EventLogPort } from "../domain/ports.js";
import { runDir } from "../resolution/run-pointer.js";

export class JsonlEventLog implements EventLogPort {
  constructor(private readonly cwd: string) {}

  private logPath(run: string): string {
    return join(runDir(this.cwd, run), "events.jsonl");
  }

  // Validate through the closed FLOW union (a malformed event can never reach the stream — the
  // schema enforcement of AC8's typed vocabulary), then append exactly one line.
  append(run: string, event: FlowEvent): void {
    const validated = FlowEvent.parse(event);
    const dir = runDir(this.cwd, run);
    mkdirSync(dir, { recursive: true });
    appendFileSync(this.logPath(run), `${JSON.stringify(validated)}\n`);
  }

  // Return the raw lines (newest-relevant left to the reader). `since` filters by the `ts` field
  // lexicographically — ISO-8601 timestamps sort chronologically, so a string compare is correct.
  tail(run: string, since?: string): string[] {
    const path = this.logPath(run);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
    if (since === undefined) return lines;
    return lines.filter((line) => {
      try {
        const ts = (JSON.parse(line) as { ts?: unknown }).ts;
        return typeof ts === "string" && ts >= since;
      } catch {
        return false; // a corrupt line is dropped from a filtered tail, never throws
      }
    });
  }
}
