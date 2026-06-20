// CommentRail — the review rail in the doc drawer's right column (task 18, ported from
// prototype-document.html's `.rail`). Lists the open document's comments (newest first), each with its
// decision tint, the quoted span, the body, and Reply/Resolve actions. It also mounts the SelectionBubble
// (the compose affordance) so the whole comment loop lives in this one slot — the rail is what DocDrawer's
// `commentRail` slot renders, receiving `{ runId, docId }`.
//
// SRP: the rail RENDERS comments from the shared comment-store; SelectionBubble WRITES to it; the node
// badge READS the count from it. No comment state lives in this component — it subscribes to the store.
import { useEffect } from "react";
import type { ReviewDecision } from "./review-types.js";
import { fetchReview } from "../../../../api/client.js";
import { SelectionBubble } from "./SelectionBubble.js";
import { hydrate, resolveComment, useComments, type UiComment } from "./comment-store.js";
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
        {comments.length === 0 ? (
          <div className="dd-rail-empty">
            No comments on this document yet.
            <br />
            Select any text to request changes, ask, or approve.
          </div>
        ) : (
          comments.map((c) => (
            <CommentCard key={c.id} runId={runId} docId={docId} comment={c} />
          ))
        )}
      </div>
      <SelectionBubble runId={runId} docId={docId} applyCommentMark={applyCommentMark} />
    </div>
  );
}

function CommentCard({
  runId,
  docId,
  comment,
}: {
  runId: string;
  docId: string;
  comment: UiComment;
}) {
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
            onClick={() => resolveComment(runId, docId, id)}
          >
            Resolve
          </button>
        )}
      </div>
    </div>
  );
}
