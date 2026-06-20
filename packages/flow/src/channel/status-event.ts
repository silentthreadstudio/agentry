// status-event — the PURE half of the human→agent status channel. The Workbench writes a status-signal
// file when a HUMAN changes a task's status (the lock-unblock / the override); this turns that file's
// shape into the channel notification the agent reads. Human-origin is unambiguous: only the Workbench
// writes these files (the agent's own `task_status` calls never do), so the agent is never notified of its
// own writes. Pure (no I/O) so it's unit-testable; the watcher (status-bridge.ts) owns the fs.
import { z } from "zod";
import type { ChannelNotification } from "./channel-event.js";

// The PINNED on-disk shape the Workbench writes to `<cwd>/.agentry/run/status-signals/<id>.json`.
export const StatusSignal = z.object({
  run: z.string(),
  task: z.string(), // the task node id, e.g. "task-003"
  status: z.string(), // the new FLOW status (todo | in-progress | in-review | done)
  at: z.string().optional(), // ISO stamp the Workbench wrote it (display only)
});
export type StatusSignal = z.infer<typeof StatusSignal>;

// Render the channel notification for a human status change. `content` is what the agent reads; `meta`
// (snake_case) surfaces as `<channel …>` attributes for routing.
export function statusNotification(sig: StatusSignal): ChannelNotification {
  return {
    content: `Human set ${sig.task} status → ${sig.status} (run ${sig.run}).`,
    meta: { run_id: sig.run, task: sig.task, status: sig.status, kind: "status" },
  };
}
