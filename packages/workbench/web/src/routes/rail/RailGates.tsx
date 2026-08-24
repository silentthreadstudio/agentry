// RailGates — what is waiting on you, in the conversation.
//
// A gate is a document with unresolved human comments: the agent has stopped and is waiting for an
// answer. It already appears on the board (the `gate` chip) and on the Gates page, but neither is where
// you are when the agent asks — you are in the conversation. So the rail carries it too, as something
// you can act on rather than a badge you have to go somewhere else to clear.
//
// The actions are deliberately the two that are TRUE here: open the document in the work column, or mark
// it resolved. There is no "approve and start the build" — the Workbench has no model and cannot start
// anything (doc 19 D1), and a button implying otherwise would be the same lie as the old "Start now".
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchGates, type OpenGateItem } from "../../api/index.js";
import { getWsClient } from "../../api/ws.js";
import { resolveComment } from "../doc/comment-store.js";
import { runHref } from "../board/board-view.js";

export function RailGates({ run }: { run: string }) {
  const [gates, setGates] = useState<OpenGateItem[]>([]);
  const navigate = useNavigate();

  const load = useCallback(() => {
    fetchGates(run)
      .then(setGates)
      .catch(() => setGates([]));
  }, [run]);

  useEffect(() => {
    load();
    return getWsClient().subscribe((msg) => {
      if (msg.type === "works-changed" || msg.type === "file-changed") load();
    });
  }, [load]);

  if (gates.length === 0) return null;

  const clear = async (gate: OpenGateItem) => {
    // Resolving every open comment on the doc IS clearing the gate — the gate is not a separate record,
    // it is the presence of unanswered comments, so there is nothing else to mark.
    for (const comment of gate.comments) {
      await resolveComment(run, gate.gate, comment.id);
    }
    load();
  };

  return (
    <div className="railgates">
      {gates.map((gate) => (
        <article className="railgate" key={`${gate.run}/${gate.gate}`}>
          <div className="k">
            Gate · {gate.docId}
            <span className="n">{gate.comments.length} open</span>
          </div>
          <div className="q">{gate.comments[0]?.body ?? "Waiting on you."}</div>
          <div className="acts">
            <button type="button" className="pri" onClick={() => void clear(gate)}>
              Resolve
            </button>
            <button type="button" onClick={() => navigate(`${runHref(run)}?doc=${encodeURIComponent(gate.docId)}`)}>
              Open {gate.docId}
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
