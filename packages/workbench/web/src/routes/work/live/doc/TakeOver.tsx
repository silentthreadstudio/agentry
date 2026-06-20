// TakeOver — the explicit lock transition (ADR-006): the human claiming the edit on a doc the agent
// holds (`status: in-progress`). It POSTs the pinned takeover endpoint (task 17 server territory); the
// SERVER performs the lock flip on disk (the client is never trusted — ADR-006). On success the caller
// re-fetches the doc, which now reports the lock freed, and the editor becomes editable.
//
// This component is a thin button + request state machine; it owns no editor/lock state of its own —
// DocDrawer passes `runId`/`docId` and an `onTakenOver` callback that re-reads the doc.
import { useState } from "react";
import { Button } from "../../../../design-system/index.js";

// The pinned takeover endpoint (task 17). The client codes to this path; if the server route is absent
// the request fails and the error surfaces in-band (no silent flip). The server owns the actual lock
// transition on disk — this is only the request.
async function postTakeover(runId: string, docId: string): Promise<void> {
  const res = await fetch(`/api/work/${encodeURIComponent(runId)}/takeover`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    // `by: "human"` — the generic takeover holder (single-user local workbench); the server stamps
    // `lockedBy: "human"`. `target` is the docId string ("task-<NNN>"); takeover only shows for a
    // locked TASK doc, so the server derives the task number from it.
    body: JSON.stringify({ target: docId, by: "human" }),
  });
  if (!res.ok) {
    throw new Error(`takeover → ${res.status} ${res.statusText}`);
  }
}

export interface TakeOverProps {
  runId: string;
  docId: string;
  /** Called after the server flips the lock — DocDrawer re-fetches the (now-free) doc. */
  onTakenOver: () => void;
}

export function TakeOver({ runId, docId, onTakenOver }: TakeOverProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function takeOver() {
    setPending(true);
    setError(null);
    try {
      await postTakeover(runId, docId);
      onTakenOver();
    } catch (err) {
      setError(err instanceof Error ? err.message : "take over failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="dd-takeover">
      <Button variant="primary" onClick={takeOver} disabled={pending}>
        {pending ? "Taking over…" : "✎ Take over"}
      </Button>
      {error ? (
        <span className="dd-takeover-err" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
