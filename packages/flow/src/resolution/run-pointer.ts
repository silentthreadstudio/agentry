// Run-id resolution — the pointer seam (ADR-005 NO branch). One of the two fs-touching layers (with
// persistence/); it *uses* the pure `assertSafeSegment` guard from the domain.
//
// Identity contract (ADR-005 NO branch — pinned):
//  - The run id is explicit and caller-threaded. There is NO ambient "current run" and NEVER a
//    newest-mtime folder scan (the named anti-pattern). `index.ts`'s `resolveRunContext` errors when
//    a run can't be resolved.
//  - The session→run pointer is `session_id`-keyed and OWNED by the work-id-binder hook. FLOW writes
//    it (`writeSessionPointer`) ONLY when a caller passes `session_id` explicitly; it never reads
//    `session_id` from its own (absent) context. Both ends harden the seam with `assertSafeSegment`.
//
// Pointer seam (pinned — identical to the binder/emitter hooks):
//   path:  <cwd>/.agentry/run/sessions/<session_id>.json   (one file per session)
//   shape: { "workId": "<run>", "updatedAt": "<iso8601>" }  (atomic tmp-then-rename, last-write-wins)
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSafeSegment } from "../domain/ids.js";

// `<cwd>/.agentry/work` — the run-directory root every FLOW write lives under.
export function workRoot(cwd: string): string {
  return join(cwd, ".agentry", "work");
}

// `<cwd>/.agentry/work/<run>` — asserts `run` is a safe single segment before joining (containment:
// a poisoned run id can never escape work/ — mirrors the hooks' guards, ADR-005 §4).
export function runDir(cwd: string, run: string): string {
  assertSafeSegment(run);
  return join(workRoot(cwd), run);
}

// `<cwd>/.agentry/run/sessions/<session_id>.json` — the pointer path (guards the session segment too).
function pointerPath(cwd: string, session_id: string): string {
  assertSafeSegment(session_id);
  return join(cwd, ".agentry", "run", "sessions", `${session_id}.json`);
}

// Resolve the run a session is bound to by reading the binder's pointer. Returns undefined when the
// pointer is missing/unparseable or carries no `workId` (the caller decides what "unresolved" means —
// `resolveRunContext` turns it into a hard error). Containment: a `workId` that isn't a safe segment
// is rejected (never trust a poisoned pointer — mirrors the emitter hook's guard).
export function resolveRunFromSession(cwd: string, session_id: string): string | undefined {
  let ptr: unknown;
  try {
    ptr = JSON.parse(readFileSync(pointerPath(cwd, session_id), "utf8"));
  } catch {
    return undefined; // missing / unreadable / bad JSON — treat as unresolved
  }
  if (typeof ptr !== "object" || ptr === null) return undefined;
  const workId = (ptr as Record<string, unknown>).workId;
  if (typeof workId !== "string" || workId.length === 0) return undefined;
  try {
    assertSafeSegment(workId);
  } catch {
    return undefined; // poisoned pointer — never let a traversal id escape
  }
  return workId;
}

// Write the session→run pointer — the SAME contract the binder writes (ADR-005 §4): atomic
// tmp-then-rename, last-write-wins. Called ONLY when a caller passes `session_id` (run_start's
// proactive seed); absent `session_id`, FLOW skips and relies on the binder to seed it reactively.
// Both the session key and the run value are asserted safe before any fs touch.
export function writeSessionPointer(cwd: string, session_id: string, run: string): void {
  assertSafeSegment(run);
  const target = pointerPath(cwd, session_id); // asserts the session segment
  const dir = join(cwd, ".agentry", "run", "sessions");
  mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  const body = JSON.stringify({ workId: run, updatedAt: new Date().toISOString() });
  writeFileSync(tmp, body); // write to a sibling, then atomically swap in
  renameSync(tmp, target); // a concurrent reader never sees a half-written file
}
