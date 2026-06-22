// StatusBridge — the INFRA half of the human→agent status channel (mirrors ChannelBridge / PermissionRelay:
// file-watch signaling, no HTTP). chokidar-watches `<cwd>/.agentry/run/status-signals/*.json`; on each new
// signal file it parses the StatusSignal, emits one `notifications/claude/channel`, and DELETES the file
// (process-once). Only the Workbench writes these files (on a human status change), so every emit is a
// genuine human→agent steering note — the agent is never told about its own `task_status` writes.
//
// Emitting is decoupled behind the same `EmitFn` ChannelBridge uses: a session that didn't load flow as a
// channel silently drops the notification (spike-proven), so the bridge needs no enablement branch — and it
// still deletes the file, so signals never accumulate when channels are off.
import { FSWatcher, watch } from "chokidar";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EmitFn } from "./channel-bridge.js";
import { StatusSignal, statusNotification } from "./status-event.js";

export class StatusBridge {
  private watcher: FSWatcher | undefined;

  constructor(
    private readonly cwd: string,
    private readonly emit: EmitFn,
    // Same session-targeting gate as ChannelBridge: a status signal carries `run`, so a status change
    // on another session's run is dropped here too. Default `() => true` preserves existing behavior.
    private readonly shouldEmit: (run: string) => boolean = () => true,
  ) {}

  // Start watching the status-signal dir. ignoreInitial is FALSE so a signal written while flow was down
  // (between turns) still fires on startup — and is deleted after, so it never re-fires. The dir is created
  // up front (chokidar on a missing dir reports ready but never watches — the macOS gotcha).
  start(): void {
    if (this.watcher !== undefined) return;
    const dir = join(this.cwd, ".agentry", "run", "status-signals");
    mkdirSync(dir, { recursive: true });
    this.watcher = watch(dir, { ignoreInitial: false, persistent: true, depth: 0 });
    this.watcher.on("add", (file) => void this.handle(file));
  }

  async stop(): Promise<void> {
    if (this.watcher === undefined) return;
    await this.watcher.close();
    this.watcher = undefined;
  }

  // Read + parse one signal file, emit the channel note, delete the file. A malformed file is dropped
  // (no throw) so a stray/partial write never wedges the watcher.
  private async handle(file: string): Promise<void> {
    if (!file.endsWith(".json")) return;
    let signal: StatusSignal;
    try {
      signal = StatusSignal.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      rmSync(file, { force: true });
      return;
    }
    // Emit only when this process owns the run; either way DELETE the file (process-once) so a
    // not-ours signal — consumed once by whichever process saw it first — never accumulates.
    if (this.shouldEmit(signal.run)) await this.emit(statusNotification(signal));
    rmSync(file, { force: true });
  }
}
