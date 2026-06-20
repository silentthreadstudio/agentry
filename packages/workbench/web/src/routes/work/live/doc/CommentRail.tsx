// CommentRail — the docs workspace's right pane: the document's review CONVERSATION (design/right-pane.html).
// One header (Conversation + gate + Open/All/Resolved filter), the in-rail composer (opened by the editor's
// margin Comment button), then a list of threads. Each thread is a chat-style exchange: the root annotation
// (You), nested replies (You + agent ✦), and a "Reply to the agent" box so the human can answer inline —
// the affordance the old rail lacked. A long quoted span collapses to a clickable line-range chip.
//
// Live (note 3 / AC7): the rail subscribes to the ws `file-changed` stream and re-hydrates from disk when
// THIS doc's gate sidecar changes — so an agent's `channel_reply` (or a terminal edit) appears with no
// reload. The hydrate merge keeps this session's optimistic comments (dedup by id), so the human's own
// post never double-renders.
//
// SRP: the rail RENDERS from the shared comment-store; RailComposer + the reply boxes WRITE to it; the node
// badge READS the count. No comment state lives here — it subscribes to the store.
import { useEffect, useMemo, useState } from "react";
import type { ReviewDecision } from "./review-types.js";
import { fetchReview } from "../../../../api/index.js";
import { getWsClient } from "../../../../api/ws.js";
import { RailComposer } from "./RailComposer.js";
import {
  addComment,
  hydrate,
  resolveComment,
  threadsOf,
  useComments,
  useOpenCommentCount,
  type CommentThread,
  type UiComment,
} from "./comment-store.js";
import { useCommentRailStyles } from "./comment-styles.js";

const DECISION_LABEL: Record<ReviewDecision, string> = {
  changes: "changes",
  approve: "approve",
  question: "question",
};

type Filter = "open" | "all" | "resolved";

export function CommentRail({
  runId,
  docId,
  applyCommentMark,
}: {
  runId: string;
  docId: string;
  applyCommentMark?: (range: Range, commentId: string) => void;
}) {
  useCommentRailStyles();
  const comments = useComments(runId, docId);
  const openCount = useOpenCommentCount(runId, docId);
  const [filter, setFilter] = useState<Filter>("open");

  const { threads, orphanReplies } = threadsOf(comments);
  // Newest first (reverse the chronological store), then apply the filter.
  const ordered = useMemo(() => {
    const rev = [...threads].reverse();
    if (filter === "open") return rev.filter((t) => !t.comment.resolved);
    if (filter === "resolved") return rev.filter((t) => t.comment.resolved);
    // "all": open above resolved (stable).
    return rev.sort((a, b) => Number(a.comment.resolved) - Number(b.comment.resolved));
  }, [threads, filter]);

  // Hydrate the on-disk comments on mount + on a run/doc switch (the bidirectional loop, VISION §6).
  useEffect(() => {
    const ctrl = new AbortController();
    fetchReview(runId, docId, ctrl.signal)
      .then((disk) => hydrate(runId, docId, disk))
      .catch(() => {
        /* offline or rejected — keep session-only state; the badge still reflects POSTs */
      });
    return () => ctrl.abort();
  }, [runId, docId]);

  // Live refresh (note 3): when the gate sidecar for THIS doc changes on disk, re-hydrate. This is how an
  // agent's channel_reply or a terminal `review_resolve` shows up with no reload. The server pushes
  // `file-changed` with path `.review/<gate>.annotations.json`; the gate key IS the docId.
  useEffect(() => {
    const wantPath = `.review/${docId}.annotations.json`;
    const off = getWsClient().subscribe((msg) => {
      if (msg.type !== "file-changed" || msg.path !== wantPath) return;
      const ctrl = new AbortController();
      fetchReview(runId, docId, ctrl.signal)
        .then((disk) => hydrate(runId, docId, disk))
        .catch(() => {});
    });
    return off;
  }, [runId, docId]);

  return (
    <div className="dd-railwrap">
      <div className="dd-rail-h">
        <span className="dd-rail-t">Conversation</span>
        <span className="dd-gatepill">{docId}</span>
        <span className="dd-rail-grow" />
        <div className="dd-filter" role="group" aria-label="Filter comments">
          {(["open", "all", "resolved"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={filter === f ? "on" : ""}
              onClick={() => setFilter(f)}
            >
              {f === "open" ? `Open${openCount ? ` ${openCount}` : ""}` : f === "all" ? "All" : "Resolved"}
            </button>
          ))}
        </div>
      </div>

      <div className="dd-rail-body">
        {/* The composer renders here when the margin Comment button captures a selection (selection-store). */}
        <RailComposer runId={runId} docId={docId} applyCommentMark={applyCommentMark} />

        {ordered.length === 0 ? (
          <div className="dd-rail-empty">
            {filter === "resolved"
              ? "No resolved comments."
              : filter === "open" && comments.length > 0
                ? "No open comments — all resolved."
                : "No comments yet."}
            <br />
            Select any text in the document — a <b>Comment</b> button appears in the margin.
          </div>
        ) : (
          ordered.map((t) => <ThreadCard key={t.comment.id} runId={runId} docId={docId} thread={t} />)
        )}

        {filter !== "resolved" && orphanReplies.length > 0 ? (
          <div className="dd-orphans">
            <div className="dd-orphans-h">replies</div>
            {orphanReplies.map((r) => (
              <Message key={r.id} msg={r} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// One thread: the root annotation + its replies as chat messages, with the quote header (inline or a
// collapsible line-range chip) and a reply box when the thread is open.
function ThreadCard({
  runId,
  docId,
  thread,
}: {
  runId: string;
  docId: string;
  thread: CommentThread;
}) {
  const { comment, replies } = thread;
  const { decision, anchor, resolved, id } = comment;
  const [expanded, setExpanded] = useState(false);
  const long = quoteIsLong(anchor.originalText);

  return (
    <div className={`dd-thread ${decision}${resolved ? " resolved" : ""}`} data-id={id}>
      <div className="dd-th-hd">
        <span className={`dd-th-dec ${decision}`}>{DECISION_LABEL[decision]}</span>
        {long ? (
          <button
            type="button"
            className="dd-th-range"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <span className="chip">{lineRange(anchor)}</span>
            <span className="hint">{anchor.originalText.replace(/\s+/g, " ").trim()}</span>
            <Chevron />
          </button>
        ) : (
          <span className="dd-th-quote" title={anchor.originalText}>
            “{anchor.originalText}”
          </span>
        )}
        {!long ? <span className="dd-th-loc">L{anchor.startLine}</span> : null}
        {resolved ? (
          <span className="dd-th-resolved">resolved ✓</span>
        ) : (
          <button type="button" className="dd-th-resolve" onClick={() => void resolveComment(runId, docId, id)}>
            Resolve
          </button>
        )}
      </div>

      {long && expanded ? <div className="dd-th-full">{anchor.originalText}</div> : null}

      <div className="dd-msgs">
        <Message msg={comment} rootDecision={decision} />
        {replies.map((r) => (
          <Message key={r.id} msg={r} />
        ))}
      </div>

      {!resolved ? <ReplyBox runId={runId} docId={docId} thread={thread} /> : null}
    </div>
  );
}

// One message bubble — avatar + name + body. Agent replies (origin "agent") get the ✦ avatar; everything
// else is the human ("You"). A root annotation with an empty body shows its decision as the message line.
function Message({ msg, rootDecision }: { msg: UiComment; rootDecision?: ReviewDecision }) {
  const isAgent = msg.origin === "agent";
  const body = msg.body.trim();
  const text = body || (rootDecision ? `Requested ${DECISION_LABEL[rootDecision]}.` : "");
  return (
    <div className={`dd-msg${isAgent ? " agent" : ""}`} data-id={msg.id}>
      <span className={`dd-ava ${isAgent ? "ag" : "you"}`}>{isAgent ? "✦" : "YOU"}</span>
      <div className="dd-mcol">
        <div className="dd-who">
          <span className={`dd-nm${isAgent ? " ag" : ""}`}>{isAgent ? "Agent" : "You"}</span>
          <span className="dd-when">{isAgent ? "· replied" : "· you"}</span>
        </div>
        {text ? <div className="dd-bd">{text}</div> : null}
      </div>
    </div>
  );
}

// The inline reply input — a human follow-up posted into the thread (replyTo = the root id, origin human).
// Reuses the root's anchor + decision so the reply stays attached to the same span/gate.
function ReplyBox({
  runId,
  docId,
  thread,
}: {
  runId: string;
  docId: string;
  thread: CommentThread;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    const res = await addComment({
      runId,
      docId,
      anchor: thread.comment.anchor,
      decision: thread.comment.decision,
      body,
      replyTo: thread.comment.id,
      origin: "human",
    });
    setBusy(false);
    if (res.ok) setText("");
  }

  return (
    <div className="dd-reply">
      <textarea
        placeholder="Reply to the agent…"
        rows={1}
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <button type="button" className="dd-send" aria-label="Send reply" disabled={busy || !text.trim()} onClick={() => void send()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
        </svg>
      </button>
    </div>
  );
}

function Chevron() {
  return (
    <svg className="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

// A quote is "long" (→ collapse to a line-range chip) when it spans multiple lines or exceeds ~48 chars.
function quoteIsLong(text: string): boolean {
  return text.includes("\n") || text.length > 48;
}

// The line range for the chip: `L<start>` for a single line, `L<start>:L<end>` across lines. The end is
// derived from the selected text's line count (no anchor schema change — startLine + newlines).
function lineRange(anchor: { originalText: string; startLine: number }): string {
  const lines = anchor.originalText.split("\n").length;
  const start = anchor.startLine;
  return lines > 1 ? `L${start}:L${start + lines - 1}` : `L${start}`;
}
