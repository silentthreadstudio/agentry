// Freshness guard (ADR-001) — proves the derived-index staleness cure end to end at the service level:
//   1. an out-of-band write (another process) is reflected without a restart (ensureFresh rebuilds),
//   2. a stable store does NOT rebuild on a second read (the signature short-circuits), and
//   3. resync() force-rebuilds and reports before/after counts.
// Mirrors the harness in memory.test.ts: mkdtemp roots, a local newService, a direct MarkdownFileStore
// for out-of-band writes. Each test gets its OWN temp dir — never share roots across cases.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MemoryService } from "../src/application/memory-service.js";
import type { FileStore, ReadResult, StoreSignature, StoredEpisode, StoredFact } from "../src/domain/ports.js";
import { SqliteTextIndex } from "../src/persistence/db-index.js";
import { MarkdownFileStore } from "../src/persistence/file-store.js";
import type { Roots } from "../src/resolution/roots.js";
import { registerResyncTool } from "../src/tools/resync-tool.js";

const fresh = (): string => mkdtempSync(join(tmpdir(), "agentry-fresh-"));

function newService(global: string, store?: FileStore): MemoryService {
  const roots: Roots = { global, project: null };
  const service = new MemoryService(store ?? new MarkdownFileStore(roots), new SqliteTextIndex(), roots);
  service.load();
  return service;
}

test("out-of-band write is reflected by search without a restart (ensureFresh rebuilds)", () => {
  const dir = fresh();
  const serviceA = newService(dir);
  // Nothing on disk yet → the term is absent.
  assert.equal(serviceA.search("peridot").length, 0);

  // A SECOND service over the same root simulates another process: its write() lands a schema-valid
  // fact file on disk and into ITS OWN maps — serviceA's maps/index are untouched.
  const writer = newService(dir);
  const { id } = writer.write({ type: "gotcha", scope: "global", text: "the peridot index must be rebuilt" });

  // serviceA never called load() again — the ensureFresh guard at the top of search() must rebuild,
  // because the file count moved.
  const hits = serviceA.search("peridot");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, id);
});

test("out-of-band write is reflected by recall and stats without a restart", () => {
  const dir = fresh();
  const serviceA = newService(dir);
  assert.equal(serviceA.stats().facts, 0);

  const writer = newService(dir);
  writer.write({ type: "decision", scope: "global", text: "garnet beats topaz for this lookup" });

  assert.equal(serviceA.stats().facts, 1);
  assert.equal(serviceA.recall({ query: "garnet topaz lookup" }).memories.length, 1);
});

// A counting spy over a real MarkdownFileStore: delegates everything, but tallies the disk reads so a
// test can assert the fresh path short-circuits (no rebuild → no second readFacts/readEpisodes).
class CountingStore implements FileStore {
  reads = 0;
  constructor(private readonly inner: MarkdownFileStore) {}
  get hasProjectRoot(): boolean {
    return this.inner.hasProjectRoot;
  }
  writeFact(...a: Parameters<FileStore["writeFact"]>): void {
    this.inner.writeFact(...a);
  }
  writeEpisode(...a: Parameters<FileStore["writeEpisode"]>): void {
    this.inner.writeEpisode(...a);
  }
  readFacts(): ReadResult<StoredFact> {
    this.reads++;
    return this.inner.readFacts();
  }
  readEpisodes(): ReadResult<StoredEpisode> {
    this.reads++;
    return this.inner.readEpisodes();
  }
  deleteFact(...a: Parameters<FileStore["deleteFact"]>): void {
    this.inner.deleteFact(...a);
  }
  deleteEpisode(...a: Parameters<FileStore["deleteEpisode"]>): void {
    this.inner.deleteEpisode(...a);
  }
  signature(): StoreSignature {
    return this.inner.signature(); // a REAL signature, so the short-circuit logic is genuinely exercised
  }
}

test("stable store does NOT rebuild on a second read (signature short-circuits)", () => {
  const dir = fresh();
  // Seed one fact so the store isn't empty (a separate service writes it directly to disk).
  newService(dir).write({ type: "gotcha", scope: "global", text: "amber stays put between reads" });

  const spy = new CountingStore(new MarkdownFileStore({ global: dir, project: null }));
  const service = newService(dir, spy); // load() here captures the current signature

  const readsAfterLoad = spy.reads;
  service.search("amber"); // first read — signature matches captured, no rebuild
  service.stats(); // second read — still no disk change
  assert.equal(spy.reads, readsAfterLoad, "no rebuild → readFacts/readEpisodes must not be re-invoked");
});

test("resync() force-rebuilds and reports before/after counts reflecting out-of-band facts", () => {
  const dir = fresh();
  const serviceA = newService(dir); // empty store → before.facts === 0

  // A second service over the same root lands a schema-valid fact on disk, bypassing serviceA's maps.
  newService(dir).write({ type: "repo-fact", scope: "global", text: "ruby lives under the persistence layer" });

  const result = serviceA.resync();
  assert.equal(result.rebuilt, true);
  assert.equal(result.before.facts, 0);
  assert.equal(result.after.facts, 1);
  assert.deepEqual(Object.keys(result).sort(), ["after", "before", "rebuilt"]);
});

test("memory_resync tool registers and its handler returns an ok envelope with resync payload", async () => {
  const dir = fresh();
  const service = newService(dir);
  newService(dir).write({ type: "gotcha", scope: "global", text: "opal was added out of band" });

  // Capture the registered handler off a stub server, then invoke it directly.
  let handler: ((args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>) | undefined;
  const stub = {
    registerTool: (_name: string, _def: unknown, h: typeof handler) => {
      handler = h;
    },
  } as unknown as McpServer;
  registerResyncTool(stub, service);
  assert.ok(handler, "registerResyncTool must register a handler");

  const res = await handler!({});
  assert.notEqual(res.isError, true);
  const payload = JSON.parse(res.content[0]!.text);
  assert.equal(payload.rebuilt, true);
  assert.equal(payload.after.facts, 1);
});
