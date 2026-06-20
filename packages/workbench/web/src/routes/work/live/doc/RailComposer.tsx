// RailComposer — the comment composer, now living in the review rail (not floating over the text). It
// appears at the top of the rail when the margin 💬 button captures a selection (selection-store →
// usePendingComment): the quoted span, a textarea, and the three decisions (request changes / question /
// approve). Posting writes the comment (comment-store → task 17's /comment), paints the in-editor highlight
// (applyCommentMark, AC5), and closes the composer; the new comment then shows in the list below.
//
// Autofocusing the textarea is SAFE here (unlike the old floating bubble) — the composer is in the rail, far
// from the prose, so taking focus never disturbs the selection or the reader's place in the document.
import { useState } from "react";
import type { ReviewDecision } from "./review-types.js";
import { addComment } from "./comment-store.js";
import { closeComposer, usePendingComment } from "./selection-store.js";
import type { ApplyCommentMark } from "../../docs/DocEditor.js";

const DECISIONS: ReadonlyArray<{ decision: ReviewDecision; label: string; cls: string }> = [
  { decision: "changes", label: "✎ Request changes", cls: "chg" },
  { decision: "question", label: "? Question", cls: "qz" },
  { decision: "approve", label: "✓ Approve", cls: "acc" },
];

export function RailComposer({
  runId,
  docId,
  applyCommentMark,
  onPosted,
}: {
  runId: string;
  docId: string;
  applyCommentMark?: ApplyCommentMark | undefined;
  onPosted?: (message: string) => void;
}) {
  const pending = usePendingComment(runId, docId);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  if (!pending) return null;

  async function post(decision: ReviewDecision) {
    if (!pending || busy) return;
    setBusy(true);
    const result = await addComment({ runId, docId, anchor: pending.anchor, decision, body: body.trim() });
    setBusy(false);
    if (result.ok && result.id) applyCommentMark?.(pending.range, result.id);
    onPosted?.(result.message);
    if (result.ok) {
      setBody("");
      closeComposer();
    }
  }

  return (
    <div className="dd-composer">
      <div className="dd-composer-h">
        <span className="dd-composer-t">New comment</span>
        <button type="button" className="dd-composer-x" aria-label="Cancel" onClick={closeComposer}>
          ×
        </button>
      </div>
      <div className="dd-composer-q">“{pending.text}”</div>
      <textarea
        className="dd-composer-ta"
        placeholder="Add a note… (optional), then pick a decision below"
        value={body}
        autoFocus
        disabled={busy}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            closeComposer();
          } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void post("question");
          }
        }}
      />
      <div className="dd-composer-row">
        {DECISIONS.map((d) => (
          <button
            key={d.decision}
            type="button"
            className={`dd-bubble-btn ${d.cls}`}
            disabled={busy}
            onClick={() => void post(d.decision)}
          >
            {d.label}
          </button>
        ))}
      </div>
    </div>
  );
}
