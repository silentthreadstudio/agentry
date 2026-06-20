// GateInbox — the waiting-on-you list (plan §6). Scans every run's `.review/<gate>.annotations.json`
// sidecars and returns the OPEN gate items: a gate with at least one UNRESOLVED review comment is waiting
// on a human. Each `GateItem` carries the jump-to-doc-at-gate pointer (run + doc + gate) so the Gates page
// can deep-link straight to the document at the gate. PURE of HTTP/ws (ADR-001): it depends only on the
// `WorkRepository` (the run list) + plain fs reads of the sidecars.
//
// ── Reuse, not fork (ADR-005 tier 1) ─────────────────────────────────────────────────────────────────
// The sidecar shape is FLOW's: each file is a `ReviewComment[]`, validated through FLOW's closed
// `ReviewComment` schema (a corrupt/partially-written sidecar reads as empty rather than throwing — the
// SAME tolerance FLOW's `JsonReviewStore.read` gives). A comment is OPEN when `resolved === false`; a gate
// with no open comments is not in the inbox.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GateItem } from "@agentry/workbench-shared";
import { ReviewComment } from "@agentry/flow/domain/review";
import { runDir } from "@agentry/flow/resolution/run-pointer";
import type { WorkRepository } from "../domain/ports.js";

// The inbox carries the run alongside each gate item so the Gates page can deep-link into the right run.
// `GateItem` (the shared shape) pins `gate`/`docId`/`comments`/`decision`; `run` is the jump target added
// here — kept distinct from the shared transport type, which is run-agnostic by design.
export interface OpenGateItem extends GateItem {
  run: string; // the run this gate lives in (the jump-to-doc-at-gate target)
}

export class GateInbox {
  // `cwd` (the project root) is threaded on every fs path — no ambient cwd (mirrors FsWorkRepository).
  constructor(
    private readonly repository: WorkRepository,
    private readonly cwd: string,
  ) {}

  // The open waiting-on-you list across every run (or one run when `runId` is given). A gate is OPEN when
  // its sidecar holds at least one unresolved comment. Runs are scanned in `listRuns` order (stable); a run
  // with no `.review/` dir contributes nothing. `decision` is null while the gate is open — the read-model
  // surfaces the comments, not a verdict (a verdict is reached at the FLOW gate, not derived here).
  open(runId?: string): OpenGateItem[] {
    const runs = runId !== undefined ? [runId] : this.repository.listRuns();
    const items: OpenGateItem[] = [];
    for (const run of runs) {
      for (const { gate, comments } of this.gatesOf(run)) {
        const openComments = comments.filter((c) => !c.resolved);
        if (openComments.length === 0) continue; // resolved gates are not waiting on you
        items.push({ run, gate, docId: gate, comments: openComments, decision: null });
      }
    }
    return items;
  }

  // Every gate sidecar in one run: the `<gate>.annotations.json` files under `.review/`, each parsed into
  // its `ReviewComment[]`. The gate name is the filename stem. An absent `.review/` dir ⇒ no gates.
  private gatesOf(run: string): Array<{ gate: string; comments: ReviewComment[] }> {
    const reviewDir = join(runDir(this.cwd, run), ".review");
    if (!existsSync(reviewDir)) return [];
    const out: Array<{ gate: string; comments: ReviewComment[] }> = [];
    for (const file of readdirSync(reviewDir).sort()) {
      if (!file.endsWith(".annotations.json")) continue;
      const gate = file.slice(0, -".annotations.json".length);
      out.push({ gate, comments: this.readSidecar(join(reviewDir, file)) });
    }
    return out;
  }

  // Parse one sidecar into validated `ReviewComment[]`. Reuses FLOW's closed schema; a non-array or a file
  // that fails to parse reads as empty (the SAME tolerance FLOW's review store gives — a half-written
  // sidecar never throws here). A single ill-formed comment drops the whole file to empty, matching FLOW.
  private readSidecar(file: string): ReviewComment[] {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(raw)) return [];
      return raw.map((c) => ReviewComment.parse(c));
    } catch {
      return [];
    }
  }
}
