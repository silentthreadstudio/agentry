// PermissionWatcher — the read + live-loop half of the permission-approval relay (Phase 3b; channels.md
// §"Relay permission prompts"). It watches the project-global permissions dir FLOW writes to (Phase 3a's
// pinned file contract) and maintains the set of PENDING approval requests:
//
//   dir:     <projectRoot>/.agentry/run/permissions/
//   request: <request_id>.json          (FLOW writes; the Workbench READS — PermissionRequest)
//   verdict: <request_id>.verdict.json  (the Workbench writes — OURS; never read back here)
//
// A request appears when FLOW adds `<id>.json`; it disappears when FLOW deletes that file after emitting
// the verdict (resolved in the terminal OR by a verdict we wrote — first answer wins). So we key off the
// REQUEST files only, ignoring `*.verdict.json` (those are ours). On add/change → parse + upsert + emit
// `added`; on unlink → drop + emit `removed`. The watcher is transport-agnostic (plain `PermissionEvent`
// out, no ws type): the composition root wires `subscribe` → the ws `pushAll` (the base-host broadcast,
// since permissions belong to no run). `current()` seeds the REST `GET /api/permissions` snapshot.
//
// This is NOT under `.agentry/work/` (the run tree the ChokidarWatcher covers) — permissions are
// session/project-level, so this is a SEPARATE watcher rooted at `.agentry/run/permissions/`.
import { watch } from "chokidar";
import type { FSWatcher } from "chokidar";
import { basename } from "node:path";
import { permissionsDir } from "@agentry/flow/channel/permission-relay";
import type { PermissionRequest } from "@agentry/workbench-shared";
import { readRequestFile } from "./permission-reader.js";

const VERDICT_SUFFIX = ".verdict.json";

// What a subscriber receives: a request appeared (full shape, so the banner renders without a refetch) or
// resolved (id only — the request file is gone).
export type PermissionEvent =
  | { kind: "added"; request: PermissionRequest }
  | { kind: "removed"; requestId: string };

export class PermissionWatcher {
  private readonly fsWatcher: FSWatcher;
  private readonly handlers = new Set<(event: PermissionEvent) => void>();
  // The pending requests, keyed by request_id (== the `<id>.json` filename stem). The source of truth the
  // REST snapshot reads; the watcher keeps it in lockstep with the dir's request files.
  private readonly pending = new Map<string, PermissionRequest>();

  constructor(projectRoot: string) {
    const dir = permissionsDir(projectRoot);
    // Watch the permissions dir, one level deep (request files are direct children). `ignoreInitial:
    // false` so requests already on disk at startup (FLOW raised them while the workbench was down, and
    // is still blocked waiting) seed the pending set — they must show in the banner immediately.
    this.fsWatcher = watch(dir, { ignoreInitial: false, persistent: true, depth: 0 });
    this.fsWatcher.on("add", (path) => this.onUpsert(path));
    this.fsWatcher.on("change", (path) => this.onUpsert(path));
    this.fsWatcher.on("unlink", (path) => this.onUnlink(path));
  }

  // Register a change handler; returns an unsubscribe handle (mirrors ChokidarWatcher).
  subscribe(handler: (event: PermissionEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // The current pending requests — the seed for `GET /api/permissions`. A copy, newest last (insertion
  // order == file-add order), so a caller can't mutate the internal map.
  current(): PermissionRequest[] {
    return [...this.pending.values()];
  }

  async close(): Promise<void> {
    await this.fsWatcher.close();
    this.pending.clear();
    this.handlers.clear();
  }

  // A request file was added or rewritten. Ignore our own verdict files; parse the request file and, when
  // it's well-formed, upsert it into pending + emit `added`. A malformed/half-written file is skipped (no
  // emit) — chokidar will fire `change` again when FLOW finishes the write.
  private onUpsert(path: string): void {
    if (path.endsWith(VERDICT_SUFFIX)) return; // ours — not a request to surface
    const request = readRequestFile(path);
    if (request === undefined) return;
    this.pending.set(request.request_id, request);
    this.emit({ kind: "added", request });
  }

  // A file was removed. A verdict file leaving is not a request resolution we track (FLOW deletes both
  // files; the request unlink is the signal). For a request file, drop it from pending + emit `removed`
  // keyed by the filename stem (== request_id, the pinned `<id>.json` contract).
  private onUnlink(path: string): void {
    if (path.endsWith(VERDICT_SUFFIX)) return;
    const requestId = basename(path).replace(/\.json$/, "");
    if (!this.pending.delete(requestId)) return; // not one we were tracking — nothing to drop
    this.emit({ kind: "removed", requestId });
  }

  private emit(event: PermissionEvent): void {
    for (const handler of [...this.handlers]) handler(event);
  }
}
