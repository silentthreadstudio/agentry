// GateInbox — the waiting-on-you list (plan §6). Scans every run's `.review/<gate>.annotations.json`
// sidecars and returns the OPEN gate items: a gate with at least one UNRESOLVED review comment is waiting
// on a human. Each `GateItem` carries the jump-to-doc-at-gate pointer (run + doc + gate) so the Gates page
// can deep-link straight to the document at the gate. PURE of HTTP/ws AND of fs (ADR-001): it depends only
// on the `WorkRepository` (the run list) + the `ReviewSidecarSource` port (the sidecar reads), so it is
// unit-testable against a fake source with no disk.
//
// ── Reuse, not fork (ADR-005 tier 1) ─────────────────────────────────────────────────────────────────
// The sidecar shape is FLOW's: each file is a `ReviewComment[]`, read through the port's single
// parse-tolerant reader (a corrupt/partially-written sidecar reads as empty rather than throwing — the
// SAME tolerance FLOW's `JsonReviewStore.read` gives, now consolidated in `FsReviewSidecarSource`). A
// comment is OPEN when `resolved === false`; a gate with no open comments is not in the inbox.
import type { GateItem } from "@agentry/workbench-shared";
import { ReviewComment, isHumanComment } from "@agentry/flow/domain/review";
import type { ReviewSidecarSource, WorkRepository } from "../domain/ports.js";

// The inbox carries the run alongside each gate item so the Gates page can deep-link into the right run.
// `GateItem` (the shared shape) pins `gate`/`docId`/`comments`/`decision`; `run` is the jump target added
// here — kept distinct from the shared transport type, which is run-agnostic by design.
export interface OpenGateItem extends GateItem {
  run: string; // the run this gate lives in (the jump-to-doc-at-gate target)
}

export class GateInbox {
  // The run list comes from the repository (mirrors the Works home listing); the sidecar reads come from
  // the injected `ReviewSidecarSource` port — no fs here, the adapter owns the bytes + the parser (ADR-001).
  constructor(
    private readonly repository: WorkRepository,
    private readonly sidecars: ReviewSidecarSource,
  ) {}

  // The open waiting-on-you list across every run (or one run when `runId` is given). A gate is OPEN when
  // its sidecar holds at least one unresolved comment. Runs are scanned in `listRuns` order (stable); a run
  // with no `.review/` dir contributes nothing. `decision` is null while the gate is open — the read-model
  // surfaces the comments, not a verdict (a verdict is reached at the FLOW gate, not derived here).
  open(runId?: string): OpenGateItem[] {
    const runs = runId !== undefined ? [runId] : this.repository.listRuns();
    const items: OpenGateItem[] = [];
    for (const run of runs) {
      for (const gate of this.sidecars.listGates(run)) {
        const comments = this.sidecars.commentsFor(run, gate);
        // Waiting-on-you = unresolved HUMAN comments only. Agent replies (`origin:"agent"`, Phase 2b)
        // already carry `resolved:true`, but filter them explicitly so a malformed unresolved reply can
        // never surface a gate as "waiting on you" (defense-in-depth, ADR-002).
        const openComments = comments.filter((c) => isHumanComment(c) && !c.resolved);
        if (openComments.length === 0) continue; // resolved gates are not waiting on you
        items.push({ run, gate, docId: gate, comments: openComments, decision: null });
      }
    }
    return items;
  }

  // ALL comments (open + resolved) for one run+gate — the doc-level read the comment rail hydrates from on
  // load (the bidirectional AI↔Dashboard loop, VISION §6). The gate key IS the docId (the SAME key the
  // `/comment` POST writes under). Delegates to the source's single parser; an absent sidecar ⇒ `[]` (clean
  // empty), distinct from `open()` which filters to unresolved and drops resolved-empty gates.
  commentsFor(run: string, gate: string): ReviewComment[] {
    return this.sidecars.commentsFor(run, gate);
  }
}
