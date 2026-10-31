import { FsBacklogStore } from "@agentry/flow/persistence/backlog-store";
// flow-services — FLOW's file-store tree, built for one project root.
//
// FLOW exports `createServices(cwd)` from its barrel, but importing that barrel drags the MCP SDK into
// this bundle (the barrel also defines the server). So the tree is assembled here from FLOW's SUBPATH
// exports — the same discipline `flow-writer.ts` uses when it reaches for `computeVersion`/`runDir`.
// The adapters that need a FLOW service (starting a run, the backlog) share this one builder rather than
// each assembling their own, so a field added to `FlowServices` lands in one place.
import { JsonlEventLog } from "@agentry/flow/persistence/event-log";
import { JsonReviewStore } from "@agentry/flow/persistence/review-store";
import { JsonRunStateStore } from "@agentry/flow/persistence/run-state-store";
import { TaskFileStore } from "@agentry/flow/persistence/task-file-store";

/** Structurally FLOW's `FlowServices`, assembled without importing its barrel. */
export function createFlowServices(root: string) {
  return {
    cwd: root,
    tasks: new TaskFileStore(root),
    events: new JsonlEventLog(root),
    reviews: new JsonReviewStore(root),
    runs: new JsonRunStateStore(root),
    backlog: new FsBacklogStore(root),
  };
}

export type FlowServicesLike = ReturnType<typeof createFlowServices>;
