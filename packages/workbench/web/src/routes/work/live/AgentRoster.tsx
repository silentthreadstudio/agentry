// AgentRoster — the live roster panel docked bottom-left over the Panorama canvas (doc 10 §3a / the
// agent-overlay mockup). Lists every recorded agent with its FLOW state (working | blocked | done), the
// node it's on, and a live "since" timer. Pure view over `useRoster`'s `agents` (fetched + ws-refreshed in
// Panorama, passed down); the only local state is the 1s clock that ticks the timers. Hidden when the run
// has no agents yet (an empty panel is clutter, not information).
import { formatElapsed, useNowTick, type RosterAgent } from "./use-roster.js";

const ORDER: Record<RosterAgent["state"], number> = { working: 0, blocked: 1, done: 2 };
const STATE_GLYPH: Record<RosterAgent["state"], string> = { working: "✳", blocked: "◇", done: "✓" };

export function AgentRoster({ agents }: { agents: readonly RosterAgent[] }) {
  const now = useNowTick();
  if (agents.length === 0) return null;
  const sorted = [...agents].sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  const working = agents.filter((a) => a.state === "working").length;

  return (
    <div className="ar-panel" aria-label="Live agents">
      <div className="ar-hd">
        <span className="ar-t">Agents · live</span>
        <span className="ar-count">{working ? `${working} working` : "idle"}</span>
      </div>
      {sorted.map((a) => (
        <div key={a.id} className={`ar-row ${a.state}`}>
          <span className="ar-ava" aria-hidden="true">{STATE_GLYPH[a.state]}</span>
          <div className="ar-who">
            <div className="ar-role">{a.role}</div>
            <div className="ar-meta">
              {a.task ? a.task : "no task"}
              {a.sinceIso ? ` · ${formatElapsed(a.sinceIso, now)}` : ""}
            </div>
          </div>
          <span className="ar-st">
            <i aria-hidden="true" />
            {a.state}
          </span>
        </div>
      ))}
    </div>
  );
}
