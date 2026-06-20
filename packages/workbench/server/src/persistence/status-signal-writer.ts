// status-signal-writer — drops a human-origin status signal that FLOW's StatusBridge watches + emits as a
// `<channel>` note. Written ONLY here, on a Workbench-initiated status change, so the signal is unambiguous
// human-origin (the agent's own task_status writes never produce one → no self-notification loop). FLOW
// deletes the file after emitting; the contract is the pinned `{ run, task, status, at }` shape (FLOW's
// `StatusSignal`). Mirrors permission-writer: a tiny fs adapter, traversal-safe by construction (the
// filename is a minted id, never caller input).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// `<projectRoot>/.agentry/run/status-signals/` — the SAME `.agentry/run/` tree the permission relay uses.
function signalDir(projectRoot: string): string {
  return join(projectRoot, ".agentry", "run", "status-signals");
}

// A unique, fs-safe filename so concurrent signals don't clobber. The bridge reads the FILE CONTENT for
// run/task/status, so the name only needs to be unique — base36 time + a short random suffix.
function mintName(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`;
}

/** Write a human status-change signal for FLOW's StatusBridge to pick up. Best-effort: a write failure
 *  never blocks the status change itself (the file is truth; the channel is the live extra). */
export function writeStatusSignal(
  projectRoot: string,
  signal: { run: string; task: string; status: string },
): void {
  const dir = signalDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const payload = { ...signal, at: new Date().toISOString() };
  writeFileSync(join(dir, mintName()), `${JSON.stringify(payload, null, 2)}\n`);
}
