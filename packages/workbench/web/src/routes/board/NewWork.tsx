// NewWork — the composer that puts work into the workspace.
//
// It creates a BACKLOG ITEM, not a run. That is the honest shape (doc 18 §3.2): the Workbench has no
// model and cannot dispatch an agent, so a button that read "Start now" would promise something the
// system does not do. Queueing marks an item available; the next conducting session claims it.
//
// The destination is therefore the real decision this dialog makes, which is why it is two explained
// options rather than two bare radio labels — and why the primary button's text changes with it.
import { useEffect, useRef, useState } from "react";
import { createBacklogItem } from "../../api/index.js";

const KINDS = ["feature", "bug", "refactor", "perf", "docs", "design"];

export function NewWork({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState("feature");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) titleRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setError(null);
  };

  const submit = async () => {
    const t = title.trim();
    if (t.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createBacklogItem({ title: t, body: body.trim(), kind, ready });
      setTitle("");
      setBody("");
      setReady(false);
      setOpen(false);
      onCreated();
    } catch {
      setError("Couldn't create that.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="newwork-open" onClick={() => setOpen(true)}>
        + New work
      </button>
    );
  }

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-dismiss; the keyboard path is Escape on the dialog below */}
      <div className="mscrim" onClick={close} />
      <section
        className="modal"
        // biome-ignore lint/a11y/useSemanticElements: <dialog> is closed until showModal() runs; this modal is mounted conditionally
        role="dialog"
        aria-modal="true"
        aria-label="New work"
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          // ⌘/Ctrl+Enter submits from anywhere in the dialog, including the textarea, where a bare
          // Enter has to stay a newline.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
        }}
      >
        <div className="mhd">
          <span className="t">New work</span>
        </div>

        <div className="mbody">
          <input
            ref={titleRef}
            className="tin"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs to happen?"
            aria-label="Title"
          />
          <textarea
            className="din"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Context the agents should start from — constraints, links, what done looks like."
            aria-label="Context"
          />

          <div className="frow">
            <span className="flbl">Kind</span>
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                className={`kchip${k === kind ? " on" : ""}`}
                onClick={() => setKind(k)}
              >
                {k}
              </button>
            ))}
          </div>

          <div>
            <span className="flbl block">Where does it go</span>
            <div className="dest">
              <button
                type="button"
                className={`dopt${ready ? "" : " on"}`}
                onClick={() => setReady(false)}
              >
                <span className="dt">
                  <span className="dot2" style={{ background: "var(--todo)" }} />
                  Backlog
                </span>
                <span className="dd">Captured, not started. Sits until you decide it's next.</span>
              </button>
              <button
                type="button"
                className={`dopt${ready ? " on" : ""}`}
                onClick={() => setReady(true)}
              >
                <span className="dt">
                  <span className="dot2" style={{ background: "var(--v1)" }} />
                  Ready
                </span>
                <span className="dd">
                  Queued for the conductor. The next session claims it, right-sizes the work, and
                  gates you at each decision.
                </span>
              </button>
            </div>
          </div>
        </div>

        <div className="mft">
          <span className="hint">⌘ + Enter to create</span>
          {error !== null ? (
            <span className="err" role="alert">
              {error}
            </span>
          ) : null}
          <span className="grow" />
          <button type="button" className="ghost" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="newwork-open"
            onClick={() => void submit()}
            disabled={busy || title.trim().length === 0}
          >
            {busy ? "Creating…" : ready ? "Queue for the conductor" : "Add to backlog"}
          </button>
        </div>
      </section>
    </>
  );
}
