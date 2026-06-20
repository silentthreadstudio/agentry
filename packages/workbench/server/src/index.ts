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
import { FlowWriter } from "./persistence/flow-writer.js";
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

  // Phase-4 aggregation readers (the Activity / Agents / Gates / Tokens / Memory data). `EventStore` is
  // the one timeline fold + the roster source; its `roster` doubles as the `RunSummary.agentCount` counter
  // wired into the WorkReader (one roster read, not two). `TokenReader` folds the `TranscriptReader`'s
  // samples; `MemReader` browses both mem roots read-only.
  const events = new EventStore(repository, projectRoot);
  const gates = new GateInbox(repository, projectRoot);
  const tokens = new TokenReader(new TranscriptReader(projectRoot));
  const memory = new MemReader(projectRoot);
  const reader = new WorkReader(repository, systemClock, (run) => events.roster(run).length);

  // Transports: the ws edge (constructed first so the http handler can push on a successful write) pushes
  // per-run change messages; the http edge serves the SPA + REST reads + the Phase-3 writes + the Phase-4
  // aggregation reads.
  const transport = new WsTransport(server);
  server.on(
    "request",
    createHttpHandler(reader, { reader, writeService, transport }, { events, gates, tokens, memory }),
  );

  // The live loop (AC7): a debounced run change → push a `file-changed` message per changed path to that
  // run's ws subscribers. The `WorkReader.read` confirms the run still resolves (a change in a vanished
  // run is dropped); the parsed `doc-updated`/`diff-ready` projections are Phase 3.
  watcher.subscribe((change: RunChange) => {
    if (!reader.read(change.run)) return; // run no longer resolves — nothing to push
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
    void watcher.close().finally(() => server.close(() => process.exit(0)));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("workbench server failed to start:", err);
  process.exit(1);
});
