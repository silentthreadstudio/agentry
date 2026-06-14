// Error-envelope wiring tests (Task 2 / ADR-001). Drives the service outcomes directly AND through the
// real adapters via a fake McpServer that captures each registered handler, so the assertions run the
// genuine err()/ok() wire shape. Covers AC2–AC9 + Q1.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryError } from "@agentry/core";
import { MemoryService } from "../src/application/memory-service.js";
import type { FileStore, ReadResult, StoredEpisode, StoredFact } from "../src/domain/ports.js";
import type { TextIndex } from "../src/domain/ports.js";
import { SqliteTextIndex } from "../src/persistence/db-index.js";
import { MarkdownFileStore } from "../src/persistence/file-store.js";
import { registerEpisodeTools } from "../src/tools/episode-tools.js";
import { registerFactTools } from "../src/tools/fact-tools.js";
import { registerFlowTools } from "../src/tools/flow-tools.js";
import type { Roots } from "../src/resolution/roots.js";

// ── harness ────────────────────────────────────────────────────────────────
type Handler = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/** Minimal fake McpServer capturing the third positional arg (the handler) of registerTool by name. */
class CapturingServer {
  readonly handlers = new Map<string, Handler>();
  registerTool(name: string, _config: unknown, handler: Handler): void {
    this.handlers.set(name, handler);
  }
}

function wired(global: string): { service: MemoryService; call: (tool: string, args?: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> } {
  const roots: Roots = { global, project: null };
  const service = new MemoryService(new MarkdownFileStore(roots), new SqliteTextIndex(), roots);
  service.load();
  const server = new CapturingServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerFactTools(server as any, service);
  registerEpisodeTools(server as any, service);
  registerFlowTools(server as any, service);
  const call = (tool: string, args: unknown = {}) => {
    const h = server.handlers.get(tool);
    if (!h) throw new Error(`tool ${tool} not registered`);
    return h(args);
  };
  return { service, call };
}

const fresh = (): string => mkdtempSync(join(tmpdir(), "agentry-mem-err-"));

/** Parse a tool response payload; assert+return the error envelope (validated against the core schema). */
function envelopeOf(res: { content: { text: string }[]; isError?: boolean }) {
  assert.equal(res.isError, true, "expected isError:true");
  const parsed = JSON.parse(res.content[0]!.text);
  return MemoryError.parse(parsed.error); // throws if the shape drifts (AC1/AC8 conformance)
}
function payloadOf(res: { content: { text: string }[]; isError?: boolean }) {
  assert.notEqual(res.isError, true, "expected a success response (isError falsy)");
  return JSON.parse(res.content[0]!.text);
}

const ARCHIVE_THRESHOLD = 4;

/** Archive a fresh fact and return its id (drives the real decay path). */
function archivedFact(service: MemoryService, tick: () => number): string {
  const { id } = service.write({ type: "gotcha", scope: "global", text: `archive target ${Math.random()}` });
  for (let s = 1; s <= ARCHIVE_THRESHOLD; s++) {
    tick();
    service.feedback({ recalled: [id], used: [], outcome: "pass" });
  }
  return id;
}

// ── AC2 / AC4 — not-found is an error, byte-identical across update/forget/recover ──────────────────
test("AC2/AC4: update/forget/recover on a missing id → isError, code:not-found, byte-identical shape", async () => {
  const { call } = wired(fresh());
  const missing = "g:NONEXISTENT";
  const u = envelopeOf(await call("memory_update", { id: missing }));
  const f = envelopeOf(await call("memory_forget", { id: missing }));
  const r = envelopeOf(await call("memory_recover", { id: missing }));

  for (const env of [u, f, r]) assert.equal(env.code, "not-found");
  // field names + values are byte-identical across the three tools (AC4).
  assert.deepEqual(Object.keys(u).sort(), Object.keys(f).sort());
  assert.deepEqual(Object.keys(u).sort(), Object.keys(r).sort());
  assert.deepEqual(u, f);
  assert.deepEqual(u, r);
  assert.ok(u.why.includes(missing), "why surfaces the offending id");
});

// ── AC2 — recover on an existing-but-not-archived id → invalid-state, why mentions the status ───────
test("AC2: recover on an existing non-archived fact → invalid-state, why names the status", async () => {
  let clock = 1000;
  const dir = fresh();
  const roots: Roots = { global: dir, project: null };
  const service = new MemoryService(new MarkdownFileStore(roots), new SqliteTextIndex(), roots, () => clock);
  service.load();
  const { id } = service.write({ type: "decision", scope: "global", text: "an active fact, not archived" });

  // service-level outcome carries the actual status
  const outcome = service.recover(id);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, "invalid-state");
  assert.equal(outcome.ok === false && "status" in outcome && outcome.status, "active");

  // adapter-level envelope distinguishes invalid-state from not-found
  const server = new CapturingServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerFactTools(server as any, service);
  const res = await server.handlers.get("memory_recover")!({ id });
  const env = envelopeOf(res);
  assert.equal(env.code, "invalid-state");
  assert.ok(env.why.includes("active"), "why distinguishes the actual status");
  assert.ok(env.why.toLowerCase().includes("archived") || env.fix.toLowerCase().includes("archived"));
});

// ── AC3 — semantic bad-input: blank id → code:bad-input, fix names the field ────────────────────────
test("AC3: a blank/whitespace id → isError, code:bad-input, fix names the field", async () => {
  const { call } = wired(fresh());
  for (const tool of ["memory_update", "memory_forget", "memory_recover"]) {
    const env = envelopeOf(await call(tool, { id: "   " }));
    assert.equal(env.code, "bad-input", `${tool} blank id`);
    assert.ok(env.fix.includes("id"), `${tool} fix names the field`);
  }
});

// ── AC5 / Q2 — feedback partial reporting + all-invalid → error ─────────────────────────────────────
test("AC5: feedback with one good + one bogus id → success listing applied + skipped(reason)", async () => {
  const { service, call } = wired(fresh());
  const { id: good } = service.write({ type: "gotcha", scope: "global", text: "a real recalled fact" });
  const res = await call("memory_feedback", { recalled: [good, "g:BOGUS"], used: [good], outcome: "pass" });
  const data = payloadOf(res);
  assert.deepEqual(data.applied, [good]);
  assert.equal(data.skipped.length, 1);
  assert.equal(data.skipped[0].id, "g:BOGUS");
  assert.ok(typeof data.skipped[0].reason === "string" && data.skipped[0].reason.length > 0);
});

test("AC5/Q2: feedback with all-invalid ids → isError, code:not-found naming the ids", async () => {
  const { call } = wired(fresh());
  const res = await call("memory_feedback", { recalled: ["g:NOPE1", "g:NOPE2"], used: [], outcome: "pass" });
  const env = envelopeOf(res);
  assert.equal(env.code, "not-found");
  assert.ok(
    env.why.includes('"g:NOPE1"') && env.why.includes('"g:NOPE2"'),
    "why names each missing id distinctly (quoted), not joined into one string",
  );
});

// ── AC5 / Q2 — distill stamp: partial + all-invalid ─────────────────────────────────────────────────
test("AC5: distill stamp with one good + one bogus episode id → success listing applied + skipped", async () => {
  const { service, call } = wired(fresh());
  const { id } = service.episodeWrite({ task: "t", shape: "s", outcome: "pass", lesson: "l" });
  const res = await call("memory_distill", { mode: "stamp", episodeIds: [id, "g:BOGUS_EP"] });
  const data = payloadOf(res);
  assert.deepEqual(data.applied, [id]);
  assert.equal(data.skipped[0].id, "g:BOGUS_EP");
});

test("AC5/Q2: distill stamp with all-invalid episode ids → isError, code:not-found", async () => {
  const { call } = wired(fresh());
  const env = envelopeOf(await call("memory_distill", { mode: "stamp", episodeIds: ["g:NOPE"] }));
  assert.equal(env.code, "not-found");
});

// ── AC6 / Q3 — write with bogus supersedes → success, supersededMissing flagged ─────────────────────
test("AC6: write with a bogus supersedes → success with supersededMissing === the bogus id", async () => {
  const { call } = wired(fresh());
  const res = await call("memory_write", { type: "repo-fact", scope: "global", text: "new fact", supersedes: "g:GHOST" });
  const data = payloadOf(res);
  assert.equal(data.action, "created");
  assert.equal(data.supersededMissing, "g:GHOST");
});

test("AC9: write with NO supersedes → success, supersededMissing absent (additive-only)", async () => {
  const { call } = wired(fresh());
  const data = payloadOf(await call("memory_write", { type: "repo-fact", scope: "global", text: "plain fact" }));
  assert.equal(data.action, "created");
  assert.equal("supersededMissing" in data, false);
});

// ── AC7 — induced internal throw → code:internal, no path/stack leak ─────────────────────────────────
test("AC7: a throwing handler path → isError, code:internal, no path or stack substring", async () => {
  // A FileStore double whose readFacts throws would be caught by load(), so instead drive a tool whose
  // service call throws: a TextIndex that throws on search makes memory_search's handler throw.
  const throwingIndex: TextIndex = {
    reset() {},
    add() {},
    search() {
      throw new Error("boom at /Users/secret/path/file.ts:42");
    },
  };
  const roots: Roots = { global: fresh(), project: null };
  const service = new MemoryService(new MarkdownFileStore(roots), throwingIndex, roots);
  service.load();
  const server = new CapturingServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerFactTools(server as any, service);
  const res = await server.handlers.get("memory_search")!({ query: "anything" });
  const env = envelopeOf(res);
  assert.equal(env.code, "internal");
  const blob = `${env.what} ${env.why} ${env.fix}`;
  assert.ok(!blob.includes("/"), "no path-like substring leaks");
  assert.ok(!blob.includes("at "), "no stack-like substring leaks");
  // the raw response carries no leaked path either
  assert.ok(!res.content[0]!.text.includes("/Users/secret"), "no leaked path in the wire payload");
});

// ── Q1 — corrupt store record surfaces via memory_stats.readErrors, not swallowed ───────────────────
test("Q1: a corrupt fact file surfaces as stats().readErrors and on the memory_stats payload", async () => {
  const dir = fresh();
  // write a valid fact so the dir exists, then drop a corrupt file alongside it
  const { service, call } = wired(dir);
  service.write({ type: "gotcha", scope: "global", text: "a healthy fact" });
  const factsDir = join(dir, "facts");
  mkdirSync(factsDir, { recursive: true });
  writeFileSync(join(factsDir, "corrupt-record.md"), "---\nthis: is: not: valid: yaml: frontmatter\n---\nbody\n");

  // reload picks up the corrupt file as a read-error (not swallowed)
  service.load();
  const stats = service.stats();
  assert.ok(stats.readErrors.length >= 1, "a read-error is collected");
  assert.equal(stats.readErrors[0]!.kind, "facts");
  assert.equal(stats.readErrors[0]!.file, "corrupt-record.md");
  assert.ok(typeof stats.readErrors[0]!.reason === "string" && stats.readErrors[0]!.reason.length > 0);

  // and memory_stats surfaces it on its payload (Q1)
  const data = payloadOf(await call("memory_stats"));
  assert.ok(Array.isArray(data.readErrors) && data.readErrors.length >= 1);
  assert.equal(data.readErrors[0].file, "corrupt-record.md");
});

// ── AC8 — corrupt-read does NOT block memory_stats (it stays a success carrying readErrors) ─────────
test("AC8/Q1: corrupt read does not regress memory_stats to an error — it stays a success with readErrors", async () => {
  const dir = fresh();
  const { call } = wired(dir);
  mkdirSync(join(dir, "facts"), { recursive: true });
  writeFileSync(join(dir, "facts", "bad.md"), "---\nbroken yaml ::: [\n---\nx\n");
  const data = payloadOf(await call("memory_stats"));
  assert.equal(Array.isArray(data.readErrors), true);
});

// ── AC9 — happy-path regression: every one of the 11 tools returns isError falsy with expected data ──
test("AC9: every one of the 11 tools' happy path stays isError:false with expected data", async () => {
  const { service, call } = wired(fresh());

  // seed records the happy paths can act on
  const { id: factId } = service.write({ type: "gotcha", scope: "global", text: "seed fact for happy paths" });
  const { id: epId } = service.episodeWrite({ task: "t", shape: "decompose", outcome: "pass", lesson: "lesson text" });

  // 1 memory_write
  assert.equal((await call("memory_write", { type: "decision", scope: "global", text: "another fact" })).isError ?? false, false);
  // 2 memory_recall
  assert.equal(payloadOf(await call("memory_recall", { query: "seed fact happy paths" })) && true, true);
  // 3 memory_search
  assert.ok(Array.isArray(payloadOf(await call("memory_search", { query: "seed fact" })).results));
  // 4 memory_update (valid id)
  assert.deepEqual(payloadOf(await call("memory_update", { id: factId, confidence: 0.9 })), { id: factId, updated: true });
  // 5 memory_feedback (valid recalled/used)
  assert.ok(payloadOf(await call("memory_feedback", { recalled: [factId], used: [factId], outcome: "pass" })).applied.includes(factId));
  // 6 memory_forget (valid id) — forget the *other* fact, keep factId for later
  const { id: throwaway } = service.write({ type: "gotcha", scope: "global", text: "forget me" });
  assert.deepEqual(payloadOf(await call("memory_forget", { id: throwaway })), { forgotten: true, kind: "fact" });
  // 7 episode_write
  assert.ok(payloadOf(await call("episode_write", { task: "t2", shape: "s2", outcome: "pass" })).id);
  // 8 memory_stats
  assert.ok(typeof payloadOf(await call("memory_stats")).facts === "number");
  // 9 memory_distill (list mode)
  assert.ok(Array.isArray(payloadOf(await call("memory_distill", { mode: "list" })).clusters));
  // 9b memory_distill (stamp valid)
  assert.ok(payloadOf(await call("memory_distill", { mode: "stamp", episodeIds: [epId] })).applied.includes(epId));
  // 10 memory_consolidate
  assert.ok(Array.isArray(payloadOf(await call("memory_consolidate", {})).proposals));
  // 11 memory_recover (valid: archive a fact, then recover it)
  let clock = 5000;
  const dir2 = fresh();
  const roots2: Roots = { global: dir2, project: null };
  const svc2 = new MemoryService(new MarkdownFileStore(roots2), new SqliteTextIndex(), roots2, () => (clock += 1000));
  svc2.load();
  const archivedId = archivedFact(svc2, () => (clock += 1000));
  const server2 = new CapturingServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerFactTools(server2 as any, svc2);
  const recoverRes = await server2.handlers.get("memory_recover")!({ id: archivedId });
  assert.deepEqual(payloadOf(recoverRes), { recovered: true });
});

// ── AC8 — a sample failure envelope from every category validates against the closed core schema ────
test("AC8: every produced envelope conforms to the closed core MemoryError schema", async () => {
  const { service, call } = wired(fresh());
  service.write({ type: "gotcha", scope: "global", text: "x" });
  // not-found, bad-input, invalid-state, internal all run through envelopeOf which MemoryError.parse()s.
  envelopeOf(await call("memory_update", { id: "g:MISSING" })); // not-found
  envelopeOf(await call("memory_update", { id: " " })); // bad-input
  assert.ok(true);
});
