// Process identity — which runs/session THIS flow process has operated on. A stdio MCP process is
// 1:1 with a Claude Code session (one process per session), so process-global identity == session
// identity: a module singleton is the correct scope here, NOT a leak. It's the live signal the
// comment-routing decision reads at emit-time to answer "is this run mine?".
//
// `myRuns` fills from the explicit `run` arg every tool threads (ADR-005 normal path) via the
// `resolveRunContext` chokepoint; `mySessionId` records the first `session_id` a caller passes, so
// the persisted pointer can be cross-checked. Both are read live (knownRuns/knownSessionId), never
// captured once — a run operated on after startup must count.

const operatedRuns = new Set<string>();
let sessionId: string | undefined;

// Record a run this process operated on. No-op for an absent/empty run (resolveRunContext may run
// before a run is known — the session pointer path).
export function noteRunArg(run?: string): void {
  if (run !== undefined && run.length > 0) operatedRuns.add(run);
}

// Record the session this process serves — the FIRST non-empty session_id seen wins (a process is
// 1:1 with a session; later args carrying the same id are redundant, a different id would be misuse).
export function noteSessionArg(session_id?: string): void {
  if (sessionId === undefined && session_id !== undefined && session_id.length > 0) {
    sessionId = session_id;
  }
}

// The runs this process has operated on (read live at emit-time).
export function knownRuns(): ReadonlySet<string> {
  return operatedRuns;
}

// The session this process serves, or undefined if no caller ever passed a session_id.
export function knownSessionId(): string | undefined {
  return sessionId;
}

// Clear both — TESTS ONLY (module singleton state would otherwise bleed across cases).
export function __resetProcessIdentity(): void {
  operatedRuns.clear();
  sessionId = undefined;
}
