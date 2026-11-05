// Freshness guard — proves the derived-index staleness cure end to end at the service level:
//   1. an out-of-band write (another process) is reflected without a restart (ensureFresh rebuilds),
//   2. a stable store does NOT rebuild on a second read (the signature short-circuits), and
//   3. resync() force-rebuilds and reports before/after counts.
// Each test gets its OWN temp dir — never share roots across cases.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryService } from "../lib/memory/application/memory-service.mjs";
import { SqliteTextIndex } from "../lib/memory/persistence/db-index.mjs";
import { MarkdownFileStore } from "../lib/memory/persistence/file-store.mjs";

const fresh = () => mkdtempSync(join(tmpdir(), "agentry-fresh-"));

function newService(global, store) {
  const roots = { global, project: null };
  const service = new MemoryService(
    store ?? new MarkdownFileStore(roots),
    new SqliteTextIndex(),
    roots,
  );
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
  const { id } = writer.write({
    type: "gotcha",
    scope: "global",
    text: "the peridot index must be rebuilt",
  });

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
class CountingStore {
  reads = 0;
  #inner;
  constructor(inner) {
    this.#inner = inner;
  }
  get hasProjectRoot() {
    return this.#inner.hasProjectRoot;
  }
  writeFact(...a) {
    this.#inner.writeFact(...a);
  }
  writeEpisode(...a) {
    this.#inner.writeEpisode(...a);
  }
  readFacts() {
    this.reads++;
    return this.#inner.readFacts();
  }
  readEpisodes() {
    this.reads++;
    return this.#inner.readEpisodes();
  }
  deleteFact(...a) {
    this.#inner.deleteFact(...a);
  }
  deleteEpisode(...a) {
    this.#inner.deleteEpisode(...a);
  }
  signature() {
    return this.#inner.signature(); // a REAL signature, so the short-circuit logic is genuinely exercised
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
  assert.equal(
    spy.reads,
    readsAfterLoad,
    "no rebuild → readFacts/readEpisodes must not be re-invoked",
  );
});

// A store whose fingerprint never moves, as on a filesystem with coarse mtimes where a write lands in
// the same tick as the last load. Search after the service's own writes must still be right: the
// service's own writes mark its view stale, they do not wait for the probe to notice them.
class HeldSignatureStore extends CountingStore {
  signature() {
    return { count: 0, maxMtimeMs: 0 };
  }
}
const held = (dir) => new HeldSignatureStore(new MarkdownFileStore({ global: dir, project: null }));

test("update() text is searchable by its new words while the store signature holds still", () => {
  const dir = fresh();
  const service = newService(dir, held(dir));
  const { id } = service.write({ type: "gotcha", scope: "global", text: "the jasper cache warms" });
  assert.equal(service.search("jasper")[0]?.id, id);

  service.update(id, { text: "the obsidian cache warms" });

  assert.deepEqual(
    service.search("obsidian").map((h) => h.id),
    [id],
  );
  assert.equal(service.search("jasper").length, 0, "the old text is gone from the index");
});

test("update() tags are searchable by the new tag while the store signature holds still", () => {
  const dir = fresh();
  const service = newService(dir, held(dir));
  const { id } = service.write({
    type: "decision",
    scope: "global",
    text: "beryl wins the lookup",
  });

  service.update(id, { tags: ["chrysoberyl"] });

  assert.deepEqual(
    service.search("chrysoberyl").map((h) => h.id),
    [id],
  );
});

test("recover() makes the fact searchable again while the signature holds still", () => {
  const dir = fresh();
  let clock = 1_000;
  const service = new MemoryService(
    held(dir),
    new SqliteTextIndex(),
    { global: dir, project: null },
    () => clock,
  );
  service.load();
  const { id } = service.write({
    type: "gotcha",
    scope: "global",
    text: "the zircon gauge drifts",
  });
  for (let strike = 0; strike < 4; strike++) {
    clock += 1_000;
    service.feedback({ recalled: [id], used: [], outcome: "pass" });
  }
  assert.equal(service.search("zircon").length, 0, "archived facts are not searchable");

  service.recover(id);

  assert.deepEqual(
    service.search("zircon").map((h) => h.id),
    [id],
  );
});

test("resync() force-rebuilds and reports before/after counts reflecting out-of-band facts", () => {
  const dir = fresh();
  const serviceA = newService(dir); // empty store → before.facts === 0

  // A second service over the same root lands a schema-valid fact on disk, bypassing serviceA's maps.
  newService(dir).write({
    type: "repo-fact",
    scope: "global",
    text: "ruby lives under the persistence layer",
  });

  const result = serviceA.resync();
  assert.equal(result.rebuilt, true);
  assert.equal(result.before.facts, 0);
  assert.equal(result.after.facts, 1);
  assert.deepEqual(Object.keys(result).sort(), ["after", "before", "rebuilt"]);
});

test("resync twice with no disk change → search returns exactly one hit (no double-index)", () => {
  const dir = fresh();
  const service = newService(dir);
  const { id } = service.write({
    type: "gotcha",
    scope: "global",
    text: "onyx must index exactly once",
  });

  // Force two rebuilds back-to-back with nothing changing on disk between them. add() is
  // delete-then-insert (db-index.mjs) and load() resets first (memory-service.mjs), so the term
  // resolves to a SINGLE row — a duplicate hit means add() regressed to INSERT-only and the
  // no-UNIQUE FTS/LIKE tables started double-indexing (an invariant the store leans on).
  service.resync();
  service.resync();

  const hits = service.search("onyx");
  assert.equal(hits.length, 1, "double resync must not double-index the term");
  assert.equal(hits[0]?.id, id);
});
