// CommentRail — the review rail in the doc drawer's right column (task 18, ported from
// prototype-document.html's `.rail`). Lists the open document's comments (newest first), each with its
// decision tint, the quoted span, the body, and Reply/Resolve actions. It also mounts the SelectionBubble
// (the compose affordance) so the whole comment loop lives in this one slot — the rail is what DocDrawer's
// `commentRail` slot renders, receiving `{ runId, docId }`.
//
// SRP: the rail RENDERS comments from the shared comment-store; SelectionBubble WRITES to it; the node
// badge READS the count from it. No comment state lives in this component — it subscribes to the store.
import type { ReviewDecision } from "./review-types.js";
import { SelectionBubble } from "./SelectionBubble.js";
import { resolveComment, useComments, type UiComment } from "./comment-store.js";
import { useCommentRailStyles } from "./comment-styles.js";

const DECISION_LABEL: Record<ReviewDecision, string> = {
  changes: "request changes",
  approve: "approve",
  question: "question",
};

export function CommentRail({ runId, docId }: { runId: string; docId: string }) {
  useCommentRailStyles();
  const comments = useComments(runId, docId);

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
      <SelectionBubble runId={runId} docId={docId} />
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
