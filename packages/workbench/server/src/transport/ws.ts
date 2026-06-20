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
import { parseHostLabel } from "./host-router.js";

// The path the web ws-client connects on (pinned: web/src/api/ws-client.ts uses `/ws`). An upgrade to any
// other path is rejected, so the http server's other concerns are untouched.
const WS_PATH = "/ws";

// Resolve a host LABEL (a `workSlug` or a full id, task 003) to the FULL run id this socket subscribes
// to, or null when it resolves to no run. The subscription key MUST be the full id: `push` is called by
// the watcher loop + the write routes with the full id, so a socket registered under a raw slug would
// never receive its run's messages. Injected by the composition root (it holds the run list).
export type ResolveRun = (label: string) => string | null;

export class WsTransport implements Transport {
  private readonly wss: WebSocketServer;
  // run id → the set of open sockets subscribed to it. A bare-home connection (no run) is not registered
  // for any run — it receives nothing per-run (the Works home is poll/REST-driven in Phase 1).
  private readonly byRun = new Map<string, Set<WebSocket>>();
  // EVERY open socket (run hosts AND the bare home), the target of `pushAll`. Permission-relay messages
  // are project-global (no run), so the approvals banner must reach the base host too — `byRun` alone
  // would miss it. Kept in lockstep with `byRun` on register/close.
  private readonly all = new Set<WebSocket>();

  // `resolveRun` turns the host's parsed label (slug or full id) into the FULL run id the socket
  // subscribes under — the SAME id `push` is keyed by. Defaults to identity (the label IS the id) so
  // existing tests that construct a bare `WsTransport(server)` keep their full-id-host behavior.
  constructor(
    server: Server,
    private readonly resolveRun: ResolveRun = (label) => label,
  ) {
    // `noServer` — we own the upgrade handshake so we can gate on the path and resolve the run BEFORE
    // accepting, rather than letting ws bind every upgrade on the port.
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== WS_PATH) {
        socket.destroy(); // not our endpoint — drop the handshake
        return;
      }
      const label = parseHostLabel(req.headers.host);
      const run = label !== null ? this.resolveRun(label) : null;
      this.wss.handleUpgrade(req, socket, head, (ws) => this.register(ws, run));
    });
  }

  // Register an accepted socket. Every socket joins `all` (the `pushAll` target for project-global
  // messages like the permission relay), even the bare home. A run-bound socket also joins its run set
  // (the per-run `push` target); a bare-home socket (no run) joins only `all`.
  private register(ws: WebSocket, run: string | null): void {
    this.all.add(ws);
    const set = run !== null ? this.runSet(run) : undefined;
    if (set) set.add(ws);
    ws.on("close", () => {
      this.all.delete(ws);
      if (set && run !== null) {
        set.delete(ws);
        if (set.size === 0) this.byRun.delete(run);
      }
    });
  }

  // The socket set for a run, created on first use.
  private runSet(run: string): Set<WebSocket> {
    let set = this.byRun.get(run);
    if (!set) {
      set = new Set();
      this.byRun.set(run, set);
    }
    return set;
  }

  // Transport port: push a `WsMessage` to every open socket subscribed to `run`. No subscribers ⇒ a
  // no-op (a run nobody is watching costs nothing). Serialized once and reused across the run's sockets.
  push(run: string, message: WsMessage): void {
    const set = this.byRun.get(run);
    if (!set || set.size === 0) return;
    this.broadcast(set, message);
  }

  // Transport port: broadcast a project-global `WsMessage` to EVERY open socket (run hosts + the bare
  // home). The permission relay (Phase 3b) is the consumer — a request belongs to no run, so the
  // approvals banner subscribes everywhere.
  pushAll(message: WsMessage): void {
    if (this.all.size === 0) return;
    this.broadcast(this.all, message);
  }

  // Serialize once and send to every OPEN socket in the set.
  private broadcast(set: Set<WebSocket>, message: WsMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  // Close every socket and the server (graceful shutdown). Idempotent.
  close(): void {
    for (const ws of this.all) ws.close();
    this.all.clear();
    this.byRun.clear();
    this.wss.close();
  }
}
