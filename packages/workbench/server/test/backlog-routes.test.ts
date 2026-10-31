// backlog-routes proof (doc 18 slice 1) — the HTTP surface over the project's backlog, against a real
// temp project root (the store is the thing under test, and it is a file store).
//
// The absence worth asserting: there is NO route that claims an item. Minting a run from intent is a
// session's move, not the dashboard's (doc 18 §3.2) — the Workbench has no model and must never appear
// to start work on its own. A future route that does this would silently break that promise, so the
// last test pins it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Clock } from "../src/domain/ports.js";
import { BacklogAdapter } from "../src/persistence/backlog-adapter.js";
import { handleBacklogRequest, handleRunResetRequest } from "../src/transport/routes.js";

let root: string;
const clock: Clock = { now: () => new Date().toISOString() };
let pushed: number;

const deps = () => ({
  backlog: new BacklogAdapter(root, clock),
  transport: {
    pushAll: () => {
      pushed += 1;
    },
  },
});

function req(url: string, method = "GET", body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const stream = {
    url,
    method,
    headers: { "content-type": "application/json" },
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === "data") for (const c of chunks) cb(c);
      if (event === "end") cb();
      return this;
    },
  };
  return stream as unknown as IncomingMessage;
}

function res(): { res: ServerResponse; got: { status: number; body: unknown } } {
  const got = { status: 0, body: undefined as unknown };
  let raw = "";
  const r = {
    writeHead(status: number) {
      got.status = status;
      return this;
    },
    end(chunk?: string) {
      if (chunk) raw += chunk;
      got.body = raw.length > 0 ? JSON.parse(raw) : undefined;
    },
  } as unknown as ServerResponse;
  return { res: r, got };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentry-blroutes-"));
  pushed = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("GET /api/backlog on a cold project is an empty list, not a 404", async () => {
  const { res: r, got } = res();
  assert.equal(await handleBacklogRequest(req("/api/backlog"), r, deps()), true);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, { items: [] });
});

test("POST /api/backlog creates an item and returns it", async () => {
  const d = deps();
  const { res: r, got } = res();
  await handleBacklogRequest(
    req("/api/backlog", "POST", { title: "Cap the verify retries", kind: "perf" }),
    r,
    d,
  );
  assert.equal(got.status, 200);
  const item = got.body as { id: string; title: string; kind: string; status: string };
  assert.equal(item.title, "Cap the verify retries");
  assert.equal(item.kind, "perf");
  assert.equal(item.status, "backlog");
  assert.equal(pushed, 1, "a new item makes the board live for every open client");
});

test("POST with ready:true queues it for the conductor", async () => {
  const { res: r, got } = res();
  await handleBacklogRequest(
    req("/api/backlog", "POST", { title: "Queue me", ready: true }),
    r,
    deps(),
  );
  assert.equal((got.body as { status: string }).status, "ready");
});

test("POST without a title is refused", async () => {
  const { res: r, got } = res();
  await handleBacklogRequest(req("/api/backlog", "POST", { title: "   " }), r, deps());
  assert.equal(got.status, 400);
  assert.deepEqual(got.body, { error: "missing_title" });
});

test("an item written through the API is readable back through it (files are truth)", async () => {
  const d = deps();
  const created = res();
  await handleBacklogRequest(req("/api/backlog", "POST", { title: "Round trip" }), created.res, d);
  const id = (created.got.body as { id: string }).id;

  // A FRESH adapter over the same root — nothing is cached in memory.
  const listed = res();
  await handleBacklogRequest(req("/api/backlog"), listed.res, deps());
  const items = (listed.got.body as { items: { id: string }[] }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, id);
});

test("GET /api/backlog?status= filters", async () => {
  const d = deps();
  await handleBacklogRequest(req("/api/backlog", "POST", { title: "Parked" }), res().res, d);
  await handleBacklogRequest(
    req("/api/backlog", "POST", { title: "Queued", ready: true }),
    res().res,
    d,
  );

  const { res: r, got } = res();
  await handleBacklogRequest(req("/api/backlog?status=ready"), r, d);
  const items = (got.body as { items: { title: string }[] }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.title, "Queued");
});

test("POST /api/backlog/:id patches — a status move keeps the body", async () => {
  const d = deps();
  const created = res();
  await handleBacklogRequest(
    req("/api/backlog", "POST", { title: "Move me", body: "context worth keeping" }),
    created.res,
    d,
  );
  const id = (created.got.body as { id: string }).id;

  const { res: r, got } = res();
  await handleBacklogRequest(req(`/api/backlog/${id}`, "POST", { status: "ready" }), r, d);
  const item = got.body as { status: string; body: string };
  assert.equal(item.status, "ready");
  assert.equal(item.body, "context worth keeping");
});

test("patching an unknown id is a 404, not a silent create", async () => {
  const { res: r, got } = res();
  await handleBacklogRequest(req("/api/backlog/b-ghost", "POST", { status: "done" }), r, deps());
  assert.equal(got.status, 404);
});

test("a verb the surface does not serve is a 405, never a silent fall-through", async () => {
  const { res: r, got } = res();
  await handleBacklogRequest(req("/api/backlog", "DELETE"), r, deps());
  assert.equal(got.status, 405);
});

test("an unrelated path is not claimed by this dispatcher", async () => {
  const { res: r } = res();
  assert.equal(await handleBacklogRequest(req("/api/works"), r, deps()), false);
});

test("there is NO http route that claims an item — starting work is a session's move", async () => {
  const d = deps();
  const created = res();
  await handleBacklogRequest(
    req("/api/backlog", "POST", { title: "Do not auto-start", ready: true }),
    created.res,
    d,
  );

  for (const path of ["/api/backlog/claim", "/api/backlog/next"]) {
    const { res: r } = res();
    assert.equal(
      await handleBacklogRequest(req(path, "POST", {}), r, d),
      path === "/api/backlog/claim" || path === "/api/backlog/next",
      "the :id patch route matches the shape, but it can only patch — it never mints a run",
    );
  }
  // The proof that matters: no run directory exists.
  const listed = res();
  await handleBacklogRequest(req("/api/backlog"), listed.res, d);
  const items = (listed.got.body as { items: { status: string; runs: string[] }[] }).items;
  assert.deepEqual(items[0]?.runs, [], "queued, not started");
});

// ── reset, not cancel (doc 18 Q2 / AC7) ────────────────────────────────────────────────────────────
// Dropping a run card back onto Ready RESETS it: tasks return to todo and the item returns to ready.
// It kills nothing. An agent writing right now keeps writing, and the run's artifacts and history
// survive — killing a live agent mid-write is not what a drag on a board should ever mean.
test("reset returns every task to todo and hands the item back to ready", async () => {
  const statuses: { taskNo: string; status: string }[] = [];
  const updated: { id: string; status: string }[] = [];
  const deps = {
    reader: {
      listRuns: () => ["r-1"],
      read: () => ({ docs: [{ id: "task-001" }, { id: "task-002" }, { id: "spec" }] }),
    },
    writeService: {
      setStatus: (r: { taskNo: string; status: "todo" }) => {
        statuses.push({ taskNo: r.taskNo, status: r.status });
        return { ok: true };
      },
    },
    backlog: {
      list: () => [{ id: "b-src", runs: ["r-1"], status: "claimed" }],
      update: (i: { id: string; status: "ready" }) => updated.push(i),
    },
    transport: { push: () => {}, pushAll: () => {} },
  };

  const { res: r, got } = res();
  assert.equal(
    await handleRunResetRequest(req("/api/work/r-1/reset", "POST"), r, deps as never),
    true,
  );
  assert.equal(got.status, 200);
  assert.deepEqual(statuses, [
    { taskNo: "001", status: "todo" },
    { taskNo: "002", status: "todo" },
  ]);
  assert.deepEqual(
    updated,
    [{ id: "b-src", status: "ready" }],
    "back to ready, not backlog — you still want it",
  );
  assert.deepEqual(got.body, { ok: true, run: "r-1", tasks: 2, item: "b-src" });
});

test("a run with no originating item resets its tasks and touches no backlog", async () => {
  const deps = {
    reader: { listRuns: () => ["r-1"], read: () => ({ docs: [{ id: "task-001" }] }) },
    writeService: { setStatus: () => ({ ok: true }) },
    backlog: {
      list: () => [],
      update: () => assert.fail("must not patch an item that does not exist"),
    },
    transport: { push: () => {}, pushAll: () => {} },
  };
  const { res: r, got } = res();
  await handleRunResetRequest(req("/api/work/r-1/reset", "POST"), r, deps as never);
  assert.deepEqual(got.body, { ok: true, run: "r-1", tasks: 1 });
});

test("resetting an unknown run is a 404, and a GET is a 405", async () => {
  const deps = {
    reader: { listRuns: () => [], read: () => undefined },
    writeService: { setStatus: () => ({ ok: true }) },
    backlog: { list: () => [], update: () => {} },
    transport: { push: () => {}, pushAll: () => {} },
  };
  const a = res();
  await handleRunResetRequest(req("/api/work/ghost/reset", "POST"), a.res, deps as never);
  assert.equal(a.got.status, 404);

  const b = res();
  await handleRunResetRequest(req("/api/work/r-1/reset", "GET"), b.res, deps as never);
  assert.equal(b.got.status, 405);
});
