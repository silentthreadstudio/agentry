// ws — the WebSocket edge implementing the `Transport` port (ADR-001). Clients connect to `/ws` on a
// `<id>.localhost` host; the connection's run is resolved from its `Host` header (host-router, ADR-002),
// so a socket is subscribed to exactly its run's changes — the web ws-client opens one connection per
// host, never sends a subscribe frame, so the Host IS the subscription key. `push(run, msg)` fans a
// `WsMessage` out to every open socket bound to that run.
//
// The composition root attaches this to the port-locked http server (a single `upgrade` listener), wires
// the watcher → `push` loop, and closes it on shutdown. This module owns the socket registry only; it
// holds no run-read state (the watcher loop calls `push` with the already-projected message).
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { WsMessage } from "@agentry/workbench-shared";
import type { Transport } from "../domain/ports.js";
import { resolveRunContext } from "./host-router.js";

// The path the web ws-client connects on (pinned: web/src/api/ws-client.ts uses `/ws`). An upgrade to any
// other path is rejected, so the http server's other concerns are untouched.
const WS_PATH = "/ws";

export class WsTransport implements Transport {
  private readonly wss: WebSocketServer;
  // run id → the set of open sockets subscribed to it. A bare-home connection (no run) is not registered
  // for any run — it receives nothing (the Works home is poll/REST-driven in Phase 1).
  private readonly byRun = new Map<string, Set<WebSocket>>();

  constructor(server: Server) {
    // `noServer` — we own the upgrade handshake so we can gate on the path and resolve the run BEFORE
    // accepting, rather than letting ws bind every upgrade on the port.
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== WS_PATH) {
        socket.destroy(); // not our endpoint — drop the handshake
        return;
      }
      const { run } = resolveRunContext(req.headers.host);
      this.wss.handleUpgrade(req, socket, head, (ws) => this.register(ws, run));
    });
  }

  // Register an accepted socket under its run. A connection with no run context (bare home) is accepted
  // but joins no run set, so it is never a `push` target — it stays open for the client's status check.
  private register(ws: WebSocket, run: string | null): void {
    if (run === null) return;
    let set = this.byRun.get(run);
    if (!set) {
      set = new Set();
      this.byRun.set(run, set);
    }
    set.add(ws);
    ws.on("close", () => {
      set.delete(ws);
      if (set.size === 0) this.byRun.delete(run);
    });
  }

  // Transport port: push a `WsMessage` to every open socket subscribed to `run`. No subscribers ⇒ a
  // no-op (a run nobody is watching costs nothing). Serialized once and reused across the run's sockets.
  push(run: string, message: WsMessage): void {
    const set = this.byRun.get(run);
    if (!set || set.size === 0) return;
    const payload = JSON.stringify(message);
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  // Close every socket and the server (graceful shutdown). Idempotent.
  close(): void {
    for (const set of this.byRun.values()) {
      for (const ws of set) ws.close();
    }
    this.byRun.clear();
    this.wss.close();
  }
}
