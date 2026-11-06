// The index runtime seam (ADR-1): a driver-less runtime (no `node:sqlite`, e.g. Bun) runs the
// pure-JS token-scan with the exact fallback relevance rule (hits / query tokens, filtered > 0,
// desc, limit last); the default production path (driver resolved) is unchanged; and importing
// the index + constructing the default one writes nothing to disk — the index stays in-memory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MemoryService } from "../lib/memory/application/memory-service.mjs";
import { SqliteTextIndex } from "../lib/memory/persistence/db-index.mjs";
import { MarkdownFileStore } from "../lib/memory/persistence/file-store.mjs";

const fresh = () => mkdtempSync(join(tmpdir(), "agentry-mem-idx-"));
const DB_INDEX = join(dirname(fileURLToPath(import.meta.url)), "../lib/memory/persistence/db-index.mjs");

/** A driver-less index, its one [mem] notice swallowed (the notice itself is asserted below). */
function nullIndex(t) {
  const writes = mock.method(process.stderr, "write", () => true);
  const idx = new SqliteTextIndex(null);
  mock.restoreAll();
  assert.equal(writes.mock.calls.length, 1); // exactly the one [mem] line, nothing else
  return idx;
}

/** The default-path index, its FTS5-related [mem] notice swallowed when one fires. */
function defaultIndex() {
  mock.method(process.stderr, "write", () => true);
  const idx = new SqliteTextIndex();
  mock.restoreAll();
  return idx;
}

// ── driver-less mode: the pinned contract ─────────────────────────────────────────────────────────────

test("driver-less index: relevance = hits / query-token-count, sorted desc", (t) => {
  const idx = nullIndex(t);
  idx.add("a", "alpha beta gamma");
  idx.add("b", "alpha delta");
  assert.deepEqual(idx.search("alpha beta", 10), [
    { id: "a", relevance: 1 },
    { id: "b", relevance: 0.5 },
  ]);
  // partial overlap: one of two query tokens hits
  assert.deepEqual(idx.search("beta epsilon", 10), [{ id: "a", relevance: 0.5 }]);
});

test("driver-less index: limit applied last, after relevance ranking", (t) => {
  const idx = nullIndex(t);
  for (const [id, body] of [["a", "x y"], ["b", "x y z"], ["c", "x"]]) idx.add(id, body);
  // b covers all three tokens (1.0), a two of three (2/3), c one (1/3); limit 1 keeps only the top.
  assert.deepEqual(idx.search("x y z", 1), [{ id: "b", relevance: 1 }]);
});

test("driver-less index: empty and no-hit queries return []", (t) => {
  const idx = nullIndex(t);
  idx.add("a", "alpha");
  assert.deepEqual(idx.search("", 5), []);
  assert.deepEqual(idx.search("zzz qqq", 5), []);
});

test("driver-less index: re-adding an id never duplicates (and replaces the body)", (t) => {
  const idx = nullIndex(t);
  idx.add("a", "first wording");
  idx.add("a", "alpha beta gamma");
  const hits = idx.search("alpha beta", 10);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits, [{ id: "a", relevance: 1 }]);
  assert.deepEqual(idx.search("first wording", 10), []); // old body is gone
});

test("driver-less index: reset() empties it", (t) => {
  const idx = nullIndex(t);
  idx.add("a", "alpha beta");
  idx.reset();
  assert.deepEqual(idx.search("alpha", 10), []);
});

test("driver-less index: one [mem] stderr notice per constructor, same shape as the FTS5 line", () => {
  const writes = mock.method(process.stderr, "write", () => true);
  try {
    new SqliteTextIndex(null);
    new SqliteTextIndex(null);
  } finally {
    const lines = writes.mock.calls.map((c) => String(c.arguments[0]));
    mock.restoreAll();
    assert.equal(lines.length, 2); // once per constructor call, never per search/add
    for (const line of lines) {
      assert.equal(line, "[mem] node:sqlite unavailable — using a pure-JS token-scan index\n");
      assert.match(line, /^\[mem\] .*— .*\n$/); // same shape as the "[mem] FTS5 unavailable — …" line
    }
  }
});

// ── default production path: unchanged ────────────────────────────────────────────────────────────────

test("default path: search keeps its shape, relevant ≤ 1, limit, and the upsert rule", () => {
  const idx = defaultIndex();
  idx.add("keep", "alpha beta gamma");
  idx.add("drop", "alpha delta");
  assert.deepEqual(idx.search("alpha beta", 1), [idx.search("alpha beta", 2)[0]]);
  for (const { relevance } of idx.search("alpha beta gamma", 10)) {
    assert.ok(relevance > 0 && relevance <= 1, relevance);
  }
  idx.add("keep", "alpha replaced");
  const replaced = idx.search("alpha replaced", 10);
  assert.ok(replaced.filter((r) => r.id === "keep").length === 1); // never a duplicate
  assert.equal(replaced[0].relevance <= 1, true); // keep scores ahead of drop
});

test("default path: the composed service still opens its index over a temp store", () => {
  const dir = fresh();
  const service = new MemoryService(
    new MarkdownFileStore({ global: dir, project: null }),
    new SqliteTextIndex(),
    { global: dir, project: null },
  );
  service.write({ type: "gotcha", scope: "global", text: "node:sqlite is a default-path dependency" });
  const { memories } = service.recall({ query: "node:sqlite dependency" });
  assert.equal(memories.length, 1);
  for (const m of memories) assert.ok(m.score > 0 && m.score <= 1, m.score);
});

// ── the import-side-effect proof (a fresh process, so no in-process cache can help) ───────────────────

test("importing db-index and constructing the default index writes nothing to the store dir", () => {
  const dir = fresh();
  const before = readdirSync(dir);
  const script = [
    'import { pathToFileURL } from "node:url";',
    `const m = await import(pathToFileURL(${JSON.stringify(DB_INDEX)}).href);`,
    'const i = new m.SqliteTextIndex(); i.add("x", "hello world"); i.search("hello", 5); i.reset();',
  ].join("\n");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, AGENTRY_GLOBAL_DIR: dir },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(dir), before);
});
