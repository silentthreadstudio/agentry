// routes proof (task 009) — the Phase-1 REST surface against a real WorkReader over a FAKE repository
// (no fs, the port purity ADR-001 buys). Asserts the PINNED endpoint behavior the web api-client
// consumes: /healthz, /api/works (RunSummary[]), /api/work/:id/docs (RunDoc[], 404 unknown),
// /api/context (host-router run, or {}). Evidence is the captured status + parsed JSON body.
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import type { Clock, RunFiles, WorkRepository } from "../src/domain/ports.js";
import { WorkReader } from "../src/application/work-reader.js";
import { workSlug } from "@agentry/workbench-shared";
import { handleApiRequest } from "../src/transport/routes.js";
import type { RunContext } from "../src/transport/host-router.js";

const fixedClock: Clock = { now: () => "2026-06-19T00:00:00.000Z" };

function sampleFiles(): RunFiles {
  return {
    run: "sample",
    routing: { shape: "decompose+verify", kind: "feature" },
    spec: { frontmatter: { kind: "spec" }, body: "# Spec" },
    plan: { frontmatter: { id: "plan", title: "The Plan" }, body: "# Plan" },
    adrs: [],
    tasks: [{ taskNo: "001", frontmatter: { title: "a", status: "done", deps: [] }, body: "" }],
  };
}

function fakeRepo(files: RunFiles): WorkRepository {
  return {
    listRuns: () => [files.run],
    readRun: (run) => (run === files.run ? files : undefined),
  };
}

// A minimal ServerResponse capture: records the status + headers + serialized body, enough to assert the
// observable HTTP outcome without a socket.
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

const reader = () => new WorkReader(fakeRepo(sampleFiles()), fixedClock);
const home: RunContext = { run: null };

test("GET /healthz answers 200 ok", () => {
  const { res, captured } = fakeRes();
  const handled = handleApiRequest(fakeReq("/healthz"), res, reader(), home);
  assert.equal(handled, true);
  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body, { status: "ok" });
});

test("GET /api/works returns the RunSummary list", () => {
  const { res, captured } = fakeRes();
  handleApiRequest(fakeReq("/api/works"), res, reader(), home);
  assert.equal(captured.status, 200);
  const works = captured.body as Array<{ run: string; title: string }>;
  assert.equal(works.length, 1);
  assert.equal(works[0]?.run, "sample");
  assert.equal(works[0]?.title, "The Plan");
});

test("GET /api/work/:id/docs returns the run's documents in reading order", () => {
  const { res, captured } = fakeRes();
  handleApiRequest(fakeReq("/api/work/sample/docs"), res, reader(), home);
  assert.equal(captured.status, 200);
  const docs = captured.body as { id: string; label: string; status: string }[];
  assert.ok(Array.isArray(docs) && docs.length > 0, "has documents");
  assert.ok(
    docs.every((d) => typeof d.id === "string" && typeof d.label === "string" && typeof d.status === "string"),
    "every entry is a complete { id, label, status }",
  );
});

test("GET /api/work/:id/docs on an unknown run is 404", () => {
  const { res, captured } = fakeRes();
  handleApiRequest(fakeReq("/api/work/nope/docs"), res, reader(), home);
  assert.equal(captured.status, 404);
  assert.deepEqual(captured.body, { error: "unknown_run" });
});

test("GET /api/context returns the host's run when one is in context", () => {
  const { res, captured } = fakeRes();
  handleApiRequest(fakeReq("/api/context"), res, reader(), { run: "sample" });
  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body, { run: "sample" });
});

test("GET /api/context returns {} for the Works home (no run)", () => {
  const { res, captured } = fakeRes();
  handleApiRequest(fakeReq("/api/context"), res, reader(), home);
  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body, {});
});

test("a non-API path is not handled (falls through to static)", () => {
  const { res } = fakeRes();
  const handled = handleApiRequest(fakeReq("/work/sample"), res, reader(), home);
  assert.equal(handled, false);
});

test("a non-GET to a known read path is 405", () => {
  const { res, captured } = fakeRes();
  handleApiRequest(fakeReq("/api/works", "POST"), res, reader(), home);
  assert.equal(captured.status, 405);
  assert.deepEqual(captured.body, { error: "method_not_allowed" });
});

// ── workSlug `:id` resolution (task 003) ──────────────────────────────────────────────────────────────
// A long FLOW run id is served at its short `workSlug` subdomain, so the SPA running at
// `<workSlug>.localhost` issues `/api/work/<workSlug>/...` paths. The `:id` segment must resolve back to
// the FULL run id before the read; an exact-id path stays back-compat; an unresolvable label is a 404.
const LONG_ID = "build-agentry-workbench-the-agentry-agent-center-5s9v6deiit";

function longIdReader(): WorkReader {
  const files = { ...sampleFiles(), run: LONG_ID };
  return new WorkReader(fakeRepo(files), fixedClock);
}

test("GET /api/work/:id/docs resolves a workSlug segment to the full run", () => {
  const { res, captured } = fakeRes();
  const slug = workSlug(LONG_ID); // build-agentry-<hash> — shorter than the full id
  assert.notEqual(slug, LONG_ID, "the long id must actually slugify (else this proves nothing)");
  handleApiRequest(fakeReq(`/api/work/${slug}/docs`), res, longIdReader(), home);
  assert.equal(captured.status, 200);
  const docs = captured.body as unknown[];
  assert.ok(Array.isArray(docs) && docs.length > 0, "served the run's documents");
});

test("GET /api/work/:id/docs still resolves an exact full-id segment (back-compat)", () => {
  const { res, captured } = fakeRes();
  handleApiRequest(fakeReq(`/api/work/${LONG_ID}/docs`), res, longIdReader(), home);
  assert.equal(captured.status, 200);
  const docs = captured.body as unknown[];
  assert.ok(Array.isArray(docs) && docs.length > 0, "the full id resolves to itself");
});

test("GET /api/work/:id/docs on a label matching no run is 404 (not a 500)", () => {
  const { res, captured } = fakeRes();
  handleApiRequest(fakeReq("/api/work/build-agentry-000000/docs"), res, longIdReader(), home);
  assert.equal(captured.status, 404);
  assert.deepEqual(captured.body, { error: "unknown_run" });
});

test("GET /api/work/:id/doc resolves a workSlug segment to the full run's doc", () => {
  const { res, captured } = fakeRes();
  const slug = workSlug(LONG_ID);
  handleApiRequest(fakeReq(`/api/work/${slug}/doc/spec`), res, longIdReader(), home);
  assert.equal(captured.status, 200);
  const doc = captured.body as { body: string };
  assert.equal(doc.body, "# Spec");
});

// ── path routing + project identity (M1) ────────────────────────────────────────────────────────────
// The two defects these pin down were BOTH silent in the UI: a lower-cased run label resolved to no run
// (so the SPA rendered the Works home instead of the run, with no error anywhere), and the served project
// was invisible to the client (so a second repo's workbench "focused" the first repo's server and showed
// its runs under the wrong name).

test("GET /api/context?run= resolves a label to the full run id (path routing's bootstrap)", () => {
  const { res, captured } = fakeRes();
  handleApiRequest(fakeReq("/api/context?run=sample"), res, reader(), home);
  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body, { run: "sample" });
});

test("GET /api/context?run= resolves a CASE-FOLDED label (browsers lower-case the Host header)", () => {
  const upper = { ...sampleFiles(), run: "M7" };
  const upperReader = new WorkReader(fakeRepo(upper), fixedClock);
  const { res, captured } = fakeRes();
  handleApiRequest(fakeReq("/api/context?run=m7"), res, upperReader, home);
  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body, { run: "M7" });
});

test("GET /api/context?run= wins over the host-derived run (the path is the primary address)", () => {
  const { res, captured } = fakeRes();
  handleApiRequest(fakeReq("/api/context?run=sample"), res, reader(), { run: "stale-host-run" });
  assert.deepEqual(captured.body, { run: "sample" });
});

test("GET /api/context?run= on an unknown label reports no run rather than 500-ing", () => {
  const { res, captured } = fakeRes();
  handleApiRequest(fakeReq("/api/context?run=ghost"), res, reader(), home);
  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body, {});
});

test("GET /api/context reports the project the server is ACTUALLY serving", () => {
  const { res, captured } = fakeRes();
  handleApiRequest(fakeReq("/api/context"), res, reader(), home, "/Users/x/Projects/lifeos");
  assert.deepEqual(captured.body, { project: "lifeos", root: "/Users/x/Projects/lifeos" });
});

test("a case-folded label resolves through a workSlug too", () => {
  const long = { ...sampleFiles(), run: "Build-Agentry-Workbench-The-Agentry-Agent-Center" };
  const longReader = new WorkReader(fakeRepo(long), fixedClock);
  const { res, captured } = fakeRes();
  handleApiRequest(fakeReq(`/api/context?run=${workSlug(long.run).toLowerCase()}`), res, longReader, home);
  assert.deepEqual(captured.body, { run: long.run });
});
