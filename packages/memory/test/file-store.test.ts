// MarkdownFileStore on disk: a rewrite never leaves a record missing or half-written.
import assert from "node:assert/strict";
import fs, { mkdtempSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { Fact } from "@agentry/core";
import { MarkdownFileStore } from "../src/persistence/file-store.js";

const fresh = (): string => mkdtempSync(join(tmpdir(), "agentry-files-"));

const fact = (over: Partial<Fact> = {}): Fact => ({
  id: "g:01JABCDEFGHJKMNPQRSTVWXYZ0",
  type: "gotcha",
  scope: "global",
  text: "the topaz build caches its output",
  confidence: 0.7,
  usefulness: 0,
  decay: 0,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

/** Run `fn` while every `writeFileSync` writes half its text and then throws, as a kill mid-write would. */
function withWritesKilledMidway(fn: () => void): void {
  const real = fs.writeFileSync;
  mock.method(fs, "writeFileSync", (file: fs.PathOrFileDescriptor, text: string) => {
    real(file, text.slice(0, text.length / 2));
    throw new Error("killed mid-write");
  });
  syncBuiltinESMExports();
  try {
    fn();
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
}

test("a rewrite killed mid-write leaves the record's previous file whole", () => {
  const dir = fresh();
  const store = new MarkdownFileStore({ global: dir, project: null });
  store.writeFact("g", fact());

  withWritesKilledMidway(() => {
    assert.throws(() => store.writeFact("g", fact({ confidence: 0.9 })), /killed mid-write/);
  });

  const { records, errors } = store.readFacts();
  assert.deepEqual(errors, []);
  assert.deepEqual(
    records.map((r) => r.fact),
    [fact()],
  );
});

test("a rewrite that changes the slug leaves exactly one file for the id", () => {
  const dir = fresh();
  const store = new MarkdownFileStore({ global: dir, project: null });
  store.writeFact("g", fact());

  store.writeFact("g", fact({ text: "the opal build skips its cache" }));

  assert.deepEqual(readdirSync(join(dir, "facts")), [
    "the-opal-build-skips-its-cache-01JABCDEFGHJKMNPQRSTVWXYZ0.md",
  ]);
  assert.equal(store.readFacts().records[0]?.fact.text, "the opal build skips its cache");
});
