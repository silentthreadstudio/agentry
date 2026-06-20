// Permission relay — the INFRA half of the permission relay (channels.md "Relay permission prompts",
// Phase 3a). Two pieces of I/O, mirroring the Phase-1 ChannelBridge:
//   1. A notification handler for `notifications/claude/channel/permission_request` (registered on the
//      low-level Server). On a request: add `request_id` to the pending set + write the request file.
//   2. A chokidar watcher on `<cwd>/.agentry/run/permissions/*.verdict.json`. On a verdict file: if
//      its `request_id` is pending, emit `notifications/claude/channel/permission` with the verdict,
//      drop it from pending, and delete BOTH `<id>.json` + `<id>.verdict.json` (cleanup).
//
// The pure decision/shape logic lives in permission-event.ts; this file is only the watcher + the
// pending set + the fs writes + the emit wiring. Load-safe like Phase 1: if the session isn't a
// permission channel, Claude Code never sends a permission_request, so the handler simply never fires
// and the watcher only ever sees stray files (which it ignores) — the relay needs no enablement branch.
//
// File contract (PINNED — Phase 3b's Workbench depends on this verbatim):
//   dir:     <cwd>/.agentry/run/permissions/
//   request: <request_id>.json          (flow writes; PermissionRequestFile)
//   verdict: <request_id>.verdict.json  (Workbench writes; { request_id, behavior })
import { FSWatcher, watch } from "chokidar";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildRequestFile,
  parseVerdictFile,
  PermissionRequestSchema,
  type PermissionVerdictNotification,
} from "./permission-event.js";

// What the relay needs to emit a verdict back — a single async fn so the SDK (and its custom-method
// cast) stays in `index.ts` and this seam is unit-testable with a plain spy. Mirrors ChannelBridge's
// `EmitFn`.
export type EmitVerdictFn = (notification: PermissionVerdictNotification) => void | Promise<void>;

const VERDICT_SUFFIX = ".verdict.json";

// `<cwd>/.agentry/run/permissions` — the relay's dir, a sibling of run-pointer's `.agentry/run/sessions`.
export function permissionsDir(cwd: string): string {
  return join(cwd, ".agentry", "run", "permissions");
}

export class PermissionRelay {
  // Request ids flow has issued and not yet resolved. A verdict only emits for an id in this set
  // (the file contract: ignore stray verdict files for ids flow never issued).
  private readonly pending = new Set<string>();
  private watcher: FSWatcher | undefined;

  constructor(
    private readonly cwd: string,
    private readonly emit: EmitVerdictFn,
  ) {}

  // The zod schema Claude Code's `permission_request` notification validates against — also the
  // dispatch key `setNotificationHandler` routes by. Re-exported so index.ts registers it on the
  // low-level Server (the SDK stays at that single seam, mirroring the bridge's `emit` cast).
  static readonly requestSchema = PermissionRequestSchema;

  // The handler index.ts wires to `server.server.setNotificationHandler(PermissionRelay.requestSchema, …)`.
  // Load-safe: a non-permission session never triggers a permission_request, so it never fires.
  readonly onRequestNotification = (notification: {
    params: { request_id: string; tool_name: string; description: string; input_preview: string };
  }): void => {
    this.onRequest(notification.params);
  };

  // Start watching the permissions dir for verdict files. The dir MUST exist before chokidar watches
  // it (same macOS gotcha the ChannelBridge documents: pointed at a missing dir, chokidar reports
  // `ready` but never establishes the watch). Idempotent: a second `start` is a no-op.
  start(): void {
    if (this.watcher !== undefined) return;
    const dir = permissionsDir(this.cwd);
    mkdirSync(dir, { recursive: true });
    // Watch the permissions dir (one level — verdict files sit directly in it). Verdicts are always
    // new (a fresh file per request), so no seed-ignore: we WANT every `add`/`change`, including any
    // present at startup (a verdict written while flow was down should still be honored if pending).
    this.watcher = watch(dir, {
      ignoreInitial: false,
      persistent: true,
      depth: 0, // verdict files are direct children of the permissions dir
    });

    const onPath = (filePath: string): void => {
      if (!filePath.endsWith(VERDICT_SUFFIX)) return; // ignore `<id>.json` and anything else
      void this.handleVerdict(filePath);
    };
    this.watcher.on("add", onPath);
    this.watcher.on("change", onPath);
  }

  // Tear down the watcher (shutdown path). Safe to call when never started.
  async stop(): Promise<void> {
    if (this.watcher === undefined) return;
    await this.watcher.close();
    this.watcher = undefined;
  }

  // Test/inspection seam: a snapshot of the ids flow is currently awaiting a verdict on.
  pendingIds(): string[] {
    return [...this.pending];
  }

  // A permission_request arrived: track the id pending + write the request file the Workbench reads.
  // Public so a test can drive the request path without a live SDK transport (the registrar handler
  // delegates straight here).
  onRequest(params: { request_id: string; tool_name: string; description: string; input_preview: string }): void {
    this.pending.add(params.request_id);
    const dir = permissionsDir(this.cwd);
    mkdirSync(dir, { recursive: true });
    const record = buildRequestFile(params, new Date().toISOString());
    writeFileSync(join(dir, `${params.request_id}.json`), JSON.stringify(record, null, 2));
  }

  // A verdict file appeared. Read + validate it; if its `request_id` is pending, emit the verdict,
  // drop the id, and delete both files. A malformed file or an unknown/stale id is ignored — we still
  // remove the stray verdict file so it doesn't re-fire on every later dir change.
  private async handleVerdict(filePath: string): Promise<void> {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      return; // file vanished between the event and the read — nothing to do
    }
    const verdict = parseVerdictFile(raw);
    if (verdict === undefined) {
      rmSync(filePath, { force: true }); // malformed — clear the stray so it doesn't re-fire
      return;
    }
    if (!this.pending.has(verdict.request_id)) {
      rmSync(filePath, { force: true }); // unknown/stale id — never emit; clear the stray
      return;
    }
    this.pending.delete(verdict.request_id);
    await this.emit({
      method: "notifications/claude/channel/permission",
      params: { request_id: verdict.request_id, behavior: verdict.behavior },
    });
    // Cleanup: delete both the request file and the verdict file for this id.
    const dir = permissionsDir(this.cwd);
    rmSync(join(dir, `${verdict.request_id}.json`), { force: true });
    rmSync(filePath, { force: true });
  }
}
