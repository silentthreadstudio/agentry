// The workbench pidfile (ADR-002): advisory metadata for the /agentry:workbench command, NOT the lock.
// The port bind (port-lock.ts) is the singleton lock; this file just carries who/where/when so the
// command can probe liveness (process.kill(pid, 0)) and open the deep link. A stale pidfile (process
// dead, port free) is harmless — it is overwritten on the next start; the bind, not the file, decides.
//
// PINNED CONTRACT (task 11's command reads this — do not drift):
//   path:  <projectRoot>/.agentry/run/workbench.json
//   shape: { "pid": <number>, "port": <number>, "startedAt": "<iso8601>" }
//   write: atomic tmp-then-rename (the pattern flow's run-pointer.ts uses) — a reader never sees a
//          half-written file.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The pinned metadata the command consumes. Frozen by ADR-002: `pid` for the liveness probe, `port`
// to open, `startedAt` (ISO-8601) for display/diagnostics.
export interface PidfileData {
  pid: number;
  port: number;
  startedAt: string;
}

// `<projectRoot>/.agentry/run/workbench.json` — the single pinned location. Exported so the command
// (task 11) resolves the same path off the project root rather than re-deriving the string.
export function pidfilePath(projectRoot: string): string {
  return join(projectRoot, ".agentry", "run", "workbench.json");
}

// Atomically write the pidfile, creating `.agentry/run/` if it does not exist (don't assume it does).
// tmp-then-rename: write a sibling then rename in, so a concurrent reader sees either the old file or
// the complete new one, never a partial write (mirrors run-pointer.ts's writeSessionPointer).
export function writePidfile(projectRoot: string, data: PidfileData): void {
  const target = pidfilePath(projectRoot);
  const dir = join(projectRoot, ".agentry", "run");
  mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, target);
}

// Read and parse the pidfile. Returns undefined when it is missing, unreadable, not valid JSON, or
// not the pinned shape (the caller decides what "no pidfile" means — typically: just bind). Never
// throws on a malformed file; a poisoned/old pidfile is treated as absent, the bind is the real gate.
export function readPidfile(projectRoot: string): PidfileData | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pidfilePath(projectRoot), "utf8"));
  } catch {
    return undefined; // missing / unreadable / bad JSON
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { pid, port, startedAt } = parsed as Record<string, unknown>;
  if (typeof pid !== "number" || typeof port !== "number" || typeof startedAt !== "string") {
    return undefined; // not the pinned shape — treat as absent
  }
  return { pid, port, startedAt };
}

// Liveness probe via `process.kill(pid, 0)` — sends no signal, only checks the process exists and is
// signalable. true = the recorded process is live (an instance is likely up); false = stale (dead, or
// no longer signalable). This distinguishes a live owner from a leftover pidfile, but it is advisory:
// the port bind is the authoritative singleton check, not this probe.
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (stale). EPERM = process exists but owned by another user (still alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Remove the pidfile on graceful shutdown. Idempotent (force: true) — a missing file is not an error,
// since the bind, not the file, is the lock; a stale file left by a crash is simply overwritten next
// start. Errors other than "missing" are not expected here and would surface.
export function removePidfile(projectRoot: string): void {
  rmSync(pidfilePath(projectRoot), { force: true });
}
