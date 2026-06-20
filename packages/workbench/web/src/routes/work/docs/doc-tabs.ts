// doc-tabs — the open-document tab state for the Docs workspace (task 008). A tiny module-level store
// (mirroring the old `selectDoc` store pattern) that holds the ARRAY of open doc ids plus the active one.
// Opening a doc (a Live-graph node click, a Decisions row, the Gates `?doc=` jump) calls `openDocTab(id)`;
// the workspace's editor tab-strip subscribes via `useDocTabs()`.
//
// `selectDoc` is preserved as the cross-module OPEN SIGNAL the rest of the app already imports (Panorama,
// DecisionsDrawer, WorkLayout): it now opens+focuses a tab instead of opening the retired drawer. Keeping
// the name means the node/ADR/gate call sites stay one-liners — only their import path moves here, to the
// module that now owns "a doc is open".
import { useSyncExternalStore } from "react";

export interface DocTabsState {
  /** The open doc ids, in the order they were first opened (the tab-strip order). */
  open: readonly string[];
  /** The focused doc id, or null when no doc is open (the workspace shows its empty state). */
  active: string | null;
}

let state: DocTabsState = { open: [], active: null };
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The live open-tabs state (the editor strip + the active doc). */
export function useDocTabs(): DocTabsState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** Read the active doc id without a React render — the WorkLayout url-sync reads this. */
export function activeDocId(): string | null {
  return state.active;
}

/**
 * Open a doc (or focus it if already open) and make it active. A `null` clears the active doc WITHOUT
 * closing any tab — Back to the bare run state. This is the workspace's drawer-open replacement: it never
 * mounts an overlay, it adds/focuses a tab in the editor column.
 */
export function openDocTab(id: string | null): void {
  if (id == null) {
    if (state.active === null) return;
    state = { open: state.open, active: null };
    emit();
    return;
  }
  if (state.active === id) return; // already focused — no churn
  const open = state.open.includes(id) ? state.open : [...state.open, id];
  state = { open, active: id };
  emit();
}

/**
 * Close one open tab. The next active doc is the neighbor to the right (or left when closing the last),
 * or null when the strip empties — the calm, expected behavior of a tabbed editor.
 */
export function closeDocTab(id: string): void {
  const idx = state.open.indexOf(id);
  if (idx === -1) return;
  const open = state.open.filter((t) => t !== id);
  let active = state.active;
  if (active === id) {
    active = open[idx] ?? open[idx - 1] ?? null;
  }
  state = { open, active };
  emit();
}

// ── The preserved open-signal seam (selectDoc / useSelectedDoc) ──────────────────────────────────────
// The app's existing open contract: Panorama (node click), DecisionsDrawer (ADR row), and WorkLayout
// (the `?doc=` deep link + popstate) all speak `selectDoc`. It now opens a tab in the workspace.

/** Open the doc as a workspace tab (the Live-graph node click / ADR row / gate deep-link open signal). */
export function selectDoc(docId: string | null): void {
  openDocTab(docId);
}

/** The currently-active doc id (null = no doc open) — the back-compat read the popstate sync uses. */
export function useSelectedDoc(): string | null {
  return useDocTabs().active;
}
