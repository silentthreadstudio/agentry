// Run-state store — the run-level json `.agentry/work/<run>/run-state.json` (the agent roster + live
// states; spec §3.1 Agents). One of the state holders (AC6: roster survives a server kill).
// `ensureRun` creates the run directory so the first write — and any artifact write — has a home;
// run-state is loose at this layer (T05 owns its field contract).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunStore } from "../domain/ports.js";
import { runDir } from "../resolution/run-pointer.js";

export class JsonRunStateStore implements RunStore {
  constructor(private readonly cwd: string) {}

  private statePath(run: string): string {
    return join(runDir(this.cwd, run), "run-state.json");
  }

  // Create `.agentry/work/<run>/` (asserts the run segment via runDir). Idempotent.
  ensureRun(run: string): void {
    mkdirSync(runDir(this.cwd, run), { recursive: true });
  }

  readRunState(run: string): Record<string, unknown> | undefined {
    const path = this.statePath(run);
    if (!existsSync(path)) return undefined;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
    } catch {
      return undefined; // a corrupt state file reads as absent rather than throwing
    }
  }

  writeRunState(run: string, state: Record<string, unknown>): void {
    this.ensureRun(run);
    writeFileSync(this.statePath(run), `${JSON.stringify(state, null, 2)}\n`);
  }
}
