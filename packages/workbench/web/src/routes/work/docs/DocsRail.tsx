// DocsRail — the Docs workspace's right column (task 008, the mockup's `.rail`). The active doc's
// conversation: a header ("Conversation · <open count>" + an inert "Ask agent" button — the live
// agent-comms loop is the NEXT planned piece, so the button is disabled with a "coming" affordance and
// NO faked backend), then the existing CommentRail (the comment loop: list + selection bubble + on-disk
// hydrate), and the DiffDrawer (the live agent-edit before/after with Accept/Iterate/Reject).
//
// REUSE: CommentRail (task 18) and DiffDrawer (task 19) carry the whole comment→.review write + diff
// flow unchanged — DocsRail only frames them with the mockup's conversation header. The "Ask agent"
// stub is the single inert affordance; the comment write + the diff-on-agent-edit stay fully live.
import type { ApplyCommentMark } from "./DocEditor.js";
import { CommentRail } from "../live/doc/CommentRail.js";
import { DiffDrawer } from "../live/doc/DiffDrawer.js";
import { useOpenCommentCount } from "../live/doc/comment-store.js";
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
  const open = useOpenCommentCount(runId, docId);

  return (
    <div className="dr-root">
      <div className="dr-hd">
        <b>Conversation</b>
        {open > 0 ? <span className="dr-count">{open}</span> : null}
        {/* Inert until the live agent-comms loop ships — disabled, with a title affordance. No faked backend. */}
        <button
          type="button"
          className="dr-ask"
          disabled
          title="Live agent replies are coming in the next view — comments are written to the gate now."
        >
          ✦ Ask agent
        </button>
      </div>
      <div className="dr-body">
        <CommentRail runId={runId} docId={docId} applyCommentMark={applyCommentMark} />
      </div>
      {/* The live agent-edit diff (Accept/Iterate/Reject) — stays mounted so a ws doc-update slides it up. */}
      <DiffDrawer runId={runId} docId={docId} />
    </div>
  );
}
