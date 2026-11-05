// The frontmatter reader and writer (lib/memory/persistence): they read every file the store's old writer
// (the `yaml` package) wrote and write the same bytes. The fixtures in mem-fixtures/frontmatter were produced
// once by that package: each .yaml is its `stringify` of a record, expected.json is its `parse` of the .yaml.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join as joinFile, split } from "../lib/memory/persistence/frontmatter.mjs";
import { parseMap } from "../lib/memory/persistence/yaml-read.mjs";
import { stringifyMap } from "../lib/memory/persistence/yaml-write.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "mem-fixtures", "frontmatter");
const expected = JSON.parse(readFileSync(join(FIXTURES, "expected.json"), "utf8"));
const cases = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => [f.replace(/\.yaml$/, ""), readFileSync(join(FIXTURES, f), "utf8")]);

for (const [name, text] of cases) {
  test(`fixture ${name}: reads as the yaml package read it`, () => {
    assert.deepEqual({ ...parseMap(text) }, expected[name]);
  });

  test(`fixture ${name}: writes the bytes the yaml package wrote`, () => {
    assert.equal(stringifyMap(expected[name]), text);
  });
}

test("every fixture has an expected value, and the reverse", () => {
  assert.deepEqual(Object.keys(expected).sort(), cases.map(([name]) => name).sort());
});

// ── what yaml writes that JSON cannot hold, and what a hand edit is likely to hold ─────────────────────

test("numbers: infinities and -0 survive a write and a read", () => {
  const record = { up: Number.POSITIVE_INFINITY, down: Number.NEGATIVE_INFINITY, neg: -0 };
  const text = stringifyMap(record);
  assert.equal(text, "up: .inf\ndown: -.inf\nneg: -0\n");
  const back = parseMap(text);
  assert.equal(back.up, Number.POSITIVE_INFINITY);
  assert.equal(back.down, Number.NEGATIVE_INFINITY);
  assert.ok(Object.is(back.neg, -0));
});

test("plain scalars resolve as in the YAML 1.2 core schema", () => {
  const got = parseMap(
    "a: 1\nb: -2.5\nc: true\nd: False\ne: null\nf: ~\ng:\nh: 0x1F\ni: 0o17\nj: .inf\nk: 1e3\nl: yes\nm: 2026-01-01\nn: 1.\n",
  );
  assert.deepEqual(
    { ...got },
    {
      a: 1,
      b: -2.5,
      c: true,
      d: false,
      e: null,
      f: null,
      g: null,
      h: 31,
      i: 15,
      j: Number.POSITIVE_INFINITY,
      k: 1000,
      l: "yes",
      m: "2026-01-01",
      n: 1,
    },
  );
  assert.ok(Number.isNaN(parseMap("a: .nan\n").a));
});

test("a hand-edited file: comments, a list at the key's indent, flow lists, single quotes", () => {
  const got = parseMap(
    [
      "# a leading comment",
      "id: g:01 # trailing",
      "",
      "tags:",
      "- a   # one",
      "  # between",
      "- 'it''s'",
      '- "q\\"x"',
      "provenance: [x, 'y, z', \"w\", 3]",
      "empty: []",
      "single: 'two",
      "  lines'",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    { ...got },
    {
      id: "g:01",
      tags: ["a", "it's", 'q"x'],
      provenance: ["x", "y, z", "w", 3],
      empty: [],
      single: "two lines",
    },
  );
});

test("a plain scalar over several lines folds; a blank line is a newline", () => {
  const got = parseMap("why: one\n  two\n\n  three\nnext: 1\n");
  assert.deepEqual({ ...got }, { why: "one two\nthree", next: 1 });
});

test("block scalars: literal, folded, chomping and the indent indicator", () => {
  const read = (text) => parseMap(text).v;
  assert.equal(read("v: |\n  one\n  two\n"), "one\ntwo\n");
  assert.equal(read("v: |-\n  x\n\nnext: 1\n"), "x");
  assert.equal(read("v: |+\n  y\n\nnext: 1\n"), "y\n\n");
  assert.equal(
    read("v: >\n  fold\n  me\n\n  para\n    indented\n  back\n"),
    "fold me\npara\n  indented\nback\n",
  );
  assert.equal(read("v: >-\n  tail"), "tail");
  assert.equal(read("v: |2-\n   lead\n  next"), " lead\nnext");
});

test("a |+ scalar on the last key keeps exactly its trailing newlines (the file's final newline ends the line)", () => {
  // each text and value is what the yaml package wrote and read for it
  const cases = [
    ["id: g:01J\ntext: |+\n  trail nl\n\n", { id: "g:01J", text: "trail nl\n\n" }],
    [
      "id: g:01J\nprovenance:\n  - |+\n    trail nl\n\n",
      { id: "g:01J", provenance: ["trail nl\n\n"] },
    ],
    ["id: g:01J\ntext: |+\n  \n", { id: "g:01J", text: "\n" }],
    ["id: g:01J\nprovenance:\n  - |+\n    \n", { id: "g:01J", provenance: ["\n"] }],
    ["id: g:01J\ntext: |+\n  \n\n", { id: "g:01J", text: "\n\n" }],
    ["id: g:01J\nprovenance:\n  - |+\n    \n\n", { id: "g:01J", provenance: ["\n\n"] }],
    ["why: |+\n  a\n\n\nx: 1\n", { why: "a\n\n\n", x: 1 }],
  ];
  for (const [text, want] of cases)
    assert.deepEqual({ ...parseMap(text) }, want, JSON.stringify(text));
});

test("an unknown key may hold a nested mapping or a flow mapping, or be quoted or hold a space; known keys read", () => {
  const got = parseMap(
    [
      "id: g:01",
      "meta:",
      "  source: hand",
      "  deeper:",
      "    a: 1",
      "# between",
      "my note: added by hand",
      "extra: {a: 1, b: [2, 3],",
      "  c: 'x}'}",
      '"type": gotcha',
      "'scope': repo",
      "why: kept",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    { ...got },
    {
      id: "g:01",
      meta: {},
      "my note": "added by hand",
      extra: {},
      type: "gotcha",
      scope: "repo",
      why: "kept",
    },
  );
});

test("a quote inside a flow mapping opens only at the start of a key or value; elsewhere it is text", () => {
  const read = (text) => ({ ...parseMap(text) });
  assert.deepEqual(read("meta: {note: it's mine}\nwhy: don't drop me}\n"), {
    meta: {},
    why: "don't drop me}",
  });
  assert.deepEqual(read("meta: {note: it's}\nwhy: x\n"), { meta: {}, why: "x" });
  assert.deepEqual(read("meta: {author: O'Brien}\nwhy: x\n"), { meta: {}, why: "x" });
  assert.deepEqual(read("meta: {a: 'it''s }', \"b\": \"}\"}\nwhy: x\n"), { meta: {}, why: "x" });
  assert.deepEqual(read("meta: {a: 1, # note }\n  b: 2}\nwhy: x\n"), { meta: {}, why: "x" });
});

test("a flow mapping that never closes is a read error, not a swallowed key; text after one is refused", () => {
  assert.throws(() => parseMap("meta: {a: 1\nwhy: x\n"), /line 1: .*never closed/);
  assert.throws(
    () => parseMap("meta: {a: 1} trailing\nwhy: x\n"),
    /line 1: .*after a flow mapping/,
  );
});

test("a known key that holds a mapping reads as an object, so the record check refuses it", () => {
  assert.deepEqual({ ...parseMap("why:\n  a: 1\n") }, { why: {} });
});

test("double-quoted escapes, a folded line, and an escaped line break", () => {
  const got = parseMap(
    'a: "tab\\t é \\x41 \\U0001F600 \\\\ \\/ \\_ \\N"\nb: "one\n  two\n\n  three"\nc: "a\\\n   b"\nd: "x \\ \n  y"\n',
  );
  assert.deepEqual(
    { ...got },
    { a: "tab\t é A \u{1F600} \\ / \u00a0 \u0085", b: "one two\nthree", c: "ab", d: "x   y" },
  );
});

test("a document that is not a mapping reads as one with no fields", () => {
  assert.deepEqual({ ...parseMap("") }, {});
  assert.deepEqual({ ...parseMap("just a bare line\n") }, {});
  assert.deepEqual({ ...parseMap("- a\n- b\n") }, {});
});

test("what is outside the subset is refused with its line, never guessed at", () => {
  const refusals = [
    ["a: &x 1\n", /line 1: .*anchors/],
    ["a: !!str 1\n", /line 1: .*tags/],
    ["a: [x, {y: 1}]\n", /line 1: .*flow list item/],
    ["a: b: c\n", /line 1: .*nested mapping/],
    ["this: is: not: valid\n", /line 1: .*nested mapping/],
    ["a: 1\na: 2\n", /line 2: .*repeated/],
    ['a: "never closed\n', /line 1: .*never closed/],
    ["a: 'x' y\n", /line 1: .*after a quoted/],
    ["a: 1\n  indented: 2\n", /line 2: .*nested mapping/],
    ["  why: x\n", /line 1: .*indentation/],
    ["why: x\n...\n", /line 2:/],
    ["tags: [[a]]\n", /line 1: .*flow list item/],
    ["a: @b\n", /line 1: .*cannot start/],
    ['a: "bad \\q escape"\n', /line 1: .*escape/],
  ];
  for (const [text, why] of refusals)
    assert.throws(() => parseMap(text), why, JSON.stringify(text));
});

// ── the file: header, YAML, body ───────────────────────────────────────────────────────────────────

test("a record file splits into its frontmatter and its trimmed body, and joins back", () => {
  const raw = "---\nid: g:01\ntags:\n  - a\n---\n\nthe body\n";
  const { front, body } = split(raw);
  assert.deepEqual({ ...front }, { id: "g:01", tags: ["a"] });
  assert.equal(body, "the body");
  assert.equal(joinFile({ id: "g:01", tags: ["a"] }, body), raw);
});

test("a file without an LF-ended header is refused", () => {
  assert.throws(() => split("no header here\n"), /no frontmatter header/);
  assert.throws(() => split("---\r\nid: x\r\n---\r\n\r\nbody\r\n"), /no frontmatter header/);
});

test("keys are written in the order given, and undefined values are left out", () => {
  assert.equal(stringifyMap({ zed: "z", alpha: undefined, mid: 1 }), "zed: z\nmid: 1\n");
});

test("a value the format cannot hold is refused when written", () => {
  assert.throws(() => stringifyMap({ a: { nested: 1 } }), /cannot write/);
  assert.throws(() => stringifyMap({ "bad key": 1 }), /cannot write the key/);
});
