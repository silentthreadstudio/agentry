// The process skill's format reference against the rule catalog: its rule table names every rule, its
// params table lists every param each rule declares, with what is required, the default and the type
// (the capabilities a kind needs among it), as `rules/*.mjs` declare them, and its capability table
// words each capability as `rules/capabilities.mjs` does. A param added, dropped, retyped or given
// another need in code fails here until the page says so too.
// Run: node --test plugin/scripts/test/format-doc.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as md from "../lib/process/markdown.mjs";
import { CAN, CATALOG, FIELD } from "../lib/process/rules/index.mjs";

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
// How the page words each declared param type.
const TYPE = {
  kind: (d) => `a kind${needs(d)}`,
  field: (d) => FIELD[d.is].says("the rule's kind") + (d.needs ? `, to a kind${needs(d)}` : ""),
  section: (d) => `a section of the ${d.of === "parent" ? "parent's" : "kind's"} file`,
  parent: () => "an item of the parent's kind, or an also value of the parent field",
  string: () => "a string",
  strings: () => "a list of strings",
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
