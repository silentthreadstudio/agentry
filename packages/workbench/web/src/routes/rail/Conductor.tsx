import { CONDUCTOR_GATE, anchorlessSpan } from "@agentry/workbench-shared";
// Conductor — the run-level conversation: say something to the run without annotating a document.
//
// Everything the Workbench could do to a run until now had to be ANCHORED to a document span. That is the
// right shape for reviewing a spec, and the wrong shape for "stop, the migration has to run first" — so
// there was no way to simply talk to the agent that is working. This tab is that rail.
//
// It is not a new mechanism: a message rides the SAME `.review/` bus every review comment rides, under the
// reserved `CONDUCTOR_GATE`, so FLOW's channel bridge pushes it into the conducting session as a
// `<channel>` event, and the agent answers on the same bus via `channel_reply` (`origin:"agent"`) — which
// shows up here as the other side of the thread. Reused wholesale: `comment-store` for the optimistic
// write + hydrate, `fetchReview` for the on-disk seed, the ws `file-changed` loop for live updates.
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchReview } from "../../api/index.js";
import { getWsClient } from "../../api/ws.js";
import { EmptyState } from "../../ui/index.js";
import { addComment, hydrate, useComments } from "../doc/comment-store.js";
import {
  BUBBLE,
  BUBBLE_AGENT,
  BUBBLE_META,
  COMPOSER,
  CONVO,
  INPUT,
  SEND,
  STREAM,
} from "./conductor-view.js";

// The sidecar this thread lives in — the path the ws `file-changed` nudge carries when the agent replies.
const THREAD_PATH = `.review/${CONDUCTOR_GATE}.annotations.json`;

export function Conductor({ runId, onIncoming }: { runId: string; onIncoming?: () => void }) {
  const messages = useComments(runId, CONDUCTOR_GATE);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);

  // Seed from disk, so a reload shows the whole conversation rather than only this session's messages.
  const seed = useCallback(
    (signal?: AbortSignal) => {
      fetchReview(runId, CONDUCTOR_GATE, signal)
        .then((disk) => hydrate(runId, CONDUCTOR_GATE, disk))
        .catch(() => {
          /* no thread yet (404/empty) is the normal cold state — the empty state below says so */
        });
    },
    [runId],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    seed(ctrl.signal);
    return () => ctrl.abort();
  }, [seed]);

  // Live: the agent's reply lands as a write to this run's sidecar, which the server pushes as
  // `file-changed`. Re-seed on that path only — every other file change in the run is somebody else's.
  useEffect(() => {
    return getWsClient().subscribe((msg) => {
      if (msg.type === "file-changed" && msg.path === THREAD_PATH) {
        seed();
        onIncoming?.(); // lets a collapsed rail show an unread count instead of going quiet
      }
    });
  }, [seed, onIncoming]);

  // Keep the newest message in view as the conversation grows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages.length is the trigger — re-scroll when a message arrives, not on unrelated renders
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = async () => {
    const body = draft.trim();
    if (body.length === 0 || sending) return;
    setSending(true);
    setError(null);
    // `decision: "question"` is the schema-required verdict vocabulary, not a review verdict — a message
    // carries no approve/changes judgement. The anchor is the neutral placeholder a span-less entry uses.
    const result = await addComment({
      runId,
      docId: CONDUCTOR_GATE,
      anchor: anchorlessSpan(),
      decision: "question",
      body,
      origin: "human",
    });
    setSending(false);
    if (result.ok) setDraft("");
    else setError(result.message);
  };

  // Enter sends, Shift+Enter breaks the line — the convention for a message box, not a document editor.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  // The store is CHRONOLOGICAL (both `insert` and `hydrate` append, matching the on-disk sidecar's
  // append order), which is already what a conversation wants: oldest at the top, newest above the
  // composer. The comment rail reverses for its own newest-first list — that is the rail's display
  // choice, not the store's order. Do not reverse here.
  const ordered = messages;

  return (
    <div style={CONVO}>
      <div style={STREAM} ref={streamRef}>
        {ordered.length === 0 ? (
          <EmptyState title="Nothing said yet">
            Send the conductor a message — it arrives in the session running this work.
          </EmptyState>
        ) : (
          ordered.map((m) => {
            const fromAgent = m.origin === "agent";
            return (
              <div key={m.id} style={fromAgent ? BUBBLE_AGENT : BUBBLE}>
                <div style={BUBBLE_META}>{fromAgent ? "conductor" : "you"}</div>
                <div>{m.body}</div>
              </div>
            );
          })
        )}
      </div>

      <div style={COMPOSER}>
        <textarea
          style={INPUT}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message the conductor…"
          aria-label="Message the conductor"
          rows={2}
        />
        <button
          type="button"
          style={SEND}
          onClick={() => void send()}
          disabled={sending || draft.trim().length === 0}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      {error !== null ? (
        <div
          role="alert"
          style={{ color: "var(--bad, #f87171)", fontSize: 12, padding: "0 4px 8px" }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
