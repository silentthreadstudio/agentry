// workspace-counts — the numbers the sidebar carries beside each destination.
//
// The counts are the point of the sidebar, not decoration: "Gates 2" is how you learn something is
// waiting on you without opening the page, and a nav entry with no number makes you click to find out
// there was nothing there. They refresh on the same `works-changed` nudge the board uses, so they never
// disagree with what the board is showing.
import { useEffect, useState } from "react";
import { fetchBoard, fetchGates, fetchMemory, fetchProjects } from "../../api/index.js";
import { getWsClient } from "../../api/ws.js";

export interface WorkspaceCounts {
  board: number;
  backlog: number;
  gates: number;
  memory: number;
  projects: number;
}

const EMPTY: WorkspaceCounts = { board: 0, backlog: 0, gates: 0, memory: 0, projects: 0 };

export function useWorkspaceCounts(): WorkspaceCounts {
  const [counts, setCounts] = useState<WorkspaceCounts>(EMPTY);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () => {
      // Each source is independent: one failing endpoint must leave the others' numbers intact rather
      // than blanking the whole sidebar.
      void fetchBoard(ctrl.signal)
        .then((board) => {
          const all = Object.values(board.columns);
          setCounts((c) => ({
            ...c,
            board: all.reduce((sum, list) => sum + list.length, 0),
            backlog: board.columns.backlog.length + board.columns.ready.length,
          }));
        })
        .catch(() => {});
      void fetchGates(undefined, ctrl.signal)
        .then((gates) => setCounts((c) => ({ ...c, gates: gates.length })))
        .catch(() => {});
      void fetchMemory(undefined, ctrl.signal)
        .then((records) => setCounts((c) => ({ ...c, memory: records.length })))
        .catch(() => {});
      void fetchProjects(ctrl.signal)
        .then((list) => setCounts((c) => ({ ...c, projects: list.projects.length })))
        .catch(() => {});
    };

    load();
    const off = getWsClient().subscribe((msg) => {
      if (msg.type === "works-changed") load();
    });
    return () => {
      ctrl.abort();
      off();
    };
  }, []);

  return counts;
}
