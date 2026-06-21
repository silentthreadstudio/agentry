// Composition root for the Agentry Workbench local service (Phase 1) — ADR-001's `index.ts` wiring.
//
// The lifecycle: acquire the singleton port-lock (ADR-002); if another instance already holds it, print
// that and exit 0 (a second invocation must NEVER spawn a second server — AC1). If we got the lock, write
// the advisory pidfile, wire the ports-and-adapters tree (FsWorkRepository + ChokidarWatcher + WorkReader),
// attach the http handler + the ws transport to the bound server, wire the watcher → ws push loop (the
// live half of AC7), and start. On SIGINT/SIGTERM, remove the pidfile and close the watcher cleanly.
//
// The project root (the cwd the `.agentry/` tree lives under) is resolved the SAME way FLOW resolves its
// root — `CLAUDE_PROJECT_DIR ?? AGENTRY_PROJECT_DIR ?? process.cwd()` — so the workbench reads the same
// runs FLOW writes. No hardcoded paths.
import { bindPortLock } from "./instance/port-lock.js";
import { removePidfile, writePidfile } from "./instance/pidfile.js";
import { FsWorkRepository } from "./persistence/fs-work-repository.js";
import { ChokidarWatcher } from "./persistence/chokidar-watcher.js";
import { PermissionWatcher, type PermissionEvent } from "./persistence/permission-watcher.js";
import { FlowWriter } from "./persistence/flow-writer.js";
import { FsEventSource } from "./persistence/event-source.js";
import { FsReviewSidecarSource } from "./persistence/review-sidecar-source.js";
import { WorkReader } from "./application/work-reader.js";
import { WriteService } from "./application/write-service.js";
import { EventStore } from "./application/event-store.js";
import { GateInbox } from "./application/gate-inbox.js";
import { TokenReader } from "./application/token-reader.js";
import { TranscriptReader } from "./persistence/transcript-reader.js";
import { MemReader } from "./persistence/mem-reader.js";
import type { Clock, RunChange } from "./domain/ports.js";
import { createHttpHandler } from "./transport/http.js";
import { WsTransport } from "./transport/ws.js";
import { resolveSlug } from "@agentry/workbench-shared";

// The project root, resolved exactly as FLOW resolves it (packages/flow/src/index.ts) so both layers see
// the same `.agentry/` tree.
function resolveProjectRoot(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.env.AGENTRY_PROJECT_DIR ?? process.cwd();
}

// The single source of "now" injected into the application layer (the read-models' `updatedAt`).
const systemClock: Clock = { now: () => new Date().toISOString() };

async function main(): Promise<void> {
  const projectRoot = resolveProjectRoot();

  const lock = await bindPortLock();
  if (lock.status === "already-up") {
    // Another instance holds the port-lock — focus it, don't spawn a second (ADR-002, AC1).
    console.log("workbench already running on http://127.0.0.1:4317 — focusing the existing instance");
    process.exit(0);
  }

  const server = lock.server;
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 4317;

  // Advisory metadata for the /agentry:workbench command (liveness + deep-link). The bind is the lock;
  // this file is just who/where/when.
  writePidfile(projectRoot, { pid: process.pid, port, startedAt: systemClock.now() });

  // Wire the ports-and-adapters tree: fs read side + watcher → the application reader; the fs write
  // side → the WriteService boundary (ADR-006) the POST routes call.
  const repository = new FsWorkRepository(projectRoot);
  const watcher = new ChokidarWatcher(projectRoot);
  const writeService = new WriteService(new FlowWriter(projectRoot));

  // The project-global permission relay (Phase 3b): watch `.agentry/run/permissions/*.json` (FLOW's
  // request files) for pending tool-approval prompts. NOT under `.agentry/work/`, so a SEPARATE watcher
  // from the run-tree one above. Its `current()` seeds `GET /api/permissions`; its events drive the
  // approvals banner via `pushAll` (wired below, after the transport exists).
  const permissionWatcher = new PermissionWatcher(projectRoot);

  // Phase-4 aggregation readers (the Activity / Agents / Gates / Tokens / Memory data). `EventStore` is
  // the one timeline fold + the roster source; its `roster` doubles as the `RunSummary.agentCount` counter
  // wired into the WorkReader (one roster read, not two). `TokenReader` folds the `TranscriptReader`'s
  // samples; `MemReader` browses both mem roots read-only.
  const events = new EventStore(repository, new FsEventSource(projectRoot));
  const gates = new GateInbox(repository, new FsReviewSidecarSource(projectRoot));
  const tokens = new TokenReader(new TranscriptReader(projectRoot));
  const memory = new MemReader(projectRoot);
  const reader = new WorkReader(repository, systemClock, (run) => events.roster(run).length);

  // Transports: the ws edge (constructed first so the http handler can push on a successful write) pushes
  // per-run change messages; the http edge serves the SPA + REST reads + the Phase-3 writes + the Phase-4
  // aggregation reads.
  // The ws subscription key is the FULL run id: resolve the connecting host's label (a short `workSlug`
  // or the full id, task 003) against the live run list, the SAME resolution the http routes use, so a
  // workSlug-host socket joins the run that `push` is keyed by.
  const transport = new WsTransport(server, (label) => resolveSlug(label, reader.listRuns()) ?? null);
  server.on(
    "request",
    createHttpHandler(
      reader,
      { reader, writeService, transport, projectRoot },
      { events, gates, tokens, memory },
      { watcher: permissionWatcher, projectRoot },
    ),
  );

  // The approvals live loop (Phase 3b): a request file appears/resolves → broadcast it to EVERY connected
  // client (`pushAll`, not `push` — permissions belong to no run, and the banner mounts on the base host
  // and every run host alike). The watcher already coalesces add/change into a single `added` per id.
  permissionWatcher.subscribe((event: PermissionEvent) => {
    if (event.kind === "added") {
      transport.pushAll({ type: "permission-added", request: event.request });
    } else {
      transport.pushAll({ type: "permission-removed", requestId: event.requestId });
    }
  });

  // The live loop (AC7): a debounced run change → push a `file-changed` message per changed path to that
  // run's ws subscribers. The `WorkReader.read` confirms the run still resolves (a change in a vanished
  // run is dropped); the parsed `doc-updated`/`diff-ready` projections are Phase 3.
  watcher.subscribe((change: RunChange) => {
    // Project-global FIRST (before the run-resolves guard): the work tree moved — a new run appeared, a
    // status flipped, an updatedAt bumped. Tell the bare-host Works home to refetch its list, so it goes
    // live for BRAND-NEW runs too (which may not resolve via `reader.read` yet). A payload-free nudge.
    transport.pushAll({ type: "works-changed" });
    if (!reader.read(change.run)) return; // run no longer resolves — nothing run-scoped to push
    for (const path of change.paths) {
      transport.push(change.run, { type: "file-changed", path });
    }
  });

  console.log(`workbench server listening on http://127.0.0.1:${port} (project root: ${projectRoot})`);

  // Graceful shutdown: drop the pidfile, stop the watcher + ws, close the server.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`workbench server shutting down (${signal})`);
    removePidfile(projectRoot);
    transport.close();
    void Promise.allSettled([watcher.close(), permissionWatcher.close()]).finally(() =>
      server.close(() => process.exit(0)),
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("workbench server failed to start:", err);
  process.exit(1);
});
