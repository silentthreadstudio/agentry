// CommentRail — the review rail in the docs workspace's right column (task 18, ported from
// prototype-document.html's `.rail`). Lists the open document's comments (newest first), each with its
// decision tint, the quoted span, the body, and Reply/Resolve actions. It also mounts the RailComposer
// (the in-rail compose affordance, opened by the editor's margin 💬 button via selection-store) so the
// whole comment loop lives in this one slot — receiving `{ runId, docId }` from DocsWorkspace.
//
// SRP: the rail RENDERS comments from the shared comment-store; RailComposer WRITES to it; the node badge
// READS the count from it. No comment state lives in this component — it subscribes to the store.
import { useEffect } from "react";
import type { ReviewDecision } from "./review-types.js";
import { fetchReview } from "../../../../api/client.js";
import { RailComposer } from "./RailComposer.js";
import {
  hydrate,
  resolveComment,
  threadsOf,
  useComments,
  type CommentThread,
  type UiComment,
} from "./comment-store.js";
import { useCommentRailStyles } from "./comment-styles.js";

const DECISION_LABEL: Record<ReviewDecision, string> = {
  changes: "request changes",
  approve: "approve",
  question: "question",
};

export function CommentRail({
  runId,
  docId,
  applyCommentMark,
}: {
  runId: string;
  docId: string;
  // Paints the in-editor `comment` highlight on a submitted span (AC5). Supplied by DocDrawer's
  // commentRail slot; threaded to the SelectionBubble that owns the captured selection.
  applyCommentMark?: (range: Range, commentId: string) => void;
}) {
  useCommentRailStyles();
  const comments = useComments(runId, docId);
  // Split the flat list into human threads + nested agent replies (Phase 2b). Human comments are the
  // top-level cards; agent `channel_reply` entries nest under the human comment they answer (`replyTo`).
  const { threads, orphanReplies } = threadsOf(comments);

  // Hydrate the on-disk comments on mount (and on a run/doc switch): seed the store from
  // `.review/<gate>.annotations.json` so a fresh page load shows comments that already exist on disk, not
  // just this session's POSTs (the bidirectional AI↔Dashboard loop, VISION §6). The merge keeps session
  // comments (dedup by id, store-side); a fetch error leaves the session-only state untouched (the rail
  // still works, just without the on-disk seed). Aborted on unmount so a late response never seeds a
  // closed/switched doc.
  useEffect(() => {
    const ctrl = new AbortController();
    fetchReview(runId, docId, ctrl.signal)
      .then((disk) => hydrate(runId, docId, disk))
      .catch(() => {
        /* offline or rejected — keep the session-only state; the badge still reflects POSTs */
      });
    return () => ctrl.abort();
  }, [runId, docId]);

  return (
    <div className="dd-railwrap">
      <div className="dd-rail-h">
        <span className="dd-rail-t">Review</span>
        <span className="dd-gatepill">gate · {docId}</span>
      </div>
      <div className="dd-rail-body">
        {/* The composer renders here when the margin 💬 button captures a selection (selection-store). */}
        <RailComposer runId={runId} docId={docId} applyCommentMark={applyCommentMark} />
        {comments.length === 0 ? (
          <div className="dd-rail-empty">
            No comments yet.
            <br />
            Select any text in the document — a <b>💬</b> appears in the margin; click it to comment.
          </div>
        ) : (
          <>
            {threads.map((t) => (
              <CommentCard key={t.comment.id} runId={runId} docId={docId} thread={t} />
            ))}
            {orphanReplies.length > 0 ? (
              <div className="dd-orphans">
                <div className="dd-orphans-h">replies</div>
                {orphanReplies.map((r) => (
                  <AgentReply key={r.id} reply={r} />
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function CommentCard({
  runId,
  docId,
  thread,
}: {
  runId: string;
  docId: string;
  thread: CommentThread;
}) {
  const { comment, replies } = thread;
  const { decision, anchor, body, resolved, id } = comment;
  return (
    <div className={`dd-cmt ${decision}${resolved ? " resolved" : ""}`} data-id={id}>
      <div className="dd-cmt-top">
        <span className={`dd-cmt-dec d-${decision}`}>{DECISION_LABEL[decision]}</span>
        <span className="dd-cmt-who">you</span>
      </div>
      <div className="dd-cmt-q">“{anchor.originalText}”</div>
      {body ? <div className="dd-cmt-bd">{body}</div> : null}
      <div className="dd-cmt-meta">
        {anchor.headingAnchor ? <span>§ {anchor.headingAnchor}</span> : null}
        <span>line {anchor.startLine}</span>
      </div>
      <div className="dd-cmt-ax">
        {resolved ? (
          <span className="dd-cmt-resolved">resolved ✓</span>
        ) : (
          <button
            type="button"
            className="dd-mini"
            onClick={() => void resolveComment(runId, docId, id)}
          >
            Resolve
          </button>
        )}
      </div>
      {replies.map((r) => (
        <AgentReply key={r.id} reply={r} />
      ))}
    </div>
  );
}

// One agent `channel_reply` (Phase 2b), nested inside the human comment it answers. Display-only here —
// the human acts via the comment's Resolve and the diff drawer's Accept/Reject (no action lives on the
// reply). Tinted reply block per the mockup's `.reply`: agent avatar, "agent · when", then the body.
function AgentReply({ reply }: { reply: UiComment }) {
  return (
    <div className="dd-reply" data-id={reply.id}>
      <div className="dd-reply-top">
        <span className="dd-reply-ava">✦</span>
        <span className="dd-reply-who">agent</span>
        <span className="dd-reply-when">· reply</span>
      </div>
      {reply.body ? <div className="dd-reply-bd">{reply.body}</div> : null}
    </div>
  );
}
