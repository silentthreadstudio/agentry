// GutterCommentButton — the ONLY floating affordance in the new comment UX. Select text in the open doc and
// a small 💬 button appears in the editor's RIGHT GUTTER (the whitespace beside the 760px prose column),
// vertically aligned to the selection — never over the text, so it can't fight the drag. Click it and the
// composer opens in the review rail (selection-store → RailComposer), anchored to the selection.
//
// Why this replaced the old SelectionBubble: that one was a 300px card pinned over the selection on every
// `selectionchange`, autofocusing a textarea — so it landed on top of the text mid-drag and made selecting
// painful. This shows only AFTER the selection settles (`mouseup`), is ~30px, lives in the margin, and never
// takes focus. Works in Read AND Edit mode (both render a `.dd-prose .ProseMirror`, selectable either way).
import { useCallback, useEffect, useRef, useState } from "react";
import { buildAnchor } from "./anchor.js";
import { openComposer } from "./selection-store.js";

interface ButtonPos {
  left: number;
  top: number;
}

export function GutterCommentButton({ runId, docId }: { runId: string; docId: string }) {
  const [pos, setPos] = useState<ButtonPos | null>(null);
  // The selection frozen when the button appeared — click posts against this, not the live DOM selection
  // (which a click can collapse). Holds the prose root + range + text needed to build the 3-way anchor.
  const captured = useRef<{ prose: HTMLElement; range: Range; text: string } | null>(null);

  const hide = useCallback(() => {
    setPos(null);
    captured.current = null;
  }, []);

  // Show on mouseup: only when a non-empty selection sits inside this doc's prose. Positioned in the editor
  // body's right gutter (`.de-body` right edge), clamped to the visible body so it never escapes the column.
  useEffect(() => {
    function onMouseUp() {
      // Defer a tick so the browser has finalized the selection the mouseup produced.
      requestAnimationFrame(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hide();
        const range = sel.getRangeAt(0);
        const prose = proseRoot(range.commonAncestorContainer);
        if (!prose) return hide();
        const text = sel.toString().trim();
        if (!text) return hide();
        const body = prose.closest(".de-body") as HTMLElement | null;
        const rect = range.getBoundingClientRect();
        const bodyRect = (body ?? prose).getBoundingClientRect();
        const top = Math.min(
          Math.max(rect.top + rect.height / 2 - 16, bodyRect.top + 6),
          bodyRect.bottom - 40,
        );
        // Right-align the labeled pill into the gutter; clamp so it never crosses into the prose column.
        captured.current = { prose, range: range.cloneRange(), text };
        setPos({ left: bodyRect.right - 130, top });
      });
    }
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, [hide]);

  // A collapsed selection (clicked away) dismisses the button; so does a doc switch.
  useEffect(() => {
    function onSelChange() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) hide();
    }
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
  }, [hide]);
  useEffect(() => hide(), [docId, hide]);

  if (!pos) return null;

  return (
    <button
      type="button"
      className="dd-gutter-btn"
      style={{ left: pos.left, top: pos.top }}
      aria-label="Comment on selection"
      title="Comment on selection"
      // Keep the selection alive through the click so the captured range still maps into the editor.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const snap = captured.current;
        if (!snap) return;
        const anchor = buildAnchor(snap.prose, snap.range, snap.text);
        openComposer({ runId, docId, text: snap.text, anchor, range: snap.range });
        hide();
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
      Comment
    </button>
  );
}

// The nearest enclosing editor prose element of a node, or null if the node is outside the open doc's prose.
function proseRoot(node: Node | null): HTMLElement | null {
  let el: Node | null = node;
  while (el && !(el instanceof HTMLElement)) el = el.parentNode;
  return (el as HTMLElement | null)?.closest(".dd-prose .ProseMirror") ?? null;
}
