// RunStarter — start a new run from the Workbench, reusing FLOW's own front door.
//
// Until now the Workbench could only steer work that already existed: every write rail (comment, artifact,
// status) needs a run to act on, and runs were only ever minted from a session calling `run_start`. That
// made it an observability panel with annotations. This is the missing verb.
//
// ── Reuse, not fork (ADR-005 tier 1 / ADR-007) ─────────────────────────────────────────────────────
// It does NOT re-implement "create a run": it calls FLOW's `RunService.start`, so the id minting, the
// `.agentry/work/<run>/` layout and the `spec.md` scaffold are byte-identical to a run started by the MCP
// tool. Only the four file-store adapters are constructed here (via FLOW's subpath exports, the same way
// `flow-writer.ts` reaches for `computeVersion`/`runDir`) — importing FLOW's barrel would drag the MCP
// SDK into this bundle for no reason.
//
// `session_id` is deliberately NOT passed: the Workbench is not a Claude session, so it must not claim the
// session→run pointer. The conducting session binds itself on its first write (the work-id-binder hook).
import { RunService } from "@agentry/flow/application/run-service";
import { JsonlEventLog } from "@agentry/flow/persistence/event-log";
import { JsonReviewStore } from "@agentry/flow/persistence/review-store";
import { JsonRunStateStore } from "@agentry/flow/persistence/run-state-store";
import { TaskFileStore } from "@agentry/flow/persistence/task-file-store";

export class RunStarter {
  private readonly service: RunService;

  constructor(root: string) {
    this.service = new RunService({
      cwd: root,
      tasks: new TaskFileStore(root),
      events: new JsonlEventLog(root),
      reviews: new JsonReviewStore(root),
      runs: new JsonRunStateStore(root),
    });
  }

  /** Mint a run for `goal` and lay down its scaffold. Returns the run id the SPA navigates to. */
  start(goal: string): { run: string } {
    return this.service.start({ goal });
  }
}
