// The pure shape-extractor (ADR-001): infer the dispatched `Shape` from a captured `claude -p` event stream.
//
// GENERALIZES the dispatch-parse proven in benchmark/src/smoke/subagent-cost.ts:148-208 (NDJSON parse
// tolerating noise lines; `tool_use name:"Agent"` in `assistant` messages; `subagent_type` in the block
// input) into a pure, side-effect-free library function — it is NOT an import of that script (which spends
// API at module load). The only I/O here is reading the stream file the runner already wrote; the one-shot
// disambiguator's extra signals (`resultSubtype`, `producedTreeNonEmpty`) arrive via `ctx` so the dispatch
// classification stays pure data-over-lines.

import { readFileSync } from "node:fs";

import type { RoleFamily, Shape } from "./shape.ts";
import { roleFamilyOf, shapeForDispatch } from "./shape.ts";

/**
 * The settle signals the no-dispatch case needs to tell a genuine `one-shot` from a degenerate/aborted run.
 * Supplied by the driver from `RunResult` (the runner already observed them) so `extractShape` does no fs
 * walk of its own and stays pure over the stream:
 *   - `resultSubtype`        — `result.subtype` of the settled run; `'success'` marks a clean settle. Absent
 *                              on a killed/aborted run (no trailing `result` envelope).
 *   - `producedTreeNonEmpty` — did the run leave a non-empty produced tree (the OQ1 one-shot tree signal)?
 */
export interface ExtractContext {
  resultSubtype?: string;
  producedTreeNonEmpty: boolean;
}

/** Thrown when a no-dispatch run is NOT a clean settle — an indeterminate/degenerate run, never `one-shot`. */
export class DegenerateRunError extends Error {
  constructor(streamPath: string, reason: string) {
    super(`indeterminate/degenerate run (not one-shot): ${reason} [stream: ${streamPath}]`);
    this.name = "DegenerateRunError";
  }
}

/**
 * Parse the captured stream into the set of role families dispatched. Reads the stream-json shape
 * (`{type:"assistant", message:{content:[{type:"tool_use", name:"Agent", input:{subagent_type}}]}}`),
 * tolerating non-JSON noise lines and partial/garbled tails (a captured stream after early-terminate has no
 * trailing `result` envelope and may end mid-line). Every `subagent_type` named in an `Agent` dispatch is
 * classified into its {@link RoleFamily} by name (roster-agnostic).
 */
function dispatchedFamilies(streamLog: string): Set<RoleFamily> {
  const families = new Set<RoleFamily>();
  for (const line of streamLog.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // tolerate non-JSON noise / a truncated final line
    }
    if (typeof event !== "object" || event === null) continue;
    const ev = event as { type?: unknown; message?: { content?: unknown } };
    if (ev.type !== "assistant") continue;
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: unknown; name?: unknown; input?: unknown };
      if (b.type !== "tool_use" || b.name !== "Agent") continue;
      const input = b.input;
      if (typeof input !== "object" || input === null) continue;
      const subagentType = (input as { subagent_type?: unknown }).subagent_type;
      if (typeof subagentType !== "string" || subagentType === "") continue;
      families.add(roleFamilyOf(subagentType));
    }
  }
  return families;
}

/**
 * Infer the dispatched {@link Shape} from a captured event stream (ADR-001). Pure: the only effect is reading
 * `streamPath` (the file the runner already wrote); the verdict is a function of the parsed dispatch set and
 * the `ctx` settle signals.
 *
 * Mapping (the rule lives in `shape.ts`):
 *   - any implementer dispatched                         ⇒ `decompose`
 *   - dispatch present, no implementer                   ⇒ `spec-first`
 *   - ZERO dispatch AND resultSubtype==='success' AND producedTreeNonEmpty ⇒ `one-shot`
 *   - ZERO dispatch otherwise                            ⇒ NOT one-shot — throws {@link DegenerateRunError}
 *
 * The degenerate-case fallback is an explicit THROW, not a silent label: a no-dispatch run that did not settle
 * cleanly (no `success`, or an empty produced tree — e.g. an aborted/errored run) can never be mistaken for a
 * genuine one-shot. A genuine one-shot is exactly the run that settles, so its `result` envelope (hence
 * `resultSubtype`) IS present; this branch never requires a trailing `result` on a dispatched/killed stream.
 */
export function extractShape(streamPath: string, ctx: ExtractContext): Shape {
  const streamLog = readFileSync(streamPath, "utf8");
  const families = dispatchedFamilies(streamLog);

  if (families.size === 0) {
    // No-dispatch: distinguish a genuine one-shot (clean settle + produced output) from a degenerate run.
    if (ctx.resultSubtype === "success" && ctx.producedTreeNonEmpty) return "one-shot";
    const reason =
      ctx.resultSubtype === undefined
        ? "no dispatch and no settled result (run aborted/killed before settling)"
        : `no dispatch but resultSubtype=${JSON.stringify(ctx.resultSubtype)}, producedTreeNonEmpty=${ctx.producedTreeNonEmpty}`;
    throw new DegenerateRunError(streamPath, reason);
  }

  return shapeForDispatch(families);
}
