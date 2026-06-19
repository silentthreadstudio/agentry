// instance/ — the OS-enforced singleton (ADR-002). Two proofs:
//  1. port-lock: a second bind on the same port fails with the typed "already-up" (EADDRINUSE) result
//     — the singleton guarantee. The bind IS the lock.
//  2. pidfile: write→read round-trips the pinned shape; process.kill(pid,0) liveness separates live
//     from stale; graceful shutdown removes the file.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  isProcessAlive,
  pidfilePath,
  readPidfile,
  removePidfile,
  writePidfile,
} from "../src/instance/pidfile.js";
import { bindPortLock } from "../src/instance/port-lock.js";

// --- port-lock: the bind-is-the-lock singleton proof -----------------------------------------------

// Bind on an ephemeral port (0 picks a free one) so the suite never collides with a real :4317 or a
// parallel test run, then read the OS-assigned port back to aim the second bind at the SAME port.
function boundPort(server: Server): number {
  const addr = server.address();
  assert.ok(
    addr !== null && typeof addr === "object",
    "expected an AddressInfo from a bound server",
  );
  return addr.port;
}

let servers: Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

test("bindPortLock: a second bind on the same port returns already-up (EADDRINUSE singleton proof)", async () => {
  const first = await bindPortLock(0);
  assert.equal(first.status, "bound");
  assert.ok(first.status === "bound");
  servers.push(first.server);

  const port = boundPort(first.server);
  const second = await bindPortLock(port);
  assert.equal(second.status, "already-up");
});

test("bindPortLock: a free port binds and returns the server handle", async () => {
  const result = await bindPortLock(0);
  assert.equal(result.status, "bound");
  assert.ok(result.status === "bound");
  servers.push(result.server);
  assert.ok(result.server.listening, "bound server should be listening");
});

// --- pidfile: round-trip, liveness, removal --------------------------------------------------------

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workbench-pidfile-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("writePidfile→readPidfile round-trips { pid, port, startedAt }", () => {
  const data = { pid: 4242, port: 4317, startedAt: "2026-06-19T00:00:00.000Z" };
  writePidfile(root, data);
  assert.deepEqual(readPidfile(root), data);
});

test("writePidfile creates .agentry/run/ when it does not exist, at the pinned path", () => {
  writePidfile(root, { pid: 1, port: 4317, startedAt: "t" });
  assert.equal(pidfilePath(root), join(root, ".agentry", "run", "workbench.json"));
  assert.ok(existsSync(pidfilePath(root)), "pidfile should exist after write");
});

test("readPidfile returns undefined when no pidfile exists", () => {
  assert.equal(readPidfile(root), undefined);
});

test("readPidfile returns undefined for a malformed pidfile (treated as absent)", () => {
  // a pidfile missing the pinned fields must not parse as valid — the bind is the real gate.
  writePidfile(root, { pid: 1, port: 2, startedAt: "t" });
  // overwrite with a wrong shape at the pinned path — readPidfile must reject it.
  writeFileSync(pidfilePath(root), JSON.stringify({ pid: "not-a-number" }));
  assert.equal(readPidfile(root), undefined);
});

test("isProcessAlive distinguishes a live process from a stale pid", () => {
  // this very test process is alive; a pid we just reaped / never existed is stale.
  assert.equal(isProcessAlive(process.pid), true, "current process should read as alive");
  // PID 2^31-1 is effectively never a running process — a stale recorded pid.
  assert.equal(isProcessAlive(2147483646), false, "an unused pid should read as stale");
});

test("removePidfile removes the file on graceful shutdown and is idempotent", () => {
  writePidfile(root, { pid: 1, port: 4317, startedAt: "t" });
  assert.ok(existsSync(pidfilePath(root)));
  removePidfile(root);
  assert.ok(!existsSync(pidfilePath(root)), "pidfile should be gone after remove");
  // idempotent: removing again does not throw (a crash may have already cleared it).
  removePidfile(root);
});
