// Agents — the roster across runs (the /agents sidebar page). Consumes GET /api/agents → AgentView[] (the
// cross-run roster task 20 derives from each run's run-state.json). Each entry's id is `<run>/<role>`, so a
// role that appears in several runs arrives as several entries; this page folds them into ONE card per role
// with its live state, the count of runs it has touched, and what it is on now — so a blocked role (the
// bottleneck) stands out. Dark + calm (AC8); loading / empty / error are good states (VISION §3). Read-only.
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { AgentView } from "@agentry/workbench-shared";
import { ApiError, fetchAgents } from "../api/client.js";
import { Avatar, EmptyState, StatusDot } from "../design-system/index.js";
import type { DotStatus } from "../design-system/index.js";

// ── View model: AgentView[] (one row per run/role) → one card per role ──────────────────────────────────
// Pure, exported for unit test. The cross-run roster has `<run>/<role>` ids; we group by role and pick the
// most "live" state across that role's appearances so the eye lands on what is moving (or stuck).
export interface RoleCard {
  role: string;
  state: AgentView["state"]; // FLOW's closed AgentState (working | blocked | done)
  runsTouched: number; // distinct runs this role appears in
  recent: string; // a short "what it is on" line
}

// AgentState → the StatusDot vocabulary. `working` maps to the in-progress dot, `blocked` to blocked,
// `done` to done — so the roster reads in the same dot language as the rest of the app.
const STATE_DOT: Record<AgentView["state"], DotStatus> = {
  working: "in-progress",
  blocked: "blocked",
  done: "done",
};

// The bottleneck-first priority: a blocked role outranks a working one outranks a done one, so the card a
// human should act on sorts to the top and supplies the role's headline state.
const STATE_RANK: Record<AgentView["state"], number> = { blocked: 0, working: 1, done: 2 };

export function rollUp(roster: AgentView[]): RoleCard[] {
  // Per role, track its appearances; the "live" appearance (the lowest STATE_RANK) supplies both the
  // headline state AND the recent task, so a working role's "Recent" is the task it is working — not a
  // stale done task seen first in another run.
  const byRole = new Map<string, { live: AgentView; runs: Set<string> }>();
  for (const a of roster) {
    const run = a.id.includes("/") ? a.id.slice(0, a.id.indexOf("/")) : a.id;
    const entry = byRole.get(a.role);
    if (!entry) {
      byRole.set(a.role, { live: a, runs: new Set([run]) });
      continue;
    }
    entry.runs.add(run);
    if (STATE_RANK[a.state] < STATE_RANK[entry.live.state]) entry.live = a;
  }

  const cards: RoleCard[] = [];
  for (const [role, entry] of byRole) {
    cards.push({
      role,
      state: entry.live.state,
      runsTouched: entry.runs.size,
      recent: recentLine(entry.live.state, entry.live.task),
    });
  }
  // bottleneck first, then most-active (runs touched), then name — stable + scannable.
  return cards.sort(
    (a, b) =>
      STATE_RANK[a.state] - STATE_RANK[b.state] || b.runsTouched - a.runsTouched || a.role.localeCompare(b.role),
  );
}

/** The card's "Recent" line: the task the live appearance is on, else a calm idle/blocked note. */
function recentLine(state: AgentView["state"], task: string | null): string {
  if (task) return task;
  return state === "working" ? "working" : state === "blocked" ? "blocked" : "idle";
}

// ── Component ────────────────────────────────────────────────────────────────────────────────────────
type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; roster: AgentView[] };

export function Agents() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    fetchAgents(undefined, ctrl.signal)
      .then((roster) => setState({ kind: "ready", roster }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        const message =
          err instanceof ApiError ? `Couldn’t load the agent roster (${err.status}).` : "Couldn’t load the agent roster.";
        setState({ kind: "error", message });
      });
    return () => ctrl.abort();
  }, []);

  const cards = useMemo(() => (state.kind === "ready" ? rollUp(state.roster) : []), [state]);

  return (
    <div className="page">
      {state.kind === "loading" ? (
        <EmptyState>Loading the roster…</EmptyState>
      ) : state.kind === "error" ? (
        <EmptyState title="Can’t reach the server">{state.message}</EmptyState>
      ) : cards.length === 0 ? (
        <EmptyState title="No agents yet">
          When Agentry dispatches its specialists they appear here — who’s working, who’s blocked, who’s done.
        </EmptyState>
      ) : (
        <div style={CARDS}>
          {cards.map((c) => (
            <AgentCard key={c.role} card={c} />
          ))}
        </div>
      )}
    </div>
  );
}

const STATE_LABEL: Record<AgentView["state"], string> = { working: "Working", blocked: "Blocked", done: "Done" };

function AgentCard({ card }: { card: RoleCard }) {
  return (
    <div style={CARD}>
      <div style={CARD_TOP}>
        <Avatar name={card.role} size={26} />
        <div style={{ minWidth: 0 }}>
          <div style={CARD_NAME}>{card.role}</div>
        </div>
        <span style={{ marginLeft: "auto" }}>
          <StatusDot status={STATE_DOT[card.state]} showLabel={false} />
        </span>
      </div>
      <div style={STAT}>
        <span>State</span>
        <b style={STAT_B}>{STATE_LABEL[card.state]}</b>
      </div>
      <div style={STAT}>
        <span>Runs touched</span>
        <b style={STAT_B}>{card.runsTouched}</b>
      </div>
      <div style={STAT}>
        <span>Recent</span>
        <span style={{ color: "var(--muted)", minWidth: 0, textAlign: "right" }}>{card.recent}</span>
      </div>
    </div>
  );
}

// Inline styles on the design tokens (the prototype's .cards/.card grid — restyled here because the page
// CSS classes live in task 10's stylesheet, not this owned route file).
const CARDS: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
  gap: 12,
};
const CARD: CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: 12,
  background: "var(--panel)",
  padding: 14,
};
const CARD_TOP: CSSProperties = { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 };
const CARD_NAME: CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const STAT: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  fontSize: 12,
  color: "var(--muted)",
  padding: "4px 0",
  borderTop: "1px solid var(--line)",
};
const STAT_B: CSSProperties = { color: "var(--ink)", fontWeight: 600 };
