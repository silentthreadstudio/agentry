// DiffDrawer — the live before/after diff with Accept/Reject/Iterate (task 19, ported from
// prototype-document.html's `.diff` drawer). Mounted via DocDrawer's `diffDrawer` slot (so it plugs in
// without editing the drawer), it watches the open document over the websocket: when an agent edit
// live-updates the doc (`doc-updated`) — or a diff is announced (`diff-ready`) — it slides up and shows
// the before/after, with the gate actions wired to task 17's write endpoints. NOTHING here reloads the
// page (AC7): the ws message flows into React state and re-renders in place.
//
// ── The live loop (plan §3 / AC7) ─────────────────────────────────────────────────────────────────────
//   agent writes a file → watcher fires → server re-projects → ws pushes a `WsMessage` keyed to the run.
//   • doc-updated{docId,doc}      → the fresh DocModel IS the "after"; the prior body is the "before".
//   • diff-ready{docId,base,head} → carries only versions, so we fetch the fresh doc as the "after".
//   The "before" is the body we last held (initial fetch on open, then each accepted/observed version).
//
// The diff is over task 14's `normalize(body)` for BOTH sides, so it reflects real prose edits, not
// serializer formatting. Accept writes the after-body via `/artifact` (bumping the version); Reject
// discards it (keep the before); Iterate posts a follow-up "please iterate" comment to the gate.
import { useCallback, useEffect, useRef, useState } from "react";
import type { DocModel, WsMessage } from "@agentry/workbench-shared";
import { getWsClient } from "../../../../api/ws.js";
import { normalize } from "./markdown-serializer.js";
import { wordDiff, isUnchanged, type DiffOp } from "./word-diff.js";
import { addComment } from "./comment-store.js";
import { useDiffStyles } from "./diff-styles.js";

async function fetchDoc(runId: string, docId: string, signal: AbortSignal): Promise<DocModel> {
  const res = await fetch(
    `/api/work/${encodeURIComponent(runId)}/doc/${encodeURIComponent(docId)}`,
    { headers: { accept: "application/json" }, signal },
  );
  if (!res.ok) throw new Error(`doc ${docId} → ${res.status} ${res.statusText}`);
  return (await res.json()) as DocModel;
}

// POST the accepted after-body via task 17's /artifact (the SAME shape DocDrawer's Save uses): echo the
// OPAQUE baseVersion, never compute one (ADR-006). Returns a user-facing message.
async function postArtifact(
  runId: string,
  docId: string,
  baseVersion: string,
  newBody: string,
): Promise<{ ok: boolean; message: string }> {
  let res: Response;
  try {
    res = await fetch(`/api/work/${encodeURIComponent(runId)}/artifact`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ target: docId, baseVersion, newBody }),
    });
  } catch {
    return { ok: false, message: "Couldn't reach the server — not written." };
  }
  return res.ok
    ? { ok: true, message: "Accepted ✓ — written to the doc, version bumped, the agent continues." }
    : res.status === 409
      ? { ok: false, message: "Out of date — the doc moved on. Reopen to merge." }
      : { ok: false, message: `Write failed (${res.status} ${res.statusText}).` };
}

// A proposed change to review: the body to diff against, plus the base version Accept echoes.
interface Proposal {
  beforeBody: string; // normalized "before"
  afterBody: string; // normalized "after" (the agent's proposed text)
  baseVersion: string; // the version Accept writes against (the CURRENT on-disk version)
}

export function DiffDrawer({ runId, docId }: { runId: string; docId: string }) {
  useDiffStyles();
  // The body we currently believe is on disk (the diff "before") + its version. Seeded by the initial
  // fetch, advanced on every accepted/observed update so the next diff is against the latest baseline.
  const baseline = useRef<{ body: string; version: string } | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Open / reset the baseline whenever the watched doc changes — fetch its current body as the "before".
  useEffect(() => {
    baseline.current = null;
    setProposal(null);
    setFeedback(null);
    const ctrl = new AbortController();
    fetchDoc(runId, docId, ctrl.signal)
      .then((doc) => {
        baseline.current = { body: normalize(doc.body), version: doc.version };
      })
      .catch(() => {
        /* no baseline yet — the first doc-updated will seed both sides */
      });
    return () => ctrl.abort();
  }, [runId, docId]);

  // Land a fresh DocModel as the "after": diff it against the held baseline. A no-op edit shows nothing.
  const landUpdate = useCallback((doc: DocModel) => {
    const afterBody = normalize(doc.body);
    const base = baseline.current;
    if (!base) {
      // No baseline yet — adopt this as the baseline, nothing to diff.
      baseline.current = { body: afterBody, version: doc.version };
      return;
    }
    if (isUnchanged(base.body, afterBody)) {
      // The version moved but the prose didn't (formatting / frontmatter) — advance silently.
      baseline.current = { body: afterBody, version: doc.version };
      return;
    }
    setProposal({ beforeBody: base.body, afterBody, baseVersion: base.version });
  }, []);

  // Subscribe to the ws stream for THIS doc's updates (AC7 — no reload).
  useEffect(() => {
    const handle = (msg: WsMessage) => {
      if (msg.type === "doc-updated" && msg.docId === docId) {
        landUpdate(msg.doc);
      } else if (msg.type === "diff-ready" && msg.docId === docId) {
        // diff-ready carries only versions — fetch the fresh doc as the "after".
        const ctrl = new AbortController();
        fetchDoc(runId, docId, ctrl.signal).then(landUpdate).catch(() => {});
      }
    };
    const unsubscribe = getWsClient().subscribe(handle);
    return unsubscribe;
  }, [runId, docId, landUpdate]);

  const dismiss = useCallback(() => setProposal(null), []);

  async function accept() {
    if (!proposal || busy) return;
    setBusy(true);
    setFeedback(null);
    const result = await postArtifact(runId, docId, proposal.baseVersion, proposal.afterBody);
    setBusy(false);
    setFeedback(result.message);
    if (result.ok) {
      // The accepted after IS the new baseline — but the version is server-assigned; the next
      // doc-updated (the server pushes one after /artifact) re-seeds it. Clear the proposal now.
      baseline.current = { body: proposal.afterBody, version: proposal.baseVersion };
      setProposal(null);
    }
  }

  function reject() {
    if (busy) return;
    // Discard the agent's proposal: keep the before as the baseline, close the drawer.
    setProposal(null);
    setFeedback("Rejected — the agent keeps the original.");
  }

  async function iterate() {
    if (!proposal || busy) return;
    setBusy(true);
    // Send it back: a follow-up comment on the gate asks the agent to iterate (Reject the diff, keep
    // the before as baseline). Anchored at the section top (line 1) since this is a whole-doc note.
    await addComment({
      runId,
      docId,
      anchor: { originalText: docId, headingAnchor: "", startLine: 1 },
      decision: "changes",
      body: "Please iterate on this revision before it lands.",
    });
    setBusy(false);
    setProposal(null);
    setFeedback("Sent back to the agent to iterate ↻");
  }

  // Nothing to show when there's no live proposal (the drawer stays slid down). A transient feedback
  // line can still flash without a proposal (e.g. after Reject).
  const ops = proposal ? wordDiff(proposal.beforeBody, proposal.afterBody) : null;

  return (
    <div className={`dd-diff${proposal ? " up" : ""}`} role="dialog" aria-label="Proposed change" aria-hidden={!proposal}>
      <div className="dd-diff-h">
        <span className="dd-diff-tag">agent reply · in-doc</span>
        <b>The agent revised this document</b>
        <button type="button" className="dd-diff-x" onClick={dismiss} aria-label="Dismiss">
          ✕
        </button>
      </div>
      <div className="dd-diff-cols">
        <div className="dd-diff-c before">
          <div className="dd-diff-lab">before</div>
          <DiffPane ops={ops} side="before" />
        </div>
        <div className="dd-diff-c after">
          <div className="dd-diff-lab">after — proposed</div>
          <DiffPane ops={ops} side="after" />
        </div>
      </div>
      <div className="dd-diff-foot">
        <span className="dd-diff-note">
          {feedback ?? "Accept writes it to the doc; the agent continues. Reject keeps the original."}
        </span>
        <button type="button" className="dd-bbtn deny" onClick={reject} disabled={busy}>
          Reject
        </button>
        <button type="button" className="dd-bbtn iter" onClick={() => void iterate()} disabled={busy}>
          Iterate ↻
        </button>
        <button type="button" className="dd-bbtn accept" onClick={() => void accept()} disabled={busy}>
          {busy ? "Writing…" : "Accept ✓"}
        </button>
      </div>
    </div>
  );
}

// One pane of the diff: the before pane paints `equal`+`del`; the after pane paints `equal`+`add`. (A
// side-by-side full-text view of each version with the changed runs tinted — the prototype's treatment.)
function DiffPane({ ops, side }: { ops: DiffOp[] | null; side: "before" | "after" }) {
  if (!ops) return null;
  const drop = side === "before" ? "add" : "del"; // each side omits the OTHER side's exclusive run
  const changed = side === "before" ? "del" : "add";
  return (
    <p className="dd-diff-text">
      {ops
        .filter((op) => op.kind !== drop)
        .map((op, i) =>
          op.kind === changed ? (
            <span key={i} className={`dd-diff-${changed}`}>
              {op.text}
            </span>
          ) : (
            <span key={i}>{op.text}</span>
          ),
        )}
    </p>
  );
}
