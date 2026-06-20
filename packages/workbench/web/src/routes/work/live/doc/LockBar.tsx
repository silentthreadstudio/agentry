// LockBar — the lock-aware banner under the doc header (ADR-006 on the UI side). It reads ONE derived
// signal — whether the doc is locked — and renders only the meaningful case:
//   • locked → amber "Read-only — <lockedBy> is writing this now" + the Take over action.
//   • free   → nothing (the editable/in-sync line was noise — the header pill already says "editable").
// The lock itself is server-truth (a `status: in-progress` doc is locked by its assignee — ADR-006);
// this bar only renders the state the editor derives, it never decides editability on its own.
import { TakeOver } from "./TakeOver.js";

export interface LockBarProps {
  /** True when the doc is held by the agent (in-progress) — read-only until taken over. */
  locked: boolean;
  /** Who holds the lock (the FLOW assignee), shown when locked. */
  lockedBy: string | null;
  /** The doc's current version hash — shown when free, as the in-sync freshness cue. */
  version: string;
  runId: string;
  docId: string;
  /** Re-fetch hook DocDrawer passes to TakeOver — after the server flips the lock. */
  onTakenOver: () => void;
}

export function LockBar({ locked, lockedBy, runId, docId, onTakenOver }: LockBarProps) {
  if (locked) {
    return (
      <div className="dd-lockbar" role="status">
        <span className="dd-pulse" aria-hidden="true" />
        <span>
          Read-only — <b>{lockedBy ?? "an agent"}</b> is writing this now.{" "}
          <span className="dd-lock-hint">You can comment, or take over when it's free.</span>
        </span>
        <span className="dd-grow" />
        <TakeOver runId={runId} docId={docId} onTakenOver={onTakenOver} />
      </div>
    );
  }

  // Free doc → no banner (the header's "editable" pill already conveys it).
  return null;
}
