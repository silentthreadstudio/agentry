// selection-store — the shared "a comment is being composed" signal between the editor column (where the
// margin 💬 button lives) and the review rail (where the composer renders). The two are grid SIBLINGS in
// DocsWorkspace, so neither can prop-drill to the other; this module store is the seam (same pattern as
// comment-store). The GutterCommentButton captures a selection and calls `openComposer`; the rail's
// RailComposer reads it via `usePendingComment` and renders the composer anchored to that quote.
//
// SRP: this holds ONLY the in-flight selection (text + anchor + the DOM Range kept for the in-editor
// highlight). The posted comment lives in comment-store; the two never overlap. A single global slot — one
// composer is open at a time — keyed by run+doc so a doc switch (or a post) clears it.
import { useSyncExternalStore } from "react";
import type { ReviewAnchor } from "./review-types.js";

/** The selection a comment is being composed against (the rail composer's input). */
export interface PendingComment {
  runId: string;
  docId: string;
  text: string; // the quoted span (anchor.originalText, shown in the composer)
  anchor: ReviewAnchor; // the 3-way anchor built at capture time (the server's stored shape)
  range: Range; // kept so applyCommentMark can paint the in-editor highlight once the id is minted
}

let pending: PendingComment | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Open the rail composer against a captured selection (the margin button's click). */
export function openComposer(p: PendingComment): void {
  pending = p;
  emit();
}

/** Close the composer (a post landed, the user cancelled, or the doc switched). Idempotent. */
export function closeComposer(): void {
  if (pending === null) return;
  pending = null;
  emit();
}

/** The pending composer for THIS run+doc, or null. Returns the stable `pending` ref so useSyncExternalStore
 *  doesn't tear (same object across reads until it changes). Filtered by run+doc so a stale slot from another
 *  doc never shows in this rail. */
export function usePendingComment(runId: string, docId: string): PendingComment | null {
  const get = (): PendingComment | null =>
    pending !== null && pending.runId === runId && pending.docId === docId ? pending : null;
  return useSyncExternalStore(subscribe, get, get);
}
