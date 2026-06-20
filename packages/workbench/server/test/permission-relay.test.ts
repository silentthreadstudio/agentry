// Permission-relay (Phase 3b) proof — the Workbench side of the approval relay. Three units:
//   1. PermissionWatcher: a request file added → listed in `current()` + emits `added`; removed → dropped
//      + emits `removed`; a `*.verdict.json` (ours) is ignored. Built on a throwaway temp project so the
//      real `.agentry/run/permissions/` is never touched (mirrors chokidar-watcher.test.ts).
//   2. The routes: `GET /api/permissions` lists the snapshot; `POST /api/permissions/:id` writes a
//      correct verdict file (validates behavior; rejects a poisoned id); the verb/body guards.
//   3. permission-reader: a malformed/partial request file reads as undefined (never throws).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { PermissionRequest } from "@agentry/workbench-shared";
import { permissionsDir } from "@agentry/flow/channel/permission-relay";
import { parseRequestFile } from "../src/persistence/permission-reader.js";
import { PermissionWatcher, type PermissionEvent } from "../src/persistence/permission-watcher.js";
import { handlePermissionRequest, type PermissionDeps } from "../src/transport/routes.js";

let root: string; // temp project root (its .agentry/run/permissions is the watched dir)
let permDir: string;
let watcher: PermissionWatcher | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wb-perm-"));
  permDir = permissionsDir(root);
  mkdirSync(permDir, { recursive: true });
});

afterEach(async () => {
  if (watcher) await watcher.close();
  watcher = undefined;
  rmSync(root, { recursive: true, force: true });
});

function sampleRequest(id = "abcde"): PermissionRequest {
  return {
    request_id: id,
    tool_name: "Bash",
    description: "list the files",
    input_preview: '{"command":"ls -la"}',
    created_at: "2026-06-19T00:00:00.000Z",
  };
}

function writeRequestFile(req: PermissionRequest): void {
  writeFileSync(join(permDir, `${req.request_id}.json`), JSON.stringify(req, null, 2));
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for a permission event");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
}

// ── PermissionWatcher ───────────────────────────────────────────────────────────────────────────────

test("a request file added is listed in current() and emits an added event", async () => {
  watcher = new PermissionWatcher(root);
  const events: PermissionEvent[] = [];
  watcher.subscribe((e) => events.push(e));
  await settle();

  writeRequestFile(sampleRequest());
  await waitFor(() => events.length > 0);

  const added = events.find((e) => e.kind === "added");
  assert.ok(added && added.kind === "added", "an added event fired");
  assert.equal(added.request.request_id, "abcde");
  assert.equal(added.request.tool_name, "Bash");
  assert.deepEqual(
    watcher.current().map((r) => r.request_id),
    ["abcde"],
    "the request is in the pending snapshot",
  );
});

test("a removed request file drops it from current() and emits a removed event", async () => {
  watcher = new PermissionWatcher(root);
  const events: PermissionEvent[] = [];
  watcher.subscribe((e) => events.push(e));
  await settle();

  const req = sampleRequest();
  writeRequestFile(req);
  await waitFor(() => watcher!.current().length === 1);

  rmSync(join(permDir, `${req.request_id}.json`), { force: true });
  await waitFor(() => events.some((e) => e.kind === "removed"));

  const removed = events.find((e) => e.kind === "removed");
  assert.ok(removed && removed.kind === "removed");
  assert.equal(removed.requestId, "abcde");
  assert.equal(watcher.current().length, 0, "the request is gone from the snapshot");
});

test("a *.verdict.json file (ours) is ignored — not a request to surface", async () => {
  watcher = new PermissionWatcher(root);
  const events: PermissionEvent[] = [];
  watcher.subscribe((e) => events.push(e));
  await settle();

  // Write only a verdict file — the watcher must not treat it as a pending request.
  writeFileSync(
    join(permDir, "abcde.verdict.json"),
    JSON.stringify({ request_id: "abcde", behavior: "allow" }),
  );
  await settle();

  assert.equal(events.length, 0, "no event for a verdict file");
  assert.equal(watcher.current().length, 0, "no pending request from a verdict file");
});

test("a request already on disk at startup seeds the pending set (the agent was blocked before the page opened)", async () => {
  // Write the request BEFORE the watcher starts — ignoreInitial:false must pick it up.
  writeRequestFile(sampleRequest("fghij"));
  watcher = new PermissionWatcher(root);
  await waitFor(() => watcher!.current().length === 1);
  assert.equal(watcher.current()[0]?.request_id, "fghij");
});

// ── Routes: GET /api/permissions + POST /api/permissions/:id ─────────────────────────────────────────

function fakeGet(url: string): IncomingMessage {
  return { url, method: "GET", headers: {} } as unknown as IncomingMessage;
}

function fakePost(url: string, body: unknown, method = "POST"): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
  (req as unknown as { url: string }).url = url;
  (req as unknown as { method: string }).method = method;
  (req as unknown as { headers: object }).headers = {};
  (req as unknown as { destroy: () => void }).destroy = () => {};
  queueMicrotask(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

interface Captured {
  status: number;
  body: unknown;
}
function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined };
  let raw = "";
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(chunk?: string) {
      if (chunk) raw += chunk;
      captured.body = raw.length > 0 ? JSON.parse(raw) : undefined;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

// A PermissionDeps backed by a fixed snapshot + this test's temp project root (so the verdict file lands
// in the real temp permissions dir we can read back).
function deps(snapshot: PermissionRequest[]): PermissionDeps {
  return { watcher: { current: () => snapshot }, projectRoot: root };
}

test("GET /api/permissions returns the pending snapshot", async () => {
  const { res, captured } = fakeRes();
  const handled = await handlePermissionRequest(fakeGet("/api/permissions"), res, deps([sampleRequest()]));
  assert.equal(handled, true);
  assert.equal(captured.status, 200);
  assert.deepEqual((captured.body as PermissionRequest[])[0]?.request_id, "abcde");
});

test("POST /api/permissions/:id writes a correct verdict file and returns ok", async () => {
  const { res, captured } = fakeRes();
  const handled = await handlePermissionRequest(
    fakePost("/api/permissions/abcde", { behavior: "allow" }),
    res,
    deps([]),
  );
  assert.equal(handled, true);
  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body, { ok: true });

  const verdictPath = join(permDir, "abcde.verdict.json");
  assert.ok(existsSync(verdictPath), "the verdict file was written");
  assert.deepEqual(JSON.parse(readFileSync(verdictPath, "utf8")), {
    request_id: "abcde",
    behavior: "allow",
  });
});

test("POST /api/permissions/:id with a deny behavior writes behavior:deny", async () => {
  const { res } = fakeRes();
  await handlePermissionRequest(fakePost("/api/permissions/wxyzz", { behavior: "deny" }), res, deps([]));
  const verdict = JSON.parse(readFileSync(join(permDir, "wxyzz.verdict.json"), "utf8"));
  assert.equal(verdict.behavior, "deny");
});

test("POST with an invalid behavior is 400, no verdict file", async () => {
  const { res, captured } = fakeRes();
  await handlePermissionRequest(fakePost("/api/permissions/abcde", { behavior: "maybe" }), res, deps([]));
  assert.equal(captured.status, 400);
  assert.equal((captured.body as { error: string }).error, "invalid_behavior");
  assert.equal(existsSync(join(permDir, "abcde.verdict.json")), false, "no file on a rejected verdict");
});

test("POST with a traversal-unsafe id is 400, never a write outside the dir", async () => {
  const { res, captured } = fakeRes();
  // A percent-encoded slash (`%2F`) survives URL normalization and decodes to `foo/bar` — a multi-segment
  // id assertSafeSegment must reject before it becomes a path outside the permissions dir.
  await handlePermissionRequest(
    fakePost("/api/permissions/foo%2Fbar", { behavior: "allow" }),
    res,
    deps([]),
  );
  assert.equal(captured.status, 400);
  assert.equal((captured.body as { error: string }).error, "invalid_request_id");
  assert.equal(existsSync(join(permDir, "foo")), false, "nothing written outside the dir");
});

test("a GET to the verdict path is 405", async () => {
  const { res, captured } = fakeRes();
  const handled = await handlePermissionRequest(
    fakePost("/api/permissions/abcde", undefined, "GET"),
    res,
    deps([]),
  );
  assert.equal(handled, true);
  assert.equal(captured.status, 405);
});

test("a non-permission path falls through (not handled here)", async () => {
  const { res } = fakeRes();
  const handled = await handlePermissionRequest(fakeGet("/api/works"), res, deps([]));
  assert.equal(handled, false);
});

// ── permission-reader: untrusted file parsing ────────────────────────────────────────────────────────

test("parseRequestFile returns the request for a well-formed file", () => {
  const r = parseRequestFile(JSON.stringify(sampleRequest()));
  assert.equal(r?.request_id, "abcde");
  assert.equal(r?.input_preview, '{"command":"ls -la"}');
});

test("parseRequestFile returns undefined for malformed / partial files (never throws)", () => {
  assert.equal(parseRequestFile("{not json"), undefined, "bad JSON");
  assert.equal(parseRequestFile(JSON.stringify({ request_id: "abcde" })), undefined, "missing fields");
  assert.equal(parseRequestFile(JSON.stringify({ ...sampleRequest(), request_id: 1 })), undefined, "non-string id");
  assert.equal(parseRequestFile("[]"), undefined, "not an object");
});
