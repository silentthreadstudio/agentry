// DocsRail — the Docs workspace's right column. A thin frame around the conversation: the CommentRail
// owns the whole pane now (its own Conversation header + Open/All/Resolved filter + threads + the inline
// "Reply to the agent" box — design/right-pane.html), and the DiffDrawer stays mounted below so a ws
// doc-update slides the live agent-edit before/after (Accept/Iterate/Reject) up over it.
//
// The old `.dr-hd` ("Conversation" + inert "Ask agent") is gone: the header moved into CommentRail (one
// header, not two), and the agent-comms loop is now LIVE (the margin Comment button + inline replies +
// FLOW's channel_reply), so the disabled stub button is retired.
import type { ApplyCommentMark } from "./DocEditor.js";
import { CommentRail } from "../live/doc/CommentRail.js";
import { DiffDrawer } from "../live/doc/DiffDrawer.js";
import { useDocsRailStyles } from "./docs-styles.js";

export function DocsRail({
  runId,
  docId,
  applyCommentMark,
}: {
  runId: string;
  docId: string;
  applyCommentMark: ApplyCommentMark;
}) {
  useDocsRailStyles();

  return (
    <div className="dr-root">
      <div className="dr-body">
        <CommentRail runId={runId} docId={docId} applyCommentMark={applyCommentMark} />
      </div>
      {/* The live agent-edit diff (Accept/Iterate/Reject) — stays mounted so a ws doc-update slides it up. */}
      <DiffDrawer runId={runId} docId={docId} />
    </div>
  );
}
