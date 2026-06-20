// SelectionBubble — select a span in the open document → a floating bubble to compose a comment with a
// decision (task 18, ported from prototype-document.html's `.bubble`). On a decision click it builds the
// 3-way anchor from the selection and POSTs it (via comment-store → task 17's `/comment`); the rail and
// the node badge then reflect it with no reload.
//
// ── Why it reads the DOM selection, not the Tiptap editor handle ──────────────────────────────────────
// DocDrawer (task 16) owns the editor and exposes it only through render slots that pass `{ runId, docId }`
// — not the `Editor` instance, and its extension list does not register the `comment` mark. This task may
// not edit DocDrawer (pinned boundary). So the bubble anchors on the browser selection inside the rendered
// `.dd-prose .ProseMirror` node: that is enough to build the 3-way anchor the server stores (originalText
// = selected text, headingAnchor = nearest `##` above, startLine = body line of the selection). The
// in-editor highlight (the `comment` MARK) is defined in CommentMark.ts and serializes to nothing, but it
// is not live-applied here because the drawer's editor doesn't register it — see the implementer's flag.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewDecision } from "./review-types.js";
import { addComment } from "./comment-store.js";
import { buildAnchor } from "./anchor.js";

// The decisions the bubble offers, in the prototype's order (request-changes / question / approve). The
// FLOW vocabulary is `approve | changes | question` (ReviewDecision); the bubble maps its labels to it.
const DECISIONS: ReadonlyArray<{ decision: ReviewDecision; label: string; cls: string }> = [
  { decision: "changes", label: "✎ Request changes", cls: "chg" },
  { decision: "question", label: "? Question", cls: "qz" },
  { decision: "approve", label: "✓ Approve", cls: "acc" },
];

interface BubblePos {
  left: number;
  top: number;
}

export function SelectionBubble({
  runId,
  docId,
  onPosted,
}: {
  runId: string;
  docId: string;
  // Lets the rail toast/refresh after a post (the rail re-renders from the store regardless; this is the
  // optional UX nudge). Kept a callback so the bubble stays decoupled from the rail.
  onPosted?: (message: string) => void;
}) {
  const [pos, setPos] = useState<BubblePos | null>(null);
  // The selection captured when the bubble opened — frozen so a click on a bubble button (which can clear
  // the live DOM selection) still has the text/anchor to post.
  const captured = useRef<{ text: string; range: Range } | null>(null);

  const hide = useCallback(() => {
    setPos(null);
    captured.current = null;
  }, []);

  // Recompute the bubble on every selection change: show it when a non-empty selection sits inside the
  // open document's prose, hide it otherwise.
  useEffect(() => {
    function onSelectionChange() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        hide();
        return;
      }
      const range = sel.getRangeAt(0);
      const prose = proseRoot(range.commonAncestorContainer);
      if (!prose) {
        hide();
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        hide();
        return;
      }
      const rect = range.getBoundingClientRect();
      captured.current = { text, range: range.cloneRange() };
      setPos({ left: rect.left + rect.width / 2, top: rect.top });
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [hide]);

  // A new doc closes any open bubble (stale selection from the previous doc).
  useEffect(() => hide(), [docId, hide]);

  async function post(decision: ReviewDecision) {
    const snap = captured.current;
    if (!snap) return;
    const prose = proseRoot(snap.range.commonAncestorContainer);
    const anchor = buildAnchor(prose, snap.range, snap.text);
    hide();
    const result = await addComment({ runId, docId, anchor, decision, body: "" });
    onPosted?.(result.message);
  }

  if (!pos) return null;

  return (
    <div
      className="dd-bubble"
      style={{ left: pos.left, top: pos.top }}
      role="toolbar"
      aria-label="Comment on selection"
      // Keep the DOM selection alive while clicking a button.
      onMouseDown={(e) => e.preventDefault()}
    >
      {DECISIONS.map((d) => (
        <button
          key={d.decision}
          type="button"
          className={`dd-bubble-btn ${d.cls}`}
          onClick={() => void post(d.decision)}
        >
          {d.label}
        </button>
      ))}
    </div>
  );
}

// The nearest enclosing `.ProseMirror` element of a selection node, or null if the selection is outside
// the open document's prose (e.g. in the rail or source textarea).
function proseRoot(node: Node | null): HTMLElement | null {
  let el: Node | null = node;
  while (el && !(el instanceof HTMLElement)) el = el.parentNode;
  return (el as HTMLElement | null)?.closest(".dd-prose .ProseMirror") ?? null;
}
