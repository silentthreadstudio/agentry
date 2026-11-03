// The process skill's format reference against the rule catalog: its rule table names every rule, its
// params table lists every param each rule declares, with what is required, the default and the type
// (the capabilities a kind needs among it), as `rules/*.mjs` declare them, and its capability table
// words each capability as `rules/capabilities.mjs` does. A param added, dropped, retyped or given
// another need in code fails here until the page says so too. The same holds for the process file's
// keys: the top-level table and the harness-key table list exactly the keys `spec.mjs` checks, with
// which of them are required, and the lifecycle section names every `write` key.
// Run: node --test plugin/scripts/test/format-doc.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as md from "../lib/process/markdown.mjs";
import { CAN, CATALOG, FIELD } from "../lib/process/rules/index.mjs";
import { schema } from "../lib/process/spec.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORMAT = join(HERE, "..", "..", "skills", "process", "references", "format.md");
const text = readFileSync(FORMAT, "utf8");

/** The rows of the first table under `heading`, each cell read plain (backticks and bold stripped). */
function rows(heading) {
  const sec = md.section(text, heading);
  assert.ok(sec, `format.md has a "${heading}" heading`);
  const table = md.tableIn(text, sec);
  assert.ok(table, `a table under "${heading}"`);
  return table.rows.map((r) => table.header.map((h) => md.plain(r.cells[h])));
}

const quoted = (values) => values.map((v) => `"${v}"`).join(" or ");
const needs = (d) => (d.needs?.length ? ` with ${d.needs.join(", ")}` : "");
const NAMES = { id: "the kind's items", parent: "their parents" };
// How the page words each declared param type.
const TYPE = {
  kind: (d) => `a kind${needs(d)}`,
  field: (d) => FIELD[d.is].says("the rule's kind") + (d.needs ? `, to a kind${needs(d)}` : ""),
  section: (d) =>
    `a ${d.as ? `${d.as} ` : ""}section of the ${d.of === "parent" ? "parent's" : "kind's"} file`,
  parent: () => "an item of the parent's kind, or an also value of the parent field",
  string: () => "a string",
  strings: (d) =>
    d.names ? `a list of ids of ${d.names.map((n) => NAMES[n]).join(" or ")}` : "a list of strings",
  enum: (d) => quoted(d.values),
  except: () => '{ field or "id": [values] }',
};
const only = (d) =>
  d.only
    ? `, used only when ${Object.entries(d.only)
        .map(([p, values]) => `${p} is ${quoted(values)}`)
        .join(" and ")}`
    : "";
const defaultOf = (d) => {
  if (d.default !== undefined) return JSON.stringify(d.default);
  return d.pick ? "the first field that fits" : "—";
};

test("the rule table names every catalog rule, once", () => {
  assert.deepEqual(
    rows("Rule catalog").map(([rule]) => rule),
    Object.keys(CATALOG),
  );
});

test("the params table lists every declared param with its required, default and type", () => {
  const declared = Object.values(CATALOG).flatMap((rule) =>
    Object.entries(rule.params).map(([name, d]) => [
      rule.id,
      name,
      d.required ? "yes" : "no",
      defaultOf(d),
      TYPE[d.type](d) + only(d),
    ]),
  );
  assert.deepEqual(rows("Rule params"), declared);
});

test("the capability table words every capability a rule can need, once", () => {
  assert.deepEqual(
    rows("Kind capabilities"),
    Object.entries(CAN).map(([name, c]) => [name, c.says("the rule's kind")]),
  );
});

// A shape's keys as [path, "yes" | "no"] (required or not), each followed by its nested shape's keys.
const keyRows = (keys, at = "") =>
  Object.entries(keys).flatMap(([key, check]) => {
    const path = `${at}${key.replace(/!$/, "")}`;
    const row = [path, key.endsWith("!") ? "yes" : "no"];
    return [row, ...(check.keys ? keyRows(check.keys, `${path}.`) : [])];
  });
const HARNESS = ["gate", "extensions", "conductor"];

test("the top-level table lists every key of the process file, with what is required", () => {
  assert.deepEqual(
    rows("Top level").map(([key, required]) => [key, required]),
    Object.keys(schema.keys).map((k) => [k.replace(/!$/, ""), k.endsWith("!") ? "yes" : "no"]),
  );
});

test("the harness-key table lists every gate, extensions and conductor key, with what is required", () => {
  assert.deepEqual(
    rows("gate, extensions and conductor").map(([key, required]) => [key, required]),
    HARNESS.flatMap((top) => keyRows(schema.keys[top].keys, `${top}.`)),
  );
});

test("the lifecycle section names every write key", () => {
  const sec = md.section(text, "lifecycle and drafts");
  const body = text.split("\n").slice(sec.line, sec.end).join("\n");
  for (const key of Object.keys(schema.keys.lifecycle.keys.write.keys))
    assert.ok(body.includes(`\`${key}\` (`), `the lifecycle section words write.${key}`);
});

test("the join row states what a separator may not hold, as the validators refuse it", () => {
  const row = text.split("\n").find((l) => l.startsWith("  | `join`"));
  assert.ok(row, "format.md has a join row");
  assert.match(row, /no letters, digits, line breaks or other control characters/);
});

test("init and the learn reference offer lifecycle writes once, saying what they write", () => {
  const skills = join(HERE, "..", "..", "skills", "process", "references", "learn.md");
  for (const file of [join(HERE, "..", "..", "commands", "init.md"), skills]) {
    const doc = readFileSync(file, "utf8");
    assert.match(doc, /\*\*Lifecycle writes\.\*\*/, file);
    assert.match(doc, /lifecycle off/, file);
    assert.match(doc, /verdict/, file);
    assert.doesNotMatch(doc, /`explain` and the merge print|explain\` and the\s+merge print/, file);
    assert.doesNotMatch(doc, /Harness writes on\?/, file);
    assert.match(doc, /ignored `\.env`/, file);
  }
});
