// OnShift — who is working, right now, across the whole project.
//
// Presence also appears on the run cards, and that is not a duplicate: the card answers "who is on THIS
// run", while this answers "who is working at all" — the question you have when you are not looking at
// any particular run. It lives in the sidebar because it belongs to the workspace, not to the board:
// switch to Memory or Gates and you still want to know four agents are mid-flight.
import { useEffect, useState } from "react";
import type { AgentView } from "@agentry/workbench-shared";
import { fetchAgents } from "../../api/index.js";
import { getWsClient } from "../../api/ws.js";

export function OnShift() {
  const [agents, setAgents] = useState<AgentView[]>([]);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () => {
      void fetchAgents(undefined, ctrl.signal)
        .then(setAgents)
        .catch(() => {});
    };
    load();
    const off = getWsClient().subscribe((msg) => {
      if (msg.type === "works-changed" || msg.type === "file-changed") load();
    });
    return () => {
      ctrl.abort();
      off();
    };
  }, []);

  // An empty roster is the normal resting state of a project nobody is running right now, so it says so
  // in one quiet line rather than leaving a labelled panel with nothing under it.
  return (
    <div className="roster">
      <div className="k">On shift</div>
      {agents.length === 0 ? (
        <div className="idle">nobody working</div>
      ) : (
        agents.map((a) => (
          <div className="who" key={a.id} title={`${a.role} · ${a.state}${a.task ? ` · task ${a.task}` : ""}`}>
            <span className={`av ${a.state}`}>{a.role.slice(0, 2).toUpperCase()}</span>
            <span className="nm">{a.role}</span>
            {a.state === "working" ? <span className="pulse" /> : null}
          </div>
        ))
      )}
    </div>
  );
}
