// HIDDEN held-out oracle — drives the schema validator, the table's auto-id storage, the pure query layer, and
// the relations layer's referential integrity. The stub seed FAILS (throws "not implemented"); golden PASSES; the
// broken build (no required-check + ignored orderBy + unenforced referential integrity) FAILS.
const test = require("node:test");
const assert = require("node:assert/strict");

const { defineSchema } = require("../src/schema.js");
const { createTable } = require("../src/table.js");
const { select } = require("../src/query.js");
const { createDb } = require("../src/index.js");

test("schema flags a missing required column", () => {
  const schema = defineSchema({ name: { type: "string", required: true } });
  const result = schema.validate({});
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length >= 1);
});

test("schema flags a present column of the wrong type", () => {
  const schema = defineSchema({ age: { type: "number", required: true } });
  const result = schema.validate({ age: "old" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 1);
});

test("schema applies a default for a missing optional column", () => {
  const schema = defineSchema({
    name: { type: "string", required: true },
    active: { type: "boolean", default: true },
  });
  const result = schema.validate({ name: "ada" });
  assert.equal(result.ok, true);
  assert.equal(result.value.active, true);
});

test("table validates, auto-assigns incrementing ids from 1, and supports get/all", () => {
  const schema = defineSchema({ name: { type: "string", required: true } });
  const table = createTable(schema);
  const a = table.insert({ name: "a" });
  const b = table.insert({ name: "b" });
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.equal(table.get(1).name, "a");
  assert.equal(table.get(99), undefined);
  assert.equal(table.all().length, 2);
  table.remove(1);
  assert.equal(table.get(1), undefined);
  assert.equal(table.all().length, 1);
});

test("table.insert THROWS on an invalid row", () => {
  const schema = defineSchema({ name: { type: "string", required: true } });
  const table = createTable(schema);
  assert.throws(() => table.insert({}));
});

test("select filters by where (all keys must match)", () => {
  const rows = [
    { id: 1, kind: "a", n: 1 },
    { id: 2, kind: "b", n: 2 },
    { id: 3, kind: "a", n: 3 },
  ];
  const result = select(rows, { where: { kind: "a" } });
  assert.deepEqual(result.map((r) => r.id), [1, 3]);
});

test("select sorts by orderBy desc", () => {
  const rows = [
    { id: 1, n: 2 },
    { id: 2, n: 1 },
    { id: 3, n: 3 },
  ];
  const result = select(rows, { orderBy: { column: "n", dir: "desc" } });
  assert.deepEqual(result.map((r) => r.n), [3, 2, 1]);
});

test("select caps the count by limit", () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  const result = select(rows, { limit: 2 });
  assert.equal(result.length, 2);
});

test("db RESTRICT: removing a referenced parent THROWS", () => {
  const db = createDb();
  const authors = db.defineTable("authors", { name: { type: "string", required: true } });
  const books = db.defineTable("books", {
    title: { type: "string", required: true },
    authorId: { type: "number", required: true },
  });
  db.link("books", "authorId", "authors");

  const author = authors.insert({ name: "ada" });
  books.insert({ title: "notes", authorId: author.id });

  assert.throws(() => db.remove("authors", author.id));
  assert.notEqual(authors.get(author.id), undefined); // still present — not orphaned
});

test("db RESTRICT: removing an unreferenced row succeeds", () => {
  const db = createDb();
  const authors = db.defineTable("authors", { name: { type: "string", required: true } });
  const books = db.defineTable("books", {
    title: { type: "string", required: true },
    authorId: { type: "number", required: true },
  });
  db.link("books", "authorId", "authors");

  const referenced = authors.insert({ name: "ada" });
  const unreferenced = authors.insert({ name: "grace" });
  books.insert({ title: "notes", authorId: referenced.id });

  db.remove("authors", unreferenced.id);
  assert.equal(authors.get(unreferenced.id), undefined);
});

module.exports = {};
