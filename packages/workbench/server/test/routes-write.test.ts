// write-routes proof (task 017) — the three POST handlers + the doc GET, against a fake WriteService /
// Transport / WorkReader (the port purity ADR-001 buys — no fs, no socket). Asserts the PINNED wire
// behavior tasks 16/18/19 consume: the typed-outcome → HTTP mapping (200 / 409 locked / 409 stale /
// 404), the minted comment id, the `doc-updated` ws push on a successful artifact write (AC7), and the
// doc-fetch DocModel shape. Evidence is the captured status + parsed JSON body + the pushed messages.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import type { WsMessage } from "@agentry/workbench-shared";
import { computeVersion } from "@agentry/flow/domain/version";
import type { Clock, RunFiles, Transport, WorkRepository } from "../src/domain/ports.js";
import { WorkReader } from "../src/application/work-reader.js";
import type {
  AddCommentRequest,
  StatusOutcome,
  WriteArtifactOutcome,
  WriteArtifactRequest,
} from "../src/application/write-service.js";
import type { FlowTaskStatus } from "@agentry/flow/domain/status";
import { handleApiRequest, handlePostRequest, type WriteDeps } from "../src/transport/routes.js";

const fixedClock: Clock = { now: () => "2026-06-19T00:00:00.000Z" };

function sampleFiles(): RunFiles {
  return {
    run: "sample",
    routing: { shape: "decompose+verify", kind: "feature" },
    spec: { frontmatter: { kind: "spec", version: "v-spec" }, body: "# Spec" },
    plan: { frontmatter: { id: "plan", title: "The Plan", version: "v-plan" }, body: "# Plan" },
    adrs: [{ frontmatter: { id: "001", title: "stateless" }, body: "# ADR-001" }],
    tasks: [{ taskNo: "001", frontmatter: { title: "a", status: "done", deps: [] }, body: "" }],
  };
}

function fakeRepo(files: RunFiles): WorkRepository {
  return {
    listRuns: () => [files.run],
    readRun: (run) => (run === files.run ? files : undefined),
  };
}

// A recording Transport: captures every (run, message) push so the test can assert the AC7 ws fan-out.
function recordingTransport(): Transport & { pushes: Array<{ run: string; message: WsMessage }> } {
  const pushes: Array<{ run: string; message: WsMessage }> = [];
  return {
    pushes,
    push: (run, message) => void pushes.push({ run, message }),
    pushAll: (message) => void pushes.push({ run: "*", message }),
  };
}

// A stub WriteService whose three methods return whatever the test arms — the route is the unit here, so
// the service is faked to drive each typed outcome. Only the shape the route consumes is implemented.
interface StubWrite {
  addComment: (req: AddCommentRequest) => { id: string };
  writeArtifact: (req: WriteArtifactRequest) => WriteArtifactOutcome;
  setStatus: (req: { run: string; taskNo: string; status: FlowTaskStatus }) => StatusOutcome;
}

function deps(write: Partial<StubWrite>, transport = recordingTransport()): WriteDeps & {
  transport: ReturnType<typeof recordingTransport>;
} {
  const reader = new WorkReader(fakeRepo(sampleFiles()), fixedClock);
  const writeService = {
    addComment: write.addComment ?? (() => ({ id: "c-stub" })),
    writeArtifact: write.writeArtifact ?? (() => ({ ok: false, reason: "not-found" }) as const),
    setStatus: write.setStatus ?? (() => ({ ok: false, reason: "not-found" }) as const),
  } as unknown as WriteDeps["writeService"];
  return { reader, writeService, transport };
}

// A fake POST request that emits the given JSON body over the data/end stream the handler consumes.
function fakePost(url: string, body: unknown, method = "POST"): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
  (req as unknown as { url: string }).url = url;
  (req as unknown as { method: string }).method = method;
  (req as unknown as { headers: object }).headers = {};
  (req as unknown as { destroy: () => void }).destroy = () => {};
  // Emit on the next tick so the handler has attached its listeners.
  queueMicrotask(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function fakeGet(url: string): IncomingMessage {
  return { url, method: "GET", headers: {} } as unknown as IncomingMessage;
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

const anchor = { originalText: "the snippet", headingAnchor: "## H", startLine: 3 };

// ── POST /comment ─────────────────────────────────────────────────────────────────────────────────

test("POST /comment returns the minted id and pushes a file-changed for the sidecar (AC5)", async () => {
  const { res, captured } = fakeRes();
  let seen: AddCommentRequest | undefined;
  const d = deps({
    addComment: (req) => {
      seen = req;
      return { id: "c-123" };
    },
  });
  const handled = await handlePostRequest(
    fakePost("/api/work/sample/comment", {
      gate: "spec",
      anchor,
      decision: "changes",
      body: "needs work",
    }),
    res,
    d,
  );
  assert.equal(handled, true);
  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body, { id: "c-123" });
  assert.equal(seen?.run, "sample");
  assert.equal(seen?.gate, "spec");
  assert.deepEqual(seen?.anchor, anchor);
  assert.deepEqual(d.transport.pushes[0], {
    run: "sample",
    message: { type: "file-changed", path: ".review/spec.annotations.json" },
  });
});

test("POST /comment with a malformed anchor is 400, no write", async () => {
  const { res, captured } = fakeRes();
  let called = false;
  const d = deps({ addComment: () => ((called = true), { id: "x" }) });
  await handlePostRequest(
    fakePost("/api/work/sample/comment", { gate: "spec", anchor: { nope: 1 }, decision: "changes", body: "b" }),
    res,
    d,
  );
  assert.equal(captured.status, 400);
  assert.equal((captured.body as { error: string }).error, "invalid_anchor");
  assert.equal(called, false);
});

test("POST /comment with an invalid decision is 400", async () => {
  const { res, captured } = fakeRes();
  await handlePostRequest(
    fakePost("/api/work/sample/comment", { gate: "spec", anchor, decision: "lgtm", body: "b" }),
    res,
    deps({}),
  );
  assert.equal(captured.status, 400);
  assert.equal((captured.body as { error: string }).error, "invalid_decision");
});

// ── POST /artifact ────────────────────────────────────────────────────────────────────────────────

test("POST /artifact with a fresh baseVersion writes, returns the DocModel and pushes doc-updated (AC6/AC7)", async () => {
  const { res, captured } = fakeRes();
  const d = deps({ writeArtifact: () => ({ ok: true, version: "v-new" }) });
  await handlePostRequest(
    fakePost("/api/work/sample/artifact", {
      target: "spec", // the docId STRING the web sends (mapped to { kind: "spec" })
      baseVersion: "v-spec",
      newBody: "# Spec edited",
    }),
    res,
    d,
  );
  assert.equal(captured.status, 200);
  const doc = captured.body as { body: string; version: string; lock: unknown };
  // The version is RECOMPUTED (computeVersion over body+frontmatter-sans-version), not the stamped
  // frontmatter field — it must equal what WriteService checks on save (ADR-006), so it is a 16-char hash.
  assert.match(doc.version, /^[0-9a-f]{16}$/);
  assert.equal(doc.lock, null);
  const push = d.transport.pushes[0];
  assert.equal(push?.message.type, "doc-updated");
  assert.equal((push?.message as { docId: string }).docId, "spec");
});

test("POST /artifact with a stale baseVersion is 409 stale + currentVersion (AC6 optimistic-concurrency reject)", async () => {
  const { res, captured } = fakeRes();
  const d = deps({ writeArtifact: () => ({ ok: false, reason: "stale", currentVersion: "v-disk" }) });
  await handlePostRequest(
    fakePost("/api/work/sample/artifact", { target: "spec", baseVersion: "v-old", newBody: "x" }),
    res,
    d,
  );
  assert.equal(captured.status, 409);
  assert.deepEqual(captured.body, { error: "stale", currentVersion: "v-disk" });
  assert.equal(d.transport.pushes.length, 0); // no push on a rejected write
});

test("POST /artifact against a locked task is 409 locked + lockedBy (AC4)", async () => {
  const { res, captured } = fakeRes();
  let seen: WriteArtifactRequest | undefined;
  await handlePostRequest(
    // `target: "task-001"` (the docId) maps to { taskNo: "001" } for the WriteService.
    fakePost("/api/work/sample/artifact", { target: "task-001", baseVersion: "v", newBody: "x" }),
    res,
    deps({
      writeArtifact: (req) => {
        seen = req;
        return { ok: false, reason: "locked", lockedBy: "implementer" };
      },
    }),
  );
  assert.equal(captured.status, 409);
  assert.deepEqual(captured.body, { error: "locked", lockedBy: "implementer" });
  assert.deepEqual(seen?.target, { taskNo: "001" }, "task-<NNN> docId maps to { taskNo }");
});

test("POST /artifact against an adr-* doc is rejected read_only (V1 decision records, no write)", async () => {
  const { res, captured } = fakeRes();
  let called = false;
  await handlePostRequest(
    fakePost("/api/work/sample/artifact", { target: "adr-001", baseVersion: "v", newBody: "x" }),
    res,
    deps({ writeArtifact: () => ((called = true), { ok: true, version: "v" }) }),
  );
  assert.equal(captured.status, 409);
  assert.equal((captured.body as { error: string }).error, "read_only");
  assert.equal(called, false, "the WriteService is never called for a read-only artifact");
});

test("POST /artifact on an absent artifact is 404", async () => {
  const { res, captured } = fakeRes();
  await handlePostRequest(
    fakePost("/api/work/sample/artifact", { target: "plan", baseVersion: "v", newBody: "x" }),
    res,
    deps({ writeArtifact: () => ({ ok: false, reason: "not-found" }) }),
  );
  assert.equal(captured.status, 404);
  assert.equal((captured.body as { error: string }).error, "not_found");
});

test("POST /artifact with an unknown/non-string target is 400, no write", async () => {
  const { res, captured } = fakeRes();
  let called = false;
  await handlePostRequest(
    // Not one of spec/plan/task-<NNN>/adr-* — an unknown docId is rejected before any write.
    fakePost("/api/work/sample/artifact", { target: "mystery", baseVersion: "v", newBody: "x" }),
    res,
    deps({ writeArtifact: () => ((called = true), { ok: true, version: "v" }) }),
  );
  assert.equal(captured.status, 400);
  assert.equal((captured.body as { error: string }).error, "invalid_target");
  assert.equal(called, false);
});

// ── POST /status (the task-status override — also the in-progress unblock path) ──────────────────────

test("POST /status with a task-<NNN> target sets the status and returns { ok:true }", async () => {
  const { res, captured } = fakeRes();
  let seen: { run: string; taskNo: string; status: FlowTaskStatus } | undefined;
  const d = deps({
    setStatus: (req) => {
      seen = req;
      return { ok: true };
    },
  });
  await handlePostRequest(fakePost("/api/work/sample/status", { target: "task-001", status: "done" }), res, d);
  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body, { ok: true });
  assert.equal(seen?.run, "sample");
  assert.equal(seen?.taskNo, "001", "the task number is derived from the task-<NNN> target");
  assert.equal(seen?.status, "done");
  // The status write nudges watchers so the graph/navigator re-tint.
  assert.ok(d.transport.pushes.some((p) => p.message.type === "file-changed"), "pushes a file-changed");
});

test("POST /status with an out-of-vocab status is 400, no write", async () => {
  const { res, captured } = fakeRes();
  let called = false;
  await handlePostRequest(
    fakePost("/api/work/sample/status", { target: "task-001", status: "bogus" }),
    res,
    deps({ setStatus: () => ((called = true), { ok: true }) }),
  );
  assert.equal(captured.status, 400);
  assert.equal((captured.body as { error: string }).error, "invalid_status");
  assert.equal(called, false);
});

test("POST /status on a non-task target (spec/plan/adr-*) is 400", async () => {
  const { res, captured } = fakeRes();
  let called = false;
  await handlePostRequest(
    fakePost("/api/work/sample/status", { target: "spec", status: "done" }),
    res,
    deps({ setStatus: () => ((called = true), { ok: true }) }),
  );
  assert.equal(captured.status, 400);
  assert.equal((captured.body as { error: string }).error, "not_a_task");
  assert.equal(called, false);
});

test("POST /status on an absent task is 404", async () => {
  const { res, captured } = fakeRes();
  await handlePostRequest(
    fakePost("/api/work/sample/status", { target: "task-999", status: "done" }),
    res,
    deps({ setStatus: () => ({ ok: false, reason: "not-found" }) }),
  );
  assert.equal(captured.status, 404);
  assert.equal((captured.body as { error: string }).error, "not_found");
});

// ── verb + body guards ──────────────────────────────────────────────────────────────────────────────

test("a GET to a write path is 405", async () => {
  const { res, captured } = fakeRes();
  const handled = await handlePostRequest(fakePost("/api/work/sample/comment", undefined, "GET"), res, deps({}));
  assert.equal(handled, true);
  assert.equal(captured.status, 405);
});

test("a malformed JSON body is 400", async () => {
  const { res, captured } = fakeRes();
  const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
  (req as unknown as { url: string }).url = "/api/work/sample/comment";
  (req as unknown as { method: string }).method = "POST";
  (req as unknown as { headers: object }).headers = {};
  queueMicrotask(() => {
    req.emit("data", Buffer.from("{not json"));
    req.emit("end");
  });
  const handled = await handlePostRequest(req, res, deps({}));
  assert.equal(handled, true);
  assert.equal(captured.status, 400);
  assert.equal((captured.body as { error: string }).error, "invalid_json");
});

test("a non-write path falls through (not handled by the POST dispatcher)", async () => {
  const { res } = fakeRes();
  const handled = await handlePostRequest(fakePost("/api/works", undefined, "POST"), res, deps({}));
  assert.equal(handled, false);
});

// ── GET /api/work/:id/doc/:docId ────────────────────────────────────────────────────────────────────

test("GET /doc/:docId returns the DocModel for a known doc (unblocks task 16)", () => {
  const { res, captured } = fakeRes();
  const reader = new WorkReader(fakeRepo(sampleFiles()), fixedClock);
  const handled = handleApiRequest(fakeGet("/api/work/sample/doc/spec"), res, reader, { run: "sample" });
  assert.equal(handled, true);
  assert.equal(captured.status, 200);
  const doc = captured.body as { body: string; version: string; lock: unknown; frontmatter: object };
  assert.equal(doc.body, "# Spec");
  // The optimistic-concurrency token MUST equal computeVersion(body, frontmatter-sans-version) — the
  // exact value the write boundary checks `baseVersion` against (ADR-006), NOT the stamped frontmatter
  // field. The spec fixture frontmatter carries a deliberately-wrong stamped `version:"v-spec"`.
  assert.equal(doc.version, computeVersion("# Spec", { kind: "spec" }));
  assert.notEqual(doc.version, "v-spec");
  assert.equal(doc.lock, null);
});

test("GET /doc/:docId on an unknown doc within a known run is 404 unknown_doc", () => {
  const { res, captured } = fakeRes();
  const reader = new WorkReader(fakeRepo(sampleFiles()), fixedClock);
  handleApiRequest(fakeGet("/api/work/sample/doc/nope"), res, reader, { run: "sample" });
  assert.equal(captured.status, 404);
  assert.equal((captured.body as { error: string }).error, "unknown_doc");
});

test("GET /doc/:docId on an unknown run is 404 unknown_run", () => {
  const { res, captured } = fakeRes();
  const reader = new WorkReader(fakeRepo(sampleFiles()), fixedClock);
  handleApiRequest(fakeGet("/api/work/ghost/doc/spec"), res, reader, { run: null });
  assert.equal(captured.status, 404);
  assert.equal((captured.body as { error: string }).error, "unknown_run");
});
