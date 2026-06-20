// use-roster — the live agent-tracking data hook for the Panorama (doc 10 §3a "live execution on the
// graph"). Folds two read-model sources into the overlay the canvas + roster panel render:
//   • /api/agents (roster)  → every recorded agent with its FLOW state (working|blocked|done) + task.
//   • /api/events           → node-enter lines carry { node, agent, ts }; the latest per node gives the
//                             "since" timestamp for the timer + the agent on that node.
// It re-fetches on the ws stream (debounced) so a node-enter / status flip updates with no reload — the
// same calm live behavior as the graph fetch. Pure data: no view state, no timer here (the chip + panel
// tick their own elapsed display locally so the overlay map stays referentially stable — no graph re-diff).
import { useEffect, useState } from "react";
import type { AgentView, EventView } from "@agentry/workbench-shared";
import { fetchAgents, fetchEvents } from "../../../api/client.js";
import { getWsClient } from "../../../api/ws-client.js";

// One agent on a node: the role (the dispatched agent type) + when it entered (the timer base).
export interface NodeAgent {
  role: string;
  sinceIso: string;
}

// One row in the roster panel: the agent's identity + FLOW state + the node it's on + its since stamp.
export interface RosterAgent {
  id: string;
  role: string;
  state: AgentView["state"]; // working | blocked | done (FLOW's closed AgentState)
  task: string | null;
  sinceIso: string | null;
}

export interface Roster {
  agents: RosterAgent[];
  byNode: Map<string, NodeAgent>; // node id → the agent working it (latest node-enter)
}

const EMPTY: Roster = { agents: [], byNode: new Map() };

// Normalize a roster task ref to a graph node id: a bare task number/slug becomes "task-<n>" (the node id
// form the graph uses); an already-prefixed id passes through. Lets the panel's "since" match byNode.
function nodeIdOfTask(task: string): string {
  return task.startsWith("task-") || task === "spec" || task === "plan" ? task : `task-${task}`;
}

/** Fold the roster + events into the overlay, re-fetching on the ws stream. Degrades to empty on error. */
export function useRoster(runId: string): Roster {
  const [roster, setRoster] = useState<Roster>(EMPTY);

  useEffect(() => {
    let alive = true;
    const load = () => {
      const ctrl = new AbortController();
      Promise.all([fetchAgents(runId, ctrl.signal), fetchEvents(runId, ctrl.signal)])
        .then(([agents, events]) => {
          if (alive) setRoster(fold(agents, events));
        })
        .catch(() => {
          /* offline / aborted — keep the last good roster */
        });
      return ctrl;
    };

    let ctrl = load();
    // Debounce ws bursts (a node-enter + a status write arrive together) into one refetch.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = getWsClient().subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        ctrl.abort();
        ctrl = load();
      }, 250);
    });

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      ctrl.abort();
      off();
    };
  }, [runId]);

  return roster;
}

// The pure fold (exported for unit tests): roster + events → the overlay.
//
// The ROSTER is authoritative for "which agent is on which node" (its FLOW state + assignedTask, written by
// the conductor to run-state.json). EVENTS only supply the timer base: the latest FLOW `node-enter` ts per
// node id. (Hook-backstop node-enter lines carry a hook `kind` as `node`, not a graph node id, so they
// simply don't match — the chip then shows the role without a timer, a graceful degrade.)
//
// `byNode` is built from the WORKING agents (the in-progress card reads it); the panel rows carry every
// agent with its best-effort `sinceIso`.
export function fold(agents: readonly AgentView[], events: readonly EventView[]): Roster {
  const sinceByNode = new Map<string, string>();
  for (const { event } of events) {
    if (event.type === "node-enter") sinceByNode.set(event.node, event.ts);
  }

  const byNode = new Map<string, NodeAgent>();
  const rows: RosterAgent[] = agents.map((a) => {
    const node = a.task ? nodeIdOfTask(a.task) : null;
    const sinceIso = node ? (sinceByNode.get(node) ?? null) : null;
    if (a.state === "working" && node) {
      byNode.set(node, { role: a.role, sinceIso: sinceIso ?? "" });
    }
    return { id: a.id, role: a.role, state: a.state, task: a.task, sinceIso };
  });
  return { agents: rows, byNode };
}

// Format an elapsed duration from an ISO start to `nowMs` as a compact "45s" / "2m" / "1h 4m". Used by the
// node chip + the roster panel, both of which tick `nowMs` locally so the display counts up live.
export function formatElapsed(sinceIso: string, nowMs: number): string {
  const start = Date.parse(sinceIso);
  if (Number.isNaN(start)) return "";
  const s = Math.max(0, Math.floor((nowMs - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// A 1-second ticking clock for the live timers — returns Date.now() (ms), updated each second. Local to the
// chip/panel that calls it, so only those tiny components re-render on a tick (never the graph).
export function useNowTick(): number {
  const [now, setNow] = useState(() => nowMsSeed());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// Seed without calling Date.now() at module scope; fine at runtime (the hook reads it inside useState init).
function nowMsSeed(): number {
  return Date.now();
}
