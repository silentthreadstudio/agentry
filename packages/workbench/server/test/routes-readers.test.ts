// routes-readers proof (tasks 020 + 021) — the five Phase-4 reader GET handlers as an HTTP-shape adapter
// over EventStore / GateInbox / TokenReader / MemReader. Asserts the PINNED paths + verbs + `?run=`/`?q=`
// filtering against a temp `.agentry/work/` + mem fixture tree. Evidence is the captured status + body.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunFiles, WorkRepository } from "../src/domain/ports.js";
import { EventStore } from "../src/application/event-store.js";
import { GateInbox } from "../src/application/gate-inbox.js";
import { TokenReader } from "../src/application/token-reader.js";
import { TranscriptReader } from "../src/persistence/transcript-reader.js";
import { MemReader } from "../src/persistence/mem-reader.js";
import { handleReaderRequest, type ReaderDeps } from "../src/transport/routes.js";

function fakeRepo(runs: string[]): WorkRepository {
  return { listRuns: () => runs, readRun: () => undefined as RunFiles | undefined };
}

interface Captured {
  status: number;
  body: unknown;
}
function fakeReq(url: string, method = "GET"): IncomingMessage {
  return { url, method, headers: {} } as unknown as IncomingMessage;
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

// A temp project carrying one run with events + run-state + a review sidecar + a project mem record.
function seed(): { cwd: string; home: string; deps: ReaderDeps } {
  const cwd = mkdtempSync(join(tmpdir(), "wb-routes-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "wb-routes-home-"));
  const dir = join(cwd, ".agentry", "work", "run-a");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "events.jsonl"),
    '{"ts":"2026-06-19T20:14:37.157Z","type":"node-done","node":"spec","durationMs":4200}\n',
  );
  writeFileSync(join(dir, "run-state.json"), JSON.stringify({ agents: { implementer: { state: "working" } } }));
  mkdirSync(join(dir, ".review"), { recursive: true });
  writeFileSync(
    join(dir, ".review", "spec.annotations.json"),
    JSON.stringify([{ id: "c1", anchor: { originalText: "x", headingAnchor: "h", startLine: 1 }, decision: "changes", body: "fix", resolved: false }]),
  );
  const pFacts = join(cwd, ".agentry", "memory", "facts");
  mkdirSync(pFacts, { recursive: true });
  writeFileSync(join(pFacts, "a-01h.md"), "---\nid: 01h\n---\n\nA project fact about widgets.\n");

  const repo = fakeRepo(["run-a"]);
  const deps: ReaderDeps = {
    events: new EventStore(repo, cwd),
    gates: new GateInbox(repo, cwd),
    tokens: new TokenReader(new TranscriptReader(cwd, home)),
    memory: new MemReader(cwd, home),
  };
  return { cwd, home, deps };
}

function withSeed(run: (deps: ReaderDeps) => void): void {
  const { cwd, home, deps } = seed();
  try {
    run(deps);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test("GET /api/events returns the folded timeline (EventView[])", () => {
  withSeed((deps) => {
    const { res, captured } = fakeRes();
    assert.equal(handleReaderRequest(fakeReq("/api/events"), res, deps), true);
    assert.equal(captured.status, 200);
    assert.ok(Array.isArray(captured.body));
    assert.equal((captured.body as unknown[]).length, 1, "one folded event");
  });
});

test("GET /api/agents returns the roster (AgentView[])", () => {
  withSeed((deps) => {
    const { res, captured } = fakeRes();
    assert.equal(handleReaderRequest(fakeReq("/api/agents"), res, deps), true);
    assert.equal(captured.status, 200);
    const roster = captured.body as Array<{ role: string; state: string }>;
    assert.equal(roster.length, 1);
    assert.equal(roster[0]?.role, "implementer");
  });
});

test("GET /api/gates returns the open waiting-on-you items", () => {
  withSeed((deps) => {
    const { res, captured } = fakeRes();
    assert.equal(handleReaderRequest(fakeReq("/api/gates"), res, deps), true);
    assert.equal(captured.status, 200);
    const gates = captured.body as Array<{ gate: string; run: string }>;
    assert.equal(gates.length, 1);
    assert.equal(gates[0]?.gate, "spec");
    assert.equal(gates[0]?.run, "run-a", "carries the jump-to-run pointer");
  });
});

test("GET /api/events?run filters to one run", () => {
  withSeed((deps) => {
    const { res, captured } = fakeRes();
    handleReaderRequest(fakeReq("/api/events?run=run-a"), res, deps);
    assert.equal((captured.body as unknown[]).length, 1, "the run-a fold");
    const miss = fakeRes();
    handleReaderRequest(fakeReq("/api/events?run=nope"), miss.res, deps);
    assert.equal((miss.captured.body as unknown[]).length, 0, "an unknown run folds to empty");
  });
});

test("GET /api/tokens?run returns a TokenSeries; missing run → clean empty series", () => {
  withSeed((deps) => {
    const { res, captured } = fakeRes();
    handleReaderRequest(fakeReq("/api/tokens?run=run-a"), res, deps);
    assert.equal(captured.status, 200);
    // No transcript fixture for this run → a clean empty series (graceful degrade).
    assert.deepEqual(captured.body, { timestamps: [], tokens: [] });

    const noRun = fakeRes();
    handleReaderRequest(fakeReq("/api/tokens"), noRun.res, deps);
    assert.deepEqual(noRun.captured.body, { timestamps: [], tokens: [] }, "no ?run → empty series");
  });
});

test("GET /api/memory browses; ?q filters (read-only)", () => {
  withSeed((deps) => {
    const browse = fakeRes();
    handleReaderRequest(fakeReq("/api/memory"), browse.res, deps);
    assert.equal(browse.captured.status, 200);
    assert.equal((browse.captured.body as unknown[]).length, 1, "the project fact");

    const search = fakeRes();
    handleReaderRequest(fakeReq("/api/memory?q=widgets"), search.res, deps);
    assert.equal((search.captured.body as unknown[]).length, 1, "matches the body");

    const miss = fakeRes();
    handleReaderRequest(fakeReq("/api/memory?q=zzz"), miss.res, deps);
    assert.equal((miss.captured.body as unknown[]).length, 0, "no match → empty");
  });
});

test("a non-GET to a reader path is 405", () => {
  withSeed((deps) => {
    const { res, captured } = fakeRes();
    assert.equal(handleReaderRequest(fakeReq("/api/events", "POST"), res, deps), true);
    assert.equal(captured.status, 405);
  });
});

test("a non-reader path is not handled (falls through)", () => {
  withSeed((deps) => {
    const { res, captured } = fakeRes();
    assert.equal(handleReaderRequest(fakeReq("/api/works"), res, deps), false);
    assert.equal(captured.status, 0, "untouched — the reader dispatcher didn't answer");
  });
});
