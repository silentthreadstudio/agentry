// rail-state — the conversation rail's two pieces of durable state: how wide it is, and which run it is
// talking about. Both outlive a navigation, and the mode outlives a reload (doc 18 AC12).
//
// Storage is deliberately split by lifetime:
//   • the MODE is a workspace preference — how you like to work — so it lives in `localStorage`.
//   • the FOCUSED RUN is per-tab context — two tabs can watch two different runs — so it lives in
//     `sessionStorage`, the same axis the project selection uses.
// Every access is wrapped: storage throws in private mode and with site data blocked, and a rail that
// crashes the app because it could not remember a preference would be a poor trade.
import { useEffect, useState } from "react";

export const MODES = ["collapsed", "rail", "focus"] as const;
export type RailMode = (typeof MODES)[number];

const MODE_KEY = "agentry.workbench.rail";
const RUN_KEY = "agentry.workbench.focusedRun";
/** Announced when the rail is pointed at a different run. The ws client listens for it so the live
 *  socket follows the conversation; this module deliberately does NOT reach into transport itself. */
export const FOCUS_EVENT = "agentry:focus-run";

export function loadMode(): RailMode {
  try {
    const raw = window.localStorage.getItem(MODE_KEY);
    return (MODES as readonly string[]).includes(raw ?? "") ? (raw as RailMode) : "rail";
  } catch {
    return "rail";
  }
}

export function saveMode(mode: RailMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* storage unavailable — the mode simply does not persist */
  }
}

export function focusedRun(): string | null {
  try {
    return window.sessionStorage.getItem(RUN_KEY);
  } catch {
    return null;
  }
}

/** Point the rail at a run. Called when a run view mounts, so opening a run is what focuses it — no
 *  separate "talk about this" affordance to discover. */
export function focusRun(run: string): void {
  try {
    if (window.sessionStorage.getItem(RUN_KEY) === run) return;
    window.sessionStorage.setItem(RUN_KEY, run);
  } catch {
    /* storage unavailable — the rail falls back to no focus */
  }
  // Storage writes fire no event in the tab that made them, so listeners are told directly. The ws
  // client is one of them: the socket is scoped by run and the rail's run is not in the URL, so a focus
  // change has to re-point it or the thread goes one-way.
  window.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: run }));
}

/** The run the rail is talking about, live across focus changes. */
export function useFocusedRun(): string | null {
  const [run, setRun] = useState<string | null>(focusedRun);
  useEffect(() => {
    const onFocus = (e: Event) => setRun((e as CustomEvent<string>).detail);
    window.addEventListener(FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_EVENT, onFocus);
  }, []);
  return run;
}
