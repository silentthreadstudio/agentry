// The flow-compliance trace reader — the ONLY I/O in this dimension. It reads the OBSERVABLE Flow surface of a
// run dir (`.agentry/work/<id>/`): the `events.jsonl` line log, the work-folder artifacts (`spec.md`, the
// `tasks/NNN-*.md` files), and the `run-state.json` presence. It does NOT parse the live transcript/dispatch
// stream (ADR-004's rejected anti-pattern); the assertion module (`assertions.ts`) is pure over the `RunTrace`
// this produces, so the load-bearing logic is forced-testable with synthetic traces and zero disk.
//
// THE VOCABULARY (AS-BUILT, decided by ADR-001/ADR-004 + the B1 hook):
//   - FLOW events carry a `type` field (the closed set: routing-decision | gate | node-enter | node-done).
//   - The subagent backstop lines carry a `kind` field and NO `type` (e.g. agent-started/agent-done).
//   - The B1 `flow-skipped` marker is a backstop line: `{ ts, kind:"flow-skipped", artifact, path }` — `kind`,
//     never `type`. So a `flow-skipped` line is NEVER a FLOW event and never counts as "a run exists".

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The closed FLOW event vocabulary — a `type`-bearing line. A line with only `kind` is a backstop, not FLOW. */
export const FLOW_TYPES = ["routing-decision", "gate", "node-enter", "node-done"] as const;
export type FlowType = (typeof FLOW_TYPES)[number];

/** One parsed `events.jsonl` line. Either FLOW (`type` set) or backstop (`kind` set); `flow-skipped` is the latter. */
export interface TraceEvent {
  /** ISO8601 timestamp the line carries (used for the ordering assertions). */
  ts: string;
  /** The FLOW event type, when this is a `type`-bearing FLOW line; absent on backstop lines. */
  type?: string;
  /** The backstop `kind`, when this is a `kind`-bearing line (agent-started/agent-done/flow-skipped); absent on FLOW. */
  kind?: string;
  /** The `artifact` field of a `flow-skipped` marker ("spec"|"plan"|"task"); absent otherwise. */
  artifact?: string;
}

/** One task file under `tasks/` with its raw text (the single-frontmatter assertion parses this). */
export interface TaskFile {
  /** The file name (e.g. `008-c2-….md`) — the assertion reports it on failure. */
  name: string;
  /** Raw UTF-8 contents. */
  text: string;
  /** Mtime in epoch-ms (the spec-before-tasks ordering tiebreak when no event ts is available). */
  mtimeMs: number;
}

/** The observable trace of one run dir — the pure input the assertion module consumes. */
export interface RunTrace {
  /** The run dir read (`.agentry/work/<id>/`), echoed for provenance. */
  runDir: string;
  /** Whether `run-state.json` is present (one of the two "a run exists" signals). */
  hasRunState: boolean;
  /** The parsed `events.jsonl` lines in file order (empty if the file is absent). */
  events: readonly TraceEvent[];
  /** Whether `spec.md` is present in the run dir. */
  hasSpec: boolean;
  /** `spec.md`'s mtime in epoch-ms, or null when absent. */
  specMtimeMs: number | null;
  /** Whether `plan.md` is present (an orchestration artifact — part of the artifact-based above-floor signal). */
  hasPlan: boolean;
  /** The `tasks/NNN-*.md` files, sorted by name (empty if there is no `tasks/` dir). */
  taskFiles: readonly TaskFile[];
}

/** Parse one `events.jsonl` line into a {@link TraceEvent}; returns null for blank/malformed lines (skipped). */
function parseEventLine(line: string): TraceEvent | null {
  if (!line.trim()) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const ts = typeof obj.ts === "string" ? obj.ts : "";
  const event: TraceEvent = { ts };
  if (typeof obj.type === "string") event.type = obj.type;
  if (typeof obj.kind === "string") event.kind = obj.kind;
  if (typeof obj.artifact === "string") event.artifact = obj.artifact;
  return event;
}

/** Read + parse `events.jsonl` (in file order) — the line log the ordering/skip assertions read. */
function readEvents(runDir: string): TraceEvent[] {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return [];
  const out: TraceEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const ev = parseEventLine(line);
    if (ev !== null) out.push(ev);
  }
  return out;
}

/** Read the `tasks/NNN-*.md` files, sorted by name (the create order the numeric prefix encodes). */
function readTaskFiles(runDir: string): TaskFile[] {
  const tasksDir = join(runDir, "tasks");
  if (!existsSync(tasksDir)) return [];
  const out: TaskFile[] = [];
  for (const name of readdirSync(tasksDir).sort()) {
    if (!name.endsWith(".md")) continue;
    const path = join(tasksDir, name);
    out.push({ name, text: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs });
  }
  return out;
}

/**
 * Read the observable trace of a run dir. Read-only over `events.jsonl` + work-folder artifacts (ADR-004): it
 * never touches the dispatch/transcript stream. A missing run dir throws loudly (a bad `--run` is a setup bug);
 * a present-but-empty surface (no events, no spec, no tasks) is read faithfully so the assertions can judge it.
 */
export function readRunTrace(runDir: string): RunTrace {
  if (!existsSync(runDir)) throw new Error(`flow-compliance: run dir not found: ${runDir}`);
  const specPath = join(runDir, "spec.md");
  const hasSpec = existsSync(specPath);
  return {
    runDir,
    hasRunState: existsSync(join(runDir, "run-state.json")),
    events: readEvents(runDir),
    hasSpec,
    specMtimeMs: hasSpec ? statSync(specPath).mtimeMs : null,
    hasPlan: existsSync(join(runDir, "plan.md")),
    taskFiles: readTaskFiles(runDir),
  };
}
