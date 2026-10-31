// ConductorRail — the conversation, always there.
//
// It was a TAB inside a run. That was the wrong shape: a conversation is ambient to the work, not a
// place you navigate to, and putting it behind a tab meant you could not watch the board and talk about
// it at the same time — which is the entire point of having a bidirectional rail at all.
//
// Three modes, because "closed" and "narrow" are different needs (doc 18 AC12):
//   collapsed — a spine with an unread count. Heads-down on the board, but still told when something
//               arrives; a zero-width rail cannot do that.
//   rail      — the default. Watching work while talking.
//   focus     — the conversation leads, for thinking a problem through.
//
// The rail is bound to a FOCUSED RUN, because the thread lives on that run's `.review/` bus. Opening a
// run focuses it; the focus survives navigation back to the board, so you can keep talking about the run
// you were just looking at. With nothing focused there is no conversation to show, and the rail says so
// rather than inventing a cross-run feed that has no file behind it.
import { useEffect, useState } from "react";
import { Conductor } from "./Conductor.js";
import { RailGates } from "./RailGates.js";
import { MODES, type RailMode, loadMode, saveMode, useFocusedRun } from "./rail-state.js";

export function ConductorRail() {
  const [mode, setMode] = useState<RailMode>(loadMode);
  const focused = useFocusedRun();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    saveMode(mode);
    // The mode is a layout fact, not just this component's state: the app grid reads it to size the
    // columns, and the board switches to its digest in focus mode.
    document.body.dataset.chat = mode;
  }, [mode]);

  // Anything arriving while collapsed is counted, so the spine can say "3" rather than going quiet —
  // the whole reason collapsed is not the same as closed.
  useEffect(() => {
    if (mode !== "collapsed") setUnread(0);
  }, [mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘\ cycles the split, the way an editor toggles its panel.
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setMode((m) => MODES[(MODES.indexOf(m) + 1) % MODES.length] as RailMode);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (mode === "collapsed") {
    return (
      <aside className="rail collapsed">
        <button
          type="button"
          className="spine"
          onClick={() => setMode("rail")}
          aria-label="Open the conversation"
        >
          {unread > 0 ? <span className="badge">{unread}</span> : null}
          <span className="vt">Conductor</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="rail" aria-label="Conductor conversation">
      <div className="railhd">
        <div className="meta">
          <div className="t">Conductor</div>
          <div className="s">{focused ?? "no run in focus"}</div>
        </div>
        <div className="grow" />
        <div className="modes" role="group" aria-label="Conversation size">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={m === mode ? "on" : ""}
              onClick={() => setMode(m)}
              title={LABELS[m]}
              aria-label={LABELS[m]}
              aria-pressed={m === mode}
            >
              {GLYPHS[m]}
            </button>
          ))}
        </div>
      </div>

      {focused === null ? (
        <div className="rail-empty">
          <b>No run in focus</b>
          <span>Open a run and the conversation with its conductor appears here.</span>
        </div>
      ) : (
        <>
          {/* What is waiting on you sits ABOVE the thread: a gate is the agent having stopped, which
              outranks anything already said. */}
          <RailGates run={focused} />
          <Conductor runId={focused} onIncoming={() => setUnread((n) => n + 1)} />
        </>
      )}
    </aside>
  );
}

const LABELS: Record<RailMode, string> = {
  collapsed: "Collapse to a spine",
  rail: "Rail — the board leads",
  focus: "Focus — the conversation leads",
};

const GLYPHS: Record<RailMode, string> = { collapsed: "⟩", rail: "▥", focus: "⟨" };
