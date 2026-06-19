// Singleton via port-bind (ADR-002): the bind on :4317 IS the mutual-exclusion lock — the OS grants
// it to exactly one process, and releases it on process death (crash-safe, no stale-lock recovery).
// A second bind fails with EADDRINUSE ⇒ "one is already up." This module is the bind-or-fail primitive;
// the pidfile (pidfile.ts) carries only advisory metadata, never the lock.
import { type Server, createServer } from "node:http";

// The workbench's reserved fixed local port. The port number is the lock identity — not configurable
// here (ADR-002 pins :4317); the composition root attaches its request handler to the bound server.
export const WORKBENCH_PORT = 4317;

// Loopback address the bind/probe use directly. ADR-002: the health probe must use 127.0.0.1, never a
// `*.localhost` name (subdomain resolution is a browser behavior; a probe can't rely on it).
export const LOOPBACK_HOST = "127.0.0.1";

// Outcome of attempting to acquire the singleton lock. A discriminated union, not a throw the caller
// must catch blindly: "bound" carries the server handle to attach to; "already-up" is the EADDRINUSE
// signal (focus the existing instance, don't spawn a second).
export type BindResult = { status: "bound"; server: Server } | { status: "already-up" };

// Attempt to acquire the singleton lock by binding the fixed port on the loopback interface.
//
//  - success  ⇒ { status: "bound", server }  — "I am the server"; caller attaches its handler + routes.
//  - EADDRINUSE ⇒ { status: "already-up" }    — another instance holds the lock; caller focuses it.
//
// Any other listen error (e.g. EACCES) is a real fault and rejects — only the "already up" case is
// folded into a typed result. The returned server is bound and listening with no request handler yet;
// the composition root wires `server.on("request", ...)` (task 9). Resolves only once the bind has
// actually succeeded or failed, so a successful resolve is a proven lock.
export function bindPortLock(port: number = WORKBENCH_PORT): Promise<BindResult> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener("listening", onListening);
      if (err.code === "EADDRINUSE") {
        resolve({ status: "already-up" });
        return;
      }
      reject(err);
    };

    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve({ status: "bound", server });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, LOOPBACK_HOST);
  });
}
