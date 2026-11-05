// MarkdownFileStore on disk: a rewrite never leaves a record missing or half-written, a file the store
// cannot read is reported (never skipped silently), and the files of the old store read and rewrite as
// they were (mem-fixtures/store holds two the yaml package wrote).
import assert from "node:assert/strict";
import fs, {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { MarkdownFileStore } from "../lib/memory/persistence/file-store.mjs";

const STORE_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "mem-fixtures", "store");
const fresh = () => mkdtempSync(join(tmpdir(), "agentry-files-"));

const fact = (over = {}) => ({
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
function withWritesKilledMidway(fn) {
  const real = fs.writeFileSync;
  mock.method(fs, "writeFileSync", (file, text) => {
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
  assert.deepEqual(
    readdirSync(join(dir, "facts")).filter((f) => !f.endsWith(".md")),
    [],
    "no temp left",
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

test("a file with no frontmatter header is reported as a read error, not skipped", () => {
  const dir = fresh();
  const store = new MarkdownFileStore({ global: dir, project: null });
  store.writeFact("g", fact());
  mkdirSync(join(dir, "facts"), { recursive: true });
  writeFileSync(
    join(dir, "facts", "conflicted.md"),
    "<<<<<<< HEAD\n---\nid: g:01X\n---\n=======\n>>>>>>> theirs\n",
  );
  writeFileSync(join(dir, "facts", "crlf.md"), "---\r\nid: g:01Y\r\n---\r\n\r\nbody\r\n");

  const { records, errors } = store.readFacts();

  assert.equal(records.length, 1, "the readable fact still loads");
  assert.deepEqual(errors.map((e) => [e.kind, e.file]).sort(), [
    ["facts", "conflicted.md"],
    ["facts", "crlf.md"],
  ]);
  for (const e of errors) assert.match(e.reason, /no frontmatter header/);
});

test("a rewrite keeps the permission bits of the record's file, under the same name or a new one", () => {
  const dir = fresh();
  const store = new MarkdownFileStore({ global: dir, project: null });
  store.writeFact("g", fact());
  const only = () => {
    const names = readdirSync(join(dir, "facts"));
    assert.equal(names.length, 1);
    return join(dir, "facts", names[0] ?? "");
  };
  chmodSync(only(), 0o600);

  store.writeFact("g", fact({ confidence: 0.9 })); // same text → same file name
  assert.equal(statSync(only()).mode & 0o777, 0o600);

  store.writeFact("g", fact({ text: "the opal build skips its cache" })); // new slug → new name
  assert.match(only(), /the-opal-build-skips-its-cache-/);
  assert.equal(statSync(only()).mode & 0o777, 0o600);
});

test("a read-only fact file is rewritten, not refused", () => {
  const dir = fresh();
  const store = new MarkdownFileStore({ global: dir, project: null });
  store.writeFact("g", fact());
  const file = join(dir, "facts", readdirSync(join(dir, "facts"))[0] ?? "");
  chmodSync(file, 0o444);

  store.writeFact("g", fact({ confidence: 0.9 }));

  assert.equal(store.readFacts().records[0]?.fact.confidence, 0.9);
  assert.equal(statSync(file).mode & 0o777, 0o444);
});

test("a merge conflict is reported only when it breaks the header or YAML; in the body it is text", () => {
  const dir = fresh();
  const store = new MarkdownFileStore({ global: dir, project: null });
  mkdirSync(join(dir, "facts"), { recursive: true });
  const front = (id) =>
    `---\nid: ${id}\ntype: gotcha\nscope: global\nconfidence: 0.7\nusefulness: 0\ndecay: 0\nstatus: active\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n`;
  writeFileSync(
    join(dir, "facts", "in-body.md"),
    `${front("g:01BODY")}---\n\n<<<<<<< HEAD\none\n=======\ntwo\n>>>>>>> other\n`,
  );
  writeFileSync(
    join(dir, "facts", "in-yaml.md"),
    `${front("g:01YAML")}<<<<<<< HEAD\ndecay: 1\n=======\ndecay: 2\n>>>>>>> other\n---\n\nbody\n`,
  );

  const { records, errors } = store.readFacts();

  assert.deepEqual(
    records.map((r) => r.fact.id),
    ["g:01BODY"],
  );
  assert.match(records[0]?.fact.text ?? "", /^<<<<<<< HEAD/);
  assert.deepEqual(
    errors.map((e) => e.file),
    ["in-yaml.md"],
  );
});

test("a record that fails the shape is reported with the reasons, as the zod schema gave them", () => {
  const dir = fresh();
  const store = new MarkdownFileStore({ global: dir, project: null });
  mkdirSync(join(dir, "facts"), { recursive: true });
  writeFileSync(join(dir, "facts", "bad.md"), "---\nid: g:01\ntype: idea\n---\n\nbody\n");

  const { records, errors } = store.readFacts();

  assert.deepEqual(records, []);
  assert.equal(errors.length, 1);
  const issues = JSON.parse(errors[0]?.reason ?? "[]");
  assert.deepEqual(
    issues.map((i) => [i.path[0], i.code]),
    [
      ["type", "invalid_enum_value"],
      ["scope", "invalid_type"],
      ["confidence", "invalid_type"],
      ["usefulness", "invalid_type"],
      ["status", "invalid_type"],
      ["createdAt", "invalid_type"],
      ["updatedAt", "invalid_type"],
    ],
  );
});

test("the files the old store wrote read as the records they hold, and rewrite to the same bytes", () => {
  const dir = fresh();
  cpSync(STORE_FIXTURE, dir, { recursive: true });
  const store = new MarkdownFileStore({ global: dir, project: null });

  const facts = store.readFacts();
  const episodes = store.readEpisodes();

  assert.deepEqual(facts.errors, []);
  assert.deepEqual(episodes.errors, []);
  const [{ origin, fact: f }] = facts.records;
  assert.equal(origin, "g");
  assert.equal(f.text, "the opal build skips its cache\n\nIt reuses nothing between runs.");
  assert.deepEqual(f.tags, ["testing", "cross-component", "zod"]);
  assert.equal(f.status, "superseded");
  const [{ episode: e }] = episodes.records;
  assert.equal(e.task, "ship the port");
  assert.equal(e.distilled, true);
  assert.deepEqual(e.recallMisses, []);

  const before = (kind) => {
    const name = readdirSync(join(dir, kind))[0] ?? "";
    return [name, readFileSync(join(dir, kind, name), "utf8")];
  };
  const [factName, factText] = before("facts");
  const [episodeName, episodeText] = before("episodes");
  store.writeFact("g", f);
  store.writeEpisode("g", e);
  assert.equal(readFileSync(join(dir, "facts", factName), "utf8"), factText);
  assert.equal(readFileSync(join(dir, "episodes", episodeName), "utf8"), episodeText);
});

test("signature counts the .md files of both roots and the newest mtime", () => {
  const [g, p] = [fresh(), fresh()];
  const store = new MarkdownFileStore({ global: g, project: p });
  assert.deepEqual(store.signature(), { count: 0, maxMtimeMs: 0 });
  store.writeFact("g", fact());
  store.writeFact("p", fact({ id: "p:01JABCDEFGHJKMNPQRSTVWXYZ1" }));
  writeFileSync(join(g, "facts", "stray.txt"), "not a record");

  const sig = store.signature();

  assert.equal(sig.count, 2);
  assert.ok(sig.maxMtimeMs > 0);
});
