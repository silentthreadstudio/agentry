// Comment routing — the PURE decision "should THIS process emit a channel for run X?" (no I/O,
// unit-testable). The bug it fixes: a stdio flow process is 1:1 with a session, but every session's
// process watches the SAME `.agentry/work/*` tree, so without this gate every process emits every
// run's comments — a human commenting on run A spams an unrelated session working on run C.
//
// The signals (all injected so this stays pure): `myRuns` = runs this process operated on via an
// explicit run arg; `mySessionId` = the session this process serves; `sessionsBoundTo(run)` = the
// sessions claiming a run via the persisted binder pointer ("is this run claimed by anyone?").
export interface RoutingDeps {
  myRuns: ReadonlySet<string>;
  mySessionId: string | undefined;
  sessionsBoundTo: (run: string) => readonly string[];
}

// Decide, in order:
//  1. myRuns.has(run)                  → true   (operated on via an explicit run arg → it's ours)
//  2. owners.includes(mySessionId)     → true   (bound to us via the persisted pointer)
//  3. owners.length > 0                → false  (claimed by SOME other session → not ours, drop)
//  4. else                            → true   (ORPHAN: no live match, no owner → broadcast so a
//                                                Workbench-only run's comment is never lost)
export function shouldRouteToThisSession(run: string, deps: RoutingDeps): boolean {
  if (deps.myRuns.has(run)) return true;
  const owners = deps.sessionsBoundTo(run);
  if (deps.mySessionId !== undefined && owners.includes(deps.mySessionId)) return true;
  if (owners.length > 0) return false;
  return true; // orphan — no live run match, no persisted owner → safe broadcast fallback
}
